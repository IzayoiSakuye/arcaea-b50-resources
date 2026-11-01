#!/usr/bin/env node
/**
 * build-catalog.ts —— 把「曲库」与「视频索引」合并成应用唯一读取的曲目目录
 * ============================================================================
 *
 * 输入（原始层，保留用于审计与重建）
 *   data/arcaea-songdb.json   GitHub 曲库：曲名/曲师/定数/物量/别名     335 首
 *   data/arcaea-index.json    B站 视频索引：(曲名,难度) → 视频来源      503 首
 *
 * 输出（⭐ 应用只读这一个文件）
 *   data/arcaea-catalog.json  以 song_id 为主键的完整曲目目录
 *
 * 为什么要合并而不是让应用读两个文件
 *   1. 主键不统一：曲库用 song_id，索引用 (曲名,难度)。运行时做 join 等于把
 *      归一化逻辑复制一份到 Go 里，两边必然漂移。
 *   2. OCR 纠错需要预计算的匹配表：曲名/日文名/别名/song_id/宽松键全部拍平成
 *      match_keys，应用侧只做一次 Map 查找。
 *   3. 定数有多个来源会打架：合并时把**候选值全部留下**并标注来源，
 *      而不是让应用去猜。
 *
 * 定数优先级（越高越可信）
 *   wiki    ChartConstant.json（2023-05，wiki 工作组维护）
 *   songdb  arcsong.json（2023-07）      —— 与 wiki 在 318 首重叠上 0 处不一致
 *   video   视频分P标题里的 "(11.2)"      —— 汇编视频多为 2022–2023 年发布，
 *                                          20/104 与 wiki 不符，判定为过时值
 *   derived 由等级标签推算（不精确，仅占位）
 *
 * 用法
 *   node scripts/build-catalog.ts
 *   node scripts/build-catalog.ts --song-db data/arcaea-songdb.json -o data/arcaea-catalog.json
 *
 * 依赖：Node.js >= 18。零第三方依赖。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type {
  CatalogChart,
  CatalogFile,
  CatalogJacket,
  CatalogSong,
  ConstantSource,
  Difficulty,
  IndexChart,
  IndexFile,
  IndexVideoSource,
  JacketEntry,
  JacketsFile,
  VideoSource,
} from './lib/types.ts';

const DIFFICULTY_CLASS_ORDER: Difficulty[] = ['PST', 'PRS', 'FTR', 'BYD', 'ETR', 'INS'];

/** 定数来源优先级：数字越小越可信 */
const CONSTANT_PRIORITY: Record<ConstantSource, number> = { wiki: 0, songdb: 1, video: 2, derived: 3 };

// ---------------------------------------------------------------------------
// 原始层 JSON 的类型
//
// ⚠️ lib/types.ts 描述的是**各层产物**，但索引层的 collections / constant_source
//    与目录层不是同一套词汇，曲库层则完全没有契约。这里按**实际产物**补齐，
//    只声明本脚本用到的字段。
// ---------------------------------------------------------------------------

/** 索引层来源：collections 是对象数组（目录层才拍平成 string[]） */
interface RawIndexSource extends Omit<IndexVideoSource, 'collections'> {
  collections?: Array<{ kind?: string; name: string }>;
}

/** 索引层的 constant_source 是标题解析的原始值（'video_title' / 'song_db'），不是目录层的 ConstantSource */
interface RawIndexChart extends Omit<IndexChart, 'sources' | 'song_id' | 'constant_source'> {
  song_id?: string | null;
  constant_source?: 'video_title' | 'song_db' | null;
  sources: RawIndexSource[];
}

interface RawIndexFile extends Omit<IndexFile, 'charts' | 'unparsed'> {
  charts: RawIndexChart[];
  unparsed?: Array<{
    bvid: string;
    p: number | null;
    part_title: string;
    video_title: string;
    reason: string;
    collection?: string;
  }>;
}

/** 曲库层（build-song-db → data/arcaea-songdb.json），lib/types.ts 未覆盖 */
interface SongDbDifficulty {
  class: Difficulty;
  level: string | null;
  /** wiki Template:ChartConstant 的值，权威 */
  constant: number | null;
  /** GitHub 上 2023 年的 ChartConstant.json，仅作交叉校验 */
  constant_repo?: number | null;
  note: number | null;
  chart_designer?: string;
  jacket_designer?: string;
  /** 该难度有独立曲绘（磁盘上是 <song_id>_<难度>.jpg） */
  jacket_override?: boolean;
  /** 该难度有独立曲名，如 Last 的 BYD 叫 "Last | Moment" */
  alt_title?: string;
}

interface SongDbSong {
  song_id: string;
  title_en: string;
  title_jp?: string;
  title_norm: string;
  alias?: string[];
  alias_norm?: string[];
  artist?: string;
  bpm?: number | null;
  set?: string;
  set_friendly?: string;
  version?: string;
  date?: number | null;
  time_sec?: number | null;
  bg?: string;
  bg_inverse?: string;
  difficulties?: SongDbDifficulty[];
}

interface SongDbFile {
  generated_at?: string;
  songs: SongDbSong[];
}

/** 人工映射表：正常是 { map: {...} }，早期格式可能是裸对象；下划线键是注释，加载时忽略 */
interface AliasesFile {
  map?: Record<string, string>;
  [k: string]: unknown;
}

/**
 * 曲绘字段的实际形态：产物在「没有曲绘」时会写显式 null，而 lib 契约把这些
 * 字段标成了可选 —— 如实建模，免得为了迁就契约去改动产物。
 */
type JacketOut = Omit<CatalogJacket, 'local_256' | 'full_url' | 'native' | 'source'> & {
  local_256?: string | null;
  full_url?: string | null;
  native?: string | null;
  source?: string | null;
};

/** 定数候选：来源 → 数值。键来自 JSON，允许是 lib 未列出的历史来源名 */
type ConstantCandidates = Partial<Record<ConstantSource, number>>;

/** 谱面字段的实际形态：产物里 level 会是 null、constant_source 会缺失或为 null */
interface ChartEntry extends Omit<CatalogChart, 'level' | 'constant_source'> {
  level: string | null;
  constant_source: ConstantSource | null;
  constant_candidates?: ConstantCandidates;
}

interface SongEntry extends Omit<CatalogSong, 'jacket' | 'charts'> {
  jacket: JacketOut;
  charts: ChartEntry[];
}

interface CatalogOutFile extends Omit<CatalogFile, 'songs'> {
  songs: SongEntry[];
}

interface JacketTable {
  byId: Map<string, JacketEntry>;
  ids: Set<string>;
}

/** --suggest-aliases 的候选条目：只是**建议**，人工核对后才允许挪进 map（见铁律 5） */
interface AliasSuggestion {
  title: string;
  title_norm: string;
  derived: string;
  suggested: string;
  score: number;
  margin: number;
  alternatives: string[];
}

interface Args {
  songDb: string;
  index: string;
  jackets: string | null;
  aliases: string | null;
  suggestAliases: boolean;
  out: string;
  quiet: boolean;
}

const DEFAULTS: Args = {
  songDb: 'data/arcaea-songdb.json',
  index: 'data/arcaea-index.json',
  jackets: 'data/arcaea-jackets.json',
  aliases: 'data/song-id-aliases.json',
  suggestAliases: false,
  out: 'data/arcaea-catalog.json',
  quiet: false,
};

function parseArgs(argv: string[]): Args {
  const args: Args = { ...DEFAULTS };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--song-db') args.songDb = argv[++i];
    else if (a === '--index') args.index = argv[++i];
    else if (a === '--jackets') args.jackets = argv[++i];
    else if (a === '--no-jackets') args.jackets = null;
    else if (a === '--aliases') args.aliases = argv[++i];
    else if (a === '--no-aliases') args.aliases = null;
    else if (a === '--suggest-aliases') args.suggestAliases = true;
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        '用法: node scripts/build-catalog.ts [--song-db <f>] [--index <f>] [--jackets <f>|--no-jackets]\n' +
          '       [--aliases <f>] [--suggest-aliases] [-o <f>]'
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * ⚠️ **模块被 import 时绝不能在这里 parseArgs。**
 *
 * `build-backgrounds.ts` 要 import 本文件的 `normalizeTitle` / `looseKey` 复用归一化逻辑。
 * 如果这里无守卫地解析 argv，那么它带 `--help` 时会被**本文件**的 help 分支 `process.exit(0)`
 * 截胡 —— 表现是「跑 build-backgrounds --help 打出的是 build-catalog 的用法」，
 * 而且退出码是 0，看起来完全正常。排查过一次。
 *
 * 所以 CFG 先给默认值，真正的解析推迟到下面确认「是主模块」之后。
 */
let CFG: Args = DEFAULTS;
const log = (...a: unknown[]) => {
  if (!CFG.quiet) console.log(...a);
};

/** 与另两个脚本保持完全一致的归一化 —— 否则 join 不上 */
export function normalizeTitle(s: unknown): string {
  return String(s)
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 比 normalizeTitle 更宽松：去掉所有非字母数字，用于兜底匹配 */
export function looseKey(s: unknown): string {
  return normalizeTitle(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 为「曲库里没有的新曲」推导 song_id。
 * Arcaea 官方 song_id 恰好就是英文曲名的小写字母数字形式
 * （`Aegleseeker` → `aegleseeker`），所以这个推导命中率很高。
 * ⚠️ 但它是**推导值**，标记 song_id_source="derived"，后续需与游戏真实 ID 核对。
 */
export function deriveSongId(titleNorm: string): string {
  return titleNorm.replace(/[^a-z0-9]+/g, '');
}

/** 读 JSON。产物结构没有内建类型信息，由调用方用泛型参数声明 */
async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.resolve(p), 'utf8')) as T;
}

/**
 * 载入曲绘表（由 build-jackets.ts 产出）。
 *
 * ⭐ 曲绘文件名 `Songs_<song_id>.jpg` 里的 `<song_id>` 是**官方 ID**，
 *    所以这张表同时也是一份权威 song_id 清单 —— 可以用来校正从曲名
 *    推导出来的 ID（例如 `Aether Crest: Astral` 推导成 `aethercrestastral`，
 *    而官方 ID 其实是 `aethercrest`）。
 */
async function loadJackets(file: string | null): Promise<JacketTable | null> {
  if (!file) return null;
  try {
    const j = await readJson<JacketsFile>(file);
    const byId = new Map<string, JacketEntry>();
    for (const x of j.jackets ?? []) byId.set(x.song_id, x);
    return { byId, ids: new Set(byId.keys()) };
  } catch {
    return null;
  }
}

/**
 * 把推导出的 song_id 对齐到官方 ID。
 *
 * 三级策略：
 *   ① 精确命中
 *   ② 互为前缀（长度 ≥ 6，唯一或最长且不并列）
 *   ③ 人工映射表（--aliases）—— 覆盖前两级解决不了的命名改写，
 *      例如 `Aleph-0` → `alephzero`、`Alone & Lorn` → `aloneandlorn`、
 *      `Ashen 6oundary` → `ashenboundary`（标题里的 6 是风格化的 b）
 */
function alignToJacketId(
  derived: string,
  jackets: JacketTable | null,
  manual: Map<string, string> | null = null
): { id: string; aligned: boolean; via: string | null } {
  if (!jackets) return { id: derived, aligned: false, via: null };
  if (jackets.ids.has(derived)) return { id: derived, aligned: false, via: null };

  const cands: string[] = [];
  for (const j of jackets.ids) {
    if (j.length < 6 || j.includes('_')) continue; // 跳过 _byd / _old 这类变体文件
    if (derived.startsWith(j) || j.startsWith(derived)) cands.push(j);
  }
  if (cands.length === 1) return { id: cands[0], aligned: true, via: 'prefix' };
  if (cands.length > 1) {
    cands.sort((a, b) => b.length - a.length);
    if (cands[0].length > cands[1].length) return { id: cands[0], aligned: true, via: 'prefix' };
  }
  return { id: derived, aligned: false, via: null };
}

/**
 * 字符二元组 Dice 相似度。仅用于**生成建议**，不用于自动套用 ——
 * 张冠李戴（给一首曲配上别人的曲绘）比缺图糟糕得多，必须人工确认。
 */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const [g, n] of A) {
    const bn = B.get(g);
    if (bn !== undefined) inter += Math.min(n, bn);
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** 把曲绘条目转成产物里的 jacket 字段形态 */
function toJacketOut(j: JacketEntry): JacketOut {
  return {
    bundled: !!j.local?.thumb256,
    local_256: j.local?.thumb256 ?? null,
    full_url: j.url,
    thumb_url_256: j.thumb_url_256,
    native: j.width && j.height ? `${j.width}x${j.height}` : null,
    source: 'arcwiki',
  };
}

/**
 * 每难度专属曲绘。文件名两种写法都要试：
 *   ① `<song_id>_<难度小写>` —— 绝大多数，如 tempestissimo_byd.jpg、avril_prs.jpg
 *   ② 别名难度的曲名宽松键 —— 仅 4 个：ignotus/dropdead/redandblue/singularity
 *      的 BYD 在 wiki 上直接用了别名词（ignotusafterburn.jpg / overdead.jpg / …）
 * 找不到返回 null，调用方回落到歌曲默认曲绘。
 */
function resolveChartJacket(
  songId: string,
  chart: ChartEntry,
  jackets: JacketTable
): JacketEntry | null {
  const cands = [`${songId}_${chart.difficulty.toLowerCase()}`];
  if (chart.alt_title) cands.push(looseKey(chart.alt_title));
  for (const c of cands) {
    const j = jackets.byId.get(c);
    if (j) return j;
  }
  return null;
}

/** 把曲绘信息（含感知哈希）填进曲目条目，顺带解析各难度的专属曲绘 */
function fillJacket(song: SongEntry, jackets: JacketTable | null): boolean {
  const j = jackets?.byId.get(song.song_id);
  if (!j) {
    song.jacket = { bundled: false, full_url: null, source: null };
    song.phash = null;
  } else {
    song.jacket = toJacketOut(j);
    song.phash = j.ahash ? { ahash: j.ahash, dhash: j.dhash } : null;
  }
  if (jackets) {
    for (const chart of song.charts) {
      const jc = resolveChartJacket(song.song_id, chart, jackets);
      chart.jacket = jc ? toJacketOut(jc) : null;
      chart.phash = jc?.ahash ? { ahash: jc.ahash, dhash: jc.dhash } : null;
    }
  }
  return !!j;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  log('▶ 合并曲目目录');

  const songDb = await readJson<SongDbFile>(CFG.songDb);
  const index = await readJson<RawIndexFile>(CFG.index);
  const jackets = await loadJackets(CFG.jackets);

  // 人工 song_id 映射表（title_norm → 官方 song_id），可选。
  // 推导不出来的命名改写（Aleph-0 → alephzero 之类）靠它兜底。
  let manualAliases: Map<string, string> | null = null;
  if (CFG.aliases) {
    try {
      const raw = await readJson<AliasesFile>(CFG.aliases);
      const table: Record<string, unknown> = raw.map ?? raw;
      // 值是人工填的 song_id，必然是字符串 —— 映射表本身没有类型信息，只能断言
      manualAliases = new Map<string, string>(
        Object.entries(table).filter(([k]) => !k.startsWith('_')) as Array<[string, string]>
      );
      log(`  映射表  ${CFG.aliases}  (${manualAliases.size} 条人工映射)`);
    } catch {
      /* 没有就跳过 */
    }
  }

  log(`  曲库    ${CFG.songDb}  (${songDb.songs.length} 首)`);
  log(`  索引    ${CFG.index}  (${index.charts.length} 条目)`);
  if (jackets) log(`  曲绘    ${CFG.jackets}  (${jackets.ids.size} 张，含官方 song_id 清单)`);
  else if (CFG.jackets) log(`  曲绘    未找到 ${CFG.jackets}（先跑 build-jackets.ts）`);

  // song_id -> 目录条目
  const catalog = new Map<string, SongEntry>();
  // 各种匹配键 -> song_id（用于把索引条目挂上去）
  const normToId = new Map<string, string>();
  const looseToId = new Map<string, string | null>();

  const registerKeys = (id: string, keys: string[]): void => {
    for (const k of keys) {
      if (!k) continue;
      if (!normToId.has(k)) normToId.set(k, id);
      const lk = looseKey(k);
      if (!lk) continue;
      if (!looseToId.has(lk)) looseToId.set(lk, id);
      else if (looseToId.get(lk) !== id) looseToId.set(lk, null); // 歧义键作废
    }
  };

  // ---- 第 1 步：用曲库铺底 ----
  for (const s of songDb.songs ?? []) {
    const entry: SongEntry = {
      song_id: s.song_id,
      song_id_source: 'official',
      title_en: s.title_en,
      title_jp: s.title_jp || '',
      title_norm: s.title_norm,
      aliases: s.alias ?? [],
      match_keys: [],
      artist: s.artist ?? '',
      bpm: s.bpm ?? null,
      set: s.set ?? '',
      set_friendly: s.set_friendly ?? '',
      version: s.version ?? '',
      date: s.date ?? null,
      time_sec: s.time_sec ?? null,
      // ⚠️⚠️ 这个字段**不可信**，别直接用它去取背景图。
      //   `?? s.song_id` 的兜底看起来像真值，实际是占位：实测 198 首 derived 曲目
      //   100% 等于 song_id，另有 38 首老曲为空。而且即便是真值，也漏掉了
      //   「曲包级背景」（base_light / eden_light 这类）。
      //   权威来源是 scripts/build-backgrounds.ts 产出的
      //   data/arcaea-backgrounds.json（覆盖率 97.7%，含多候选）。
      bg: s.bg ?? s.song_id,
      jacket: { bundled: false, source_hint: 'user_supplied' }, // 曲绘待后续步骤填充
      phash: null, // 感知哈希索引待后续步骤填充
      charts: (s.difficulties ?? []).map((d): ChartEntry => {
        const raw: ConstantCandidates = {};
        // wiki 页面是权威 → 标成优先级最高的 wiki 来源；
        // GitHub 那份 2023 年的旧表降级为 songdb，只用来暴露分歧。
        if (d.constant != null) raw.wiki = d.constant;
        if (d.constant_repo != null) raw.songdb = d.constant_repo;
        const cands = dedupeCandidates(raw); // 同值只保留优先级最高的来源
        return {
          difficulty: d.class,
          level: d.level ?? null,
          constant: pickConstant(cands),
          constant_source: pickConstantSource(cands),
          ...(Object.keys(cands).length > 1 ? { constant_candidates: cands } : {}),
          note: d.note ?? null,
          chart_designer: d.chart_designer ?? '',
          jacket_designer: d.jacket_designer ?? '',
          ...(d.alt_title ? { alt_title: d.alt_title } : {}),
          video: null,
          jacket: null, // 第 3 步解析
        };
      }),
    };
    entry.match_keys = dedupe([s.title_norm, normalizeTitle(s.title_jp), s.song_id, ...(s.alias_norm ?? [])]);
    catalog.set(s.song_id, entry);
    registerKeys(s.song_id, entry.match_keys);
  }
  log(`  铺底完成：${catalog.size} 首（official song_id）`);

  // ---- 第 2 步：把索引条目挂上去 ----
  let attached = 0;
  let createdSongs = 0;
  let createdCharts = 0;
  let collision = 0;
  let skippedNoId = 0;
  let alignedToJacket = 0;
  let alignedManual = 0;

  for (const c of index.charts ?? []) {
    const tNorm = c.title_norm;

    // 2a. 定位 song_id：索引里已关联的 > 匹配键 > 宽松键 > 推导
    let songId = c.song_id || normToId.get(tNorm) || looseToId.get(looseKey(tNorm)) || null;

    if (!songId) {
      let derived = deriveSongId(tNorm);
      if (!derived) {
        // 曲名全是标点/符号，推不出 id —— 记下来而不是静默丢掉
        skippedNoId++;
        continue;
      }
      // 用曲绘表里的**官方 ID 清单**校正推导结果。
      // ⚠️ 只有在对齐结果未被别的曲目占用时才采用 —— 否则说明这本来就是
      //    两首不同的曲（如 `Aether Crest` 与 `Aether Crest: Astral`）。
      const manualId = manualAliases?.get(tNorm) ?? null;
      const al = manualId
        ? { id: manualId, aligned: true, via: 'manual' }
        : alignToJacketId(derived, jackets);
      if (al.aligned && !catalog.has(al.id)) {
        derived = al.id;
        alignedToJacket++;
        if (al.via === 'manual') alignedManual++;
      }
      if (catalog.has(derived)) {
        // 推导出的 id 与已有曲目撞车，但曲名不同 → 加后缀并标记
        songId = `${derived}-x`;
        collision++;
      } else {
        songId = derived;
      }
    }

    let entry: SongEntry | undefined = catalog.get(songId);
    if (!entry) {
      entry = {
        song_id: songId,
        song_id_source: 'derived',
        title_en: c.title,
        title_jp: '',
        title_norm: tNorm,
        aliases: [],
        match_keys: [tNorm],
        artist: '', // 索引里没有曲师信息
        bpm: null,
        set: '',
        set_friendly: '',
        version: '',
        date: null,
        time_sec: null,
        // ⚠️ 同上面那处：这不是背景名，只是把 song_id 抄进来占位。
        //   索引里根本没有背景信息，背景一律以 data/arcaea-backgrounds.json 为准。
        bg: songId,
        jacket: { bundled: false, source_hint: 'user_supplied' },
        phash: null,
        charts: [],
      };
      catalog.set(songId, entry);
      registerKeys(songId, entry.match_keys);
      createdSongs++;
    }

    // 2b. 定位难度槽位
    let chart = entry.charts.find((x) => x.difficulty === c.difficulty);
    if (!chart) {
      chart = {
        difficulty: c.difficulty,
        level: c.level ?? null,
        constant: null,
        constant_source: null,
        note: null,
        chart_designer: '',
        jacket_designer: '',
        video: null,
        jacket: null, // 第 3 步解析
      };
      entry.charts.push(chart);
      createdCharts++;
    }

    // 2c. 合并定数候选（曲库/索引各自的来源分别记录）
    if (c.constant != null) {
      const src = c.constant_source === 'song_db' ? 'songdb' : 'video';
      const cands = { ...(chart.constant_candidates ?? {}) };
      if (chart.constant != null && chart.constant_source) cands[chart.constant_source] = chart.constant;
      cands[src] = c.constant;
      chart.constant_candidates = dedupeCandidates(cands);
      chart.constant = pickConstant(chart.constant_candidates);
      chart.constant_source = pickConstantSource(chart.constant_candidates);
      if (Object.keys(chart.constant_candidates).length < 2) delete chart.constant_candidates;
    }

    // 2d. 视频来源：多来源全部保留（抗单点失效）
    // ⚠️ 这里是**字段白名单** —— 索引层新增字段时，必须同步加到这里，
    //    否则会被**静默丢掉**（video_width 第一次加进来时就踩过这个坑）。
    const sources: VideoSource[] = (c.sources ?? []).map((s) => ({
      bvid: s.bvid,
      p: s.p,
      url: s.url,
      duration_sec: s.duration_sec ?? 0,
      part_title: s.part_title ?? '',
      collections: (s.collections ?? []).map((x) => x.name),
      // 画幅：渲染层据此选 16:9 / 4:3 模板（实测 37.5% 的来源是 4:3）
      ...(s.video_width ? { video_width: s.video_width, video_height: s.video_height } : {}),
      // 署名（铁律 8）：片尾/简介要列出原作者，不能只给 BV 号
      ...(s.owner_name ? { owner_name: s.owner_name, owner_mid: s.owner_mid } : {}),
      ...(s.alt_difficulty ? { alt_difficulty: s.alt_difficulty } : {}),
    }));
    if (sources.length) {
      chart.video = { sources: [...(chart.video?.sources ?? []), ...sources] };
    }
    if (!chart.level && c.level) chart.level = c.level;

    attached++;
  }

  // ---- 第 3 步：填充曲绘 + 感知哈希 ----
  let jacketFilled = 0;
  const stillMissing: SongEntry[] = [];
  for (const song of catalog.values()) {
    if (fillJacket(song, jackets)) jacketFilled++;
    else stillMissing.push(song);
  }

  // ---- 3b.（可选）为缺图曲目生成 song_id 映射**建议**，供人工确认 ----
  let suggestions: Record<string, string> | null = null;
  if (CFG.suggestAliases && jackets) {
    const taken = new Set([...catalog.keys()]);
    const orphans = [...jackets.ids].filter((j) => !taken.has(j) && !j.includes('_'));
    suggestions = {};
    const detail: AliasSuggestion[] = [];
    for (const song of stillMissing) {
      const derived = deriveSongId(song.title_norm);
      const scored = orphans
        .map((j) => ({ j, s: diceSimilarity(derived, j) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 3);
      if (!scored.length || scored[0].s < 0.5) continue;
      const margin = scored[0].s - (scored[1]?.s ?? 0);
      suggestions[song.title_norm] = scored[0].j;
      detail.push({
        title: song.title_en,
        title_norm: song.title_norm,
        derived,
        suggested: scored[0].j,
        score: Number(scored[0].s.toFixed(3)),
        margin: Number(margin.toFixed(3)),
        alternatives: scored.slice(1).map((x) => `${x.j}(${x.s.toFixed(2)})`),
      });
    }
    // 输出成带下划线前缀的注释键，加载时会被忽略 —— 必须人工确认后才手动挪进 map
    const outObj = {
      _readme: [
        '人工 song_id 映射表：title_norm → 官方 song_id。',
        '用于推导不出来的命名改写，例如：',
        '  "aleph-0": "alephzero",        // 数字→单词',
        '  "alone & lorn": "aloneandlorn" // & → and',
        '',
        '本文件由 --suggest-aliases 生成的是**建议**，键名带下划线前缀，加载时被忽略。',
        '确认无误后，把条目从 _suggestions 挪到 map 里。',
      ],
      map: {},
      _suggestions: detail,
    };
    await fs.writeFile(
      path.resolve(CFG.aliases ?? 'data/song-id-aliases.json'),
      JSON.stringify(outObj, null, 2) + '\n',
      'utf8'
    );
  }

  // ---- 第 4 步：归一化输出 ----
  const songs = [...catalog.values()].map((s) => ({
    ...s,
    charts: s.charts
      .map((c) => ({
        ...c,
        ...(c.constant_candidates && Object.keys(c.constant_candidates).length > 1
          ? { constant_candidates: c.constant_candidates }
          : {}),
      }))
      .sort(
        (a, b) =>
          DIFFICULTY_CLASS_ORDER.indexOf(a.difficulty) - DIFFICULTY_CLASS_ORDER.indexOf(b.difficulty)
      ),
  }));
  songs.sort((a, b) => (a.title_norm < b.title_norm ? -1 : a.title_norm > b.title_norm ? 1 : 0));

  const allCharts = songs.flatMap((s) => s.charts);
  const conflicts = allCharts.filter(
    (c) => c.constant_candidates && new Set(Object.values(c.constant_candidates)).size > 1
  );

  const out: CatalogOutFile = {
    schema_version: 1,
    game: 'arcaea',
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-catalog.ts',
    difficulty_class_order: DIFFICULTY_CLASS_ORDER,
    constant_priority: CONSTANT_PRIORITY,
    notes: [
      '这是应用唯一需要读取的曲目目录文件。',
      'match_keys 已预计算好（曲名/日文名/song_id/别名），应用侧做一次 Map 查找即可完成 OCR 纠错。',
      'constant_candidates 保留全部来源的定数值，constant 是按 constant_priority 选出的推荐值。',
      'song_id_source=derived 表示该曲不在上游曲库中，song_id 由曲名推导，需与游戏真实 ID 核对。',
      'jacket/phash 尚未填充，需后续的曲绘构建步骤（见 docs/设计文档.md §4）。',
      '上游曲库停留在 2023 年，定数可能未反映后续调整。',
    ],
    provenance: {
      song_db: { file: CFG.songDb, generated_at: songDb.generated_at, songs: songDb.songs.length },
      video_index: {
        file: CFG.index,
        generated_at: index.generated_at,
        charts: index.charts.length,
        source_mid: index.source?.mid,
      },
    },
    stats: {
      songs: songs.length,
      songs_official: songs.filter((s) => s.song_id_source === 'official').length,
      songs_derived: songs.filter((s) => s.song_id_source === 'derived').length,
      songs_with_alias: songs.filter((s) => s.aliases.length).length,
      charts: allCharts.length,
      charts_with_constant: allCharts.filter((c) => c.constant != null).length,
      charts_with_note: allCharts.filter((c) => c.note != null).length,
      charts_with_video: allCharts.filter((c) => c.video?.sources?.length).length,
      chart_video_sources: allCharts.reduce((n, c) => n + (c.video?.sources?.length ?? 0), 0),
      charts_multi_source: allCharts.filter((c) => (c.video?.sources?.length ?? 0) > 1).length,
      charts_constant_conflict: conflicts.length,
      index_charts_attached: attached,
      songs_created_from_index: createdSongs,
      charts_created_from_index: createdCharts,
      derived_id_collisions: collision,
      derived_id_aligned_to_jacket: alignedToJacket,
      index_charts_skipped_no_id: skippedNoId,
      jackets_loaded: !!jackets,
      songs_with_jacket: jacketFilled,
      songs_with_phash: songs.filter((s) => s.phash).length,
      /** 有专属曲绘的难度数（Beyond 谱面经常有自己的图） */
      charts_with_own_jacket: songs.reduce(
        (n, s) => n + s.charts.filter((c) => c.jacket).length,
        0
      ),
      unresolved_from_index: (index.unparsed ?? []).length,
      elapsed_sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    },
    songs,
    // 索引里无法归入任何曲目的条目，原样带过来，不丢弃
    unresolved: (index.unparsed ?? []).map((u) => ({
      bvid: u.bvid,
      p: u.p,
      part_title: u.part_title,
      video_title: u.video_title,
      collection: u.collection,
      reason: u.reason,
    })),
  };

  await fs.mkdir(path.dirname(path.resolve(CFG.out)), { recursive: true });
  await fs.writeFile(path.resolve(CFG.out), JSON.stringify(out, null, 2) + '\n', 'utf8');

  // ---- 报表 ----
  const s = out.stats;
  log('');
  log('══════════════ 目录合并完成 ══════════════');
  log(`  输出          ${path.resolve(CFG.out)}`);
  log(`  曲目          ${s.songs} 首（official ${s.songs_official} / derived ${s.songs_derived}）`);
  log(`  谱面          ${s.charts} 个`);
  log(`     有定数      ${s.charts_with_constant}`);
  log(`     有物量      ${s.charts_with_note}   ← OCR 判定数守恒校验要用`);
  log(`     有视频      ${s.charts_with_video}  (来源共 ${s.chart_video_sources} 条，其中 ${s.charts_multi_source} 个谱面有多来源)`);
  log(`  从索引新建     ${s.songs_created_from_index} 首曲 / ${s.charts_created_from_index} 个谱面`);
  log(`  推导 ID 撞车   ${s.derived_id_collisions}`);
  if (s.jackets_loaded) {
    log(`  🖼  曲绘         ${s.songs_with_jacket}/${s.songs} 首有图（${s.songs_with_phash} 首带感知哈希｜${s.charts_with_own_jacket} 个难度有专属图）`);
    log(`      ID 校正     ${s.derived_id_aligned_to_jacket} 个推导 ID 被曲绘表校正为官方 ID`);
  } else {
    log(`  ⚠️  未加载曲绘（--no-jackets 或文件缺失）`);
  }
  log(`  ⚠️  定数分歧    ${s.charts_constant_conflict}   ← 多来源给出不同值，已保留候选`);
  log(`  未归类条目     ${s.unresolved_from_index}   ← 原样带在 unresolved 字段`);
  log(`  耗时          ${s.elapsed_sec}s`);
  log('══════════════════════════════════════════');
  log('');
  log('  📌 应用运行时只需读这一个文件。');
}

/** 来源名来自 JSON，可能是 lib 未列出的历史值 —— 未知来源一律排在最后 */
function sourcePriority(src: string): number {
  return CONSTANT_PRIORITY[src as ConstantSource] ?? 99;
}

function pickConstant(cands: ConstantCandidates): number | null {
  const keys = Object.keys(cands).sort((a, b) => sourcePriority(a) - sourcePriority(b));
  if (!keys.length) return null;
  return cands[keys[0] as ConstantSource] ?? null;
}

function pickConstantSource(cands: ConstantCandidates): ConstantSource | null {
  const keys = Object.keys(cands).sort((a, b) => sourcePriority(a) - sourcePriority(b));
  return keys.length ? (keys[0] as ConstantSource) : null;
}

/** 同一数值只保留优先级最高的那个来源，减少无意义的候选堆积 */
function dedupeCandidates(cands: ConstantCandidates): ConstantCandidates {
  const byValue = new Map<number, string>();
  for (const [src, val] of Object.entries(cands)) {
    if (val == null) continue;
    const prev = byValue.get(val);
    if (!prev || sourcePriority(src) < sourcePriority(prev)) {
      byValue.set(val, src);
    }
  }
  const out: ConstantCandidates = {};
  for (const [val, src] of byValue) out[src as ConstantSource] = val;
  return out;
}

function dedupe(arr: Array<string | null | undefined>): string[] {
  return [...new Set(arr.filter((x): x is string => !!x))];
}

/**
 * ⚠️ 只在「被直接执行」时跑 main，被 import 时不跑。
 *
 * 为什么：本文件导出了 normalizeTitle / looseKey / deriveSongId，
 * 其它脚本要复用它们以保证 join 口径一致。但没有这道守卫时，
 * `import './build-catalog.ts'` 会把**整个合并流程重跑一遍** ——
 * 表现是你只想借一个函数，却看到满屏"目录合并完成"的输出。
 *
 * 顺带：argv 的解析也挪进来了（见上面 CFG 的注释）。
 */
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  CFG = parseArgs(process.argv);
  main().catch((e: unknown) => {
    // 保留原始输出：Error 打 stack，其它值原样打印
    console.error('✗ 合并失败：', e instanceof Error ? e.stack || e : e);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * build-arcaea-index.ts —— 从 B站 UP 主的「谱面保管室」合集构建 Arcaea 谱面视频索引
 * ============================================================================
 *
 * 用途
 *   把 UP 主发布的谱面确认视频，变成一份机器可读的索引：
 *       (曲名, 难度) → { bvid, 分P页码, 时长, 来源 }
 *   供视频生成器在「素材获取」阶段查表使用（替代实时搜索，见 docs/设计文档.md §2 决策 7）。
 *
 * 为什么不用 B站 官方投稿列表接口
 *   `x/space/wbi/arc/search` 即使带上**完整正确的 WBI 签名**（img_key/sub_key 提取
 *   + 64 位 mixin 表重排 + wts 时间戳 + md5 得 w_rid），依然返回 `code=-352 风控校验失败`
 *   —— 它还需要 cookie。而目标 UP 把所有内容都组织进了「合集 / 系列」，
 *   下面这几个接口**免签名即可用**，够用了。别去跟风控较劲。
 *
 * 实测可用的接口
 *   ✅ x/polymer/web-space/seasons_series_list   列出全部合集与系列（含预览 archives）
 *   ✅ x/polymer/web-space/seasons_archives_list 列出某合集的分页视频
 *   ✅ x/series/archives                         列出某系列的分页视频
 *   ✅ x/web-interface/view?bvid=                取 pages[]（**分P标题 + 时长**）
 *   ❌ x/space/wbi/arc/search                    风控 -352，放弃
 *
 * 两种内容形态（都要处理）
 *   ① 汇编视频（多P）：一条视频覆盖整个难度档，每个分P是一首曲
 *        分P标题形如  `(11.2) Fracture Ray [FTR 11]`   ← 含**精确定数**
 *   ② 单曲视频（单P）：一条视频一首曲
 *        视频/分P标题形如 `【Arcaea谱面保管室】Lilly [FTR 9+] 谱面确认`
 *
 * ⚠️ 关键：`pages[].part` 才是权威标题，`view.title` 是视频标题，两者会不一致
 *    实例 BV1oi4C6DExx：视频标题 `[INS 12]`，分P标题 `[FTR 11]` → **一律以 part 为准**
 *
 * 用法
 *   node scripts/build-arcaea-index.ts
 *   node scripts/build-arcaea-index.ts --mid 441390256 -o data/arcaea-index.json
 *   node scripts/build-arcaea-index.ts --refresh          # 忽略缓存，重新拉取
 *   node scripts/build-arcaea-index.ts --delay 600        # 请求间隔（毫秒）
 *
 * 依赖：Node.js >= 18（内置 fetch）。零第三方依赖。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { Difficulty, IndexFile, IndexVideoSource } from './lib/types.ts';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DIFFICULTIES: Difficulty[] = ['PST', 'PRS', 'FTR', 'BYD', 'ETR', 'INS'];
const MANUAL_SOURCE_FILE = 'scripts/manual-video-sources.json';

/**
 * 自动生成的分P标题，形如 `Akasha-20260829-065532`。
 * UP 主直接上传原始录像、没改分P名时会这样，标题里**没有任何曲目信息**，
 * 只能靠人工补，不能当成解析失败静默丢掉。
 */
const AUTO_PART_TITLE_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{1,24}-\d{8}-\d{6}$/;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface CliArgs {
  mid: string;
  out: string;
  songDb: string | null;
  cacheDir: string;
  delay: number;
  retries: number;
  refresh: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mid: '441390256',
    out: 'data/arcaea-index.json',
    songDb: 'data/arcaea-songdb.json',
    cacheDir: '.cache/arcaea-index',
    delay: 350,
    retries: 3,
    refresh: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mid') args.mid = String(next());
    else if (a === '-o' || a === '--out') args.out = next();
    else if (a === '--song-db') args.songDb = next();
    else if (a === '--no-song-db') args.songDb = null;
    else if (a === '--cache-dir') args.cacheDir = next();
    else if (a === '--delay') args.delay = Number(next());
    else if (a === '--retries') args.retries = Number(next());
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        '用法: node scripts/build-arcaea-index.ts [--mid <UID>] [-o <输出>] ' +
          '[--song-db <曲库>|--no-song-db] [--refresh] [--delay <ms>]'
      );
      process.exit(0);
    }
  }
  return args;
}

const CFG = parseArgs(process.argv);
const log = (...a: unknown[]): void => {
  if (!CFG.quiet) console.log(...a);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP：带缓存 + 重试 + 限速
// ---------------------------------------------------------------------------

let lastRequestAt = 0;

/** B站 各接口共有的响应外壳 */
interface BiliEnvelope {
  code?: number;
  message?: string;
}

function cacheKeyFor(url: string): string {
  // 只保留 pathname + 关键 query，避免 mid/时间戳之类导致缓存碎片化
  return url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180);
}

async function readCache(url: string): Promise<unknown> {
  if (CFG.refresh) return null;
  try {
    const p = path.join(CFG.cacheDir, cacheKeyFor(url) + '.json');
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(url: string, data: unknown): Promise<void> {
  try {
    await fs.mkdir(CFG.cacheDir, { recursive: true });
    const p = path.join(CFG.cacheDir, cacheKeyFor(url) + '.json');
    await fs.writeFile(p, JSON.stringify(data));
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

async function getJson<T extends BiliEnvelope>(
  url: string,
  referer = 'https://space.bilibili.com/'
): Promise<T> {
  const cached = await readCache(url);
  // 缓存键就是 URL，形状与本次请求一致
  if (cached) return cached as T;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= CFG.retries; attempt++) {
    // 简单限速：两次请求之间至少间隔 CFG.delay
    const wait = CFG.delay - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Referer: referer,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;
      if (json && typeof json.code === 'number' && json.code !== 0) {
        throw new Error(`API code=${json.code} msg=${json.message}`);
      }
      await writeCache(url, json);
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < CFG.retries) await sleep(800 * attempt);
    }
  }
  throw new Error(`请求失败 ${url}\n  ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

// ---------------------------------------------------------------------------
// 标题解析 —— 本脚本的核心
// ---------------------------------------------------------------------------

/**
 * 归一化曲名，用于生成索引键。
 * Arcaea 曲名混排拉丁/日文/中文/符号，必须归一化才能对齐。
 */
export function normalizeTitle(s: string): string {
  return String(s)
    .normalize('NFKC') // 全角→半角、兼容字符统一
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 去变音符号：Anökumene → Anokumene
    .replace(/[\u2018\u2019\u02BC]/g, "'") // 各种撇号 → ASCII
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-') // 各种连字符 → ASCII
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 判断一个 `[...]` 分组是不是"标签"（而非曲名的一部分）。
 * ⚠️ 这一步必须保守：Arcaea 里存在曲名**本身带方括号**的歌，
 *    例如 `[X]`、`AI[UE]OON` —— 无脑剥掉所有方括号会把它们吃没。
 */
// 难度代号后面不能紧跟另一个字母（排除 INSANE 这类误匹配），
// 但**允许紧跟数字** —— 实测存在 `[ETR8+]` 这种「难度+等级」无空格的写法。
const TAG_DIFF_RE = /^(PST|PRS|FTR|BYD|ETR|INS)(?![A-Za-z])\s*(.*)$/i;
const TAG_UNKNOWN_RE = /^\?+$/; // ??? / ?
const TAG_PATH_RE = /^Path\s+[IVXL]+$/i; // Path III / Path VI

function isTagLike(inner: string): boolean {
  const s = String(inner).trim();
  if (!s) return false;
  return TAG_DIFF_RE.test(s) || TAG_UNKNOWN_RE.test(s) || TAG_PATH_RE.test(s);
}

/** parseChartTitle 的字段集合；ok、difficulty 与 reason 的不变量由下面的联合类型表达 */
interface ParsedTitleFields {
  constant: number | null;
  title: string;
  level: string | null;
  extras: string[];
  prefix: string | null;
}

/**
 * 解析结果。ok=true 时 difficulty 必非空、ok=false 时 reason 必有值 ——
 * parseChartTitle 正是按这个顺序判定的，写进类型后调用点不必再断言。
 */
export type ParsedTitle = ParsedTitleFields &
  (
    | { ok: true; difficulty: Difficulty }
    | { ok: false; difficulty: Difficulty | null; reason: string }
  );

/**
 * 解析一条标题，返回曲目信息。
 *
 * 已实测的形态（都要能处理）：
 *   (10.0) Alexandrite [FTR 10]                                  ← 汇编视频分P，含定数
 *   【Arcaea谱面保管室】Lilly [FTR 9+] 谱面确认                    ← 单曲视频，标准型
 *   【Arcaea谱面保管室/7.0解锁挑战】un [ETR] [Path III] 谱面确认     ← 有难度无等级 + 额外标签
 *   【Arcaea谱面保管室/7.0解锁挑战】DREAD AREA [???] [Path III] 谱面确认 ← 定数未知
 *   【Arcaea谱面保管室/7.0 谱面演出】DEINOS PHAINEIN [INS 12] 谱面演出  ← "演出"而非"确认"
 *   【Arcaea谱面保管室】Future 10 谱面确认                          ← 容器标题（不是曲目）
 *   【Arcaea谱面保管室】[X] [FTR 10] 谱面确认                       ← 曲名本身带方括号！
 *
 * 策略：**从右往左，只吃掉"像标签的"方括号**，遇到不像标签的就停下 ——
 * 剩下的整体就是曲名。这样 `[X]`、`AI[UE]OON` 这类曲名不会被误伤。
 */
export function parseChartTitle(raw: string): ParsedTitle {
  const out: ParsedTitleFields & { ok: boolean; difficulty: Difficulty | null; reason?: string } = {
    ok: false,
    constant: null,
    title: '',
    difficulty: null,
    level: null,
    extras: [],
    prefix: null,
  };
  if (typeof raw !== 'string' || !raw.trim()) {
    out.reason = 'empty';
    return out as ParsedTitle;
  }

  let s = raw.normalize('NFKC').trim();

  // 1) 去掉开头的【...】前缀（内部可能用 / 分隔多个标签）
  const pm = s.match(/^【([^】]*)】\s*/);
  if (pm) {
    out.prefix = pm[1];
    s = s.slice(pm[0].length);
  }

  // 2) 去掉结尾的「谱面确认 / 谱面演出 / 谱面预览 / 谱面展示」
  s = s.replace(/\s*谱面(?:确认|演出|预览|展示)\s*$/, '').trim();

  // 3) 从右往左吃掉像标签的方括号，遇到不像的就停
  const tags: string[] = [];
  for (;;) {
    const m = s.match(/\[([^\]]*)\]\s*$/);
    if (!m || !isTagLike(m[1])) break;
    tags.unshift(m[1].trim());
    s = s.slice(0, m.index).trim();
  }
  for (const t of tags) {
    const dm = t.match(TAG_DIFF_RE);
    if (dm && out.difficulty === null) {
      out.difficulty = dm[1].toUpperCase() as Difficulty; // TAG_DIFF_RE 已限定取值，断言安全
      const lv = (dm[2] || '').trim();
      if (lv) out.level = lv;
    } else {
      out.extras.push(t); // [???] / [?] / [Path III] 等
    }
  }

  // 4) 开头的 "(11.2) " 精确定数（汇编视频的分P标题独有）
  const cm = s.match(/^\((\d+(?:\.\d+)?)\)\s*/);
  if (cm) {
    out.constant = Number(cm[1]);
    s = s.slice(cm[0].length);
  }

  out.title = s.replace(/\s+/g, ' ').trim();

  if (!out.title) {
    out.reason = 'no_title';
    return out as ParsedTitle;
  }
  if (!out.difficulty) {
    // 「Future 10 谱面确认」这类容器标题会走到这里，属于正常情况
    out.reason = 'no_difficulty';
    return out as ParsedTitle;
  }
  out.ok = true;
  return out as ParsedTitle;
}

export function chartKeyOf(titleNorm: string, difficulty: Difficulty): string {
  return `${titleNorm}|${difficulty}`;
}

// ---------------------------------------------------------------------------
// 曲库关联：把索引里的「曲名」挂到 song_id 上
// ---------------------------------------------------------------------------

/**
 * 宽松键：去掉全部标点与空白，只留字母/数字/假名/汉字。
 * 作为最后一级兜底匹配 —— 视频标题里的标点常与官方写法有出入，
 * 例如 `Altair (feat.*spiLa*)` vs `Altair (feat. *spiLa*)`、`G e n g a o z o`。
 */
export function looseKey(s: string): string {
  return normalizeTitle(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * data/arcaea-songdb.json —— build-song-db.ts 的产出。
 * lib/types.ts 只覆盖「曲库 → 目录」之后的形状，没有这一层，所以在消费端就地声明。
 */
interface SongDbDifficulty {
  class: string;
  level: string | null;
  constant: number | null;
}

interface SongDbSong {
  song_id: string;
  title_en: string;
  title_norm: string;
  alias_norm: string[];
  match_keys: string[];
  difficulties: SongDbDifficulty[];
}

interface SongDbFile {
  songs: SongDbSong[];
  freshness_warning?: string;
}

interface SongDbIndex {
  db: SongDbFile;
  byTitle: Map<string, SongDbSong>;
  byAlias: Map<string, SongDbSong>;
  bySongId: Map<string, SongDbSong>;
  /** 值为 null 表示该宽松键有歧义（多首曲共用），匹配时自然跳过 */
  byLoose: Map<string, SongDbSong | null>;
}

/**
 * 载入曲库（由 build-song-db.ts 产出），建立若干查找表。
 * 曲库不存在时返回 null —— 索引仍可构建，只是没有 song_id。
 */
async function loadSongDb(file: string | null): Promise<SongDbIndex | null> {
  if (!file) return null;
  let db: SongDbFile;
  try {
    db = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')) as SongDbFile;
  } catch {
    return null;
  }
  const byTitle = new Map<string, SongDbSong>(); // title_norm -> song
  const byAlias = new Map<string, SongDbSong>(); // alias_norm -> song
  const bySongId = new Map<string, SongDbSong>(); // song_id_norm -> song
  const byLoose = new Map<string, SongDbSong | null>(); // looseKey -> song（歧义键直接丢弃）

  const putLoose = (k: string, song: SongDbSong): void => {
    if (!k) return;
    if (byLoose.has(k) && byLoose.get(k) !== song) byLoose.set(k, null); // 标为歧义
    else byLoose.set(k, song);
  };

  for (const song of db.songs ?? []) {
    if (song.title_norm) byTitle.set(song.title_norm, song);
    if (song.song_id) bySongId.set(normalizeTitle(song.song_id), song);
    for (const a of song.alias_norm ?? []) if (a && !byAlias.has(a)) byAlias.set(a, song);
    for (const k of song.match_keys ?? [song.title_norm]) putLoose(looseKey(k), song);
  }
  return { db, byTitle, byAlias, bySongId, byLoose };
}

/** 依次尝试：显示曲名 → 别名 → song_id → 宽松键 */
function matchSong(
  songDb: SongDbIndex | null,
  titleNorm: string
): { song: SongDbSong; via: string } | null {
  if (!songDb) return null;
  const byTitle = songDb.byTitle.get(titleNorm);
  if (byTitle) return { song: byTitle, via: 'title_en' };
  const byAlias = songDb.byAlias.get(titleNorm);
  if (byAlias) return { song: byAlias, via: 'alias' };
  const byId = songDb.bySongId.get(titleNorm);
  if (byId) return { song: byId, via: 'song_id' };
  const byLoose = songDb.byLoose.get(looseKey(titleNorm));
  if (byLoose) return { song: byLoose, via: 'loose' }; // 歧义键存的是 null，不会命中
  return null;
}

// ---------------------------------------------------------------------------
// B站 接口封装
// ---------------------------------------------------------------------------

/** 合集/系列列表内联的预览视频；分页接口的 archives 条目同形 */
interface BiliArchive {
  bvid?: string;
  title?: string;
  duration?: number;
  ctime?: number;
}

interface BiliSeasonEntry {
  meta?: { season_id?: number | string; name?: string; total?: number; ptotal?: number };
  archives?: BiliArchive[];
}

interface BiliSeriesEntry {
  meta?: { series_id?: number | string; name?: string; total?: number };
  archives?: BiliArchive[];
}

interface BiliSeasonsSeriesList extends BiliEnvelope {
  data?: {
    items_lists?: {
      seasons_list?: BiliSeasonEntry[];
      series_list?: BiliSeriesEntry[];
    };
  };
}

interface BiliArchivesList extends BiliEnvelope {
  data?: { archives?: BiliArchive[] };
}

interface BiliViewPage {
  page: number;
  part?: string;
  duration?: number;
  /** width/height 是上传者给的原始画幅，rotate 为 90/270 表示竖屏上传 */
  dimension?: { width: number; height: number; rotate?: number };
}

interface BiliView extends BiliEnvelope {
  data?: {
    bvid: string;
    title?: string;
    videos?: number;
    duration?: number;
    /**
     * 上传者。**署名要用**（铁律 8：片尾/简介必须列出原作者 + BV号 + 链接）。
     * 这个接口本来就要调（为了拿 pages[]），所以 owner 是**零额外请求**的。
     * 早些时候漏采了它，导致下游只能拿到 mid、拿不到名字。
     */
    owner?: { mid?: number; name?: string };
    pages?: BiliViewPage[];
  };
}

/** 一个合集或系列 */
interface Collection {
  kind: 'season' | 'series';
  id: string;
  name: string;
  total: number;
  preview: BiliArchive[];
}

/** 来源所属的集合。比 lib/types.ts 的 collections: string[] 细，build-catalog 取 .name */
interface CollectionRef {
  name: string;
  kind: 'season' | 'series';
}

interface ArchiveItem {
  bvid: string;
  title: string;
  duration: number;
  ctime: number;
}

interface VideoRecord extends ArchiveItem {
  collections: CollectionRef[];
}

/** 单个分P；dimension 是**显示尺寸**，调用方负责按 rotate 交换宽高 */
interface VideoPage {
  page: number;
  part: string;
  duration: number;
  dimension: { width: number; height: number; rotate: number } | null;
}

interface VideoInfo {
  bvid: string;
  title: string;
  videos: number;
  duration: number;
  /** 上传者，署名用；上游没给时为 null */
  owner: { mid: number | null; name: string | null };
  pages: VideoPage[];
}

/** 列出该 UP 的全部合集（seasons）与系列（series），含预览 archives */
async function listCollections(mid: string): Promise<Collection[]> {
  const url =
    `https://api.bilibili.com/x/polymer/web-space/seasons_series_list` +
    `?mid=${encodeURIComponent(mid)}&page_num=1&page_size=20&web_location=333.1387`;
  const json = await getJson<BiliSeasonsSeriesList>(url);
  const lists = json?.data?.items_lists ?? {};
  const seasons: Collection[] = (lists.seasons_list ?? []).map((s) => ({
    kind: 'season',
    id: String(s.meta?.season_id ?? ''),
    name: s.meta?.name ?? '',
    total: Number(s.meta?.total ?? s.meta?.ptotal ?? 0) || 0,
    preview: s.archives ?? [],
  }));
  const series: Collection[] = (lists.series_list ?? []).map((s) => ({
    kind: 'series',
    id: String(s.meta?.series_id ?? ''),
    name: s.meta?.name ?? '',
    total: Number(s.meta?.total ?? 0) || 0,
    preview: s.archives ?? [],
  }));
  return [...seasons, ...series].filter((c) => c.id);
}

/** 拉取某个集合的全部分页视频 */
async function listCollectionArchives(mid: string, col: Collection): Promise<ArchiveItem[]> {
  const out: ArchiveItem[] = [];
  const seen = new Set<string>();
  const ps = 30;
  for (let pn = 1; pn <= 20; pn++) {
    const url =
      col.kind === 'season'
        ? `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list` +
          `?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(col.id)}` +
          `&sort_reverse=false&page_num=${pn}&page_size=${ps}&web_location=333.1387`
        : `https://api.bilibili.com/x/series/archives` +
          `?mid=${encodeURIComponent(mid)}&series_id=${encodeURIComponent(col.id)}` +
          `&only_normal=true&sort=desc&pn=${pn}&ps=${ps}`;

    let json: BiliArchivesList | undefined;
    try {
      json = await getJson<BiliArchivesList>(url);
    } catch (e) {
      log(`  ! ${col.name} 第 ${pn} 页失败：${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    const archives = json?.data?.archives ?? [];
    if (!archives.length) break;
    for (const a of archives) {
      if (!a?.bvid || seen.has(a.bvid)) continue;
      seen.add(a.bvid);
      out.push({ bvid: a.bvid, title: a.title ?? '', duration: a.duration ?? 0, ctime: a.ctime ?? 0 });
    }
    if (archives.length < ps) break;
  }

  // 兜底：分页接口拿不到时，用列表接口内联的预览数据
  if (!out.length) {
    for (const a of col.preview ?? []) {
      if (a?.bvid) out.push({ bvid: a.bvid, title: a.title ?? '', duration: a.duration ?? 0, ctime: a.ctime ?? 0 });
    }
  }
  return out;
}

/**
 * 取单个视频的 pages[]（分P标题 + 时长 + **画幅**）。这是权威数据源。
 *
 * ⚠️ 画幅（dimension）为什么必须存：
 *   实测 871 个视频来源里 **37.5% 是 4:3**（1920×1440 / 2732×2048 / 3840×2880），
 *   按谱面算有 **321/645（49.8%）根本没有 16:9 的来源**。
 *   成片的视频窗口是 16:9，4:3 的片子塞进去会被裁掉 25% 高度 ——
 *   所以渲染层必须**在不开下载的前提下**就知道每个来源是什么画幅，才能选对模板。
 *   view 接口本来就返回这个字段，顺手存下来，零额外请求。
 *   rotate 为 90/270 表示竖屏上传，显示宽高要交换。
 */
async function getVideoPages(bvid: string): Promise<VideoInfo | null> {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const json = await getJson<BiliView>(url, 'https://www.bilibili.com/');
  const d = json?.data;
  if (!d) return null;
  return {
    bvid: d.bvid,
    title: d.title ?? '',
    videos: d.videos ?? 0,
    duration: d.duration ?? 0,
    // 署名信息：接口本来就要调，顺手存下来，零额外请求
    owner: { mid: d.owner?.mid ?? null, name: d.owner?.name ?? null },
    pages: (d.pages ?? []).map((p) => ({
      page: p.page, // 注意：从 1 开始，URL 的 ?p=N 与之一致
      part: p.part ?? '',
      duration: p.duration ?? 0,
      dimension: p.dimension?.width
        ? { width: p.dimension.width, height: p.dimension.height, rotate: p.dimension.rotate ?? 0 }
        : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 索引层的视频来源。复用 lib/types.ts 的 IndexVideoSource，只把 collections 收紧成
 * 实际写入的 `{ name, kind }` 数组（契约文件那里写的是 string[]，与产物不符）。
 */
interface IndexSourceOut extends Omit<IndexVideoSource, 'collections'> {
  collections: CollectionRef[];
}

/**
 * 索引层的谱面条目。
 * ⚠️ 与 lib/types.ts 的 IndexChart 有出入：那份契约的 constant_source 取的是
 *    'wiki'|'songdb'|'video'|'derived'，没有 constant_conflict，song_id 还写成必填。
 *    而 build-catalog 实际按下面这套消费（见其 `constant_source === 'song_db'` 判断）。
 */
interface IndexChartOut {
  chart_key: string;
  title: string;
  title_norm: string;
  difficulty: Difficulty;
  level: string | null;
  constant: number | null;
  constant_source: 'video_title' | 'song_db' | null;
  /** 同为视频标题来源、定数值却不一致时的全部取值，交人工裁决 */
  constant_conflict?: number[];
  song_id?: string;
  song_match_via?: string;
  sources: IndexSourceOut[];
}

interface ManualVideoSource {
  song_id: string;
  difficulty: Difficulty;
  bvid: string;
  p: number;
}

/** unparsed 条目 —— 契约见 lib/types.ts 的 IndexFile.unparsed，本脚本多记几个定位字段 */
type UnparsedEntry = IndexFile['unparsed'][number] & {
  collection?: string;
  extracted_title?: string;
  extras?: string[];
};

async function main() {
  const t0 = Date.now();
  log(`▶ 构建 Arcaea 谱面索引  mid=${CFG.mid}`);

  // 0) 曲库（可选）
  const songDb = await loadSongDb(CFG.songDb);
  let manualCount = 0;
  if (songDb) {
    log(`  曲库：${songDb.db.songs.length} 首（别名 ${songDb.byAlias.size} 条）  ← ${CFG.songDb}`);
    if (songDb.db.freshness_warning) {
      log(`  ⚠️  ${songDb.db.freshness_warning.slice(0, 60)}…`);
    }
  } else if (CFG.songDb) {
    log(`  曲库：未找到 ${CFG.songDb}，索引将不含 song_id（先跑 build-song-db.ts）`);
  }

  // 1) 集合列表
  const cols = await listCollections(CFG.mid);
  log(`  集合：${cols.length} 个（合集 ${cols.filter((c) => c.kind === 'season').length} / 系列 ${cols.filter((c) => c.kind === 'series').length}）`);

  // 2) 逐集合取视频
  const videos: VideoRecord[] = []; // { bvid, title, collection, collectionKind }
  const seenBvid = new Map<string, VideoRecord>();
  for (const col of cols) {
    const items = await listCollectionArchives(CFG.mid, col);
    log(`  · [${col.kind}] ${col.name} — ${items.length} 条视频`);
    for (const it of items) {
      const prev = seenBvid.get(it.bvid);
      if (prev) {
        // 同一视频可能同时属于合集与系列，记录多个归属
        prev.collections.push({ name: col.name, kind: col.kind });
        continue;
      }
      const rec: VideoRecord = {
        ...it,
        collections: [{ name: col.name, kind: col.kind }],
      };
      seenBvid.set(it.bvid, rec);
      videos.push(rec);
    }
  }
  log(`  去重后视频数：${videos.length}`);

  // 3) 逐视频取 pages[] 并解析
  const chartMap = new Map<string, IndexChartOut>(); // chart_key -> chart
  const unparsed: UnparsedEntry[] = [];
  let pageCount = 0;

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!CFG.quiet && (i % 10 === 0 || i === videos.length - 1)) {
      log(`  解析中 ${i + 1}/${videos.length}  ${v.bvid}`);
    }
    let info: VideoInfo | null;
    try {
      info = await getVideoPages(v.bvid);
    } catch (e) {
      unparsed.push({
        bvid: v.bvid,
        p: null,
        part_title: '',
        video_title: v.title,
        reason: 'fetch_failed',
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (!info?.pages?.length) {
      unparsed.push({ bvid: v.bvid, p: null, part_title: '', video_title: v.title, reason: 'no_pages' });
      continue;
    }

    // 视频标题解析结果，用于与分P标题交叉校验（两者会不一致）
    const fromVideoTitle = parseChartTitle(info.title);

    for (const p of info.pages) {
      pageCount++;
      // ⚠️ 以分P标题为准；分P标题为空时才退回视频标题
      const rawTitle = p.part?.trim() ? p.part : v.title;

      // UP 主没改分P名 → 标题里没有曲目信息，单独归类
      if (AUTO_PART_TITLE_RE.test(rawTitle.trim())) {
        unparsed.push({
          bvid: v.bvid,
          p: p.page,
          part_title: p.part,
          video_title: info.title,
          collection: v.collections[0]?.name ?? '',
          reason: 'auto_part_title',
        });
        continue;
      }

      const parsed = parseChartTitle(rawTitle);

      if (!parsed.ok) {
        unparsed.push({
          bvid: v.bvid,
          p: p.page,
          part_title: p.part,
          video_title: info.title,
          collection: v.collections[0]?.name ?? '',
          reason: parsed.reason,
          extracted_title: parsed.title,
          extras: parsed.extras,
        });
        continue;
      }

      const titleNorm = normalizeTitle(parsed.title);
      const key = chartKeyOf(titleNorm, parsed.difficulty);

      // 关联曲库：拿到 song_id，并从曲库回填「视频标题里没给」的定数/等级
      const hit = matchSong(songDb, titleNorm);
      const dbDiff = hit?.song.difficulties.find((d) => d.class === parsed.difficulty) ?? null;
      const constantFromDb = dbDiff?.constant ?? null;
      const levelFromDb = dbDiff?.level ?? null;

      // 分P标题与视频标题的难度不一致时记录下来，交人工裁决
      // （实测 BV1oi4C6DExx：视频标题 [INS 12]，分P标题 [FTR 11]）
      const altDifficulty =
        fromVideoTitle.ok && fromVideoTitle.difficulty !== parsed.difficulty
          ? { difficulty: fromVideoTitle.difficulty, level: fromVideoTitle.level, constant: fromVideoTitle.constant }
          : null;

      const source: IndexSourceOut = {
        bvid: v.bvid,
        p: p.page, // 1-based，与 ?p=N 一致
        part_title: p.part,
        duration_sec: p.duration || 0,
        video_title: info.title,
        video_pages: info.videos,
        collections: v.collections,
        url: `https://www.bilibili.com/video/${v.bvid}?p=${p.page}`,
        // ⚠️ 画幅决定渲染层选哪套模板（16:9 / 4:3），见 getVideoPages 的注释。
        //    存的是**显示尺寸**（rotate 为 90/270 时交换宽高），渲染层不用再判断。
        ...(p.dimension
          ? {
            video_width: p.dimension.rotate % 180 === 0 ? p.dimension.width : p.dimension.height,
            video_height: p.dimension.rotate % 180 === 0 ? p.dimension.height : p.dimension.width,
          }
          : {}),
        // 署名（铁律 8）：片尾/简介要列出原作者。上游没给就不写，**不要伪造**。
        ...(info.owner.name
          ? { owner_name: info.owner.name, owner_mid: info.owner.mid ?? undefined }
          : {}),
        ...(altDifficulty ? { alt_difficulty: altDifficulty } : {}),
      };

      const existing = chartMap.get(key);
      if (existing) {
        // 同一谱面来自多个来源：全部保留（抗单点失效，见 docs/设计文档.md 铁律 7）
        existing.sources.push(source);
        // 定数只需在**同为视频标题来源**之间比冲突。
        // 曲库值与视频标题值的差异是预期的（汇编视频多为 2022–2023 年发布，
        // 其定数是发布当时的，之后经历过调整），不算冲突。
        if (parsed.constant != null) {
          if (existing.constant == null) {
            existing.constant = parsed.constant;
            existing.constant_source = 'video_title';
          } else if (
            existing.constant_source === 'video_title' &&
            Math.abs(existing.constant - parsed.constant) > 1e-9
          ) {
            existing.constant_conflict = existing.constant_conflict ?? [existing.constant];
            existing.constant_conflict.push(parsed.constant);
          }
        }
        if (!existing.level && parsed.level) existing.level = parsed.level;
        if (!existing.title) existing.title = parsed.title;
      } else {
        // 定数优先级：分P标题里的 "(11.2)"（发布当时的值） > 曲库值
        chartMap.set(key, {
          chart_key: key,
          title: parsed.title,
          title_norm: titleNorm,
          difficulty: parsed.difficulty,
          level: parsed.level ?? levelFromDb,
          constant: parsed.constant ?? constantFromDb,
          constant_source: parsed.constant != null ? 'video_title' : constantFromDb != null ? 'song_db' : null,
          ...(hit ? { song_id: hit.song.song_id, song_match_via: hit.via } : {}),
          sources: [source],
        });
      }
    }
  }

  // 人工确认的谱面用官方 song_id 定位，避免别名曲名和泛用分P标题误配。
  if (songDb) {
    const manual = JSON.parse(await fs.readFile(path.resolve(MANUAL_SOURCE_FILE), 'utf8')) as ManualVideoSource[];
    if (!Array.isArray(manual)) throw new Error(`${MANUAL_SOURCE_FILE} 必须是数组`);
    const seenManual = new Set<string>();
    for (const item of manual) {
      const ref = `${item.bvid}?p=${item.p}`;
      if (!/^BV[0-9A-Za-z]{10}$/.test(item.bvid) || !Number.isInteger(item.p) || item.p < 1 || seenManual.has(ref)) {
        throw new Error(`人工来源无效或重复：${ref}`);
      }
      seenManual.add(ref);
      const song = songDb.bySongId.get(normalizeTitle(item.song_id));
      const diff = song?.difficulties.find((d) => d.class === item.difficulty);
      if (!song || !diff) throw new Error(`人工来源未命中曲库谱面：${item.song_id}/${item.difficulty}`);
      const info = await getVideoPages(item.bvid);
      const page = info?.pages.find((p) => p.page === item.p);
      if (!info || !page || page.duration < 10 || !info.owner.name) {
        throw new Error(`人工来源缺少有效分P或署名：${ref}`);
      }
      const key = chartKeyOf(song.title_norm, item.difficulty);
      const source: IndexSourceOut = {
        bvid: item.bvid,
        p: item.p,
        url: `https://www.bilibili.com/video/${ref}`,
        duration_sec: page.duration,
        part_title: page.part,
        video_title: info.title,
        video_pages: info.videos,
        collections: [],
        owner_name: info.owner.name,
        ...(info.owner.mid != null ? { owner_mid: info.owner.mid } : {}),
        ...(page.dimension ? {
          video_width: page.dimension.rotate % 180 === 0 ? page.dimension.width : page.dimension.height,
          video_height: page.dimension.rotate % 180 === 0 ? page.dimension.height : page.dimension.width,
        } : {}),
      };
      const existing = chartMap.get(key);
      if (existing) {
        if (!existing.sources.some((s) => s.bvid === item.bvid && s.p === item.p)) existing.sources.push(source);
      } else {
        chartMap.set(key, {
          chart_key: key,
          title: song.title_en,
          title_norm: song.title_norm,
          difficulty: item.difficulty,
          level: diff.level,
          constant: diff.constant,
          constant_source: diff.constant == null ? null : 'song_db',
          song_id: song.song_id,
          song_match_via: 'manual',
          sources: [source],
        });
      }
    }
    manualCount = manual.length;
    log(`  人工来源：${manualCount} 条`);
  }

  // 4) 汇总
  const charts = [...chartMap.values()].sort((a, b) => {
    if (a.title_norm !== b.title_norm) return a.title_norm < b.title_norm ? -1 : 1;
    return DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty);
  });

  const difficultyHistogram: Record<string, number> = {};
  for (const c of charts) difficultyHistogram[c.difficulty] = (difficultyHistogram[c.difficulty] ?? 0) + 1;

  const out = {
    schema_version: 1,
    game: 'arcaea',
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-arcaea-index.ts',
    source: {
      platform: 'bilibili',
      mid: CFG.mid,
      manual_sources_file: songDb ? MANUAL_SOURCE_FILE : null,
      collections: cols.map((c) => ({
        kind: c.kind,
        id: c.id,
        name: c.name,
        videos: videos.filter((v) => v.collections.some((x) => x.name === c.name)).length,
      })),
    },
    stats: {
      collections: cols.length,
      manual_sources: manualCount,
      videos: videos.length,
      pages: pageCount,
      charts: charts.length,
      unique_titles: new Set(charts.map((c) => c.title_norm)).size,
      charts_with_constant: charts.filter((c) => c.constant != null).length,
      constant_from_video: charts.filter((c) => c.constant_source === 'video_title').length,
      constant_from_songdb: charts.filter((c) => c.constant_source === 'song_db').length,
      charts_multi_source: charts.filter((c) => c.sources.length > 1).length,
      charts_constant_conflict: charts.filter((c) => c.constant_conflict).length,
      sources_alt_difficulty: charts.reduce(
        (n, c) => n + c.sources.filter((s) => s.alt_difficulty).length,
        0
      ),
      // 曲库关联结果 —— 这才是真实的覆盖率
      songdb_loaded: !!songDb,
      charts_matched_songdb: charts.filter((c) => c.song_id).length,
      songs_matched_songdb: new Set(charts.filter((c) => c.song_id).map((c) => c.song_id)).size,
      songs_total_songdb: songDb ? songDb.db.songs.length : 0,
      song_match_via: charts
        .filter((c): c is IndexChartOut & { song_match_via: string } => !!c.song_match_via)
        .reduce<Record<string, number>>(
          (m, c) => ((m[c.song_match_via] = (m[c.song_match_via] ?? 0) + 1), m),
          {}
        ),
      unparsed: unparsed.length,
      difficulty_histogram: difficultyHistogram,
      elapsed_sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    },
    charts,
    unparsed,
  };

  // 5) 落盘
  await fs.mkdir(path.dirname(path.resolve(CFG.out)), { recursive: true });
  await fs.writeFile(path.resolve(CFG.out), JSON.stringify(out, null, 2) + '\n', 'utf8');

  // 6) 报表
  const s = out.stats;
  log('');
  log('══════════════ 构建完成 ══════════════');
  log(`  输出          ${path.resolve(CFG.out)}`);
  log(`  集合 / 视频   ${s.collections} / ${s.videos}`);
  log(`  分P总数       ${s.pages}`);
  log(`  ✅ 解析成功    ${s.charts} 个「曲名×难度」条目 / ${s.unique_titles} 首唯一曲目`);
  log(`     带精确定数  ${s.charts_with_constant}（标题 ${s.constant_from_video} + 曲库回填 ${s.constant_from_songdb}）`);
  log(`     多来源      ${s.charts_multi_source}   ← 抗单点失效`);
  if (s.songdb_loaded) {
    const cov = s.songs_total_songdb ? ((s.songs_matched_songdb / s.songs_total_songdb) * 100).toFixed(1) : '0';
    log(`  🎯 曲库关联    ${s.charts_matched_songdb}/${s.charts} 条目命中 song_id`);
    log(`     曲目覆盖    ${s.songs_matched_songdb}/${s.songs_total_songdb} 首  (${cov}%)`);
    const unmatched = s.unique_titles - s.songs_matched_songdb;
    if (unmatched > 0) log(`     ⚠️ 未关联    ${unmatched} 首 —— 多为曲库未收录的新曲，也可能是曲名写法差异`);
  } else {
    log(`  ⚠️  未关联曲库（--no-song-db 或曲库缺失）`);
  }
  log(`  ⚠️  定数冲突    ${s.charts_constant_conflict}   ← 不同来源给出不同定数，需裁决`);
  log(`  ⚠️  难度存疑    ${s.sources_alt_difficulty}   ← 分P标题与视频标题的难度不一致`);
  log(`  ⚠️  解析失败    ${s.unparsed}`);
  log(`  难度分布      ${Object.entries(difficultyHistogram).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  log(`  耗时          ${s.elapsed_sec}s`);
  if (unparsed.length) {
    const byReason: Record<string, number> = {};
    for (const u of unparsed) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
    log(`  失败原因      ${Object.entries(byReason).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    log('  （no_difficulty 多为容器标题属正常；auto_part_title 需人工补曲名；详见 unparsed 字段）');
  }
  log('══════════════════════════════════════');
}

// 入口判断必须过 pathToFileURL：
//   ① Windows 下 import.meta.url 是三斜杠的 `file:///D:/.../x.ts`，而 `file://${argv[1]}`
//      拼出来的是 `file://D:\...`（反斜杠、两斜杠），两者永不相等；
//   ② 改名后 `.endsWith('build-arcaea-index.ts')` 这个兜底也一起失效，
//      结果是 main() 永不执行、脚本静默什么都不做（退出码还是 0）。
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

/** 解析器回归用例 —— 跑 `--self-test` 触发。新增标题变体时请同步补充。 */
export const PARSER_CASES: Array<[string, string, Difficulty | null, string | null]> = [
  // [输入, 期望曲名, 期望难度, 期望等级]
  ['(10.0) Alexandrite [FTR 10]', 'Alexandrite', 'FTR', '10'],
  ['(11.2) Fracture Ray [FTR 11]', 'Fracture Ray', 'FTR', '11'],
  ['【Arcaea谱面保管室】Lilly [FTR 9+] 谱面确认', 'Lilly', 'FTR', '9+'],
  ['【Arcaea谱面保管室/7.0解锁挑战】un [ETR] [Path III] 谱面确认', 'un', 'ETR', null],
  ['【Arcaea谱面保管室/7.0 谱面演出】DEINOS PHAINEIN [INS 12] 谱面演出', 'DEINOS PHAINEIN', 'INS', '12'],
  ['【Arcaea谱面保管室】Suomi [ETR8+] 谱面确认', 'Suomi', 'ETR', '8+'], // 难度与等级之间无空格
  ['【Arcaea谱面保管室】[X] [FTR 10] 谱面确认', '[X]', 'FTR', '10'], // 曲名本身带方括号
  ['【Arcaea谱面保管室】AI[UE]OON [FTR 10] 谱面确认', 'AI[UE]OON', 'FTR', '10'], // 曲名内嵌方括号
  ['【Arcaea谱面保管室/2025愚人节】Live Faster Yonger [?] 谱面确认', 'Live Faster Yonger', null, null],
  ['【Arcaea谱面保管室】Future 10 谱面确认', 'Future 10', null, null], // 容器标题，非曲目
];

function selfTest() {
  let pass = 0;
  for (const [raw, t, d, l] of PARSER_CASES) {
    const r = parseChartTitle(raw);
    const ok = r.title === t && r.difficulty === d && r.level === l;
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(raw)}`);
    if (!ok) {
      console.log(`     期望 title=${JSON.stringify(t)} diff=${d} lv=${l}`);
      console.log(`     实际 title=${JSON.stringify(r.title)} diff=${r.difficulty} lv=${r.level}`);
    }
  }
  console.log(`\n解析器自测：${pass}/${PARSER_CASES.length} 通过`);
  process.exit(pass === PARSER_CASES.length ? 0 : 1);
}

if (isMain && process.argv.includes('--self-test')) {
  selfTest();
} else if (isMain) {
  main().catch((e) => {
    console.error('✗ 构建失败：', e?.stack || e);
    process.exit(1);
  });
}

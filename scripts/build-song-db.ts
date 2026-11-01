#!/usr/bin/env node
/**
 * build-song-db.ts —— 构建 Arcaea 曲库（曲名 / 曲师 / 难度 / 定数 / 物量 / 别名）
 * ============================================================================
 *
 * 主源是 wiki 的 JSON 内容模型页面（游戏原始数据），2023 年的 GitHub 仓库只作补充：
 *
 *   Template:Songlist.json      554 首   曲名·曲师·BPM·曲包·版本·日期·背景·难度等级
 *   Template:ChartConstant.json 552 首   精确定数（小数）
 *   Template:ChartNotes.json    554 首   物量
 *   Template:SongDuration.json  553 首   曲目时长
 *
 *   arcsong.json（GitHub）              补充：中文别名 alias、set_friendly 显示名
 *   ChartConstant.json（GitHub）        交叉校验（2023-05，会跟 wiki 有分歧）
 *
 * ⚠️ arcsong / GitHub ChartConstant 拉不到时不致命 —— 它们只是补充与校验，
 *    wiki 那四份才是权威。拉不到会在 sources[] 里标 unavailable。
 *
 * 用法
 *   node scripts/build-song-db.ts
 *   node scripts/build-song-db.ts -o data/arcaea-songdb.json --refresh
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { WikiClient } from './lib/wiki.ts';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 难度类别。wiki 用 `ratingClass` 数字索引这个数组。 */
const DIFFICULTY_CLASSES = ['PST', 'PRS', 'FTR', 'BYD', 'ETR', 'INS'];

export function difficultyClass(ratingClass: number, ratingClassAlias?: number): string {
  // INS 沿用 BYD 的定数槽位，别名只改变展示难度。
  if (ratingClassAlias !== undefined) {
    if (ratingClass === 3 && ratingClassAlias === 1) return 'INS';
    throw new Error(`未知难度别名：ratingClass=${ratingClass}, ratingClassAlias=${ratingClassAlias}`);
  }
  return DIFFICULTY_CLASSES[ratingClass] ?? `UNKNOWN_${ratingClass}`;
}

/** wiki 页面 → 本地缓存名。缓存目录沿用既有的 .cache/wiki（可安全删除）。 */
const WIKI_PAGES = {
  songlist: { cache: 'songlist.json', title: 'Template:Songlist.json' },
  constant: { cache: 'chartconstant.json', title: 'Template:ChartConstant.json' },
  notes: { cache: 'chartnotes.json', title: 'Template:ChartNotes.json' },
  duration: { cache: 'songduration.json', title: 'Template:SongDuration.json' },
} as const;

const GITHUB_SOURCES = {
  arcsong: {
    label: 'arcsong.json',
    repo: 'Arcaea-Infinity/ArcaeaSongDatabase',
    file: 'arcsong.json',
    branch: 'main',
  },
  constants: {
    label: 'ChartConstant.json',
    repo: 'zh-arc-wiki-re-wg/chart-constant',
    file: 'ChartConstant.json',
    branch: 'main',
  },
} as const;

type SourceKey = keyof typeof GITHUB_SOURCES;

/** GitHub 镜像。裸 raw.githubusercontent.com 在部分网络环境不可达，镜像优先。 */
const MIRRORS: Array<(repo: string, branch: string, file: string) => string> = [
  (repo, branch, file) => `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
  (repo, branch, file) => `https://ghfast.top/https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
  (repo, branch, file) => `https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
];

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// 上游 JSON 的最小建模（外部数据，只标注真正读取的字段）
// ---------------------------------------------------------------------------

interface SonglistDifficulty {
  ratingClass?: number;
  ratingClassAlias?: number;
  rating?: number;
  /** true 表示该难度是 "+" 档（如 7+ / 10+） */
  ratingPlus?: boolean;
  chartDesigner?: string;
  jacketDesigner?: string;
  /** 该难度用了独立的曲绘（磁盘上是 <song_id>_<难度>.jpg） */
  jacketOverride?: boolean;
  /** 该难度有独立曲名，如 Last 的 BYD 叫 "Last | Moment" */
  title_localized?: { en?: string; ja?: string };
  /** 该难度有独立背景 */
  bg?: string;
}

interface SonglistEntry {
  id?: string;
  title_localized?: { en?: string; ja?: string };
  artist?: string;
  bpm?: string;
  bpm_base?: number;
  set?: string;
  side?: number;
  bg?: string;
  bg_inverse?: string;
  remote_dl?: boolean;
  date?: number;
  version?: string;
  difficulties?: SonglistDifficulty[];
  /** 该曲已从游戏内移除（实测 1 首 particlearts） */
  deleted?: boolean;
}

interface SonglistFile {
  songs?: SonglistEntry[];
}

/** Template:ChartConstant.json：[song_id] → 按 ratingClass 索引的难度槽位 */
type ConstantSlots = Array<{ constant?: number; old?: boolean } | null>;

/** Template:ChartNotes.json：[song_id] → 按 ratingClass 索引的物量 */
type NoteSlots = Array<number | null>;

/** Template:SongDuration.json：{ normal: {id: "mm:ss"}, beyond: {...} } */
interface DurationFile {
  normal?: Record<string, string>;
  beyond?: Record<string, string>;
}

/** arcsong.json 的难度条目（曲级字段被复制在每个难度上，取第 0 个） */
interface ArcsongDifficulty {
  name_en?: string;
  name_jp?: string;
  artist?: string;
  bpm?: string;
  bpm_base?: number;
  set?: string;
  set_friendly?: string;
  side?: number;
  date?: number;
  time?: number;
  difficulty?: number;
  rating?: number;
  note?: number;
}

interface ArcsongSong {
  song_id?: string;
  difficulties?: ArcsongDifficulty[];
  alias?: string[];
}

interface CliArgs {
  out: string;
  cacheDir: string;
  wikiCacheDir: string;
  refresh: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: 'data/arcaea-songdb.json',
    cacheDir: '.cache/arcaea-songdb',
    wikiCacheDir: '.cache/wiki',
    refresh: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--cache-dir') args.cacheDir = argv[++i];
    else if (a === '--wiki-cache-dir') args.wikiCacheDir = argv[++i];
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/build-song-db.ts [-o <输出>] [--refresh] [--quiet]');
      process.exit(0);
    }
  }
  return args;
}

const CFG = parseArgs(process.argv);
const log = (...a: unknown[]) => {
  if (!CFG.quiet) console.log(...a);
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 与 build-arcaea-index.ts 保持完全一致的归一化，否则两边 join 不上 */
export function normalizeTitle(s: string): string {
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

/**
 * 等级代号 = 等级×2（"+" 档 +1）。保留它是为了能反查，以及与旧产物对齐。
 *   10 → "5"    15 → "7+"    21 → "10+"    22 → "11"
 */
export function levelFromCode(code: unknown): string | null {
  if (typeof code !== 'number' || Number.isNaN(code)) return null;
  const lv = code / 2;
  return Number.isInteger(lv) ? String(lv) : `${Math.floor(lv)}+`;
}

/** wiki 的等级是 `rating` + `ratingPlus` 两个字段，合成展示用标签。 */
function levelLabel(rating: unknown, plus: unknown): string | null {
  if (typeof rating !== 'number') return null;
  return `${rating}${plus === true ? '+' : ''}`;
}

function levelCode(rating: unknown, plus: unknown): number | null {
  if (typeof rating !== 'number') return null;
  return rating * 2 + (plus === true ? 1 : 0);
}

/** "02:28" → 148 */
function parseDuration(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d+):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function readCache(name: string): Promise<unknown> {
  if (CFG.refresh) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(CFG.cacheDir, name + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(name: string, data: unknown): Promise<void> {
  try {
    await ensureDir(CFG.cacheDir);
    await fs.writeFile(path.join(CFG.cacheDir, name + '.json'), JSON.stringify(data));
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/** 拉一个 GitHub 上的 JSON。失败返回 null —— 它们只是补充源，不该拖垮整轮。 */
async function fetchGithub(fileKey: SourceKey): Promise<{ data: unknown; via: string } | null> {
  const cached = await readCache(fileKey);
  if (cached) {
    log(`  ${fileKey}: 命中缓存`);
    return { data: cached, via: 'cache' };
  }

  const src = GITHUB_SOURCES[fileKey];
  const branches = fileKey === 'constants' ? [src.branch, 'master'] : [src.branch];
  const errors: string[] = [];

  for (const branch of branches) {
    for (const mk of MIRRORS) {
      const url = mk(src.repo, branch, src.file);
      const via = new URL(url).host;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json, */*' },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const data = JSON.parse(text);
        await writeCache(fileKey, data);
        log(`  ${fileKey}: ${via} (${(text.length / 1024).toFixed(0)} KB)`);
        return { data, via: `${via}@${branch}` };
      } catch (e) {
        errors.push(`${via}@${branch}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  log(`  ⚠️ ${fileKey} 拉取失败（已试 ${errors.length} 个镜像），将跳过该补充源`);
  return null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  log('▶ 构建 Arcaea 曲库（主源：wiki）');

  const wiki = new WikiClient({
    cacheDir: CFG.wikiCacheDir,
    refresh: CFG.refresh,
    log,
  });

  // ---- ① wiki 四份权威数据 ----
  const sl = await wiki.page<SonglistFile>(WIKI_PAGES.songlist.cache, WIKI_PAGES.songlist.title);
  const cc = await wiki.page<Record<string, ConstantSlots>>(
    WIKI_PAGES.constant.cache,
    WIKI_PAGES.constant.title
  );
  const notes = await wiki.page<Record<string, NoteSlots>>(
    WIKI_PAGES.notes.cache,
    WIKI_PAGES.notes.title
  );
  const dur = await wiki.page<DurationFile>(WIKI_PAGES.duration.cache, WIKI_PAGES.duration.title);

  const songlist = sl.data.songs ?? [];
  if (!songlist.length) throw new Error('Songlist 为空 —— 检查页面标题或 contentmodel');
  log(
    `① wiki  Songlist ${songlist.length} 首${sl.hit ? '（缓存）' : ''}` +
      `｜定数 ${Object.keys(cc.data).length}｜物量 ${Object.keys(notes.data).length}` +
      `｜时长 ${Object.keys(dur.data.normal ?? {}).length}`
  );

  // ---- ② GitHub 补充源（可选）----
  const arcRaw = await fetchGithub('arcsong');
  const ghCcRaw = await fetchGithub('constants');

  const arcsongSongs: ArcsongSong[] = (() => {
    if (!arcRaw) return [];
    const d = arcRaw.data;
    if (Array.isArray(d)) return d as ArcsongSong[];
    const s = (d as { songs?: ArcsongSong[] }).songs;
    return Array.isArray(s) ? s : [];
  })();
  const ghCc = (ghCcRaw?.data ?? {}) as Record<string, ConstantSlots>;

  // set → 显示名。wiki 没有这个字段，只能从 arcsong 取。
  const setFriendly = new Map<string, string>();
  const aliasById = new Map<string, string[]>();
  for (const s of arcsongSongs) {
    const head = s.difficulties?.[0];
    if (head?.set && head.set_friendly && !setFriendly.has(head.set)) {
      setFriendly.set(head.set, head.set_friendly);
    }
    if (s.song_id && Array.isArray(s.alias) && s.alias.length) {
      aliasById.set(s.song_id, s.alias.filter(Boolean));
    }
  }
  log(
    `② 补充  arcsong ${arcsongSongs.length} 首 → set_friendly ${setFriendly.size} 条` +
      `｜别名 ${aliasById.size} 首｜GitHub 定数表 ${Object.keys(ghCc).length}`
  );

  // ---- ③ 合并 ----
  const songs = [];
  let chartsWithConstant = 0;
  let chartsWithNote = 0;
  let timeSecFilled = 0;
  let setFriendlyFilled = 0;
  let constantMismatch = 0;
  let jacketOverride = 0;
  let altTitle = 0;
  let altTitleSongs = 0;
  const missingSetFriendly = new Set<string>();
  /** 进不了曲库的条目。没有这一项就只能靠猜"为什么 554 变成了 553"。 */
  const skipped: Array<{ id: string | null; title: string | null; reason: string }> = [];

  const normalDur = dur.data.normal ?? {};
  const beyondDur = dur.data.beyond ?? {};

  for (const e of songlist) {
    const songId = e.id;
    if (!songId) {
      skipped.push({ id: null, title: e.title_localized?.en ?? null, reason: 'no_id' });
      continue;
    }

    const diffsRaw = Array.isArray(e.difficulties) ? e.difficulties : [];
    if (!diffsRaw.length) {
      // ⚠️ 不要静默跳过。实测 particlearts 带 deleted:true 且没有 difficulties。
      skipped.push({
        id: songId,
        title: e.title_localized?.en ?? null,
        reason: e.deleted ? 'deleted' : 'no_difficulties',
      });
      continue;
    }

    const titleEn = e.title_localized?.en || songId;
    const titleJp = e.title_localized?.ja || '';

    // 别名 = 社区别名（arcsong）+ **别名难度名**（wiki 的 difficulties[].title_localized）。
    // ⚠️ 后者必须进 alias：索引里有视频标题写的是 "Last | Moment" 而不是 "Last"，
    //    不并进来就会解析出一首独立的假曲目（实测因此多出 3 首幻影条目）。
    const altTitles = diffsRaw
      .map((d) => d.title_localized?.en || d.title_localized?.ja || '')
      .filter(Boolean);
    if (altTitles.length) altTitleSongs++;
    const alias = [...new Set([...(aliasById.get(songId) ?? []), ...altTitles])];

    const set = e.set ?? '';
    const friendly = setFriendly.get(set) ?? '';
    if (friendly) setFriendlyFilled++;
    else if (set) missingSetFriendly.add(set);

    const timeSec = parseDuration(normalDur[songId]) ?? parseDuration(beyondDur[songId]);
    if (timeSec != null) timeSecFilled++;

    const ccSlots = cc.data[songId];
    const noteSlots = notes.data[songId];
    const ghSlots = ghCc[songId];

    const difficulties = diffsRaw.map((d, idx) => {
      // ⚠️ 定数/物量数组按 **ratingClass** 索引，不是按 difficulties 的数组下标。
      //    实测 110 首歌有 ETR 没 BYD（rc = 0,1,2,4），用下标会把 ETR 的值读错位。
      const rc = d.ratingClass ?? idx;
      const cls = difficultyClass(rc, d.ratingClassAlias);

      // 精确定数：wiki 页面是权威，GitHub 那份只作交叉校验
      const ccSlot = ccSlots?.[rc] ?? null;
      const ghSlot = ghSlots?.[rc] ?? null;
      const constant = ccSlot && typeof ccSlot.constant === 'number' ? ccSlot.constant : null;
      const constantRepo = ghSlot && typeof ghSlot.constant === 'number' ? ghSlot.constant : null;
      const mismatch =
        constant != null && constantRepo != null && Math.abs(constant - constantRepo) > 1e-9;
      if (mismatch) constantMismatch++;

      const noteRaw = noteSlots?.[rc];
      const note = typeof noteRaw === 'number' ? noteRaw : null;
      if (note != null) chartsWithNote++;
      if (constant != null) chartsWithConstant++;
      if (d.jacketOverride) jacketOverride++;
      const alt = d.title_localized?.en || d.title_localized?.ja || '';
      if (alt) altTitle++;

      return {
        class: cls,
        level: levelLabel(d.rating, d.ratingPlus),
        level_code: levelCode(d.rating, d.ratingPlus),
        constant,
        ...(constantRepo != null ? { constant_repo: constantRepo } : {}),
        ...(mismatch ? { constant_mismatch: true } : {}),
        note,
        chart_designer: d.chartDesigner ?? '',
        jacket_designer: d.jacketDesigner ?? '',
        version: e.version ?? '',
        ...(d.jacketOverride ? { jacket_override: true } : {}),
        ...(alt ? { alt_title: alt } : {}),
      };
    });

    // 用于 join 的归一化键集合：英文名 / 日文名 / song_id 本身 / 全部别名
    const matchKeys = [
      ...new Set([titleEn, titleJp, songId, ...alias].filter(Boolean).map(normalizeTitle)),
    ].filter(Boolean);

    songs.push({
      song_id: songId,
      title_en: titleEn,
      title_jp: titleJp,
      title_norm: normalizeTitle(titleEn),
      alias,
      alias_norm: alias.map(normalizeTitle),
      match_keys: matchKeys,
      artist: e.artist ?? '',
      bpm: e.bpm_base ?? (e.bpm ? Number(e.bpm) : null),
      set,
      set_friendly: friendly,
      side: e.side ?? null,
      version: e.version ?? '',
      date: e.date ?? null,
      time_sec: timeSec,
      remote_download: e.remote_dl ?? false,
      // bg / bg_inverse 是游戏原始数据，权威。应用读的是 arcaea-backgrounds.json。
      bg: e.bg ?? '',
      bg_inverse: e.bg_inverse ?? '',
      difficulties,
    });
  }

  // ---- ④ 输出 ----
  const out = {
    schema_version: 1,
    game: 'arcaea',
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-song-db.ts',
    difficulty_class_order: DIFFICULTY_CLASSES,
    sources: [
      { name: 'Template:Songlist.json', page: WIKI_PAGES.songlist.title, fetched_via: sl.hit ? 'cache' : 'wiki', songs: songlist.length },
      { name: 'Template:ChartConstant.json', page: WIKI_PAGES.constant.title, fetched_via: cc.hit ? 'cache' : 'wiki', songs: Object.keys(cc.data).length },
      { name: 'Template:ChartNotes.json', page: WIKI_PAGES.notes.title, fetched_via: notes.hit ? 'cache' : 'wiki', songs: Object.keys(notes.data).length },
      { name: 'Template:SongDuration.json', page: WIKI_PAGES.duration.title, fetched_via: dur.hit ? 'cache' : 'wiki' },
      { name: GITHUB_SOURCES.arcsong.label, repo: GITHUB_SOURCES.arcsong.repo, fetched_via: arcRaw?.via ?? 'unavailable', songs: arcsongSongs.length },
      { name: GITHUB_SOURCES.constants.label, repo: GITHUB_SOURCES.constants.repo, fetched_via: ghCcRaw?.via ?? 'unavailable' },
    ],
    stats: {
      songs: songs.length,
      songs_with_alias: songs.filter((s) => s.alias.length).length,
      charts: songs.reduce((n, s) => n + s.difficulties.length, 0),
      charts_with_constant: chartsWithConstant,
      charts_with_note: chartsWithNote,
      songs_with_time_sec: timeSecFilled,
      songs_with_set_friendly: setFriendlyFilled,
      set_friendly_missing: [...missingSetFriendly].sort(),
      jacket_override_charts: jacketOverride,
      alt_title_charts: altTitle,
      alt_title_songs: altTitleSongs,
      constant_mismatch_vs_repo: constantMismatch,
      class_histogram: songs
        .flatMap((s) => s.difficulties.map((d) => d.class))
        .reduce<Record<string, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {}),
      elapsed_sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    },
    skipped,
    songs,
  };

  await ensureDir(path.dirname(path.resolve(CFG.out)));
  await fs.writeFile(path.resolve(CFG.out), JSON.stringify(out, null, 2) + '\n', 'utf8');

  // ---- 报表 ----
  const s = out.stats;
  log('');
  log('══════════════ 曲库构建完成 ══════════════');
  log(`  输出          ${path.resolve(CFG.out)}`);
  log(`  曲目          ${s.songs} 首（${s.songs_with_alias} 首带别名）`);
  log(`  谱面          ${s.charts} 个（定数 ${s.charts_with_constant}｜物量 ${s.charts_with_note}）`);
  log(`  难度分布      ${Object.entries(s.class_histogram).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  log(`  时长覆盖      ${s.songs_with_time_sec} / ${s.songs}`);
  log(`  曲包显示名    ${s.songs_with_set_friendly} / ${s.songs}（缺 ${s.set_friendly_missing.length} 个曲包）`);
  log(`  独立曲绘难度  ${s.jacket_override_charts} 个｜别名难度 ${s.alt_title_charts} 个`);
  log(`  定数交叉校验  ${s.constant_mismatch_vs_repo} 个谱面与 GitHub 旧表不一致（wiki 为准）`);
  log(`  耗时          ${s.elapsed_sec}s`);
  if (s.set_friendly_missing.length) {
    log(`  ⚠️  缺显示名的曲包：${s.set_friendly_missing.join(', ')}`);
  }
  log('══════════════════════════════════════════');
}

// ⚠️ 必须用 pathToFileURL 比较。`import.meta.url === \`file://${argv[1]}\`` 在 Windows 上恒为 false
//    （三斜杠 vs 两斜杠），会让 isMain 恒 false、main() 永不执行、脚本静默退出 0。
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error('✗ 构建失败：', e?.stack || e);
    process.exit(1);
  });
}

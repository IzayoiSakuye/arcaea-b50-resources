#!/usr/bin/env node
/**
 * build-jackets.ts —— 抓取 Arcaea 曲绘，并生成感知哈希索引
 * ============================================================================
 *
 * ⭐ 曲绘来源：Arcaea 中文维基（wiki.arcaea.cn），文件命名规律是
 *
 *       Songs_<song_id>.jpg
 *
 *   例：Songs_aegleseeker.jpg / Songs_aiueoon.jpg（曲名是 AI[UE]OON）/ Songs_abstrusedilemma.jpg
 *   —— <song_id> 与 Arcaea 官方 ID 同构，正好等于 build-arcaea-index.ts 里
 *      deriveSongId() 推导出来的形式，所以能直接 join 上曲目目录。
 *
 *   实测规模：625 张，原生 768×768，合计 174.8MB。
 *
 * 为什么需要绕过 Anubis
 *   该站由 [Anubis](https://anubis.techaro.lol/) 保护 —— 一个 Proof-of-Work 反爬门。
 *   **所有路径**（含 /images/ 与 Special:FilePath）都返回挑战页，HTTP 200 是挑战页的
 *   状态码而非数据。过盾细节全部封装在 scripts/lib/anubis-fetch.ts，那里记录了
 *   三个实测踩出来的坑（TLS 指纹 / cookie 往返 / 绝对 redir）。
 *
 * 缩略图
 *   MediaWiki 能按任意宽度实时生成缩略图，无需自己下载原图再缩放：
 *       https://wiki.arcaea.cn/images/thumb/5/5a/Songs_x.jpg/256px-Songs_x.jpg
 *   所以默认只下 256px（约 12MB），768px 原图按需（--sizes full）。
 *
 * 感知哈希
 *   用 ffmpeg 把图解码成 9×8 灰度裸数据，再在 Node 里算
 *   aHash（8×8 均值哈希）与 dHash（9×8 差分哈希），各 64 位。
 *   用途：OCR 管线里**用曲绘指纹识别曲目**，比识别花体曲名可靠得多
 *   （见 docs/设计文档.md §7）。
 *   ⚠️ 哈希不是图像，体积只有 16 字节/张，可以放心内置；高清曲绘不行。
 *
 * 用法
 *   node scripts/build-jackets.ts                      # 只下 256px 缩略图
 *   node scripts/build-jackets.ts --sizes 256,full     # 同时下 768px 原图
 *   node scripts/build-jackets.ts --refresh            # 忽略已下载的文件
 *   node scripts/build-jackets.ts --update-catalog     # 回填 catalog 的 jacket/phash
 *   node scripts/build-jackets.ts --limit 20           # 只处理前 20 张（调试用）
 *
 * 依赖：Node.js >= 18。感知哈希需要 ffmpeg（缺失时自动跳过并警告）。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CookieJar, mwApi, anubisFetch } from './lib/anubis-fetch.ts';
import type { CatalogFile, CatalogSong, CatalogJacket } from './lib/types.ts';

const execFileAsync = promisify(execFile);

const ORIGIN = 'https://wiki.arcaea.cn';
const FILE_PREFIX = 'Songs_';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface Args {
  out: string;
  dir: string;
  cacheDir: string;
  cookieFile: string;
  sizes: string[];
  delay: number;
  refresh: boolean;
  updateCatalog: boolean;
  catalog: string;
  limit: number;
  quiet: boolean;
}

/**
 * mwApi 的返回值是 any（MediaWiki 的松散 JSON，签名见 lib/anubis-fetch.ts）——
 * 这里按实际用到的字段收窄，不让 any 继续往下传染。
 */
interface AllImagesResponse {
  query?: { allimages?: ImageInfo[] };
  continue?: { aicontinue?: string };
}

/** aiprop=url|size|dimensions 返回的图片信息。三个数值字段上游没给时确实会缺，故可选 */
interface ImageInfo {
  name: string;
  url: string;
  width?: number;
  height?: number;
  size?: number;
}

interface JacketLocal {
  thumb256?: string;
  thumb256_error?: string;
  full?: string;
  full_error?: string;
}

/**
 * 构建期的曲绘条目。
 * lib/types.ts 的 JacketEntry 只描述「下载与哈希全成功」的那一种，装不下失败路径的
 * *_error 字段，也装不下「只下了 full」或「没装 ffmpeg」的情形，所以这里如实建模。
 */
interface JacketDraft {
  song_id: string;
  file: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  url: string;
  thumb_url_256: string;
  local: JacketLocal;
  ahash?: string;
  dhash?: string;
  hash_error?: string;
}

/**
 * 回填 catalog 时看到的形态：本脚本历史上写的是 null（而非省略字段），
 * 且「aHash 算出来、dHash 抛错」的半成品哈希也真的可能落盘（截断图），
 * 所以在这两处如实放宽，不去动 lib/types.ts 里描述正常产物的契约。
 */
type CatalogJacketDraft = Omit<CatalogJacket, 'local_256' | 'full_url'> & {
  local_256: string | null;
  full_url: string | null;
};
type CatalogSongDraft = Omit<CatalogSong, 'jacket' | 'phash'> & {
  jacket: CatalogJacketDraft;
  phash: { ahash: string; dhash?: string } | null;
};
type CatalogDraft = Omit<CatalogFile, 'songs'> & { songs: CatalogSongDraft[] };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'data/arcaea-jackets.json',
    dir: 'data/jackets',
    cacheDir: '.cache/jackets',
    cookieFile: '.cache/anubis-cookies.json',
    sizes: ['256'],
    delay: 120,
    refresh: false,
    updateCatalog: false,
    catalog: 'data/arcaea-catalog.json',
    limit: 0,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--sizes') args.sizes = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--update-catalog') args.updateCatalog = true;
    else if (a === '--catalog') args.catalog = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/build-jackets.ts [--sizes 256,full] [--refresh] [--update-catalog] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

const CFG = parseArgs(process.argv);
const log = (...a: unknown[]): void => {
  if (!CFG.quiet) console.log(...a);
};
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/** catch 到的值在 strict 下是 unknown；调用方只要 message，顺手兜住非 Error 抛出物 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 文件名 ↔ song_id
// ---------------------------------------------------------------------------

/** `Songs_aegleseeker.jpg` → `aegleseeker` */
function fileToSongId(name: string): string {
  return name.replace(/^Songs_/, '').replace(/\.(jpg|jpeg|png)$/i, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// ffmpeg 感知哈希
// ---------------------------------------------------------------------------

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 ffmpeg 把图片解码成 width×height 的灰度裸数据。
 * 走临时文件而不是管道 —— 避免不同平台上 stdio 管道的各种坑。
 */
async function grayPixels(file: string, width: number, height: number): Promise<Buffer> {
  const tmp = path.join(CFG.cacheDir, `.gray-${process.pid}-${Date.now()}.raw`);
  try {
    await execFileAsync(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', file, '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'gray', tmp],
      { timeout: 30000 }
    );
    const buf = await fs.readFile(tmp);
    if (buf.length < width * height) throw new Error(`裸数据不足：${buf.length} < ${width * height}`);
    return buf;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** 8×8 均值哈希 → 16 位十六进制 */
async function aHash(file: string): Promise<string> {
  const px = await grayPixels(file, 8, 8);
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += px[i];
  const avg = sum / 64;
  let bits = '';
  for (let i = 0; i < 64; i++) bits += px[i] >= avg ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

/** 9×8 水平差分哈希 → 16 位十六进制 */
async function dHash(file: string): Promise<string> {
  const px = await grayPixels(file, 9, 8);
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
    }
  }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

function thumbUrlFor(info: ImageInfo, width: number): string {
  // 原图 URL 形如 .../images/5/5a/Songs_x.jpg
  // 缩略图     .../images/thumb/5/5a/Songs_x.jpg/256px-Songs_x.jpg
  const u = new URL(info.url);
  const i = u.pathname.indexOf('/images/');
  if (i < 0) return info.url;
  const rel = u.pathname.slice(i + '/images/'.length); // 5/5a/Songs_x.jpg
  const name = rel.split('/').pop();
  return `${u.origin}/images/thumb/${rel}/${width}px-${name}`;
}

async function downloadTo(
  url: string,
  dest: string,
  jar: CookieJar,
  { refresh = false }: { refresh?: boolean } = {}
): Promise<{ skipped: boolean; bytes: number }> {
  if (!refresh) {
    try {
      const st = await fs.stat(dest);
      if (st.size > 0) return { skipped: true, bytes: st.size };
    } catch {
      /* 不存在则下载 */
    }
  }
  const res = await anubisFetch(url, { jar, timeout: 45000 });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  // 兜底：万一又拿到挑战页，说明 cookie 失效
  if (res.headers['content-type']?.includes('text/html')) {
    throw new Error('拿到 HTML 而非图片（cookie 可能已失效）');
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, res.buffer);
  return { skipped: false, bytes: res.buffer.length };
}

// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  log('▶ 抓取 Arcaea 曲绘');
  log(`  来源  ${ORIGIN}  前缀 ${FILE_PREFIX}`);

  await fs.mkdir(CFG.cacheDir, { recursive: true });
  await fs.mkdir(CFG.dir, { recursive: true });

  const hasFfmpeg = await ffmpegAvailable();
  log(`  ffmpeg ${hasFfmpeg ? '可用 → 将计算 aHash/dHash' : '不可用 → 跳过感知哈希'}`);

  const jar = await CookieJar.load(CFG.cookieFile);

  // ---- 1. 列出全部曲绘 ----
  let cont: string | undefined;
  let all: ImageInfo[] = [];
  let pages = 0;
  do {
    const p: Record<string, string> = {
      action: 'query',
      list: 'allimages',
      ailimit: '500',
      aiprefix: FILE_PREFIX,
      aiprop: 'url|size|dimensions',
    };
    if (cont) p.aicontinue = cont;
    const r = (await mwApi(ORIGIN, p, { jar })) as AllImagesResponse;
    all.push(...(r.query?.allimages ?? []));
    cont = r.continue?.aicontinue;
    pages++;
  } while (cont && pages < 40);
  log(`  曲绘 ${all.length} 张（${pages} 页 API）`);

  if (CFG.limit) all = all.slice(0, CFG.limit);

  // ---- 2. 逐张下载 + 哈希 ----
  const wanted = new Set(CFG.sizes);
  const jackets: JacketDraft[] = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  let hashReused = 0;

  // 上一轮产物：文件命中缓存时用它复用感知哈希（下面的哈希那段解释了为什么必须这么做）
  const prevJackets = new Map<string, JacketDraft>();
  try {
    const prev = JSON.parse(await fs.readFile(path.resolve(CFG.out), 'utf8')) as { jackets?: JacketDraft[] };
    for (const j of prev.jackets ?? []) prevJackets.set(j.song_id, j);
  } catch {
    /* 首次运行没有上一轮产物，正常 */
  }

  for (let i = 0; i < all.length; i++) {
    const info = all[i];
    const songId = fileToSongId(info.name);
    const entry: JacketDraft = {
      song_id: songId,
      file: info.name,
      width: info.width ?? null,
      height: info.height ?? null,
      bytes: info.size ?? null,
      url: info.url,
      thumb_url_256: thumbUrlFor(info, 256),
      local: {},
    };

    // 256px 缩略图（默认；用于内置显示）
    let thumbSkipped = false;
    if (wanted.has('256')) {
      const dest = path.join(CFG.dir, '256', `${songId}.jpg`);
      try {
        const r = await downloadTo(entry.thumb_url_256, dest, jar, { refresh: CFG.refresh });
        r.skipped ? skipped++ : downloaded++;
        thumbSkipped = r.skipped;
        totalBytes += r.bytes;
        entry.local.thumb256 = dest.split(path.sep).join('/');
        // ⚠️ 只在实际发过请求之后才限速 —— 命中缓存时没什么好客气的。
        //    无条件 sleep 的话，620 张 × 120ms = 74 秒纯白等（实测过）。
        if (!r.skipped) await sleep(CFG.delay);
      } catch (e) {
        failed++;
        entry.local.thumb256_error = errorText(e);
        await sleep(CFG.delay);
      }
    }

    // 768px 原图（可选；用于高清渲染）
    let fullSkipped = false;
    if (wanted.has('full')) {
      const dest = path.join(CFG.cacheDir, 'full', `${songId}.jpg`);
      try {
        const r = await downloadTo(entry.url, dest, jar, { refresh: CFG.refresh });
        r.skipped ? skipped++ : downloaded++;
        fullSkipped = r.skipped;
        totalBytes += r.bytes;
        entry.local.full = dest.split(path.sep).join('/');
        if (!r.skipped) await sleep(CFG.delay);
      } catch (e) {
        failed++;
        entry.local.full_error = errorText(e);
        await sleep(CFG.delay);
      }
    }

    // ---- 感知哈希 ----
    // ⚠️ 这是整条数据管线里最贵的一步：aHash 与 dHash 各 spawn 一次 ffmpeg，
    //    620 张就是 **1240 个进程、约 160 秒** —— 而哈希对同一个文件是确定值。
    //    所以只要图片文件命中缓存（没重新下载），就直接复用上一轮的哈希。
    //    实测：重复跑从 173s 降到约 13s。
    //    只有「上一轮压根没算出哈希」（缺 ffmpeg / 当时哈希失败）才重算，能自愈。
    const hashSource = entry.local.thumb256 ?? entry.local.full;
    const hashSourceSkipped = entry.local.thumb256 ? thumbSkipped : fullSkipped;
    const prev = prevJackets.get(songId);
    const reusable = !CFG.refresh && hashSourceSkipped && prev?.ahash !== undefined;

    if (reusable && prev) {
      entry.ahash = prev.ahash;
      entry.dhash = prev.dhash;
      hashReused++;
    } else if (hasFfmpeg && hashSource && fsSync.existsSync(hashSource)) {
      try {
        entry.ahash = await aHash(hashSource);
        entry.dhash = await dHash(hashSource);
      } catch (e) {
        entry.hash_error = errorText(e);
      }
    }

    jackets.push(entry);

    if (!CFG.quiet && (i % 50 === 0 || i === all.length - 1)) {
      log(`  ${i + 1}/${all.length}  ${songId}`);
    }
  }

  // ---- 3. 输出 ----
  const out = {
    schema_version: 1,
    game: 'arcaea',
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-jackets.ts',
    source: {
      origin: ORIGIN,
      file_prefix: FILE_PREFIX,
      naming: 'Songs_<song_id>.jpg —— <song_id> 与 Arcaea 官方 ID 同构',
      note: '该站由 Anubis PoW 保护，过盾细节见 scripts/lib/anubis-fetch.ts',
    },
    hash: {
      algorithm: hasFfmpeg ? ['ahash64', 'dhash64'] : [],
      note: '哈希是 16 位十六进制字符串（64 位）。哈希不是图像，可放心内置；高清曲绘不可。',
    },
    stats: {
      jackets: jackets.length,
      downloaded,
      skipped,
      failed,
      hash_reused: hashReused,
      total_mb: Number((totalBytes / 1048576).toFixed(1)),
      with_ahash: jackets.filter((j) => j.ahash).length,
      sizes: CFG.sizes,
      elapsed_sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    },
    jackets,
  };

  await fs.mkdir(path.dirname(path.resolve(CFG.out)), { recursive: true });
  await fs.writeFile(path.resolve(CFG.out), JSON.stringify(out, null, 2) + '\n', 'utf8');

  // ---- 4. 可选：回填曲目目录 ----
  let filled = 0;
  if (CFG.updateCatalog) {
    try {
      const cat = JSON.parse(await fs.readFile(path.resolve(CFG.catalog), 'utf8')) as CatalogDraft;
      const byId = new Map<string, JacketDraft>(jackets.map((j) => [j.song_id, j]));
      for (const song of cat.songs ?? []) {
        const j = byId.get(song.song_id);
        if (!j) continue;
        song.jacket = {
          bundled: !!j.local.thumb256,
          local_256: j.local.thumb256 ?? null,
          full_url: j.url,
          thumb_url_256: j.thumb_url_256,
          source: 'arcwiki',
        };
        song.phash = j.ahash ? { ahash: j.ahash, dhash: j.dhash } : null;
        filled++;
      }
      cat.stats = {
        ...cat.stats,
        songs_with_jacket: (cat.songs ?? []).filter((s) => s.jacket?.bundled).length,
        songs_with_phash: (cat.songs ?? []).filter((s) => s.phash).length,
      };
      cat.generated_at = new Date().toISOString();
      await fs.writeFile(path.resolve(CFG.catalog), JSON.stringify(cat, null, 2) + '\n', 'utf8');
    } catch (e) {
      log(`  ⚠️  回填曲目目录失败：${errorText(e)}`);
    }
  }

  const s = out.stats;
  log('');
  log('══════════════ 曲绘抓取完成 ══════════════');
  log(`  输出          ${path.resolve(CFG.out)}`);
  log(`  曲绘          ${s.jackets} 张`);
  log(`  新下载/跳过    ${s.downloaded} / ${s.skipped}    失败 ${s.failed}`);
  log(`  体积          ${s.total_mb} MB  (${CFG.sizes.join(', ')})`);
  log(`  感知哈希      ${s.with_ahash} 张有 aHash/dHash`);
  if (CFG.updateCatalog) log(`  回填曲目目录  ${filled} 首`);
  log(`  耗时          ${s.elapsed_sec}s`);
  log('══════════════════════════════════════════');
  if (!hasFfmpeg) {
    log('');
    log('  ⚠️  未检测到 ffmpeg，感知哈希被跳过。装上 ffmpeg 后重跑即可补齐。');
  }
}

main().catch((e: unknown) => {
  console.error('✗ 抓取失败：', e instanceof Error ? e.stack : e);
  process.exit(1);
});

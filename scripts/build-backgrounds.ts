#!/usr/bin/env node
/**
 * build-backgrounds.ts —— 构建 Arcaea「曲目 → 游玩背景图」映射并抓取背景图
 * ============================================================================
 *
 * 为什么需要它
 *   成片的底图要**按曲目替换**（每首歌在游戏里对应一张背景美术）。
 *   而 catalog 现有的 `bg` 字段**不可信**：
 *     · 198 首 2023 年后的新曲，`bg` 100% 等于 `song_id` —— 构建时抄进去的占位值
 *     · 38 首 v1.x 老曲干脆没有
 *     · 即便有值的也漏掉了「曲包级背景」（base_light / eden_light 这类）
 *
 * ⭐ 数据来源：wiki 的 `Template:Songlist.json`（JSON 内容模型页面，实测可取）
 *   它是**游戏原始数据的结构化投影**，直接带 `bg` / `bg_inverse` / `side`：
 *
 *      side: 0（光芒侧）→ bg 是 light 系   bg_inverse 是 conflict 系
 *      side: 1（纷争侧）→ bg 是 conflict 系 bg_inverse 是 light 系
 *
 *    **`bg` 永远是这首歌该用的那张**，没有歧义，不需要猜。
 *
 * 🕳 曾经绕过的弯路（留作记录，别再走）
 *   最初是用 `Category:采用<bg>背景的曲目` 反查（175 次请求），覆盖率 97.7%，
 *   还会撞上「一首歌落在多个背景分类里」的假冲突 —— 实测那是分类粒度不够造成的
 *   （分类只到曲目、分不出 Light/Conflict 两面），拿 `Songlist.bg` 一对就全对上了：
 *     bethere  分类猜 single2_light  → 实际 base_light
 *     dropdead 分类猜 byd_conflict   → 实际 base_conflict
 *   所以「多背景优先级规则」那套机制整个删掉了 —— **能查到事实就不要猜**。
 *
 * ⚠️ 原生分辨率是 1920×1440（4:3），不是 16:9
 *   成片恒定 16:9，所以按「等比覆盖 → 居中裁切」处理（`--aspect`，默认 16:9）。
 *   裁剪放在构建期是因为它确定；源图缓存在 .cache，换裁法重跑不用重新联网。
 *
 * 🕳 坑：960px 这类「非标准档位」的缩略图会 404（实测 63/145 失败，且是确定性的）
 *   该站可用的宽度只有标准档位：**240 / 300 / 600 / 800 / 1280 / 1600**；
 *   360 / 480 / 720 / 960 / 1080 一律 404（返回的是 34KB 的 MediaWiki HTML 错误页，
 *   体积很像正常内容，容易误判 —— 所以必须校验 JPEG 魔数，不能只看状态码）。
 *   但原图永远 200。
 *   对策：**从标准档位下源图 → 本地 ffmpeg 缩放到目标尺寸**。
 *   额外收益：源图缓存后，以后想换输出宽度**不用重新联网**。
 *
 * 用法
 *   node scripts/build-backgrounds.ts --coverage        # 只量覆盖率，不下载
 *   node scripts/build-backgrounds.ts                   # 产出 960px / 16:9（默认）
 *   node scripts/build-backgrounds.ts --sizes 960,1280  # 多档
 *   node scripts/build-backgrounds.ts --no-crop         # 保留 4:3 原比例
 *   node scripts/build-backgrounds.ts --refresh         # 忽略缓存重新拉
 *   node scripts/build-backgrounds.ts --delay 600       # 请求间隔（毫秒）
 *
 * 依赖：Node.js >= 18；裁切/缩放需要 ffmpeg。零第三方依赖。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { anubisFetch, mwApi } from './lib/anubis-fetch.ts';
import { WikiClient } from './lib/wiki.ts';
import { normalizeTitle, looseKey } from './build-catalog.ts';
import type {
  BackgroundEntry, BackgroundManifest, CatalogFile, CatalogSong, SongListEntry, SongListFile,
} from './lib/types.ts';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** wiki allimages 条目（mwApi 返回 any，这里按 aiprop=url|size|mime 的实测字段收窄） */
interface WikiImage {
  name: string;
  url: string;
  width: number;
  height: number;
  size?: number;
}

/** 已下到本地的源图（宽度写在文件名里，换输出尺寸可直接复用） */
interface SourceInfo { path: string; width: number; bytes: number }

/**
 * ⚠️ lib/types.ts 的 BackgroundEntry.files 把 path/bytes 标成必填，
 * 但本脚本在 ffmpeg 失败时只写 { error }。类型按**实际产物**放宽在这里，
 * 不去改共享契约 —— 它还被别的脚本消费。
 */
interface BackgroundFileEntry { path?: string; bytes?: number; error?: string }
interface BackgroundEntryOut extends Omit<BackgroundEntry, 'files'> {
  files: Record<string, BackgroundFileEntry>;
}
interface BackgroundManifestOut extends Omit<BackgroundManifest, 'backgrounds'> {
  backgrounds: Record<string, BackgroundEntryOut>;
}

// ---------------------------------------------------------------------------
// 配置与参数
// ---------------------------------------------------------------------------

interface Args {
  origin: string;
  catalog: string;
  outJson: string;
  imgDir: string;
  srcDir: string;
  cacheDir: string;
  cookieFile: string;
  sizes: number[];
  /** [宽, 高]；`--no-crop` 时为 null（保留原图比例） */
  aspect: number[] | null;
  delay: number;
  refresh: boolean;
  coverageOnly: boolean;
  quiet: boolean;
}

const DEFAULTS: Args = {
  origin: 'https://wiki.arcaea.cn',
  catalog: 'data/arcaea-catalog.json',
  outJson: 'data/arcaea-backgrounds.json',
  imgDir: 'data/backgrounds',
  srcDir: '.cache/backgrounds/src',
  cacheDir: '.cache/backgrounds',
  cookieFile: '.cache/anubis-cookies.json',
  sizes: [960],
  /**
   * 输出画幅。原生 4:3（1920×1440），成片 16:9，
   * 所以「等比覆盖 → 居中裁掉多余高度」：
   *   1280×960 --crop--> 1280×720 --scale--> 960×540
   */
  aspect: [16, 9],
  delay: 400, // ⚠️ wiki 是社区个人维基，不是 CDN。别调太小。
  refresh: false,
  coverageOnly: false,
  quiet: false,
};

/**
 * 源图宽度候选，按偏好排序。
 *
 * ⚠️ 只能用 MediaWiki 的**标准档位**：实测 240/300/600/800/1280/1600 可用，
 *    360/480/720/960/1080 一律 404（详见文件头「坑」）。
 *    1280 优先是因为缩放比最小（→960 只缩 0.75 倍）；失败时逐级回退。
 */
const SOURCE_WIDTHS = [1280, 1600, 800, 600];

function parseArgs(argv: string[]): Args {
  const a: Args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--coverage') a.coverageOnly = true;
    else if (v === '--sizes') a.sizes = argv[++i].split(',').map((s) => parseInt(s, 10)).filter(Boolean);
    else if (v === '--aspect') a.aspect = argv[++i].split(':').map((s) => parseInt(s, 10));
    else if (v === '--no-crop') a.aspect = null;
    else if (v === '--refresh') a.refresh = true;
    else if (v === '--delay') a.delay = parseInt(argv[++i], 10);
    else if (v === '--catalog') a.catalog = argv[++i];
    else if (v === '--quiet') a.quiet = true;
    else if (v === '-h' || v === '--help') {
      console.log(`用法: node scripts/build-backgrounds.ts [选项]

  --coverage          只量覆盖率，不下载图片
  --sizes <列表>      输出宽度，逗号分隔（默认 960）
  --aspect <W:H>      输出画幅，等比覆盖后居中裁切（默认 16:9）
  --no-crop           不裁切，保留原图比例（4:3）
  --delay <毫秒>      请求间隔（默认 400）
  --refresh           忽略缓存
  --catalog <文件>    曲目目录（默认 data/arcaea-catalog.json）
  --quiet             少打印`);
      process.exit(0);
    }
  }
  return a;
}

const args = parseArgs(process.argv);
const sleep = (ms: number): Promise<void> => new Promise((s) => { setTimeout(s, ms); });
const log = (...a: unknown[]): void => { if (!args.quiet) console.log(...a); };

/**
 * ⚠️ 写进 JSON 的路径一律用正斜杠。
 *
 * 为什么：catalog 里已有的路径就是正斜杠（`data/jackets/256/ifi.jpg`），
 * 而 `pack-data.ts` 打包时要按前缀重写这些路径。Windows 上 `path.join`
 * 产出反斜杠，混进来会让重写失配、客户端全部 404。
 */
const toPosix = (p: string): string => p.split(path.sep).join('/');

// wiki 请求（缓存 / 重试 / JSON 页面正文）统一在 lib/wiki.ts —— 别在这里再抄一份

/** catalog song_id 与 Songlist 条目的对齐方式 */
type MatchHow = 'id' | 'title' | 'loose';

/**
 * catalog 的 song_id → Songlist 条目的交叉对齐。
 *
 * 为什么需要：Songlist 用的是**官方 ID**，而 catalog 里有 198 首的 ID 是从曲名推导的
 *   （官方 `azalea` / 我们推导出 `zle`；官方 `awakening` / 我们 `wakeinhour`）。
 *   所以不能直接按 id join，要按 id → 曲名 → 宽松键三级回退。
 *
 * 顺带产出 `official_id`，这是后续把 catalog 主源切到 wiki 的桥。
 */
function buildCrosswalk(catalog: CatalogFile, songlist: SongListFile) {
  const songs = songlist.songs ?? [];
  const byId = new Map<string, SongListEntry>(songs.map((s): [string, SongListEntry] => [s.id, s]));
  const byStrict = new Map<string, SongListEntry>();
  const byLoose = new Map<string, SongListEntry>();
  const put = (m: Map<string, SongListEntry>, k: string, v: SongListEntry): void => { if (k && !m.has(k)) m.set(k, v); };

  for (const s of songs) {
    const names = [
      s.title_localized?.en, s.title_localized?.ja,
      s.id,
      ...(s.search_title?.ja ?? []), ...(s.search_title?.ko ?? []),
    ].filter(Boolean);
    for (const n of names) {
      put(byStrict, normalizeTitle(n), s);
      put(byLoose, looseKey(n), s);
    }
  }

  const ready: Array<{ catalog: CatalogSong; entry: SongListEntry; how: MatchHow }> = [];
  const unresolved: Array<{ song_id: string; title: string }> = [];
  const via: Record<MatchHow, number> = { id: 0, title: 0, loose: 0 };

  for (const c of catalog.songs) {
    let hit = byId.get(c.song_id);
    let how: MatchHow | null = hit ? 'id' : null;

    if (!hit) {
      for (const k of [c.title_en, c.title_jp, ...(c.match_keys ?? [])].filter(Boolean)) {
        const h = byStrict.get(normalizeTitle(k));
        if (h) { hit = h; how = 'title'; break; }
      }
    }
    if (!hit) {
      for (const k of [c.title_en, c.title_jp, ...(c.match_keys ?? [])].filter(Boolean)) {
        const h = byLoose.get(looseKey(k));
        if (h) { hit = h; how = 'loose'; break; }
      }
    }
    if (!hit) { unresolved.push({ song_id: c.song_id, title: c.title_en }); continue; }

    // hit 与 how 始终成对赋值，走到这里 how 必不为 null —— TS 无法关联两个独立变量
    via[how!]++;
    ready.push({ catalog: c, entry: hit, how: how! });
  }
  return { ready, unresolved, via, songlistSongs: songs };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // wiki 客户端（缓存 + 重试 + Anubis 过盾）统一在 lib/wiki.ts，别在这里再抄一份
  const wiki = new WikiClient({
    cacheDir: args.cacheDir,
    origin: args.origin,
    cookieFile: args.cookieFile,
    delay: args.delay,
    refresh: args.refresh,
    log,
  });
  const jar = await wiki.cookieJar();
  const catalog = JSON.parse(await fs.readFile(path.resolve(args.catalog), 'utf8')) as CatalogFile;

  // ── ① Songlist（权威的曲目→背景映射）──
  const { data: songlist, hit: slHit } = await wiki.page<SongListFile>(
    'songlist.json', 'Template:Songlist.json');
  log(`① Songlist：${songlist.songs?.length ?? 0} 首${slHit ? '（缓存）' : ''}`);

  // ── ② 背景图片清单 ──
  const { data: imgs, hit: imgHit } = await wiki.cached('images.json', () =>
    wiki.withRetry(async () => {
      const out: WikiImage[] = [];
      let cont: string | null = null;
      for (let p = 0; p < 8; p++) {
        const params: Record<string, string> = {
          action: 'query', list: 'allimages', aiprefix: 'Background_',
          ailimit: '500', aiprop: 'url|size|mime',
        };
        if (cont) params.aicontinue = cont;
        const r = await mwApi(args.origin, params, { jar });
        out.push(...(r.query?.allimages ?? []));
        cont = r.continue?.aicontinue ?? null;
        if (!cont) break;
        await sleep(args.delay);
      }
      return out;
    }, '背景图片清单'));
  const byFileName = new Map<string, WikiImage>(imgs.map((f): [string, WikiImage] => [f.name, f]));
  log(`② 背景图：${imgs.length} 个${imgHit ? '（缓存）' : ''}｜原生合计 ${(imgs.reduce((s, f) => s + (f.size ?? 0), 0) / 1048576).toFixed(1)} MB`);

  // ── ③ 交叉对齐 ──
  const { ready, unresolved, via } = buildCrosswalk(catalog, songlist);
  const totalSongs = catalog.songs.length;

  /** catalog song_id → { bg, bg_inverse, official_id } */
  const songs: BackgroundManifest['songs'] = {};
  /** bg名 → Set(catalog song_id) */
  const bgToSongs = new Map<string, Set<string>>();
  const missingImage: Array<{ bg: string; song_id: string }> = [];

  for (const { catalog: c, entry, how } of ready) {
    const bg = entry.bg ?? null;
    const inv = entry.bg_inverse ?? null;
    songs[c.song_id] = { bg, bg_inverse: inv, official_id: entry.id, matched_via: how };

    for (const b of [bg, inv]) {
      if (!b) continue;
      if (!byFileName.has(`Background_${b}.jpg`)) {
        if (!missingImage.some((m) => m.bg === b)) missingImage.push({ bg: b, song_id: c.song_id });
        continue;
      }
      let set = bgToSongs.get(b);
      if (!set) { set = new Set(); bgToSongs.set(b, set); }
      set.add(c.song_id);
    }
  }

  const withBg = Object.values(songs).filter((s) => s.bg).length;

  // ── ④ 覆盖率报告 ──
  console.log('\n' + '='.repeat(66));
  console.log('背景映射覆盖率报告');
  console.log('='.repeat(66));
  console.log(`Songlist 曲目          ${songlist.songs?.length ?? 0} 首`);
  console.log('');
  console.log(`catalog 曲目           ${totalSongs} 首`);
  console.log(`  对齐方式             精确 id ${via.id} ｜ 曲名 ${via.title} ｜ 宽松键 ${via.loose}`);
  console.log(`✅ 有 bg 字段           ${withBg} 首 (${(withBg / totalSongs * 100).toFixed(1)}%)`);
  console.log(`❌ 对不上 Songlist      ${unresolved.length} 首`);
  console.log(`⚠️ bg 无对应图片        ${missingImage.length} 个`);
  console.log(`📦 需要下载的背景        ${bgToSongs.size} 个`);

  if (unresolved.length) {
    console.log(`\n---- 对不上 Songlist（前 20 / 共 ${unresolved.length}）----`);
    unresolved.slice(0, 20).forEach((u) => console.log(`   ${u.song_id.padEnd(30)} ${u.title}`));
  }
  if (missingImage.length) {
    console.log(`\n---- bg 值在 wiki 上找不到图（前 20 / 共 ${missingImage.length}）----`);
    missingImage.slice(0, 20).forEach((m) => console.log(`   ${m.bg}  ← ${m.song_id}`));
  }
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (args.coverageOnly) {
    console.log('\n（--coverage：只量数，未下载图片、未写出 JSON）');
    return;
  }

  // ── ⑤ 下源图（只用标准档位）──
  await fs.mkdir(args.srcDir, { recursive: true });
  console.log(`\n⑤ 下源图（档位候选 ${SOURCE_WIDTHS.join(' → ')}）…`);

  /** 文件名里带宽度（`<bg>@1280.jpg`），换输出宽度时可直接复用，不必重新联网 */
  async function findCachedSource(bg: string): Promise<SourceInfo | null> {
    for (const w of SOURCE_WIDTHS) {
      const p = path.join(args.srcDir, `${bg}@${w}.jpg`);
      const st = await fs.stat(p).catch(() => null);
      if (st?.size) return { path: p, width: w, bytes: st.size };
    }
    return null;
  }

  const srcInfo = new Map<string, SourceInfo>();
  let netDl = 0, netBytes = 0, srcReused = 0, srcFailed = 0;

  for (const bg of bgToSongs.keys()) {
    if (!args.refresh) {
      const hit = await findCachedSource(bg);
      if (hit) { srcInfo.set(bg, hit); srcReused++; continue; }
    }
    const f = byFileName.get(`Background_${bg}.jpg`);
    // bgToSongs 的键都经过上面的 byFileName.has() 校验，这里必然命中
    if (!f) continue;
    let got: SourceInfo | null = null;
    for (const w of SOURCE_WIDTHS) {
      // ⚠️ 只请求标准档位 —— 非标准档位（960 等）会 404，详见文件头「坑」
      const url = w >= f.width
        ? f.url
        : f.url.replace('/images/', '/images/thumb/') + `/${w}px-${f.name}`;
      const res = await wiki.withRetry(() => anubisFetch(url, { jar }), `${bg}@${w}`).catch(() => null);
      // 必须验 JPEG 魔数：404 返回的是 34KB HTML，光看状态码/体积会误判
      const isJpeg = !!res && res.buffer[0] === 0xff && res.buffer[1] === 0xd8;
      if (res && res.status === 200 && isJpeg) {
        const dest = path.join(args.srcDir, `${bg}@${w}.jpg`);
        await fs.writeFile(dest, res.buffer);
        got = { path: dest, width: w, bytes: res.buffer.length };
        netDl++; netBytes += res.buffer.length;
        break;
      }
      await sleep(args.delay);
    }
    if (!got) { srcFailed++; console.warn(`   ⚠️ 取不到源图：${bg}`); continue; }
    srcInfo.set(bg, got);
    await sleep(args.delay);
  }
  console.log(`   源图：联网 ${netDl} 张 / ${(netBytes / 1048576).toFixed(1)} MB，复用 ${srcReused} 张${srcFailed ? `，失败 ${srcFailed} 张` : ''}`);

  // ── ⑥ 裁切 + 缩放到目标尺寸 ──
  console.log(`\n⑥ 输出 ${args.sizes.join('/')}px${args.aspect ? ` / ${args.aspect.join(':')}` : '（不裁切）'}（ffmpeg）…`);

  const manifest: BackgroundManifestOut = {
    schema_version: 1,
    game: 'arcaea',
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-backgrounds.ts',
    sources: {
      mapping: `${args.origin}/wiki/Template:Songlist.json`,
      images: `${args.origin} (allimages, prefix Background_)`,
    },
    notes: [
      'songs[song_id].bg 是权威值，来自游戏原始数据（Songlist.json），不是猜的。',
      '  side=0 时 bg 属光芒侧、bg_inverse 属纷争侧；side=1 时相反。bg 永远是该曲该用的那张。',
      'songs[song_id].official_id 是官方 song_id —— catalog 里有 198 首的 id 是从曲名推导的，',
      '  两者不同（如官方 azalea vs 推导 zle）。这个字段是后续切换曲库主源的桥。',
      '输出已按 output_aspect 裁切；源图缓存在 .cache/backgrounds/src，换尺寸/裁法不用重下。',
      '本表取代 catalog 里不可信的 bg 字段（198 首新曲的 bg 曾被填成 song_id）。',
    ],
    output_aspect: args.aspect ? args.aspect.join(':') : 'native',
    backgrounds: {},
    songs,
    unresolved: {
      songs_not_in_songlist: unresolved,
      bg_without_image: missingImage,
    },
  };

  let made = 0, outBytes = 0, outReused = 0, outFailed = 0;

  for (const [bg, songSet] of bgToSongs) {
    const src = srcInfo.get(bg);
    if (!src) continue;
    const f = byFileName.get(`Background_${bg}.jpg`);
    // 同 ⑤：bgToSongs 的键都经过 byFileName.has() 校验
    if (!f) continue;

    const entry: BackgroundEntryOut = {
      name: bg,
      file: f.name,
      source_page: `${args.origin}/index.php?title=File:${f.name}`,
      original: f.url,
      native: `${f.width}x${f.height}`,
      source_width: src.width,
      files: {},
      songs: [...songSet],
    };

    for (const w of args.sizes) {
      const dir = path.join(args.imgDir, String(w));
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, f.name);
      const stored = toPosix(dest);

      if (!args.refresh) {
        const st = await fs.stat(dest).catch(() => null);
        if (st?.size) {
          entry.files[w] = { path: stored, bytes: st.size };
          outBytes += st.size; outReused++;
          continue;
        }
      }

      try {
        // 先裁后缩：裁切在源图分辨率上做，精度更高
        const [aw, ah] = args.aspect ?? [];
        const cropH = aw && ah ? `trunc(iw*${ah}/${aw}/2)*2` : null;
        const vf = [
          cropH ? `crop=iw:${cropH}:0:(ih-${cropH})/2` : null,
          `scale=${w}:-2:flags=lanczos`, // -2 保证高度是偶数（JPEG/视频链路都要求）
        ].filter(Boolean).join(',');

        await execFileAsync('ffmpeg', [
          '-y', '-v', 'error', '-i', src.path, '-vf', vf, '-q:v', '3', dest,
        ], { timeout: 60_000 });
        const st = await fs.stat(dest);
        entry.files[w] = { path: stored, bytes: st.size };
        outBytes += st.size; made++;
      } catch (e) {
        entry.files[w] = { error: `ffmpeg: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}` };
        outFailed++;
      }
    }
    manifest.backgrounds[bg] = entry;
  }

  await fs.writeFile(path.resolve(args.outJson), JSON.stringify(manifest, null, 2));

  let cacheBytes = 0;
  for (const s of srcInfo.values()) cacheBytes += s.bytes;

  console.log(`\n✅ 输出 ${made} 张（复用 ${outReused} 张）${outFailed ? `，失败 ${outFailed} 张` : ''}`);
  console.log(`   成品合计 ${(outBytes / 1048576).toFixed(1)} MB`);
  console.log(`   源图缓存 ${(cacheBytes / 1048576).toFixed(1)} MB（本次联网下 ${netDl} 张 / ${(netBytes / 1048576).toFixed(1)} MB）`);
  console.log(`   ↳ 换输出宽度/裁法只需改参数重跑，不会重新联网`);
  console.log(`✅ 清单 → ${args.outJson}`);
  console.log(`   ${Object.keys(manifest.backgrounds).length} 个背景 / ${Object.keys(manifest.songs).length} 首曲目`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
  console.error('\n❌ 失败:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

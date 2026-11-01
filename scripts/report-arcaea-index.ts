#!/usr/bin/env node
/**
 * report-arcaea-index.ts —— 检查 arcaea-index.json 的质量与覆盖度
 * ============================================================================
 *
 * 用法
 *   node scripts/report-arcaea-index.ts
 *   node scripts/report-arcaea-index.ts -i data/arcaea-index.json
 *   node scripts/report-arcaea-index.ts --constants path/to/ChartConstant.json
 *
 * 看点（检查合集与人工来源的覆盖度）
 *   1. 覆盖了多少首唯一曲目 / 多少「曲名×难度」
 *   2. 与外部定数表对照：命中率、索引多出的曲、定数不一致的条目
 *   3. 定数冲突 / 难度存疑 / 解析失败 —— 需要人工裁决的清单
 *   4. 单曲覆盖分布：一首曲有几个难度、几个来源可用
 *
 * 依赖：Node.js >= 18。零第三方依赖。
 */

import fs from 'node:fs';
import process from 'node:process';
import type { Difficulty, IndexChart, IndexFile } from './lib/types.ts';

/** 别名，保持下面代码里的书写习惯不变 */
type ReportChart = IndexChart;

type UnparsedEntry = IndexFile['unparsed'][number];
/** 定数表槽位：按 [PST,PRS,FTR,BYD,ETR,INS] 顺序排列，可能缺项 */
type ConstantSlot = { constant?: number } | null;
/** ChartConstant.json（第三方松散 JSON）：song_id → 槽位数组。只声明本脚本读取的字段 */
type ConstantTable = Record<string, ConstantSlot[]>;

/** data/arcaea-songdb.json —— 只用到下面这些字段 */
interface SongDbFile {
  generated_at?: string;
  songs?: Array<{ song_id: string; title_en: string }>;
}

interface Args {
  input: string;
  constants: string | null;
  songDb: string | null;
}

const args: Args = { input: 'data/arcaea-index.json', constants: null, songDb: 'data/arcaea-songdb.json' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '-i' || a === '--input') args.input = process.argv[++i];
  else if (a === '--constants') args.constants = process.argv[++i];
  else if (a === '--song-db') args.songDb = process.argv[++i];
  else if (a === '--no-song-db') args.songDb = null;
  else if (a === '-h' || a === '--help') {
    console.log('用法: node scripts/report-arcaea-index.ts [-i <索引>] [--song-db <曲库>] [--constants <定数表>]');
    process.exit(0);
  }
}

const DIFF_ORDER: readonly Difficulty[] = ['PST', 'PRS', 'FTR', 'BYD', 'ETR', 'INS'];

function normalizeTitle(s: string): string {
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

const hr = (t: string): void => console.log(`\n${'─'.repeat(12)} ${t} ${'─'.repeat(Math.max(0, 40 - t.length))}`);

const idx: IndexFile = JSON.parse(fs.readFileSync(args.input, 'utf8'));
const charts: ReportChart[] = idx.charts ?? [];
const s: Record<string, unknown> = idx.stats ?? {};

hr('总览');
console.log(`  生成时间        ${idx.generated_at}`);
console.log(`  主来源 UP       ${idx.source?.mid}`);
if (s.manual_sources) console.log(`  人工来源        ${s.manual_sources} 条`);
console.log(`  集合 / 视频     ${s.collections} / ${s.videos}`);
console.log(`  分P总数         ${s.pages}`);
console.log(`  chart 条目      ${charts.length}`);
console.log(`  唯一曲目        ${new Set(charts.map((c) => c.title_norm)).size}`);
console.log(`  带精确定数      ${charts.filter((c) => c.constant != null).length}`);
console.log(`  多来源条目      ${charts.filter((c) => c.sources.length > 1).length}`);

hr('难度分布');
const hist: Record<string, number> = {};
for (const c of charts) hist[c.difficulty] = (hist[c.difficulty] ?? 0) + 1;
for (const d of DIFF_ORDER) if (hist[d]) console.log(`  ${d.padEnd(4)} ${String(hist[d]).padStart(4)}`);
for (const d of Object.keys(hist)) if (!(DIFF_ORDER as readonly string[]).includes(d)) console.log(`  ${d.padEnd(4)} ${String(hist[d]).padStart(4)}  ⚠️ 未知难度代号`);
if (!hist.INS) console.log('  INS  —  0  ⚠️ 视频标题里出现过 INS，但分P标题写的是 FTR，见下方"难度存疑"');

hr('每首曲的难度覆盖（Top 15 覆盖最全的）');
const byTitle = new Map<string, { title: string; diffs: Set<Difficulty>; sources: number }>();
for (const c of charts) {
  if (!byTitle.has(c.title_norm)) byTitle.set(c.title_norm, { title: c.title, diffs: new Set<Difficulty>(), sources: 0 });
  // 上一行的 has 已保证存在；get 的返回类型只是不知道这层关系
  const e = byTitle.get(c.title_norm)!;
  e.diffs.add(c.difficulty);
  e.sources += c.sources.length;
}
[...byTitle.values()]
  .sort((a, b) => b.diffs.size - a.diffs.size || b.sources - a.sources)
  .slice(0, 15)
  .forEach((e) => console.log(`  ${e.title.padEnd(38).slice(0, 38)} 难度[${[...e.diffs].sort((x, y) => DIFF_ORDER.indexOf(x) - DIFF_ORDER.indexOf(y)).join(',')}]  来源×${e.sources}`));

hr('多来源可用性（抗单点失效）');
const srcCount: Record<string, number> = {};
for (const c of charts) srcCount[c.sources.length] = (srcCount[c.sources.length] ?? 0) + 1;
for (const k of Object.keys(srcCount).sort((a, b) => Number(a) - Number(b))) {
  console.log(`  ${k} 个来源 : ${srcCount[k]} 个条目`);
}

hr('需要人工裁决');
const conflicts = charts.filter(
  (c): c is ReportChart & { constant_conflict: number[] } => !!c.constant_conflict
);
console.log(`  定数冲突   ${conflicts.length}`);
conflicts.slice(0, 10).forEach((c) =>
  console.log(`    ${c.title} [${c.difficulty}]  冲突值: ${[c.constant, ...c.constant_conflict].join(' / ')}`)
);
const alt = charts.flatMap((c) => c.sources.filter((x) => x.alt_difficulty).map((x) => ({ c, x })));
console.log(`  难度存疑   ${alt.length}`);
alt.slice(0, 10).forEach(({ c, x }) =>
  console.log(`    ${x.url}\n      分P「${x.part_title}」 vs 视频「${x.video_title}」`)
);

hr('解析失败分类');
const byReason: Record<string, UnparsedEntry[]> = {};
for (const u of idx.unparsed ?? []) (byReason[u.reason] ??= []).push(u);
const REASON_NOTES: Record<string, string> = {
  no_difficulty: '容器标题或 [???]，通常可忽略',
  auto_part_title: 'UP 主未改分P名，需人工补曲名',
  no_title: '标题里没有曲名',
  fetch_failed: '接口失败，重跑即可',
  no_pages: '接口无分P数据',
};
for (const [r, arr] of Object.entries(byReason)) {
  const note = REASON_NOTES[r] ?? '';
  console.log(`  [${r}] ×${arr.length}  ${note}`);
  arr.slice(0, 5).forEach((u) => console.log(`      ${u.bvid} p=${u.p ?? '-'} «${u.part_title || u.video_title}»`));
}

// ---- 真实覆盖度：index ↔ 曲库 ----
if (args.songDb) {
  let db: SongDbFile | null = null;
  try {
    db = JSON.parse(fs.readFileSync(args.songDb, 'utf8'));
  } catch {
    /* 曲库不存在则跳过 */
  }
  if (db) {
    hr('真实覆盖度（索引 ↔ 曲库）');
    const matchedIds = new Set(charts.map((c) => c.song_id).filter(Boolean));
    const total = db.songs?.length ?? 0;
    const pct = total ? ((matchedIds.size / total) * 100).toFixed(1) : '0';
    console.log(`  曲库            ${args.songDb}（${total} 首，生成于 ${db.generated_at?.slice(0, 10)}）`);
    console.log(`  索引覆盖曲库    ${matchedIds.size}/${total} 首  (${pct}%)`);
    console.log(`  索引总条目      ${charts.length}（其中 ${charts.filter((c) => c.song_id).length} 条命中 song_id）`);

    const uncovered = (db.songs ?? []).filter((s) => !matchedIds.has(s.song_id));
    console.log(`  曲库中未被覆盖  ${uncovered.length} 首`);
    if (uncovered.length) {
      console.log('    样本:', uncovered.slice(0, 20).map((s) => s.title_en).join(' | '));
      console.log('    （未被覆盖可能是：该曲没有谱面确认视频、或曲名写法对不上）');
    }

    // 「索引超出曲库」以索引里实际写入的 song_id 为准，
    // 不要在这里重新做一遍匹配 —— 否则会和索引的判定口径不一致。
    const matchedNorms = new Set(charts.filter((c) => c.song_id).map((c) => c.title_norm));
    const uniqNorm = new Set(charts.map((c) => c.title_norm));
    const extra = [...uniqNorm].filter((t) => !matchedNorms.has(t));
    console.log(`  索引超出曲库    ${extra.length} 首  ← 曲库停留在 2023 年，这部分多半是之后的新曲`);
    if (extra.length) console.log('    样本:', extra.slice(0, 20).join(' | '));
    const via = charts
      .filter((c): c is ReportChart & { song_match_via: string } => !!c.song_match_via)
      .reduce<Record<string, number>>((m, c) => ((m[c.song_match_via] = (m[c.song_match_via] ?? 0) + 1), m), {});
    console.log(`  匹配途径        ${Object.entries(via).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    console.log('                  （loose = 去掉标点空白后的兜底匹配，命中即说明标题写法有出入）');
    console.log('');
    console.log('  📌 覆盖率包含主来源合集与人工来源。');
  }
}

// ---- 可选：与外部定数表对照 ----
if (args.constants) {
  hr('与外部定数表对照');
  const ccRaw: ConstantTable = JSON.parse(fs.readFileSync(args.constants, 'utf8'));
  const cc = new Map(Object.entries(ccRaw).map(([k, v]) => [normalizeTitle(k), v] as const));

  const uniq = new Set(charts.map((c) => c.title_norm));
  const hit = [...uniq].filter((t) => cc.has(t));
  console.log(`  定数表条目数    ${cc.size}`);
  console.log(`  索引唯一曲目    ${uniq.size}`);
  console.log(`  直接命中        ${hit.length}  (${((hit.length / uniq.size) * 100).toFixed(1)}%)`);
  console.log(`  未命中          ${uniq.size - hit.length}`);
  console.log('');
  console.log('  ⚠️ 未命中 ≠ 新曲。此处的直接命中率**显著低估**真实覆盖率，原因有二：');
  console.log('     (a) 定数表的键是**内部 song_id**（如 `ifi`、`grievouslady`），');
  console.log('         而索引里是**显示曲名**（`I\'ve Heard It Said`、`Grievous Lady`）—— 两者形态不同；');
  console.log('     (b) 少数曲目有变音符号/标点差异（已做去变音处理但仍可能残留）。');
  console.log('     → 要做准确对照，需先用 arcsong.json 的 song_id ↔ name_en 映射建表。');

  let cmp = 0;
  const mismatches = [];
  for (const c of charts) {
    if (c.constant == null) continue;
    const slots = cc.get(c.title_norm);
    if (!slots) continue;
    const si = DIFF_ORDER.indexOf(c.difficulty);
    const old = si >= 0 && slots[si] ? slots[si].constant : null;
    if (old == null) continue;
    cmp++;
    if (Math.abs(old - c.constant) > 1e-9) mismatches.push({ c, old });
  }
  console.log('');
  console.log(`  可比对条目      ${cmp}`);
  console.log(`  定数不一致      ${mismatches.length}  (${cmp ? ((mismatches.length / cmp) * 100).toFixed(1) : 0}%)`);
  console.log('  ⚠️ 不一致通常不是谁错了：汇编视频多为 2022–2023 年发布，其分P标题里的定数');
  console.log('     是**发布当时的**，Arcaea 后续经历过定数调整。以 wiki 最新值为准，冲突项人工复核。');
  mismatches.slice(0, 15).forEach(({ c, old }) =>
    console.log(`    ${c.title} [${c.difficulty}]  定数表 ${old} → 索引 ${c.constant}`)
  );
}

console.log('');

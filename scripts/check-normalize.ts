// 归一化落差审计：Go 侧复刻 TS 的 normalizeTitle 会漏掉几首？
//
// 背景：曲库里的 match_keys / title_norm 是构建期用 TS 归一化过的
//（scripts/build-catalog.ts:244 —— NFKC → NFD → 剥组合记号 → 引号/破折号 → 小写）。
// 而 **Go 标准库没有 NFKC / NFD** —— 这是成绩导入「曲目定位」的真实缺口（docs/设计文档.md §3）。
//
// 本脚本把 Go 能做到的部分（全角→半角 + 剥组合记号 + 引号/破折号 + 小写，**不做 NFKC 兼容分解**）
// 实现一遍，对拍 catalog 自带的 564 组 (title_en, title_norm)，报出落差。
//
// 用途：这个数字决定「引不引 golang.org/x/text」。曲库刷新后重跑，落差变大就该重新评估
//（也说明 TS 侧新增了依赖 NFKC 的写法）。
//
//   node scripts/check-normalize.ts            # 默认期望落差 2 首
//   node scripts/check-normalize.ts --expect 5

import { readFileSync } from 'node:fs';

// TS 的 normalizeTitle 做了什么，这里逐条对齐；唯一缺的就是第一行的 NFKC。
const width = (s: string): string => {
  // 全角 → 半角（NFKC 会顺手做掉，这里独立实现以隔离"兼容分解"这一个变量）
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (cp === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
};

/** 方案 B：Go 侧不引依赖时能做到的归一化（缺 NFKC） */
export function normalizeWithoutNFKC(s: unknown): string {
  return width(String(s))
    .normalize('NFD') // ⚠️ Go 侧要用一张 Latin 变音 fold 表替代这一步
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const args = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const catalogPath = arg('catalog', 'data/arcaea-catalog.json');
const expect = Number(arg('expect', '2'));

const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));

type Miss = { id: string; raw: string; want: string; got: string };
const misses: Miss[] = [];
let needingNFKC = 0;
for (const s of cat.songs) {
  const got = normalizeWithoutNFKC(s.title_en);
  if (got !== s.title_norm) misses.push({ id: s.song_id, raw: s.title_en, want: s.title_norm, got });
  // 只要出现非 ASCII，就说明这首的 title 需要额外规则（NFKC 或 fold 表）
  if (/[^\x20-\x7e]/.test(s.title_en ?? '')) needingNFKC++;
}

console.log(`曲目总数 ${cat.songs.length}，title 含非 ASCII 的 ${needingNFKC} 首`);
console.log(`方案 B（不引 x/text）失配 ${misses.length} 首：`);
for (const m of misses) {
  console.log(`  ${m.id.padEnd(18)} raw=${JSON.stringify(m.raw)}`);
  console.log(`  ${''.padEnd(18)} 曲库归一化=${JSON.stringify(m.want)}  方案B=${JSON.stringify(m.got)}`);
}
console.log(
  '\n这些是 NFKC 兼容分解（罗马数字 Ⅱ→II、下标 ₀→0 之类），手写表覆盖不了。' +
    '\n方案 A（引 golang.org/x/text/unicode/norm）可以全绿；方案 B 则让这几首走人工确认。'
);

if (misses.length !== expect) {
  console.error(`\n❌ 落差 ${misses.length} 首，与预期 ${expect} 首不符 —— 归一化规则或曲库变了，需重新评估（docs/设计文档.md §3）`);
  process.exit(1);
}
console.log(`\n✅ 落差 ${misses.length} 首，与预期一致`);

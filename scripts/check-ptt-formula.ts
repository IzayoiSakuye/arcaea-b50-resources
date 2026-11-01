// 潜力值公式自检：单曲 ptt 参考节点 + 用曲库反推理论最高 PTT。
//
// 用途有两个：
//   ① 数据层回归 —— catalog 刷新后跑一遍，最高定数与定数分布一变，理论上限就会漂，
//      冒烟就能发现"定数被上游改坏了"（13.438 这个数来自 wiki，是独立于我们曲库的第三方事实）。
//   ② Go 版公式的对拍 oracle —— internal/score 写完单曲 ptt 之后，
//      用同一张参考节点表对一遍，证明两边行为一致（独立工具验证自己的产出）。
//
// 用法：
//   node scripts/check-ptt-formula.ts
//   node scripts/check-ptt-formula.ts --catalog data/arcaea-catalog.json --expect 13.438

import { readFileSync } from 'node:fs';

// ── 公式 ────────────────────────────────────────────────────────────────
// 分段边界只有两个（10,000,000 与 9,800,000），没有 9,500,000 这一档：
// 9.5M 只是"恰好等于定数"的参考点，9.2M–9.499M 已被同一 1/300,000 斜率覆盖。
type Clear = 'PM' | 'FR' | 'TC' | 'TL';

function singlePtt(constant: number, score: number, clear: Clear): number {
  let v = constant;
  if (score >= 10_000_000) v += 2;
  else if (score >= 9_800_000) v += 1 + (score - 9_800_000) / 200_000;
  else v += (score - 9_500_000) / 300_000;
  // PM / FR / TC(含 Easy Clear) 通关奖励 +0.2，TL 无奖励
  if (clear === 'PM' || clear === 'FR' || clear === 'TC') v += 0.2;
  return Math.max(0, v);
}

// ── 参考节点（docs/设计文档.md §6.3 抄来，wiki「潜力值」页的数值）────────────────
const NODES: { score: number; tl: number; tc: number }[] = [
  { score: 10_000_000, tl: 2.0, tc: 2.2 },
  { score: 9_900_000, tl: 1.5, tc: 1.7 },
  { score: 9_800_000, tl: 1.0, tc: 1.2 },
  { score: 9_500_000, tl: 0.0, tc: 0.2 },
  { score: 9_200_000, tl: -1.0, tc: -0.8 },
  { score: 8_900_000, tl: -2.0, tc: -1.8 },
  { score: 8_600_000, tl: -3.0, tc: -2.8 },
];

const C = 11.0; // 任意定数，只看相对偏移
let failed = 0;

function expect(label: string, got: number, want: number, eps: number): void {
  const ok = Math.abs(got - want) <= eps;
  if (!ok) failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(28)} 实得 ${got.toFixed(4)}  期望 ${want.toFixed(4)}`);
}

console.log('① 单曲 ptt 参考节点（定数 11.0）');
for (const n of NODES) {
  expect(`score ${n.score} / TL`, singlePtt(C, n.score, 'TL') - C, n.tl, 1e-9);
  expect(`score ${n.score} / TC`, singlePtt(C, n.score, 'TC') - C, n.tc, 1e-9);
}
// 下界：极低的定数 + 极低的分数必须夹在 0，不能出负数
expect('定数 1.0 / 8.6M / TL → 0', singlePtt(1.0, 8_600_000, 'TL'), 0, 1e-9);

// ── 用曲库反推理论最高 PTT ──────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const catalogPath = arg('catalog', 'data/arcaea-catalog.json');
const expectMax = Number(arg('expect', '13.438'));

// 理论最高 = 每个谱面都打出 1000 万分 + PM（定数 + 2.2），再取最高的 50 个谱面
type Row = { id: string; diff: string; c: number; ptt: number };
const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
const rows: Row[] = [];
for (const s of cat.songs) {
  for (const ch of s.charts) {
    if (ch.constant == null) continue;
    rows.push({ id: s.song_id, diff: ch.difficulty, c: ch.constant, ptt: ch.constant + 2.2 });
  }
}
rows.sort((a, b) => b.ptt - a.ptt);
const top50 = rows.slice(0, 50);
const top10 = top50.slice(0, 10);
const sum = (a: Row[]): number => a.reduce((x, r) => x + r.ptt, 0);

// 总 PTT = (best50 总和 + best10 总和) / 60，其中 best10 ⊂ best50（前 10 名两倍权重）
const maxPtt = (sum(top50) + sum(top10)) / 60;

console.log(`\n② 用曲库反推理论最高 PTT（${catalogPath}）`);
console.log(`  有定数的谱面   ${rows.length}`);
console.log(`  最高定数       ${rows[0].c}（${rows[0].id} ${rows[0].diff}）`);
console.log(`  第 50 名单曲ptt ${top50[49].ptt.toFixed(4)}（${top50[49].id} ${top50[49].diff}）`);
console.log(`  b50 总和       ${sum(top50).toFixed(4)}`);
console.log(`  b10 总和       ${sum(top10).toFixed(4)}`);
expect('理论最高 PTT', maxPtt, expectMax, 0.001);

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项不通过 ❌`);
process.exit(failed === 0 ? 0 : 1);

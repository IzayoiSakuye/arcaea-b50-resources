#!/usr/bin/env node
/** 资源发布入口：刷新数据、打包，并用独立 ZIP 工具核验归档。 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'IzayoiSakuye/arcaea-b50-resources';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: node scripts/build-release.ts --version YYYY.MM.DD [--pack-only]');
  process.exit(0);
}
const versionIndex = args.indexOf('--version');
const version = args[versionIndex + 1];
if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version ?? '') ||
    args.some((arg, i) => !['--version', '--pack-only'].includes(arg) && i !== versionIndex + 1)) {
  throw new Error('请传入 --version YYYY.MM.DD，可选 --pack-only');
}
process.chdir(root);

function run(command: string, argv: string[]) {
  console.log(`\n> ${command} ${argv.join(' ')}`);
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === 'tar' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败：退出码 ${result.status}`);
}

if (!args.includes('--pack-only')) {
  run(process.execPath, ['scripts/build-song-db.ts', '--refresh']);
  run(process.execPath, ['scripts/build-arcaea-index.ts', '--refresh', '--delay', '600']);
  run(process.execPath, ['scripts/build-jackets.ts']);
  run(process.execPath, ['scripts/build-catalog.ts']);
  run(process.execPath, ['scripts/build-backgrounds.ts', '--refresh', '--delay', '600']);
  run(process.execPath, ['scripts/build-catalog.ts']);
  run(process.execPath, ['scripts/report-arcaea-index.ts']);
  run(process.execPath, ['scripts/check-ptt-formula.ts']);
}
const tag = `data-${version}`;
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
run(process.execPath, ['scripts/pack-data.ts', '--version', version, '--base-url', baseUrl]);

const latest = JSON.parse(await fs.readFile('dist/latest.json', 'utf8'));
const archive = path.join('dist', latest.archive.path);
const listing = spawnSync('tar', ['-tf', archive], { cwd: root, encoding: 'utf8' });
if (listing.error) throw listing.error;
if (listing.status !== 0) throw new Error(`ZIP 核验失败：${listing.stderr}`);
const entries = new Set(listing.stdout.trim().split(/\r?\n/).map((name) => name.replace(/\\/g, '/')));
for (const file of latest.files) {
  if (!entries.has(file.path)) throw new Error(`ZIP 缺少文件：${file.path}`);
}
if (!entries.has('meta.json')) throw new Error('ZIP 缺少 meta.json');
if (entries.size !== latest.files.length) throw new Error('ZIP 条目数与清单不符');
const verifyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcaea-release-'));
try {
  const result = spawnSync('tar', ['-xf', path.resolve(archive), '-C', verifyDir], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ZIP 解压失败：${result.stderr}`);
  for (const file of latest.files) {
    const content = await fs.readFile(path.join(verifyDir, file.path));
    if (content.length !== file.size || crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) {
      throw new Error(`文件校验失败：${file.path}`);
    }
  }
} finally {
  await fs.rm(verifyDir, { recursive: true, force: true });
}
console.log(`\n核验通过：${entries.size} 个 ZIP 条目`);
console.log(`手动上传到 ${repo} 的 Release，标签 ${tag}：`);
console.log(`  ${archive}`);
console.log('  dist/latest.json');
console.log(`固定清单地址：https://github.com/${repo}/releases/latest/download/latest.json`);

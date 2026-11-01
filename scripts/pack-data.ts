#!/usr/bin/env node
/** 将应用 data/ 目录打包为 ZIP 和 latest.json；发布入口见 build-release.ts。 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { ZipWriter } from './lib/zip.ts';
import type { BackgroundManifest, CatalogFile } from './lib/types.ts';

interface PackArgs {
  dataDir: string;
  catalog: string;
  jacketDir: string;
  outDir: string;
  version: string | null;
  baseUrl: string;
  emitTree: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): PackArgs {
  const args: PackArgs = {
    dataDir: 'data',
    catalog: 'data/arcaea-catalog.json',
    jacketDir: 'data/jackets/256',
    outDir: 'dist',
    version: null,
    baseUrl: '',
    emitTree: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a === '--catalog') args.catalog = argv[++i];
    else if (a === '--jackets') args.jacketDir = argv[++i];
    else if (a === '-o' || a === '--out') args.outDir = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i].replace(/\/+$/, '');
    else if (a === '--emit-tree') args.emitTree = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        '用法: node scripts/pack-data.ts [--version <v>] [--base-url <url>] [--emit-tree] [-o <dir>]'
      );
      process.exit(0);
    }
  }
  return args;
}

const CFG = parseArgs(process.argv);
const log = (...a: unknown[]) => {
  if (!CFG.quiet) console.log(...a);
};

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  const t0 = Date.now();
  log('▶ 打包运行时数据');

  // ---- 版本号：默认按日期 ----
  const d = new Date();
  const version =
    CFG.version ??
    `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  log(`  版本    ${version}`);

  // ---- 读曲目目录 ----
  const catalogRaw = await fs.readFile(path.resolve(CFG.catalog));
  const catalog: CatalogFile = JSON.parse(catalogRaw.toString('utf8'));
  const backgrounds: BackgroundManifest = JSON.parse(
    await fs.readFile(path.resolve(CFG.dataDir, 'arcaea-backgrounds.json'), 'utf8')
  );

  // 应用按项目根目录下的 data/ 路径读取素材，归档也保持这个布局。

  // ---- 收集曲绘 ----
  const jpegFiles: Array<{ name: string; abs: string; size: number }> = [];
  try {
    for (const name of (await fs.readdir(path.resolve(CFG.jacketDir))).sort()) {
      if (!/\.(jpe?g|png)$/i.test(name)) continue;
      const abs = path.join(path.resolve(CFG.jacketDir), name);
      const st = await fs.stat(abs);
      if (st.size > 0) jpegFiles.push({ name, abs, size: st.size });
    }
  } catch {
    throw new Error(`曲绘目录不存在：${CFG.jacketDir}（先跑 build-jackets.ts）`);
  }
  const jacketBytes = jpegFiles.reduce((n, f) => n + f.size, 0);
  log(`  曲绘    ${jpegFiles.length} 张  ${mb(jacketBytes)}`);

  const backgroundFiles = new Map<string, Buffer>();
  for (const entry of Object.values(backgrounds.backgrounds ?? {})) {
    for (const file of Object.values(entry.files ?? {})) {
      if (!file.path) continue;
      const original = file.path.replace(/\\/g, '/');
      if (!/^data\/backgrounds\/[\w./-]+\.(jpe?g|png)$/i.test(original) || original.includes('..')) {
        throw new Error(`非法背景路径：${file.path}`);
      }
      const relative = original.slice('data/'.length);
      const content = await fs.readFile(path.resolve(CFG.dataDir, relative));
      if (content.length === 0) throw new Error(`背景图片为空：${original}`);
      backgroundFiles.set(original, content);
    }
  }
  const backgroundBuf = Buffer.from(JSON.stringify(backgrounds), 'utf8');
  log(`  背景    ${backgroundFiles.size} 张`);

  // ---- 额外元数据（客户端可用来做自检）----
  const meta = {
    data_version: version,
    game: 'arcaea',
    generated_at: new Date().toISOString(),
    catalog_schema_version: catalog.schema_version ?? 1,
    counts: {
      songs: catalog.songs?.length ?? 0,
      charts: (catalog.songs ?? []).reduce((n, s) => n + (s.charts?.length ?? 0), 0),
      jackets: jpegFiles.length,
      backgrounds: backgroundFiles.size,
    },
    paths: {
      catalog: 'data/arcaea-catalog.json',
      backgrounds: 'data/arcaea-backgrounds.json',
      jackets: 'data/jackets/256/',
    },
  };
  const catalogBuf = Buffer.from(JSON.stringify(catalog), 'utf8');
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');

  // ---- 打 zip ----
  const zip = new ZipWriter();
  zip.add('meta.json', metaBuf);
  zip.add('data/arcaea-catalog.json', catalogBuf);
  zip.add('data/arcaea-backgrounds.json', backgroundBuf);
  for (const f of jpegFiles) {
    zip.add(`data/jackets/256/${f.name}`, await fs.readFile(f.abs));
  }
  for (const [name, content] of backgroundFiles) zip.add(name, content);
  const zipName = `arcaea-data-${version}.zip`;
  const zipPath = path.join(CFG.outDir, zipName);
  const zipBytes = await zip.writeTo(zipPath);
  log(`  归档    ${zipName}  ${mb(zipBytes)}  (${zip.count} 个条目)`);

  // ---- 校验和解包验证（自己产的东西也要验一遍）----
  const zipBuf = await fs.readFile(zipPath);
  const zipSha = sha256(zipBuf);

  // ---- 散文件树（可选，供 OSS / CDN 逐文件托管）----
  const treeFiles: Array<{ path: string; size: number; sha256: string }> = [];
  if (CFG.emitTree) {
    const treeRoot = path.join(CFG.outDir, 'tree');
    await fs.rm(treeRoot, { recursive: true, force: true });
    const put = async (rel: string, buf: Buffer) => {
      const dest = path.join(treeRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      treeFiles.push({ path: rel.replace(/\\/g, '/'), size: buf.length, sha256: sha256(buf) });
    };
    await put('meta.json', metaBuf);
    await put('data/arcaea-catalog.json', catalogBuf);
    await put('data/arcaea-backgrounds.json', backgroundBuf);
    for (const f of jpegFiles) {
      await put(`data/jackets/256/${f.name}`, await fs.readFile(f.abs));
    }
    for (const [name, content] of backgroundFiles) await put(name, content);
    log(`  散文件树 dist/tree/  ${treeFiles.length} 个文件`);
  }

  // ---- latest.json：客户端唯一需要先拉的小文件 ----
  const latest = {
    schema_version: 1,
    game: 'arcaea',
    data_version: version,
    generated_at: meta.generated_at,
    counts: meta.counts,
    archive: {
      path: zipName,
      size: zipBytes,
      sha256: zipSha,
      url: CFG.baseUrl ? `${CFG.baseUrl}/${zipName}` : null,
    },
    // 逐文件清单 —— 支持增量更新（只下新增/变更的曲绘）
    files: [
      { path: 'meta.json', size: metaBuf.length, sha256: sha256(metaBuf) },
      { path: 'data/arcaea-catalog.json', size: catalogBuf.length, sha256: sha256(catalogBuf) },
      { path: 'data/arcaea-backgrounds.json', size: backgroundBuf.length, sha256: sha256(backgroundBuf) },
      ...(CFG.emitTree
        ? treeFiles.filter((f) => f.path.startsWith('data/jackets/') || f.path.startsWith('data/backgrounds/'))
        : [
            ...await Promise.all(jpegFiles.map(async (f) => ({
              path: `data/jackets/256/${f.name}`, size: f.size, sha256: sha256(await fs.readFile(f.abs)),
            }))),
            ...[...backgroundFiles].map(([name, content]) => ({ path: name, size: content.length, sha256: sha256(content) })),
          ]),
    ],
    urls: CFG.baseUrl
      ? {
          archive: `${CFG.baseUrl}/${zipName}`,
          file_base: CFG.emitTree ? `${CFG.baseUrl}/tree` : null,
        }
      : null,
    note: [
      CFG.emitTree ? 'archive 用于全量下载；files + urls.file_base 可用于增量更新。' : 'archive 用于全量下载。',
      '客户端应校验 sha256 后再解压/落盘。',
      '本文件不含任何构建期中间产物（songdb / index / jackets.json 都可重建，不发布）。',
    ],
  };
  const latestPath = path.join(CFG.outDir, 'latest.json');
  await fs.mkdir(path.resolve(CFG.outDir), { recursive: true });
  await fs.writeFile(latestPath, JSON.stringify(latest, null, 2) + '\n', 'utf8');

  // ---- 报表 ----
  log('');
  log('══════════════ 打包完成 ══════════════');
  log(`  版本        ${version}`);
  log(`  归档        ${path.resolve(zipPath)}`);
  log(`              ${mb(zipBytes)}   sha256 ${zipSha.slice(0, 16)}…`);
  log('  清单        ' + path.resolve(latestPath));
  if (CFG.emitTree) log(`  散文件树    ${path.resolve(path.join(CFG.outDir, 'tree'))}`);
  log('');
  log('  内容构成');
  log(`     data/arcaea-catalog.json  ${kb(catalogBuf.length)}    ${meta.counts.songs} 首 / ${meta.counts.charts} 谱面`);
  log(`     meta.json           ${kb(metaBuf.length)}`);
  log(`     jackets/256/        ${mb(jacketBytes)}    ${jpegFiles.length} 张`);
  log(`     backgrounds/       ${backgroundFiles.size} 张`);
  log('');
  log(`  ⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log('══════════════════════════════════════');
  log('');
  log('  下一步：核验后将 ZIP 与 latest.json 上传到资源仓库的 Release');
}

main().catch((e) => {
  console.error('✗ 打包失败：', e?.stack || e);
  process.exit(1);
});

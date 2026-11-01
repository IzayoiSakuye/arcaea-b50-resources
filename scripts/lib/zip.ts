/**
 * zip.ts —— 极简 ZIP 写入器（store 模式，零依赖，跨平台）
 * ============================================================================
 *
 * 为什么自己写：
 *   - 不引入第三方依赖（项目原则）
 *   - Node 标准库没有 ZIP 写入能力
 *   - 调 `zip` / `Compress-Archive` 跨平台不一致
 *
 * 为什么用 store（不压缩）：
 *   发布包里全是已经压缩过的 JPEG 和 JSON。deflate 再压一遍收益极小
 *   （通常 <2%），却要付出 CPU 与内存代价。store 模式让打包 12MB 数据只需 ~0.2s。
 *
 * 实现范围：
 *   - 本地文件头 / 中央目录 / 中央目录结束记录
 *   - CRC-32、UTF-8 文件名（置 bit 11 = EFS）
 *   - ZIP64 不实现 —— 发布包远低于 4GB，触发时直接报错而不是产出损坏文件
 *
 * 用法：
 *   import { ZipWriter } from './lib/zip.ts';
 *   const z = new ZipWriter();
 *   z.add('catalog.json', buffer);
 *   z.add('jackets/256/a.jpg', jpegBuffer);
 *   await z.writeTo('out.zip');
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const U32_MAX = 0xffffffff;

/** 一个待写入的条目。nameBuf 是 UTF-8 编码后的字节，会出现在两处头部里。 */
interface ZipEntry {
  name: string;
  nameBuf: Buffer;
  data: Buffer;
  crc: number;
  offset: number;
  time: number;
  date: number;
  size: number;
}

// --- CRC-32（标准多项式 0xEDB88320，查表法）---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间/日期（ZIP 传统字段，无时区信息） */
function dosDateTime(d: Date = new Date()): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

export class ZipWriter {
  private entries: ZipEntry[] = [];
  private chunks: Buffer[] = [];
  private offset = 0;

  /**
   * 加入一个文件。
   * @param name  ZIP 内的路径，一律用 `/` 分隔
   */
  add(name: string, data: Buffer | Uint8Array | string): this {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) throw new Error('ZIP 条目名不能为空');
    if (buf.length > U32_MAX) throw new Error(`条目过大（>4GB），本实现不支持 ZIP64：${clean}`);
    if (this.offset + buf.length > U32_MAX) throw new Error('归档超过 4GB，本实现不支持 ZIP64');

    const nameBuf = Buffer.from(clean, 'utf8');
    const { time, date } = dosDateTime();
    const crc = crc32(buf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 文件名
    local.writeUInt16LE(0, 8); // 压缩方法 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(buf.length, 18); // 压缩后大小
    local.writeUInt32LE(buf.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    this.entries.push({ name: clean, nameBuf, data: buf, crc, offset: this.offset, time, date, size: buf.length });
    this.chunks.push(local, nameBuf, buf);
    this.offset += local.length + nameBuf.length + buf.length;
    return this;
  }

  /** 已加入的条目数 */
  get count(): number {
    return this.entries.length;
  }

  /** 未压缩总字节数 */
  get rawSize(): number {
    return this.entries.reduce((n, e) => n + e.size, 0);
  }

  private _build(): Buffer {
    const central: Buffer[] = [];
    let cdSize = 0;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(0x0800, 8); // flags
      h.writeUInt16LE(0, 10); // store
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk start
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.offset, 42);
      central.push(h, e.nameBuf);
      cdSize += h.length + e.nameBuf.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with CD
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(this.offset, 16); // CD 起始偏移
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...this.chunks, ...central, eocd]);
  }

  toBuffer(): Buffer {
    return this._build();
  }

  async writeTo(file: string): Promise<number> {
    const buf = this._build();
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await fs.writeFile(path.resolve(file), buf);
    return buf.length;
  }
}


/**
 * lib/wiki.ts —— wiki.arcaea.cn 的 JSON 内容模型页面客户端
 *
 * 复用 lib/anubis-fetch.ts 过 Anubis PoW 盾（那三个约束别简化，见该文件）。
 * ⚠️ 限速：wiki 是社区个人维基，不是 CDN。delay 别调小。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { mwApi, CookieJar } from './anubis-fetch.ts';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WikiClientOptions {
  cacheDir: string;
  origin?: string;
  cookieFile?: string;
  /** 每次联网请求之间的间隔（ms） */
  delay?: number;
  refresh?: boolean;
  log?: (...a: unknown[]) => void;
}

export class WikiClient {
  readonly origin: string;
  readonly delay: number;

  private readonly cacheDir: string;
  private readonly cookieFile: string;
  private readonly refresh: boolean;
  private readonly log: (...a: unknown[]) => void;
  private jar: CookieJar | null;

  constructor(opts: WikiClientOptions) {
    this.origin = opts.origin ?? 'https://wiki.arcaea.cn';
    this.cacheDir = opts.cacheDir;
    this.cookieFile = opts.cookieFile ?? path.join(opts.cacheDir, '..', 'anubis-cookies.json');
    this.delay = opts.delay ?? 400;
    this.refresh = opts.refresh ?? false;
    this.log = opts.log ?? (() => {});
    this.jar = null;
  }

  private async getJar(): Promise<CookieJar> {
    if (!this.jar) this.jar = await CookieJar.load(this.cookieFile);
    return this.jar;
  }

  /**
   * 复用同一个 cookie jar 去做 mwApi / anubisFetch 等自定义请求。
   * 不开这个口子的话，调用方会自己 `CookieJar.load` 一份 —— 两个 jar 各走各的
   * cookie 往返，Anubis 过盾会时灵时不灵。
   */
  async cookieJar(): Promise<CookieJar> {
    return this.getJar();
  }

  /** 本地缓存，命中就不联网。缓存的是**上游原样 JSON**，不是加工结果。 */
  async cached<T>(name: string, fetcher: () => Promise<T>): Promise<{ data: T; hit: boolean }> {
    const p = path.join(this.cacheDir, name);
    if (!this.refresh) {
      try {
        return { data: JSON.parse(await fs.readFile(p, 'utf8')) as T, hit: true };
      } catch {
        /* 没缓存，正常 */
      }
    }
    const data = await fetcher();
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(p, JSON.stringify(data, null, 2));
    return { data, hit: false };
  }

  /**
   * 网络请求必须带重试。社区维基 + PoW 门链路本来就慢，
   * 一次瞬断就让整轮白跑（缓存能续上，但要白等）。
   */
  async withRetry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
    let lastErr: unknown = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i < tries - 1) {
          this.log(
            `    ↻ 重试 ${i + 2}/${tries}（${label}）：` +
              `${(e instanceof Error ? e.message : String(e)).slice(0, 70)}`
          );
          await sleep(1200 * (i + 1));
        }
      }
    }
    throw lastErr;
  }

  /** 取一个 JSON 内容模型页面的正文。契约由调用方用泛型声明（MediaWiki 返回的是任意 JSON）。 */
  async jsonPage<T>(title: string): Promise<T> {
    const jar = await this.getJar();
    const rev = await mwApi(
      this.origin,
      {
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        titles: title,
        redirects: '1',
      },
      { jar }
    );
    const page = rev.query?.pages?.[0];
    const content = page?.revisions?.[0]?.slots?.main?.content;
    if (content == null) {
      throw new Error(`${title} 取不到正文（contentmodel 可能不是 json）`);
    }
    return JSON.parse(content) as T;
  }

  /** 缓存 + 重试的组合：最常用的形式。 */
  async page<T>(cacheName: string, title: string): Promise<{ data: T; hit: boolean }> {
    const r = await this.cached(cacheName, () =>
      this.withRetry(() => this.jsonPage<T>(title), title)
    );
    if (!r.hit) await sleep(this.delay);
    return r;
  }
}

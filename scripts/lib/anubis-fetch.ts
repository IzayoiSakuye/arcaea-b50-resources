/**
 * anubis-fetch.ts —— 通过 Anubis Proof-of-Work 反爬的极简 HTTP 客户端
 * ============================================================================
 *
 * 背景：wiki.arcaea.cn 与镜像 arcwiki.mcd.blue 都由
 *       [Anubis](https://anubis.techaro.lol/) 保护 —— 一个针对 AI 爬虫的
 *       Proof-of-Work 门。**所有路径**（含 /images/、Special:FilePath）都会返回
 *       挑战页，HTTP 200 是挑战页的状态码，不是数据。
 *
 * ⚠️ 两个必须知道的坑（都是实测踩出来的）
 *
 *   1. **WAF 会按 TLS 指纹拦截 Node 的 TLS 1.3 握手。**
 *      默认 `fetch()` / `https.get()` 一律 `ECONNRESET`（连接在 TLS 阶段就被 RST，
 *      连 HTTP 都没发出去），而 curl（Schannel）能过。**强制 TLS 1.2 即通。**
 *      所以本模块不用 `fetch`，改用 `node:https` 并锁定 `TLSv1.2`。
 *
 *   2. **Anubis 的难度是可变的**，实测 `difficulty: 2`（2 个前导零十六进制位，
 *      1/256 概率，毫秒级）。但不要写死 —— 从挑战 JSON 里读。
 *
 * PoW 算法（实测通过）
 *   nonce 从 0 递增，找最小的 n 使
 *       sha256(randomData + String(n))  的前 difficulty 个十六进制字符为 '0'
 *   然后 GET
 *       /.within.website/x/cmd/anubis/api/pass-challenge
 *         ?id=<challenge.id>&response=<hash>&nonce=<n>&redir=<url>&elapsedTime=<ms>
 *   服务端通过 Set-Cookie 下发令牌，后续请求带上即可。
 *
 * 用法
 *   import { anubisFetch } from './lib/anubis-fetch.ts';
 *   const res = await anubisFetch('https://wiki.arcaea.cn/api.php?...');
 *   console.log(res.status, res.text);
 *
 * 依赖：Node.js >= 18，仅标准库。
 */

import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 注释见文件头「坑 1」—— 去掉这两个选项会全线 ECONNRESET */
const TLS_OPTS = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' } as const;

const CHALLENGE_RE =
  /<script id="anubis_challenge" type="application\/json">([\s\S]*?)<\/script>/;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface RawResponse {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  /** 最终请求到的 URL（跟随重定向后可能已变） */
  url: string;
  buffer: Buffer;
  readonly text: string;
}

export interface AnubisResponse extends RawResponse {
  /** 是否经过了解题重放（false = 第一次就拿到数据） */
  solved: boolean;
}

interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  timeout?: number;
  maxRedirects?: number;
}

export interface AnubisFetchOptions extends RawRequestOptions {
  jar?: CookieJar | null;
  /** 挑战通过前的重试上限 */
  maxRetries?: number;
}

export interface ChallengePayload {
  challenge?: { id?: string; randomData?: string };
  rules?: { difficulty?: number };
}

// ---------------------------------------------------------------------------
// 底层请求
// ---------------------------------------------------------------------------

function rawRequest(
  url: string,
  { method = 'GET', headers = {}, body = null, timeout = 30000, maxRedirects = 5 }: RawRequestOptions = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: { 'User-Agent': DEFAULT_UA, 'Accept-Encoding': 'identity', ...headers },
        ...TLS_OPTS,
      },
      (res) => {
        // statusCode 类型上是 number|undefined，实际完成响应后必有值；统一成 number
        const status = res.statusCode ?? 0;
        // 跟随重定向。MediaWiki 的缩略图对部分文件会 301，不跟随会直接失败。
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && maxRedirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          // 303 与 302/301 按惯例把非 GET 降级为 GET
          const nextMethod = status === 303 ? 'GET' : method;
          rawRequest(next, { method: nextMethod, headers, body: nextMethod === 'GET' ? null : body, timeout, maxRedirects: maxRedirects - 1 })
            .then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status,
            headers: res.headers,
            url,
            buffer: Buffer.concat(chunks),
            get text() {
              return Buffer.concat(chunks).toString('utf8');
            },
          })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时 ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cookie 罐（含磁盘持久化，避免每次重跑都解题）
// ---------------------------------------------------------------------------

export class CookieJar {
  private map = new Map<string, string>();
  private file: string | null;

  constructor(file: string | null = null) {
    this.file = file;
  }

  static async load(file: string | null): Promise<CookieJar> {
    const jar = new CookieJar(file);
    if (!file) return jar;
    try {
      const obj = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) jar.map.set(k, v);
    } catch {
      /* 首次运行没有缓存，正常 */
    }
    return jar;
  }

  async save(): Promise<void> {
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch {
      /* 存不下也不影响本次运行 */
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  header(): string {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res: RawResponse): boolean {
    const raw = res.headers['set-cookie'];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    let changed = false;
    for (const c of list) {
      const [pair = ''] = c.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.map.delete(k);
      else this.map.set(k, v);
      changed = true;
    }
    return changed;
  }
}

// ---------------------------------------------------------------------------
// PoW
// ---------------------------------------------------------------------------

const sha256hex = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 解 Anubis 挑战。
 *
 * 算法**逐行对齐**官方 worker（`static/js/worker/sha256-webcrypto.mjs`）：
 *
 *   nonce 从 0 递增（单线程即 +1），计算 h = SHA256(randomData + String(nonce))
 *   要求：h 的前 floor(difficulty/2) 个**字节**为 0
 *         若 difficulty 为奇数，还要求第 floor(difficulty/2) 字节的高 4 位为 0
 *
 * 注意是「字节」不是「十六进制字符」—— difficulty=2 时两者恰好等价（1 字节 = 2 个 hex 位），
 * 但 difficulty=3 时不等价，所以按字节实现。
 */
export function solvePow(
  randomData: string,
  difficulty: number,
  maxAttempts = 200_000_000
): { hash: string; nonce: number; elapsedMs: number } {
  const fullBytes = Math.floor(difficulty / 2);
  const needNibble = difficulty % 2 !== 0;
  const t0 = Date.now();

  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const h = crypto.createHash('sha256').update(randomData + nonce).digest();
    let ok = true;
    for (let i = 0; i < fullBytes; i++) {
      if (h[i] !== 0) {
        ok = false;
        break;
      }
    }
    if (ok && needNibble && h[fullBytes] >> 4 !== 0) ok = false;
    if (ok) return { hash: h.toString('hex'), nonce, elapsedMs: Date.now() - t0 };
  }
  throw new Error(`PoW 在 ${maxAttempts} 次内未解出（difficulty=${difficulty}）`);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 带 Anubis 自动过盾的请求。命中挑战会自动解题、拿 token、重放原请求。
 *
 * @param {string} url
 * @param {object} opts  { jar, method, headers, body, timeout, maxRetries }
 * @returns {Promise<{status:number, headers:object, text:string, buffer:Buffer, solved:boolean}>}
 */
export async function anubisFetch(url: string, opts: AnubisFetchOptions = {}): Promise<AnubisResponse> {
  const { jar, method = 'GET', headers = {}, body = null, timeout = 30000, maxRetries = 2 } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const reqHeaders: Record<string, string> = { ...headers };
    if (jar && jar.size) reqHeaders.Cookie = jar.header();

    const res = await rawRequest(url, { method, headers: reqHeaders, body, timeout });
    if (jar) jar.absorb(res);

    const m = res.text.match(CHALLENGE_RE);

    // 情况 A：不是 Anubis 页面 → 正常返回
    if (!m) return { ...res, solved: attempt > 0 };

    // 情况 B：Anubis 错误页（challenge 为 null）。典型原因是客户端带了**过期/无效的
    //         auth cookie**，Anubis 直接拒绝。清空 cookie 重试一次即可。
    let challenge: ChallengePayload | null = null;
    try {
      challenge = JSON.parse(m[1] ?? '') as ChallengePayload;
    } catch {
      /* 解析失败按错误页处理 */
    }
    if (!challenge || !challenge.challenge) {
      if (jar && jar.size) {
        jar.clear();
        await jar.save();
        continue; // 清干净后重来
      }
      throw new Error(`Anubis 返回错误页且无 cookie 可清：${url}`);
    }

    if (attempt === maxRetries) {
      throw new Error(`Anubis 挑战连续 ${maxRetries + 1} 次未通过：${url}`);
    }

    const difficulty = challenge.rules?.difficulty ?? 2;
    const randomData = challenge.challenge.randomData;
    const id = challenge.challenge.id;
    if (!randomData || !id) throw new Error('Anubis 挑战 JSON 结构异常');

    // ⚠️ Anubis 会做「cookie 往返测试」：挑战页下发的
    //    `techaro.lol-anubis-cookie-verification` 必须在提交答案时带回，
    //    否则服务端直接 500 并提示 "Your browser is configured to disable cookies"。
    //    上面的 jar.absorb(res) 已经把该 cookie 收进来了。
    if (jar && !jar.size) {
      throw new Error('Anubis 挑战页未下发 cookie —— 无法完成往返测试');
    }

    const { hash, nonce, elapsedMs } = solvePow(randomData, difficulty);

    // ⚠️ redir 必须是**绝对 URL**（对齐 main.mjs 的 window.location.href）
    const u = new URL(url);
    const passUrl =
      `${u.origin}/.within.website/x/cmd/anubis/api/pass-challenge?` +
      new URLSearchParams({
        id,
        response: hash,
        nonce: String(nonce),
        redir: url,
        elapsedTime: String(Math.max(elapsedMs, 1)),
      });

    const passRes = await rawRequest(passUrl, {
      headers: {
        Referer: url,
        Cookie: jar ? jar.header() : '', // ← 带上验证 cookie
      },
      timeout,
    });
    if (jar) jar.absorb(passRes);
    await jar?.save();

    // 落到这里说明拿到 token 了，循环重放原请求
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// MediaWiki 便捷封装
// ---------------------------------------------------------------------------

/**
 * 调用 MediaWiki Action API。
 * 未显式传 jar 时会自动建一个（Anubis 的 cookie 往返测试是必需的，不能省）。
 *
 * @param {string} origin  例如 https://wiki.arcaea.cn
 * @param {object} params  action=query&... 之类的键值对
 */
export async function mwApi(
  origin: string,
  params: Record<string, string>,
  opts: AnubisFetchOptions & { cookieFile?: string | null } = {}
): Promise<any> {
  const jar = opts.jar ?? (await CookieJar.load(opts.cookieFile ?? null));
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const url = `${origin}/api.php?${qs}`;
  const res = await anubisFetch(url, { ...opts, jar });
  if (res.status !== 200) throw new Error(`MediaWiki API HTTP ${res.status}: ${url}`);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`MediaWiki API 返回非 JSON（可能仍是挑战页）：${res.text.slice(0, 200)}`);
  }
}

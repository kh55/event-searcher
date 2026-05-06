// 自己同定 UA だと t.pia.jp の WAF が 403 を返すため、一般的なブラウザ寄りの UA を既定にする。
// scrapers/__fixtures__/ 配下の HTML は実ブラウザで取得したもので、こちらを再現する目的。
// robots.txt 遵守と低レート(2秒/req)は維持しているので、運用上の責任は変わらない。
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FetchHtmlOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchHtml(url: string, opts: FetchHtmlOptions = {}): Promise<string> {
  const f = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await f(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// JSON API 用の薄いラッパー。fetchHtml の UA / Accept-Language / タイムアウト処理を再利用する。
export async function fetchJson<T = unknown>(url: string, opts: FetchHtmlOptions = {}): Promise<T> {
  const text = await fetchHtml(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
  });
  return JSON.parse(text) as T;
}

// 並列実行のための簡易レートリミッタ
export class RateLimiter {
  private last = 0;
  constructor(private minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const wait = this.last + this.minIntervalMs - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.last = Date.now();
  }
}

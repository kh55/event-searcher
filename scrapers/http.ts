export const USER_AGENT = 'event-searcher/0.1 (+https://github.com/your/event-searcher)';

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
        'Accept': 'text/html,*/*;q=0.8',
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

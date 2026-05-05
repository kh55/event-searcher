import { describe, it, expect, vi } from 'vitest';
import { fetchHtml, USER_AGENT } from '@/scrapers/http';

describe('fetchHtml', () => {
  it('GET でテキストを取得し、UA ヘッダを付ける', async () => {
    const calls: { url: string; init: any }[] = [];
    const mockFetch = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response('<html>ok</html>', { status: 200 });
    });
    const html = await fetchHtml('https://example.com', { fetch: mockFetch as any });
    expect(html).toBe('<html>ok</html>');
    expect(calls[0].init.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('non-2xx で例外を投げる', async () => {
    const mockFetch = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(fetchHtml('https://example.com', { fetch: mockFetch as any }))
      .rejects.toThrow(/500/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { peatixAdapter } from '@/scrapers/peatix';

const FIXTURE = readFileSync(
  join(__dirname, '../../scrapers/__fixtures__/peatix/search-result.json'),
  'utf-8',
);

const baseParams = {
  // fixture の event は 2026-05-22。十分広い範囲を取る。
  dateFrom: new Date('2026-01-01'),
  dateTo: new Date('2027-01-01'),
  includeOnline: true,
};

function fakeFetch() {
  return vi.fn(async () => new Response(FIXTURE, { status: 200 }));
}

describe('peatixAdapter.search', () => {
  it('parses fixture JSON into RawEvent[] with required fields', async () => {
    const events = await peatixAdapter.search(baseParams, {
      fetch: fakeFetch() as unknown as typeof fetch,
    });
    expect(events.length).toBeGreaterThan(0);

    const e = events[0];
    expect(e.sourceEventId).toMatch(/^peatix-\d+$/);
    expect(e.title.length).toBeGreaterThan(0);
    expect(e.startsAt).toBeInstanceOf(Date);
    expect(isNaN(e.startsAt.getTime())).toBe(false);
    expect(e.ticketUrl).toMatch(/^https:\/\/peatix\.com\/event\/\d+/);
    expect(['on_sale', 'sold_out', 'ended', 'lottery', 'unknown']).toContain(e.ticketStatus);
    expect(typeof e.isOnline).toBe('boolean');
    expect(Array.isArray(e.performers)).toBe(true);
    expect(Array.isArray(e.tags)).toBe(true);
  });

  it('marks online events when locationType=online', async () => {
    const events = await peatixAdapter.search(baseParams, {
      fetch: fakeFetch() as unknown as typeof fetch,
    });
    // fixture には physical 1 件 + online 1 件が入っている
    expect(events.some(e => e.isOnline)).toBe(true);
    expect(events.some(e => !e.isOnline)).toBe(true);
  });

  it('excludes online events when includeOnline=false', async () => {
    const events = await peatixAdapter.search(
      { ...baseParams, includeOnline: false },
      { fetch: fakeFetch() as unknown as typeof fetch },
    );
    expect(events.every(e => !e.isOnline)).toBe(true);
  });

  it('filters out events outside dateFrom/dateTo (client-side)', async () => {
    // fixture イベントは 2026-05-22 だけなので、それより前の窓で空配列を期待
    const events = await peatixAdapter.search(
      {
        ...baseParams,
        dateFrom: new Date('2025-01-01'),
        dateTo: new Date('2025-12-31'),
      },
      { fetch: fakeFetch() as unknown as typeof fetch },
    );
    expect(events).toEqual([]);
  });

  it('returns empty array when API returns empty data', async () => {
    const empty = JSON.stringify({ data: [], paginationInfo: { totalItems: 0 } });
    const f = vi.fn(async () => new Response(empty, { status: 200 }));
    const events = await peatixAdapter.search(baseParams, {
      fetch: f as unknown as typeof fetch,
    });
    expect(events).toEqual([]);
  });

  it('throws on HTTP error from upstream API', async () => {
    const f = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      peatixAdapter.search(baseParams, { fetch: f as unknown as typeof fetch }),
    ).rejects.toThrow(/->\s*403/);
  });

  it('keyword is propagated to the API URL', async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toContain('keyword=' + encodeURIComponent('花江夏樹'));
      expect(url).toContain('country_id=392');
      return new Response('{"data":[]}', { status: 200 });
    });
    await peatixAdapter.search(
      { ...baseParams, keyword: '花江夏樹' },
      { fetch: f as unknown as typeof fetch },
    );
    expect(f).toHaveBeenCalledOnce();
  });
});

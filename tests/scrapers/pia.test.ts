import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { piaAdapter, parsePiaDate } from '@/scrapers/pia';

const FIXTURE = readFileSync(
  join(__dirname, '../../scrapers/__fixtures__/pia/search-result.html'),
  'utf-8',
);

describe('parsePiaDate', () => {
  it('parses single-day format', () => {
    const d = parsePiaDate('2026/5/5(火・祝)');
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-05-05T00:00:00.000Z');
  });

  it('parses range format and returns start date', () => {
    const d = parsePiaDate('2026/5/2(土) ～ 2026/5/5(火・祝)');
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });

  it('returns null for empty string', () => {
    expect(parsePiaDate('')).toBeNull();
  });
});

describe('piaAdapter.search', () => {
  it('parses fixture and returns RawEvent[] with required fields', async () => {
    // Inject fake fetch that returns the real fixture HTML
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      {
        keyword: 'ライブ',
        dateFrom: new Date('2026-05-01'),
        dateTo: new Date('2026-05-31'),
        includeOnline: true,
      },
      { fetch: fakeFetch as unknown as typeof fetch },
    );

    expect(events.length).toBeGreaterThan(0);

    const e = events[0];
    // Required fields
    expect(e.title).toMatch(/.+/);
    expect(e.startsAt).toBeInstanceOf(Date);
    expect(isNaN(e.startsAt.getTime())).toBe(false);
    expect(e.sourceEventId).toMatch(/^pia-/);
    expect(['on_sale', 'sold_out', 'ended', 'lottery', 'unknown']).toContain(e.ticketStatus);
    expect(typeof e.isOnline).toBe('boolean');
    expect(Array.isArray(e.performers)).toBe(true);
    expect(Array.isArray(e.tags)).toBe(true);
  });

  it('returns on_sale status for 販売期間中', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      { keyword: 'ライブ', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const onSaleEvents = events.filter(e => e.ticketStatus === 'on_sale');
    expect(onSaleEvents.length).toBeGreaterThan(0);
  });

  it('detects online events (PIA LIVE STREAM is online)', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      { keyword: 'ライブ', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const onlineEvents = events.filter(e => e.isOnline);
    // The fixture has a "ＰＩＡ　ＬＩＶＥ　ＳＴＲＥＡＭ" venue which has 配信 in its title
    expect(onlineEvents.length).toBeGreaterThan(0);
  });

  it('returns empty array when ptotalcnt is 0', async () => {
    const emptyHtml =
      '<div id="contents_html">' +
      '<input type="hidden" name="ptotalcnt" value="0" />' +
      '<ul></ul>' +
      '</div>';
    const fakeFetch = vi.fn(async () => new Response(emptyHtml, { status: 200 }));
    const events = await piaAdapter.search(
      { keyword: 'noresult', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events).toEqual([]);
  });

  it('returns empty array for no-HTML response', async () => {
    const noResult = '<html><body><p>該当するイベントはありません</p></body></html>';
    const fakeFetch = vi.fn(async () => new Response(noResult, { status: 200 }));
    const events = await piaAdapter.search(
      { keyword: 'noresult', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events).toEqual([]);
  });

  it('has ticketUrl that starts with http', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      { keyword: 'ライブ', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const withUrl = events.filter(e => e.ticketUrl);
    expect(withUrl.length).toBeGreaterThan(0);
    withUrl.forEach(e => {
      expect(e.ticketUrl).toMatch(/^https?:\/\//);
    });
  });
});

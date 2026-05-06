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
  // パース動作の確認時は keyword を外す。keyword フィルタの挙動は後段の専用テストで検証。
  it('parses fixture and returns RawEvent[] with required fields', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      {
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
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const onSaleEvents = events.filter(e => e.ticketStatus === 'on_sale');
    expect(onSaleEvents.length).toBeGreaterThan(0);
  });

  it('detects online events (PIA LIVE STREAM is online)', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
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

  it('throws when response is missing ptotalcnt input (blocked / unexpected page)', async () => {
    // 200 OK で ptotalcnt が無い HTML を返されたら「正規の 0 件」と区別できないため throw する。
    // これにより scrape_runs に failed として記録され、success / events_found=0 に
    // 隠れていたブロック状態を可視化できる。
    const noResult = '<html><body><p>該当するイベントはありません</p></body></html>';
    const fakeFetch = vi.fn(async () => new Response(noResult, { status: 200 }));
    await expect(
      piaAdapter.search(
        { keyword: 'noresult', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/ptotalcnt/);
  });

  it('has ticketUrl that starts with http', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const withUrl = events.filter(e => e.ticketUrl);
    expect(withUrl.length).toBeGreaterThan(0);
    withUrl.forEach(e => {
      expect(e.ticketUrl).toMatch(/^https?:\/\//);
    });
  });

  it('drops releases whose title / bundle / venue do not contain keyword', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const baseParams = { dateFrom: new Date(), dateTo: new Date(), includeOnline: true };

    const all = await piaAdapter.search(baseParams, {
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const filtered = await piaAdapter.search(
      { ...baseParams, keyword: 'ゆず' },
      { fetch: fakeFetch as unknown as typeof fetch },
    );

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(all.length);
    // 「ゆず」を含まない release(YAESU LAUGH WEEK 系)が落ちていることを確認
    expect(filtered.every(e => `${e.title} ${e.performers.join(' ')} ${e.venueName ?? ''}`
      .toLowerCase()
      .includes('ゆず'))).toBe(true);
  });

  it('keeps all releases when keyword is omitted', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events.length).toBeGreaterThan(1);
  });
});

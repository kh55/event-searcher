import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkerplusAdapter, parseWalkerplusDate } from '@/scrapers/walkerplus';

const FIXTURE = readFileSync(
  join(__dirname, '../../scrapers/__fixtures__/walkerplus/search-result.html'),
  'utf-8',
);

describe('parseWalkerplusDate', () => {
  it('parses Japanese date format', () => {
    const d = parseWalkerplusDate('2026年3月27日(金)');
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-03-27T00:00:00.000Z');
  });

  it('parses range format and returns start date', () => {
    const d = parseWalkerplusDate('2026年3月27日(金)～9月30日(水)');
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-03-27T00:00:00.000Z');
  });

  it('returns null for empty string', () => {
    expect(parseWalkerplusDate('')).toBeNull();
  });

  it('returns null for invalid text', () => {
    expect(parseWalkerplusDate('invalid text')).toBeNull();
  });
});

describe('walkerplusAdapter.search', () => {
  it('parses fixture and returns RawEvent[]', async () => {
    // keywordなしで全件取得
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await walkerplusAdapter.search(
      {
        dateFrom: new Date('2026-05-01'),
        dateTo: new Date('2026-05-31'),
        includeOnline: true,
      },
      { fetch: fakeFetch as unknown as typeof fetch },
    );

    expect(events.length).toBeGreaterThan(0);

    const e = events[0];
    expect(e.title).toMatch(/.+/);
    expect(e.startsAt).toBeInstanceOf(Date);
    expect(isNaN(e.startsAt.getTime())).toBe(false);
    expect(e.sourceEventId).toMatch(/^walkerplus-/);
    expect(['on_sale', 'sold_out', 'ended', 'lottery', 'unknown']).toContain(e.ticketStatus);
    expect(typeof e.isOnline).toBe('boolean');
    expect(Array.isArray(e.performers)).toBe(true);
    expect(Array.isArray(e.tags)).toBe(true);
  });

  it('maps __end (終了間近) and __open (開催中) both to on_sale', async () => {
    // Walkerplus の __end クラスは「終了間近」(まだ販売中) を意味し、
    // 終了済みではないので on_sale にマップされること
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await walkerplusAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    // フィクスチャに __end と __open のいずれかが少なくとも1つ含まれているはず
    // それらはすべて on_sale になっていなければならない
    expect(events.every(e => e.ticketStatus === 'on_sale' || e.ticketStatus === 'unknown')).toBe(true);
    expect(events.some(e => e.ticketStatus === 'on_sale')).toBe(true);
  });

  it('has ticketUrl that points to walkerplus.com', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await walkerplusAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events.length).toBeGreaterThan(0);
    events.forEach(e => {
      expect(e.ticketUrl).toMatch(/^https:\/\/www\.walkerplus\.com\/event\//);
    });
  });

  it('filters by keyword on client side', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    // Use a keyword that will match nothing
    const events = await walkerplusAdapter.search(
      {
        keyword: 'ZZZ_NO_MATCH_ZZZ_99999',
        dateFrom: new Date(),
        dateTo: new Date(),
        includeOnline: true,
      },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events).toEqual([]);
  });

  it('returns events matching keyword ドラえもん', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await walkerplusAdapter.search(
      {
        keyword: 'ドラえもん',
        dateFrom: new Date(),
        dateTo: new Date(),
        includeOnline: true,
      },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events.length).toBeGreaterThan(0);
    events.forEach(e => {
      expect(e.title.toLowerCase()).toContain('ドラえもん'.toLowerCase());
    });
  });

  it('returns empty array when no event items in HTML', async () => {
    const empty = '<html><body><ul class="m-mainlist__list"></ul></body></html>';
    const fakeFetch = vi.fn(async () => new Response(empty, { status: 200 }));
    const events = await walkerplusAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(events).toEqual([]);
  });

  it('returns correct source name', () => {
    expect(walkerplusAdapter.source).toBe('walkerplus');
  });

  it('includes prefecture from map links', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await walkerplusAdapter.search(
      { dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const withPref = events.filter(e => e.prefecture);
    expect(withPref.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { buildSearchQueryParams } from '@/lib/search/query';

describe('buildSearchQueryParams', () => {
  it('全文検索条件 + 日付 + on_sale_only でパラメータが揃う', () => {
    const p = buildSearchQueryParams({
      q: '花江夏樹',
      from: new Date('2026-05-09T00:00:00Z'),
      to:   new Date('2026-05-10T23:59:59Z'),
      areas: ['関東'],
      includeOnline: false,
      onSaleOnly: true,
    });
    expect(p.q).toBe('花江夏樹');
    expect(p.fromIso).toBe('2026-05-09T00:00:00.000Z');
    expect(p.toIso).toBe('2026-05-10T23:59:59.000Z');
    expect(p.areas).toEqual(['関東']);
    expect(p.includeOnline).toBe(false);
    expect(p.onSaleOnly).toBe(true);
  });

  it('areas が空のときは null', () => {
    const p = buildSearchQueryParams({
      q: '', from: new Date(), to: new Date(), areas: [],
      includeOnline: true, onSaleOnly: false,
    });
    expect(p.areas).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { searchInputSchema } from '@/app/api/search/route';

describe('searchInputSchema', () => {
  it('正しい入力をパースできる', () => {
    const r = searchInputSchema.parse({
      q: '花江夏樹',
      from: '2026-05-09T00:00:00+09:00',
      to:   '2026-05-10T23:59:59+09:00',
      areas: ['関東'],
      include_online: false,
      on_sale_only: true,
    });
    expect(r.q).toBe('花江夏樹');
    expect(r.from).toBeInstanceOf(Date);
  });

  it('既定値が補完される', () => {
    const r = searchInputSchema.parse({
      from: '2026-05-09T00:00:00Z',
      to:   '2026-05-10T23:59:59Z',
    });
    expect(r.q).toBe('');
    expect(r.areas).toEqual([]);
    expect(r.include_online).toBe(false);
    expect(r.on_sale_only).toBe(true);
  });

  it('from > to ならエラー', () => {
    expect(() => searchInputSchema.parse({
      from: '2026-06-01T00:00:00Z', to: '2026-05-01T00:00:00Z',
    })).toThrow();
  });
});

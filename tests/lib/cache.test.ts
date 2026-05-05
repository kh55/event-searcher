import { describe, it, expect } from 'vitest';
import { generateCacheKey } from '@/lib/cache';

describe('generateCacheKey', () => {
  it('同じ入力は同じキー', () => {
    const k1 = generateCacheKey({ q: 'x', from: '2026-01', to: '2026-02', areas: ['関東'], includeOnline: false, onSaleOnly: true });
    const k2 = generateCacheKey({ q: 'x', from: '2026-01', to: '2026-02', areas: ['関東'], includeOnline: false, onSaleOnly: true });
    expect(k1).toBe(k2);
  });

  it('areas の順序に依存しない', () => {
    const k1 = generateCacheKey({ q: 'x', from: 'a', to: 'b', areas: ['関東','近畿'], includeOnline: false, onSaleOnly: true });
    const k2 = generateCacheKey({ q: 'x', from: 'a', to: 'b', areas: ['近畿','関東'], includeOnline: false, onSaleOnly: true });
    expect(k1).toBe(k2);
  });

  it('q が違えばキーも違う', () => {
    const a = generateCacheKey({ q: 'a', from: '', to: '', areas: [], includeOnline: false, onSaleOnly: true });
    const b = generateCacheKey({ q: 'b', from: '', to: '', areas: [], includeOnline: false, onSaleOnly: true });
    expect(a).not.toBe(b);
  });

  it('64文字の hex を返す', () => {
    const k = generateCacheKey({ q: '', from: '', to: '', areas: [], includeOnline: false, onSaleOnly: true });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

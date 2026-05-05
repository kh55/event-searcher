import { describe, it, expect } from 'vitest';
import { getThisWeekend, getNextWeekend } from '@/lib/date';

describe('getThisWeekend', () => {
  it('月曜から見ると今週末は今週の土日(2026-05-09 土〜2026-05-10 日)', () => {
    const now = new Date('2026-05-04T10:00:00+09:00'); // 月
    const r = getThisWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-08T15:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-05-10T14:59:59.999Z');
  });

  it('土曜の朝でも今週末はその土日', () => {
    const now = new Date('2026-05-09T08:00:00+09:00'); // 土
    const r = getThisWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-08T15:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-05-10T14:59:59.999Z');
  });

  it('日曜の夜でも今週末はその土日', () => {
    const now = new Date('2026-05-10T22:00:00+09:00'); // 日
    const r = getThisWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-08T15:00:00.000Z');
  });
});

describe('getNextWeekend', () => {
  it('月曜から見ると来週末は来週の土日', () => {
    const now = new Date('2026-05-04T10:00:00+09:00'); // 月
    const r = getNextWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-15T15:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-05-17T14:59:59.999Z');
  });

  it('日曜から見ると来週末は次の土日', () => {
    const now = new Date('2026-05-10T10:00:00+09:00'); // 日
    const r = getNextWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-15T15:00:00.000Z');
  });
});

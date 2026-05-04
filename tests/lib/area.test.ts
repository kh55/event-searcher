import { describe, it, expect } from 'vitest';
import { prefectureToArea, prefecturesInArea, AREAS } from '@/lib/area';

describe('prefectureToArea', () => {
  it.each([
    ['東京都', '関東'],
    ['神奈川県', '関東'],
    ['大阪府', '近畿'],
    ['愛知県', '東海'],
    ['北海道', '北海道/東北'],
    ['福島県', '北海道/東北'],
    ['新潟県', '北陸'],
    ['広島県', '中国/四国'],
    ['沖縄県', '九州/沖縄'],
  ])('%s -> %s', (pref, expected) => {
    expect(prefectureToArea(pref)).toBe(expected);
  });

  it('returns null for unknown prefecture', () => {
    expect(prefectureToArea('火星都')).toBeNull();
  });

  it('handles empty string', () => {
    expect(prefectureToArea('')).toBeNull();
  });
});

describe('prefecturesInArea', () => {
  it('関東 contains 7 prefectures', () => {
    const list = prefecturesInArea('関東');
    expect(list).toContain('東京都');
    expect(list).toContain('神奈川県');
    expect(list).toHaveLength(7);
  });
});

describe('AREAS', () => {
  it('exposes the 7 area names in order', () => {
    expect(AREAS).toEqual([
      '関東', '近畿', '東海', '北海道/東北', '北陸', '中国/四国', '九州/沖縄',
    ]);
  });
});

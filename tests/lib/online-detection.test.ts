import { describe, it, expect } from 'vitest';
import { isOnlineEvent } from '@/lib/online-detection';

describe('isOnlineEvent', () => {
  it.each([
    ['【オンライン配信】トークイベント', '', '', true],
    ['ライブ',                          '生配信あり', '', true],
    ['ライブ',                          '',           'ライブ配信会場', true],
    ['ライブ',                          '',           'パシフィコ横浜', false],
    ['LIVE STREAMING SHOW',              '',           '', true],
    ['ライブビューイング併催',            '',           '', true],
    ['',                                 '',           '', false],
  ])('title=%s desc=%s venue=%s -> %s', (title, desc, venue, expected) => {
    expect(isOnlineEvent({ title, description: desc, venueName: venue })).toBe(expected);
  });
});

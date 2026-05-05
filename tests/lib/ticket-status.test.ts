import { describe, it, expect } from 'vitest';
import { normalizeTicketStatus } from '@/lib/ticket-status';

describe('normalizeTicketStatus', () => {
  it.each([
    ['発売中',     'on_sale'],
    ['販売中',     'on_sale'],
    ['チケット発売中', 'on_sale'],
    ['SOLD OUT',  'sold_out'],
    ['完売',       'sold_out'],
    ['終了',       'ended'],
    ['販売終了',   'ended'],
    ['抽選受付中', 'lottery'],
    ['先行抽選',   'lottery'],
    ['',           'unknown'],
    ['謎の状態',   'unknown'],
  ])('"%s" -> %s', (input, expected) => {
    expect(normalizeTicketStatus(input)).toBe(expected);
  });
});

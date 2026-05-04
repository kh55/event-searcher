export type TicketStatus = 'on_sale' | 'sold_out' | 'ended' | 'lottery' | 'unknown';

export function normalizeTicketStatus(rawText: string): TicketStatus {
  const t = (rawText || '').trim().toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('sold out') || t.includes('完売')) return 'sold_out';
  if (t.includes('抽選') || t.includes('先行')) return 'lottery';
  if (t.includes('終了') || t.includes('販売終了')) return 'ended';
  if (t.includes('発売中') || t.includes('販売中') || t.includes('受付中')) return 'on_sale';
  return 'unknown';
}

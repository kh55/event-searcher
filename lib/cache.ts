import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface SearchKey {
  q: string;
  from: string;
  to: string;
  areas: string[];
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export function generateCacheKey(k: SearchKey): string {
  const norm = {
    q: k.q ?? '',
    from: k.from,
    to: k.to,
    areas: [...k.areas].sort(),
    includeOnline: !!k.includeOnline,
    onSaleOnly: !!k.onSaleOnly,
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

const TTL_HOURS = 6;

export async function getCachedEventIds(
  pool: Pool,
  key: string,
): Promise<number[] | null> {
  // 注: BIGINT[] は pg のデフォルト型変換で string[] として返るため
  // Number() で number[] に変換する。実イベント ID は Number.MAX_SAFE_INTEGER
  // の範囲に収まる前提。
  const { rows } = await pool.query<{ event_ids: string[]; expires_at: Date }>(
    `SELECT event_ids, expires_at FROM search_cache WHERE cache_key = $1 LIMIT 1`,
    [key],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.event_ids.map(Number);
}

export async function setCachedEventIds(
  pool: Pool,
  key: string,
  eventIds: number[],
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  await pool.query(
    `INSERT INTO search_cache (cache_key, event_ids, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (cache_key) DO UPDATE SET
       event_ids = EXCLUDED.event_ids,
       expires_at = EXCLUDED.expires_at,
       created_at = NOW()`,
    [key, eventIds, expiresAt],
  );
}

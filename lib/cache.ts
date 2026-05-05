import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SearchKey {
  q: string;
  from: string;       // ISO
  to: string;         // ISO
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
  client: SupabaseClient,
  key: string,
): Promise<number[] | null> {
  // 注: Postgres の BIGINT[] は Supabase JS クライアント経由では number[] として返る
  // (JSON パース時に bigint プリミティブにはならない)。実イベント ID は
  // Number.MAX_SAFE_INTEGER の範囲に収まる前提。
  const { data, error } = await client
    .from('search_cache')
    .select('event_ids,expires_at')
    .eq('cache_key', key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.event_ids;
}

export async function setCachedEventIds(
  client: SupabaseClient,
  key: string,
  eventIds: number[],
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  const { error } = await client
    .from('search_cache')
    .upsert({ cache_key: key, event_ids: eventIds, expires_at: expiresAt });
  if (error) throw error;
}

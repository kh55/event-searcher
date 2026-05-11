/**
 * 検索オーケストレーション
 *
 * ハイブリッド取得戦略:
 *   1. db_only  — q が空のとき DB のみ参照(saved_keywords を OR フィルタとして使う)
 *   2. batch    — saved_keywords に登録済みのキーワードは cron で取込済みとみなす
 *   3. cache    — search_cache テーブルに有効なエントリがあれば DB 検索のみ行う (6h TTL)
 *   4. on_demand — キャッシュなし → 全アダプタを逐次実行してイベントを upsert し、キャッシュ登録
 *
 * 既知の制限(spec の known_constraints 参照):
 *   - performers @> ARRAY[X] は配列要素の完全一致なので、長文 bundleTitle 中の部分一致は引けない。
 *     将来 events_search_doc(GIN tsvector)を使うクエリへの置き換えで根治する想定。
 */

import type { Pool } from 'pg';
import { generateCacheKey, getCachedEventIds, setCachedEventIds } from '@/lib/cache';
import { buildSearchQueryParams, type SearchInput, type QueryParams } from './query';
import { piaAdapter } from '@/scrapers/pia';
import { walkerplusAdapter } from '@/scrapers/walkerplus';
import { peatixAdapter } from '@/scrapers/peatix';
import { prefecturesInArea, prefectureToArea, AREAS, type Area } from '@/lib/area';
import { isOnlineEvent } from '@/lib/online-detection';
import { RateLimiter } from '@/scrapers/http';
import type { RawEvent, SourceAdapter } from '@/scrapers/types';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter, peatixAdapter];
const adapterLimiter = new RateLimiter(2000);

export type FetchStrategy = 'db_only' | 'batch' | 'cache' | 'on_demand';

export interface SearchResult {
  events: any[];
  meta: {
    fetched_strategy: FetchStrategy;
    fetched_at: string;
    sources_succeeded: string[];
    sources_failed: string[];
  };
}

export async function searchEvents(
  pool: Pool,
  input: SearchInput,
): Promise<SearchResult> {
  const params = buildSearchQueryParams(input);

  let strategy: FetchStrategy;
  let cacheKey: string | null = null;
  const sourcesFailed: string[] = [];
  const sourcesSucceeded: string[] = [];
  let queryKeywords: string[];

  if (!input.q) {
    strategy = 'db_only';
    const { rows } = await pool.query<{ keyword: string }>(
      'SELECT keyword FROM saved_keywords',
    );
    queryKeywords = rows.map(r => r.keyword).filter(Boolean);
  } else {
    queryKeywords = [input.q];
    cacheKey = generateCacheKey({
      q: params.q,
      from: params.fromIso,
      to: params.toIso,
      areas: params.areas ?? [],
      includeOnline: params.includeOnline,
      onSaleOnly: params.onSaleOnly,
    });

    const { rowCount } = await pool.query(
      'SELECT id FROM saved_keywords WHERE keyword = $1 LIMIT 1',
      [input.q],
    );

    if (rowCount && rowCount > 0) {
      strategy = 'batch';
    } else {
      const cached = await getCachedEventIds(pool, cacheKey);
      if (cached) {
        strategy = 'cache';
      } else {
        const fetchResult = await runOnDemandFetch(pool, input);
        sourcesFailed.push(...fetchResult.failed);
        sourcesSucceeded.push(...fetchResult.succeeded);
        strategy = 'on_demand';
      }
    }
  }

  const events = await runDbSearch(pool, params, queryKeywords);

  if (strategy === 'on_demand' && cacheKey) {
    const ids = events.map((r: any) => r.id as number);
    await setCachedEventIds(pool, cacheKey, ids);
  }

  return {
    events,
    meta: {
      fetched_strategy: strategy,
      fetched_at: new Date().toISOString(),
      sources_succeeded: sourcesSucceeded,
      sources_failed: sourcesFailed,
    },
  };
}

interface FetchSummary {
  succeeded: string[];
  failed: string[];
}

async function runOnDemandFetch(
  pool: Pool,
  input: SearchInput,
): Promise<FetchSummary> {
  const searchParams = {
    keyword: input.q || undefined,
    dateFrom: input.from,
    dateTo: input.to,
    prefectures: input.areas
      .filter((a): a is Area => (AREAS as readonly string[]).includes(a))
      .flatMap(a => prefecturesInArea(a)),
    includeOnline: input.includeOnline,
  };

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const adapter of ADAPTERS) {
    await adapterLimiter.wait();
    const startedAt = new Date();
    let status: 'success' | 'failed' = 'success';
    let count = 0;
    let errMsg: string | null = null;
    try {
      const events = await adapter.search(searchParams);
      await upsertEvents(pool, adapter.source, events);
      count = events.length;
      succeeded.push(adapter.source);
    } catch (e: unknown) {
      status = 'failed';
      errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[search] adapter ${adapter.source} failed:`, e);
      failed.push(adapter.source);
    }
    await pool.query(
      `INSERT INTO scrape_runs
       (source, keyword, trigger, events_found, status, error_message, started_at, finished_at)
       VALUES ($1, $2, 'on_demand', $3, $4, $5, $6, $7)`,
      [
        adapter.source,
        input.q ?? null,
        count,
        status,
        errMsg,
        startedAt.toISOString(),
        new Date().toISOString(),
      ],
    );
  }

  return { succeeded, failed };
}

async function upsertEvents(
  pool: Pool,
  source: string,
  raws: RawEvent[],
): Promise<void> {
  if (raws.length === 0) return;

  const now = new Date().toISOString();

  const valuesSql: string[] = [];
  const params: unknown[] = [];
  const COLS_PER_ROW = 16;

  raws.forEach((r, i) => {
    const base = i * COLS_PER_ROW;
    valuesSql.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
      `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
      `$${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16})`,
    );
    params.push(
      source,
      r.sourceEventId,
      r.title,
      r.description ?? null,
      r.startsAt.toISOString(),
      r.endsAt?.toISOString() ?? null,
      r.venueName ?? null,
      r.prefecture ?? null,
      r.prefecture ? prefectureToArea(r.prefecture) : null,
      r.isOnline || isOnlineEvent({
        title: r.title,
        description: r.description,
        venueName: r.venueName,
      }),
      r.ticketUrl ?? null,
      r.ticketStatus,
      r.performers,
      r.tags,
      now,
      now,
    );
  });

  const sql = `
    INSERT INTO events
      (source, source_event_id, title, description, starts_at, ends_at,
       venue_name, prefecture, area, is_online, ticket_url, ticket_status,
       performers, tags, fetched_at, updated_at)
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (source, source_event_id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      venue_name = EXCLUDED.venue_name,
      prefecture = EXCLUDED.prefecture,
      area = EXCLUDED.area,
      is_online = EXCLUDED.is_online,
      ticket_url = EXCLUDED.ticket_url,
      ticket_status = EXCLUDED.ticket_status,
      performers = EXCLUDED.performers,
      tags = EXCLUDED.tags,
      fetched_at = EXCLUDED.fetched_at,
      updated_at = EXCLUDED.updated_at
  `;
  await pool.query(sql, params);
}

async function runDbSearch(
  pool: Pool,
  p: QueryParams,
  keywords: string[],
): Promise<any[]> {
  // sanitize: prepared statement なので filter injection は元から無いが、リグレッション最小化
  // のため既存の置換ロジックは維持する。
  const safeKeywords = keywords
    .map(k => k.replace(/[,()"*\\{}]/g, ' ').trim())
    .filter(k => k.length > 0);

  const conditions: string[] = ['starts_at >= $1', 'starts_at <= $2'];
  const params: unknown[] = [p.fromIso, p.toIso];

  if (safeKeywords.length > 0) {
    params.push(safeKeywords);
    const idx = params.length;
    conditions.push(`EXISTS (
      SELECT 1 FROM unnest($${idx}::text[]) AS kw
      WHERE title ILIKE '%' || kw || '%'
         OR description ILIKE '%' || kw || '%'
         OR performers @> ARRAY[kw]::text[]
    )`);
  }

  if (p.areas) {
    params.push(p.areas);
    const idx = params.length;
    if (p.includeOnline) {
      conditions.push(`(area = ANY($${idx}::text[]) OR is_online = true)`);
    } else {
      conditions.push(`area = ANY($${idx}::text[])`);
      conditions.push(`is_online = false`);
    }
  } else if (!p.includeOnline) {
    conditions.push(`is_online = false`);
  }

  if (p.onSaleOnly) {
    conditions.push(`ticket_status = ANY(ARRAY['on_sale','lottery']::text[])`);
  }

  const sql = `
    SELECT * FROM events
    WHERE ${conditions.join(' AND ')}
    ORDER BY starts_at ASC
    LIMIT 200
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

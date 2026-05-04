/**
 * 検索オーケストレーション
 *
 * ハイブリッド取得戦略:
 *   1. batch    — saved_keywords に登録済みのキーワードは GitHub Actions cron で取込済みとみなす
 *   2. cache    — search_cache テーブルに有効なエントリがあれば DB 検索のみ行う (6h TTL)
 *   3. on_demand — キャッシュなし → 全アダプタを並列実行してイベントを upsert し、キャッシュ登録
 *
 * 既知の制限:
 *   - piaAdapter は dateFrom/dateTo を API に渡さないため範囲外イベントも upsert される。
 *     ただし runDbSearch の starts_at フィルタで最終的に絞り込まれる。
 *   - walkerplusAdapter は最初の1ページ (約10件) しか取得しない。
 *   - area 名に "/" が含まれる (例: '北海道/東北')。PostgREST の or() フィルタで
 *     ダブルクォートで囲むことで特殊文字を回避する。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateCacheKey, getCachedEventIds, setCachedEventIds } from '@/lib/cache';
import { buildSearchQueryParams, type SearchInput, type QueryParams } from './query';
import { piaAdapter } from '@/scrapers/pia';
import { walkerplusAdapter } from '@/scrapers/walkerplus';
import { prefecturesInArea, prefectureToArea, AREAS, type Area } from '@/lib/area';
import { isOnlineEvent } from '@/lib/online-detection';
import type { RawEvent, SourceAdapter } from '@/scrapers/types';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter];

export type FetchStrategy = 'batch' | 'cache' | 'on_demand';

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
  client: SupabaseClient,
  input: SearchInput,
): Promise<SearchResult> {
  const params = buildSearchQueryParams(input);
  const cacheKey = generateCacheKey({
    q: params.q,
    from: params.fromIso,
    to: params.toIso,
    areas: params.areas ?? [],
    includeOnline: params.includeOnline,
    onSaleOnly: params.onSaleOnly,
  });

  let strategy: FetchStrategy = 'batch';
  const sourcesFailed: string[] = [];
  const sourcesSucceeded: string[] = [];

  if (input.q) {
    // 1. saved_keywords に登録済みか確認(バッチ取得済みとみなす)
    const { data: saved } = await client
      .from('saved_keywords')
      .select('id')
      .eq('keyword', input.q)
      .maybeSingle();

    if (!saved) {
      // 2. キャッシュ確認
      const cached = await getCachedEventIds(client, cacheKey);
      if (cached) {
        strategy = 'cache';
      } else {
        // 3. オンデマンド取得
        const fetchResult = await runOnDemandFetch(client, input);
        sourcesFailed.push(...fetchResult.failed);
        sourcesSucceeded.push(...fetchResult.succeeded);

        // DB 検索してキャッシュ登録
        const ids = await runDbSearch(client, params).then(rows =>
          rows.map((r: any) => r.id as number),
        );
        await setCachedEventIds(client, cacheKey, ids);
        strategy = 'on_demand';
      }
    }
  }

  const events = await runDbSearch(client, params);

  // sources_succeeded/failed が未設定(batch/cache 戦略)の場合はメタ情報として全アダプタ名を返す
  return {
    events,
    meta: {
      fetched_strategy: strategy,
      fetched_at: new Date().toISOString(),
      sources_succeeded: sourcesSucceeded.length > 0
        ? sourcesSucceeded
        : ADAPTERS.map(a => a.source),
      sources_failed: sourcesFailed,
    },
  };
}

interface FetchSummary {
  succeeded: string[];
  failed: string[];
}

async function runOnDemandFetch(
  client: SupabaseClient,
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

  const settled = await Promise.allSettled(ADAPTERS.map(a => a.search(searchParams)));
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const adapter = ADAPTERS[i];
    if (result.status === 'fulfilled') {
      await upsertEvents(client, adapter.source, result.value);
      succeeded.push(adapter.source);
    } else {
      // アダプタエラーはログ記録のみ。検索は続行する
      console.error(`[search] adapter ${adapter.source} failed:`, result.reason);
      failed.push(adapter.source);
    }
  }

  return { succeeded, failed };
}

async function upsertEvents(
  client: SupabaseClient,
  source: string,
  raws: RawEvent[],
): Promise<void> {
  if (raws.length === 0) return;

  const now = new Date().toISOString();

  const rows = raws.map(r => ({
    source,
    source_event_id: r.sourceEventId,
    title: r.title,
    description: r.description ?? null,
    starts_at: r.startsAt.toISOString(),
    ends_at: r.endsAt?.toISOString() ?? null,
    venue_name: r.venueName ?? null,
    prefecture: r.prefecture ?? null,
    // RawEvent.isOnline を優先し、念のため isOnlineEvent でも再チェック
    area: r.prefecture ? prefectureToArea(r.prefecture) : null,
    is_online: r.isOnline || isOnlineEvent({
      title: r.title,
      description: r.description,
      venueName: r.venueName,
    }),
    ticket_url: r.ticketUrl ?? null,
    ticket_status: r.ticketStatus,
    performers: r.performers,
    tags: r.tags,
    fetched_at: now,
    // updated_at は DEFAULT NOW() で INSERT 時に自動設定されるが、
    // UPSERT (ON CONFLICT UPDATE) 時はトリガーがないため手動で更新必須
    updated_at: now,
  }));

  const { error } = await client
    .from('events')
    .upsert(rows, { onConflict: 'source,source_event_id' });
  if (error) throw error;
}

async function runDbSearch(
  client: SupabaseClient,
  p: QueryParams,
): Promise<any[]> {
  let query = client
    .from('events')
    .select('*')
    .gte('starts_at', p.fromIso)
    .lte('starts_at', p.toIso)
    .order('starts_at', { ascending: true })
    .limit(200);

  if (p.q) {
    // タイトル・説明の部分一致。performers は TEXT[] なので別途対応が必要だが
    // MVP では title/description の ILIKE で十分とする
    query = query.or(`title.ilike.%${p.q}%,description.ilike.%${p.q}%`);
  }

  if (p.areas) {
    if (p.includeOnline) {
      // area 名に "/" が含まれる (例: '北海道/東北', '中国/四国') ため
      // PostgREST の in() フィルタ内でダブルクォートで囲んで特殊文字をエスケープする
      const areasQuoted = p.areas.map(a => `"${a}"`).join(',');
      query = query.or(`area.in.(${areasQuoted}),is_online.eq.true`);
    } else {
      query = query.in('area', p.areas);
    }
  } else if (!p.includeOnline) {
    // areas 未指定かつオンライン除外の場合のみ is_online=false を追加
    // (areas 指定 + includeOnline=false は上の in() で area フィルタが機能する)
    query = query.eq('is_online', false);
  }

  if (p.onSaleOnly) {
    query = query.in('ticket_status', ['on_sale', 'lottery']);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

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
import { peatixAdapter } from '@/scrapers/peatix';
import { prefecturesInArea, prefectureToArea, AREAS, type Area } from '@/lib/area';
import { isOnlineEvent } from '@/lib/online-detection';
import { RateLimiter } from '@/scrapers/http';
import type { RawEvent, SourceAdapter } from '@/scrapers/types';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter, peatixAdapter];

// 同一プロセス内のオンデマンド取得をスロットリングする。Vercel Functions は cold start ごとに
// 別インスタンスになるが、温まったインスタンスへの連続リクエストには有効。
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
  client: SupabaseClient,
  input: SearchInput,
): Promise<SearchResult> {
  const params = buildSearchQueryParams(input);

  let strategy: FetchStrategy;
  let cacheKey: string | null = null;
  const sourcesFailed: string[] = [];
  const sourcesSucceeded: string[] = [];

  // キーワード未入力時は saved_keywords をデフォルトの絞り込み語として使う。
  // これがないと events テーブルのあらゆる行(別キーワードでの on_demand 取り込みも含む)が
  // 出てしまい、保存している推しキーワードと無関係なイベントが混入する。
  let queryKeywords: string[];

  if (!input.q) {
    // キーワードなし検索は DB のみ参照(アダプタ取り込みやキャッシュ判定の意味がない)
    strategy = 'db_only';
    const { data: saved } = await client.from('saved_keywords').select('keyword');
    queryKeywords = (saved ?? []).map(s => s.keyword as string).filter(Boolean);
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

    // 1. saved_keywords に登録済みか確認(バッチ取得済みとみなす)
    const { data: saved } = await client
      .from('saved_keywords')
      .select('id')
      .eq('keyword', input.q)
      .maybeSingle();

    if (saved) {
      strategy = 'batch';
    } else {
      // 2. キャッシュ確認
      const cached = await getCachedEventIds(client, cacheKey);
      if (cached) {
        strategy = 'cache';
      } else {
        // 3. オンデマンド取得
        const fetchResult = await runOnDemandFetch(client, input);
        sourcesFailed.push(...fetchResult.failed);
        sourcesSucceeded.push(...fetchResult.succeeded);
        strategy = 'on_demand';
      }
    }
  }

  const events = await runDbSearch(client, params, queryKeywords);

  // on_demand 戦略のときだけキャッシュを更新する。runDbSearch を 1 回で済ませる目的で
  // ここまで遅延させている。
  if (strategy === 'on_demand' && cacheKey) {
    const ids = events.map((r: any) => r.id as number);
    await setCachedEventIds(client, cacheKey, ids);
  }

  // sources_succeeded/failed は on_demand 戦略でのみ意味を持つ。
  // db_only/batch/cache 戦略時は空配列を返す(アダプタを実行していないため)
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

  const succeeded: string[] = [];
  const failed: string[] = [];

  // 外部サイトへの負荷を抑えるため逐次 + 同一プロセスで共有のレートリミッタで間隔を確保。
  // バッチ取得と同様に、実行ごとに scrape_runs に 1 行記録して観測可能にする。
  for (const adapter of ADAPTERS) {
    await adapterLimiter.wait();
    const startedAt = new Date();
    let status: 'success' | 'failed' = 'success';
    let count = 0;
    let errMsg: string | null = null;
    try {
      const events = await adapter.search(searchParams);
      await upsertEvents(client, adapter.source, events);
      count = events.length;
      succeeded.push(adapter.source);
    } catch (e: unknown) {
      status = 'failed';
      errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[search] adapter ${adapter.source} failed:`, e);
      failed.push(adapter.source);
    }
    await client.from('scrape_runs').insert({
      source: adapter.source,
      keyword: input.q ?? null,
      trigger: 'on_demand',
      events_found: count,
      status,
      error_message: errMsg,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
    });
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
  keywords: string[],
): Promise<any[]> {
  let query = client
    .from('events')
    .select('*')
    .gte('starts_at', p.fromIso)
    .lte('starts_at', p.toIso)
    .order('starts_at', { ascending: true })
    .limit(200);

  // PostgREST の or() フィルタ DSL では `,` `(` `)` `"` `\` `*` が予約文字。
  // performers の `cs.{...}` を併用するので `{` `}` も予約に加える。
  // 入力を空白に置換してフィルタ注入を防ぐ。
  //
  // 各 keyword について title / description の部分一致 + performers TEXT[] の要素一致を
  // OR で繋ぐ。pia adapter は bundleTitle (= アーティスト名 / 作品名) を performers に
  // 入れるので、「花江夏樹」「ゆず」のような単独名キーワードを保存している場合、
  // release title に名前が直接出てこないイベントもここで拾える。
  // cs.{X} は配列要素の完全一致なので、bundleTitle 中に keyword を「含む」だけの
  // ケース(例: bundleTitle = "鬼滅の刃 花江夏樹トーク")は引けない。
  // 将来は events_search_doc(GIN tsvector)を使う RPC に置き換える前提の MVP 実装。
  const orParts: string[] = [];
  for (const kw of keywords) {
    const safeQ = kw.replace(/[,()"*\\{}]/g, ' ').trim();
    if (safeQ) {
      orParts.push(`title.ilike.%${safeQ}%`);
      orParts.push(`description.ilike.%${safeQ}%`);
      orParts.push(`performers.cs.{"${safeQ}"}`);
    }
  }
  if (orParts.length > 0) {
    query = query.or(orParts.join(','));
  }

  if (p.areas) {
    if (p.includeOnline) {
      // area 名に "/" が含まれる (例: '北海道/東北', '中国/四国') ため
      // PostgREST の in() フィルタ内でダブルクォートで囲んで特殊文字をエスケープする
      const areasQuoted = p.areas.map(a => `"${a}"`).join(',');
      query = query.or(`area.in.(${areasQuoted}),is_online.eq.true`);
    } else {
      // areas 指定 + includeOnline=false: area一致 かつ is_online=false でないと
      // 「東京都会場で配信併催」のようなオンラインフラグ付きイベントが混入する
      query = query.in('area', p.areas).eq('is_online', false);
    }
  } else if (!p.includeOnline) {
    query = query.eq('is_online', false);
  }

  if (p.onSaleOnly) {
    query = query.in('ticket_status', ['on_sale', 'lottery']);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

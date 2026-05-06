/**
 * Peatix アダプタ
 *
 * 検索エンドポイント: https://peatix-api.com/v4/events/search?keyword=<KW>&country_id=392
 * これは peatix.com の検索ページ(SPA)が裏で叩いている JSON API。
 * `country_id=392` は日本。レスポンスは JSON で、HTML パース不要なため pia / walkerplus
 * よりも実装/メンテが軽い。
 *
 * robots.txt: peatix.com は `/event/*` を Allow / `Crawl-delay: 1` を要求しており、
 * 当方の RateLimiter(2 秒/req)がこれを十分に遵守する。
 * ToS(`https://about.peatix.com/ja/tos`)上、bot 等を明示的に禁止する条項は無し。
 *
 * レスポンス構造(主要フィールド):
 *   {
 *     data: [{
 *       id: 4960743,
 *       name: "イベント名",
 *       start: { utc: "2026-05-22T10:00:00Z", timezone: "Asia/Tokyo" },
 *       end:   { utc: "2026-05-22T11:40:00Z", timezone: "Asia/Tokyo" },
 *       status: "open" | ...,
 *       locationType: "physical" | "online",
 *       locationSettings: { venueName, venueStateLong (都道府県), ... },
 *       group: { name, id, logo },
 *       organizer: { id, nickname, avatar },
 *       badges: { isSeries, isFree },
 *       coverImage: "https://..."
 *     }],
 *     paginationInfo: { totalItems, totalPages, currentPage, itemPerPage }
 *   }
 *
 * 既知の制限:
 *   - 検索 API は dateFrom/dateTo パラメータを受け付けない(渡しても無視される)
 *     → クライアント側 startsAt フィルタで対応する
 *   - description フィールドが返らない(詳細ページに行けばあるが N+1 になるため未取得)
 *   - performers は構造として無い(group.name は主催者名であって出演者ではない)
 *   - 検索 API の status は "open" 等の粗い粒度で、抽選/先行/完売の細分は無い
 */

import { fetchJson, FetchHtmlOptions } from './http';
import { SourceAdapter, SearchParams, RawEvent } from './types';
import { isOnlineEvent } from '@/lib/online-detection';

const API_URL = 'https://peatix-api.com/v4/events/search';
const COUNTRY_ID_JP = 392;
const TICKET_BASE = 'https://peatix.com/event/';

interface PeatixApiResponse {
  data?: PeatixEvent[];
  paginationInfo?: { totalItems?: number; totalPages?: number; currentPage?: number; itemPerPage?: number };
}

interface PeatixEvent {
  id?: number;
  name?: string;
  start?: { utc?: string; timezone?: string };
  end?: { utc?: string; timezone?: string };
  status?: string;
  locationType?: 'physical' | 'online' | string;
  locationSettings?: {
    venueName?: string;
    venueStateLong?: string;
    venueAddress?: string;
  };
}

function buildUrl(params: SearchParams): string {
  const q = new URLSearchParams();
  if (params.keyword) q.set('keyword', params.keyword);
  q.set('country_id', String(COUNTRY_ID_JP));
  return `${API_URL}?${q.toString()}`;
}

export const peatixAdapter: SourceAdapter = {
  source: 'peatix',

  async search(params: SearchParams, opts: FetchHtmlOptions = {}): Promise<RawEvent[]> {
    const url = buildUrl(params);
    const json = await fetchJson<PeatixApiResponse>(url, {
      ...opts,
      headers: { Referer: 'https://peatix.com/', ...(opts.headers ?? {}) },
    });

    const items = Array.isArray(json?.data) ? json.data : [];
    const events: RawEvent[] = [];

    for (const item of items) {
      const id = item?.id;
      const title = item?.name?.trim();
      const startUtc = item?.start?.utc;
      if (!id || !title || !startUtc) continue;

      const startsAt = new Date(startUtc);
      if (isNaN(startsAt.getTime())) continue;

      // dateFrom/dateTo は API 側でサポートされないのでクライアント側で絞る。
      if (params.dateFrom && startsAt < params.dateFrom) continue;
      if (params.dateTo && startsAt > params.dateTo) continue;

      const endUtc = item?.end?.utc;
      const endsAt = endUtc ? new Date(endUtc) : undefined;

      const isOnline = item?.locationType === 'online';
      // include_online=false のとき配信イベントは除外
      if (!params.includeOnline && isOnline) continue;

      const venueName = item?.locationSettings?.venueName?.trim() || undefined;
      const prefecture = item?.locationSettings?.venueStateLong?.trim() || undefined;

      // 検索 API の status は粗いので「open=販売中」だけ on_sale 扱い、それ以外は unknown にする。
      const ticketStatus = item?.status === 'open' ? 'on_sale' : 'unknown';

      events.push({
        sourceEventId: `peatix-${id}`,
        title,
        startsAt,
        endsAt: endsAt && !isNaN(endsAt.getTime()) ? endsAt : undefined,
        venueName,
        prefecture,
        ticketUrl: `${TICKET_BASE}${id}`,
        ticketStatus,
        isOnline: isOnline || isOnlineEvent({ title, venueName }),
        performers: [],
        tags: [],
      });
    }

    return events;
  },
};

/**
 * ウォーカープラス (walkerplus.com) アダプタ
 *
 * 検索エンドポイント: https://www.walkerplus.com/event_list/
 * ウォーカープラスはキーワード自由検索を静的HTMLで提供していないため、
 * 全国イベント一覧ページ (/event_list/) をページネーションしながら取得する。
 * keyword パラメータはタイトル・会場名に対するクライアント側フィルタとして機能する。
 *
 * robots.txt: /event_list/ は Disallow リストに含まれておらず、スクレイピング可能。
 *
 * HTML 構造:
 *   <div class="m-mainlist-condition">
 *     <p class="m-mainlist-condition__result">全N件中1〜10件</p>
 *   </div>
 *   <ul class="m-mainlist__list">
 *     <li class="m-mainlist__item">            ← event item OR ad placeholder
 *       <div class="m-mainlist-item">          ← only present for actual events
 *         <a class="m-mainlist-item__ttl" href="/event/ar0313eXXXXXX/">
 *           <span>イベントタイトル</span>
 *         </a>
 *         <p class="m-mainlist-item-event__period">
 *           <span class="m-mainlist-item-event__open">開催中</span>
 *           2026年3月27日(金)～9月30日(水)
 *         </p>
 *         <p class="m-mainlist-item-event__place">会場名</p>
 *         <p class="m-mainlist-item__map">
 *           <a class="m-mainlist-item__maplink" href="/event_list/ar0313/">東京都</a>
 *           <a class="m-mainlist-item__maplink" href="...">区名</a>
 *         </p>
 *       </div>
 *     </li>
 *   </ul>
 */

import * as cheerio from 'cheerio';
import { fetchHtml, FetchHtmlOptions } from './http';
import { SourceAdapter, SearchParams, RawEvent } from './types';
import { isOnlineEvent } from '@/lib/online-detection';
import { normalizeTicketStatus } from '@/lib/ticket-status';

const BASE_URL = 'https://www.walkerplus.com';

function buildUrl(): string {
  return `${BASE_URL}/event_list/`;
}

/**
 * 日付文字列 "2026年3月27日(金)" または "2026年3月27日(金)～9月30日(水)" をパースし、
 * 開始日の UTC midnight を返す。
 */
export function parseWalkerplusDate(text: string): Date | null {
  // Pick the first date (before ～)
  const first = text.split('～')[0].trim();
  const m = first.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

/**
 * ウォーカープラス固有のイベントステータステキストを正規化する。
 * 期間テキストの <span> クラス名からステータスを読み取る。
 */
function wpNormalizeStatus(openClass: string): ReturnType<typeof normalizeTicketStatus> {
  if (openClass.includes('__end')) return 'ended';
  if (openClass.includes('__open')) return 'on_sale';
  return normalizeTicketStatus('');
}

export const walkerplusAdapter: SourceAdapter & {
  search: (params: SearchParams, opts?: FetchHtmlOptions) => Promise<RawEvent[]>;
} = {
  source: 'walkerplus',

  async search(params, opts = {}) {
    const url = buildUrl();
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);

    const events: RawEvent[] = [];

    // li.m-mainlist__item > div.m-mainlist-item を選択することで広告 li をスキップする
    $('li.m-mainlist__item > div.m-mainlist-item').each((_, el) => {
      const $el = $(el);

      // タイトルと詳細 URL
      const $titleAnchor = $el.find('a.m-mainlist-item__ttl');
      const title = $titleAnchor.find('span').first().text().trim();
      const href = $titleAnchor.attr('href') ?? '';
      if (!title || !href) return;

      // sourceEventId: "/event/ar0313e583568/" → "ar0313e583568"
      const idMatch = href.match(/\/event\/([^/]+)\//);
      if (!idMatch) return;
      const sourceEventId = `walkerplus-${idMatch[1]}`;

      // 期間テキストとステータス
      const $period = $el.find('p.m-mainlist-item-event__period');
      const periodText = $period.text().trim();

      // ステータス span のクラスを取得
      const $statusSpan = $period.find('span').first();
      const statusClass = $statusSpan.attr('class') ?? '';
      const ticketStatus = wpNormalizeStatus(statusClass);

      const startsAt = parseWalkerplusDate(periodText);
      if (!startsAt) return; // 日付パース失敗はスキップ

      // 会場名
      const venueName = $el.find('p.m-mainlist-item-event__place').text().trim() || undefined;

      // 都道府県: maplink の最初のリンクテキスト
      const $mapLinks = $el.find('a.m-mainlist-item__maplink');
      const prefecture = $mapLinks.first().text().trim() || undefined;

      // チケット URL
      const ticketUrl = `${BASE_URL}${href}`;

      // キーワードフィルタリング (クライアント側): タイトル・会場名に部分一致
      if (params.keyword) {
        const kw = params.keyword.toLowerCase();
        const haystack = `${title} ${venueName ?? ''}`.toLowerCase();
        if (!haystack.includes(kw)) return;
      }

      events.push({
        sourceEventId,
        title,
        startsAt,
        venueName,
        prefecture,
        ticketUrl,
        ticketStatus,
        isOnline: isOnlineEvent({ title, venueName }),
        performers: [],
        tags: [],
      });
    });

    return events;
  },
};

/**
 * ぴあ (t.pia.jp) アダプタ
 *
 * 検索エンドポイント: https://t.pia.jp/pia/rlsInfo.do
 * このエンドポイントは t.pia.jp/pia/search_all.do の AJAX バックエンドで、
 * 検索結果の HTML フラグメントを返す。
 *
 * robots.txt: /pia/rlsInfo.do は disallow リストに含まれておらず、スクレイピング可能。
 *
 * HTML 構造:
 *   <div id="contents_html">
 *     <input name="ptotalcnt" value="N" />   ← 件数
 *     <ul>
 *       <li>  ← event bundle (artist / event group)
 *         <h3><a href="http://ticket.pia.jp/pia/event.do?eventBundleCd=bXXXXXX">タイトル</a></h3>
 *         <ul>
 *           <li>  ← 個別チケット発売情報
 *             <h4 class="PC-perfinfo-title">発売種別／イベント名</h4>
 *             <div class="PC-perfinfo-period">2026/5/2(土) ～ 2026/5/5(火・祝)</div>
 *             <div class="PC-perfinfo-venue">会場名(都道府県)</div>
 *             <div class="PC-perfinfo-ticket">
 *               <p class="PC-detaillink-button"><a href="...ticketInformation.do?eventCd=...">詳細へ</a></p>
 *               <p class="PC-ticket-status"><span>販売期間中</span></p>
 *             </div>
 *           </li>
 *         </ul>
 *       </li>
 *     </ul>
 *   </div>
 */

import * as cheerio from 'cheerio';
import { fetchHtml, FetchHtmlOptions } from './http';
import { SourceAdapter, SearchParams, RawEvent } from './types';
import { isOnlineEvent } from '@/lib/online-detection';
import { normalizeTicketStatus } from '@/lib/ticket-status';

const AJAX_URL = 'https://t.pia.jp/pia/rlsInfo.do';
const TICKET_BASE = 'http://ticket.pia.jp';

function buildUrl(params: SearchParams): string {
  const q = new URLSearchParams();
  if (params.keyword) q.set('kw', params.keyword);
  q.set('searchType', '');
  q.set('mode', '2');
  q.set('dispMode', '1');
  q.set('setRlsAfter', '1');
  return `${AJAX_URL}?${q.toString()}`;
}

/**
 * 日付文字列 "2026/5/2(土)" または "2026/5/2(土) ～ 2026/5/5(火・祝)" をパースし、
 * 開始日の UTC 0:00 を返す。
 */
export function parsePiaDate(text: string): Date | null {
  // Pick the first date (before ～)
  const first = text.split('～')[0].trim();
  const m = first.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Use UTC midnight (no time info available in this endpoint)
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

/**
 * ぴあ固有のチケットステータステキストを正規化する。
 * normalizeTicketStatus が未対応の語もここで補完する。
 */
function piaNormalizeStatus(raw: string) {
  const t = raw.trim();
  if (t.includes('販売期間中')) return 'on_sale' as const;
  if (t.includes('発売前')) return 'unknown' as const;
  if (t.includes('予定枚数終了') || t.includes('完売')) return 'sold_out' as const;
  return normalizeTicketStatus(t);
}

export const piaAdapter: SourceAdapter & {
  search: (params: SearchParams, opts?: FetchHtmlOptions) => Promise<RawEvent[]>;
} = {
  source: 'pia',

  async search(params, opts = {}) {
    const url = buildUrl(params);
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);

    // ptotalcnt が 0 → 結果なし
    const totalCnt = Number($('input[name="ptotalcnt"]').val() ?? '0');
    if (totalCnt === 0) return [];

    const events: RawEvent[] = [];

    // Outer <li> = event bundle
    $('div#contents_html > ul > li').each((_, bundleEl) => {
      const $bundle = $(bundleEl);
      const bundleTitle = $bundle.find('> h3 > a').first().text().trim();
      const bundleHref = $bundle.find('> h3 > a').first().attr('href') ?? '';
      // eventBundleCd から ID を抽出
      const bundleCdMatch = bundleHref.match(/eventBundleCd=([\w]+)/);
      const bundleCd = bundleCdMatch ? bundleCdMatch[1] : '';

      // Inner <li> = individual release
      $bundle.find('> ul > li').each((releaseIdx, releaseEl) => {
        const $r = $(releaseEl);

        const perfTitle = $r.find('.PC-perfinfo-title').text().trim().replace(/\s+/g, ' ');
        const periodText = $r.find('.PC-perfinfo-period').text().trim();
        const venue = $r.find('.PC-perfinfo-venue').text().trim();
        const detailHref = $r.find('.PC-detaillink-button a').attr('href') ?? '';
        const statusText = $r.find('.PC-ticket-status span').first().text().trim();

        const startsAt = parsePiaDate(periodText);
        if (!startsAt) return; // 日付パース失敗はスキップ

        // eventCd からソースイベントIDを生成
        const eventCdMatch = detailHref.match(/eventCd=(\d+)/);
        const rlsCdMatch = detailHref.match(/rlsCd=(\w*)/);
        const eventCd = eventCdMatch ? eventCdMatch[1] : '';
        const rlsCd = rlsCdMatch ? rlsCdMatch[1] : '';
        const sourceEventId = eventCd
          ? `pia-${eventCd}-${rlsCd || releaseIdx}`
          : `pia-${bundleCd}-${releaseIdx}`;

        // タイトル: パフォーマンスタイトルがあればそれを使用、なければバンドルタイトル
        const title = perfTitle || bundleTitle;

        // チケット URL の正規化
        const ticketUrl = detailHref
          ? (detailHref.startsWith('http') ? detailHref : `${TICKET_BASE}${detailHref}`)
          : (bundleHref.startsWith('http') ? bundleHref : undefined);

        // 都道府県の抽出 (venue末尾の "(都道府県)" パターン)
        const prefMatch = venue.match(/\(([^)]+)\)$/);
        const prefecture = prefMatch ? prefMatch[1] : undefined;
        // 都道府県部分を除いたvenue名
        const venueName = prefMatch ? venue.slice(0, venue.lastIndexOf('(')).trim() : venue || undefined;

        events.push({
          sourceEventId,
          title,
          startsAt,
          venueName: venueName || undefined,
          prefecture,
          ticketUrl,
          ticketStatus: piaNormalizeStatus(statusText),
          isOnline: isOnlineEvent({ title, venueName }),
          performers: bundleTitle ? [bundleTitle] : [],
          tags: [],
        });
      });
    });

    return events;
  },
};

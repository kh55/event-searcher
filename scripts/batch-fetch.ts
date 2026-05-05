// scripts/batch-fetch.ts
import { getServerClient } from '../lib/supabase';
import { piaAdapter } from '../scrapers/pia';
import { walkerplusAdapter } from '../scrapers/walkerplus';
import { prefectureToArea } from '../lib/area';
import { isOnlineEvent } from '../lib/online-detection';
import type { RawEvent, SourceAdapter } from '../scrapers/types';
import { RateLimiter } from '../scrapers/http';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter];
const limiter = new RateLimiter(2000); // 2秒/リクエスト

async function main() {
  const client = getServerClient();
  const { data: keywords, error } = await client
    .from('saved_keywords').select('id,keyword');
  if (error) throw error;
  if (!keywords || keywords.length === 0) {
    console.log('no saved keywords; nothing to fetch.');
    return;
  }

  // 1ヶ月先までを対象に取得
  const now = new Date();
  const dateFrom = now;
  const dateTo = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

  for (const k of keywords) {
    for (const adapter of ADAPTERS) {
      await limiter.wait();
      const startedAt = new Date();
      let status: 'success' | 'failed' = 'success';
      let count = 0;
      let errMsg: string | null = null;
      try {
        const events = await adapter.search({
          keyword: k.keyword,
          dateFrom, dateTo,
          includeOnline: true,
        });
        await upsertEvents(client, adapter.source, events);
        count = events.length;
      } catch (e: any) {
        status = 'failed';
        errMsg = e?.message ?? String(e);
        console.error(`[${adapter.source}] ${k.keyword}:`, e);
      }
      await client.from('scrape_runs').insert({
        source: adapter.source,
        keyword: k.keyword,
        trigger: 'cron',
        events_found: count,
        status,
        error_message: errMsg,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
      });
    }
    await client.from('saved_keywords')
      .update({ last_fetched_at: new Date().toISOString() }).eq('id', k.id);
  }

  // 古いイベントを削除
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  await client.from('events').delete().lt('starts_at', cutoff);

  console.log(`done. processed ${keywords.length} keywords.`);
}

async function upsertEvents(client: any, source: string, raws: RawEvent[]) {
  if (raws.length === 0) return;
  const rows = raws.map(r => ({
    source,
    source_event_id: r.sourceEventId,
    title: r.title,
    description: r.description ?? null,
    starts_at: r.startsAt.toISOString(),
    ends_at: r.endsAt?.toISOString() ?? null,
    venue_name: r.venueName ?? null,
    prefecture: r.prefecture ?? null,
    area: r.prefecture ? prefectureToArea(r.prefecture) : null,
    is_online: r.isOnline || isOnlineEvent({
      title: r.title, description: r.description, venueName: r.venueName,
    }),
    ticket_url: r.ticketUrl ?? null,
    ticket_status: r.ticketStatus,
    performers: r.performers,
    tags: r.tags,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await client.from('events')
    .upsert(rows, { onConflict: 'source,source_event_id' });
  if (error) throw error;
}

main().catch(e => { console.error(e); process.exit(1); });

// scripts/batch-fetch.ts
// ローカル/コンテナ実行兼用。GitHub Actions ではなく ofelia コンテナまたは
// `docker compose exec app npm run batch-fetch` から呼ばれる。
// host から直接実行するときは .env.local の DATABASE_URL を読む。
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', quiet: true });

import type { Pool } from 'pg';
import { getPool } from '../lib/db';
import { piaAdapter } from '../scrapers/pia';
import { walkerplusAdapter } from '../scrapers/walkerplus';
import { peatixAdapter } from '../scrapers/peatix';
import { prefectureToArea } from '../lib/area';
import { isOnlineEvent } from '../lib/online-detection';
import type { RawEvent, SourceAdapter } from '../scrapers/types';
import { RateLimiter } from '../scrapers/http';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter, peatixAdapter];
const limiter = new RateLimiter(2000);

async function main() {
  const pool = getPool();

  const { rows: keywords } = await pool.query<{ id: number; keyword: string }>(
    'SELECT id, keyword FROM saved_keywords',
  );
  if (keywords.length === 0) {
    console.log('no saved keywords; nothing to fetch.');
    return;
  }

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
        await upsertEvents(pool, adapter.source, events);
        count = events.length;
      } catch (e: unknown) {
        status = 'failed';
        errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[${adapter.source}] ${k.keyword}:`, e);
      }
      await pool.query(
        `INSERT INTO scrape_runs
         (source, keyword, trigger, events_found, status, error_message, started_at, finished_at)
         VALUES ($1, $2, 'cron', $3, $4, $5, $6, $7)`,
        [
          adapter.source,
          k.keyword,
          count,
          status,
          errMsg,
          startedAt.toISOString(),
          new Date().toISOString(),
        ],
      );
    }
    await pool.query(
      'UPDATE saved_keywords SET last_fetched_at = $1 WHERE id = $2',
      [new Date().toISOString(), k.id],
    );
  }

  // 古いイベントを削除
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  await pool.query('DELETE FROM events WHERE starts_at < $1', [cutoff]);

  console.log(`done. processed ${keywords.length} keywords.`);
}

async function upsertEvents(pool: Pool, source: string, raws: RawEvent[]) {
  if (raws.length === 0) return;
  const nowIso = new Date().toISOString();
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
        title: r.title, description: r.description, venueName: r.venueName,
      }),
      r.ticketUrl ?? null,
      r.ticketStatus,
      r.performers,
      r.tags,
      nowIso,
      nowIso,
    );
  });

  await pool.query(
    `INSERT INTO events
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
       updated_at = EXCLUDED.updated_at`,
    params,
  );
}

main()
  .then(async () => {
    await getPool().end();
  })
  .catch(async e => {
    console.error(e);
    try { await getPool().end(); } catch { /* noop */ }
    process.exit(1);
  });

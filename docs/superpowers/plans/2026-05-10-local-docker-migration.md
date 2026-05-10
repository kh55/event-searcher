# Vercel/Supabase → ローカル Docker 移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vercel + Supabase + GitHub Actions cron 構成をやめ、ローカル Mac 上の docker compose(postgres + Next.js + ofelia)で完結する個人利用向け運用に切り替える。

**Architecture:** `db` (postgres:16-alpine) / `app` (Next.js 16 prod build) / `ofelia` (cron) の 3 サービス。アプリ層は `@supabase/supabase-js` をやめて `pg`(node-postgres)生 SQL で書き直す。マイグレーションは初回 entrypoint 自動実行 + `schema_migrations` テーブルで idempotent 化、追加分は host から `npm run migrate` で流す。

**Tech Stack:** Next.js 16 / React 19 / TypeScript / vitest / pg (node-postgres) / postgres:16-alpine / mcuadros/ofelia / Docker Compose v2

**Spec:** `docs/superpowers/specs/2026-05-10-local-docker-migration-design.md`

---

## File Structure

### 新規作成

| パス | 責務 |
|---|---|
| `lib/db.ts` | `pg.Pool` を遅延初期化する `getPool()` を export。`DATABASE_URL` で接続。 |
| `tests/lib/db.test.ts` | `getPool` の env validation テスト。 |
| `tests/helpers/mock-pool.ts` | `Pool` 互換の最小 fake(`query` メソッドのみ。`{ rows, rowCount }` を返す)。 |
| `db/migrations/0000_create_schema_migrations.sql` | `schema_migrations` テーブルを最初に作る。 |
| `scripts/migrate.ts` | `db/migrations/*.sql` を `schema_migrations` で管理して未適用のものだけ実行する idempotent runner。 |
| `Dockerfile` | Node 20 multi-stage(deps → builder → runner)で Next.js prod build。 |
| `.dockerignore` | `node_modules` / `.next` / `.git` / `.env*` / `.playwright-mcp` 等を除外。 |
| `docker-compose.yml` | db / app / ofelia の 3 サービス、`pgdata` named volume、loopback ポート公開。 |
| `docker/ofelia.ini` | ofelia の `[job-exec]` で `app` コンテナに `npm run batch-fetch` を JST 06:00/18:00 投入。 |

### 修正

| パス | 主な変更 |
|---|---|
| `lib/cache.ts` | `SupabaseClient` 型 → `Pool` 型。`from('search_cache')...` を `pool.query()` の生 SQL に。 |
| `lib/search/index.ts` | `searchEvents`、`runOnDemandFetch`、`upsertEvents`、`runDbSearch` をすべて `Pool` 受け取り + 生 SQL に。 |
| `app/api/search/route.ts` | `getServerClient` → `getPool`。 |
| `app/api/saved-keywords/route.ts` | 同上 + GET/POST を `pool.query()` に書き換え。 |
| `scripts/batch-fetch.ts` | 同上 + `upsertEvents` / `saved_keywords` / `events` クリーンアップを生 SQL に。 |
| `db/migrations/0001_create_events.sql` | 末尾に schema_migrations への INSERT を追加。 |
| `db/migrations/0002_create_saved_keywords.sql` | 同上。 |
| `db/migrations/0003_create_search_cache.sql` | 同上。 |
| `db/migrations/0004_create_scrape_runs.sql` | 同上。 |
| `package.json` | `pg` / `@types/pg` 追加、`@supabase/supabase-js` 削除、`migrate` script 追加。 |
| `.env.local.example` | `SUPABASE_*` → `DATABASE_URL` に置換。 |
| `README.md` | クイックスタートを `docker compose up -d` ベースに書き直し。 |
| `docs/ARCHITECTURE.md` | システム俯瞰・環境変数・デプロイ・運用 runbook・セキュリティモデルを Docker 文脈で全面書き直し。 |
| `db/README.md` | Supabase ダッシュボード手順削除、`docker-entrypoint-initdb.d` と `npm run migrate` の手順に置換。 |

### 削除

| パス | 理由 |
|---|---|
| `lib/supabase.ts` | `@supabase/supabase-js` への依存ごと撤去。 |
| `tests/lib/supabase.test.ts` | `db.test.ts` に置き換え。 |
| `db/migrations/0005_grant_service_role.sql` | superuser で接続するため不要。 |
| `.github/workflows/batch-fetch.yml` | cron は ofelia に移行。 |
| `.vercel/` | Vercel 連携破棄。 |

---

## Important Notes

- **既存テストの影響は小さい**: 動的 DB アクセスを mock しているテストは `tests/lib/supabase.test.ts` だけで、他は schema バリデーションや純粋関数のテスト。差し替えに伴うテスト書き直しはほぼ不要。
- **TDD の適用範囲**: `lib/db.ts` の getPool は TDD で書く。`lib/cache.ts` 以降の DB アクセス書き換えは「既存テストが green のまま現状挙動を保つリファクタ」として進め、既存テストを安全網にする。
- **コミット粒度**: 1 タスク = 1 コミットを基本とし、レビューしやすくする。
- **`runDbSearch` の挙動互換**: PostgREST の `or()` フィルタと等価な SQL を書く必要がある。`performers.cs.{X}` ↔ `performers @> ARRAY[X]` の対応に注意。
- **Mac の Docker Desktop**: 既にインストール済み前提。未インストールなら `brew install --cask docker` で先に入れる必要があるが本プランではタッチしない。

---

## Task 1: pg 依存を追加(@supabase/supabase-js は残す)

**Files:**
- Modify: `package.json`、`package-lock.json`

- [ ] **Step 1: pg と @types/pg をインストール**

```bash
cd /Users/hyoudoukazuhiko/github/event-searcher
npm install pg
npm install --save-dev @types/pg
```

期待結果: `package.json` の dependencies に `"pg": "^8.x"` が、devDependencies に `"@types/pg": "^8.x"` が追加。`package-lock.json` 更新。

- [ ] **Step 2: 型チェックが通ることを確認**

```bash
npx tsc --noEmit
```

期待結果: エラーなし。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pg dependency for postgres direct access"
```

---

## Task 2: lib/db.ts と getPool テストを作成

**Files:**
- Create: `lib/db.ts`
- Create: `tests/lib/db.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`tests/lib/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPool, _resetPoolForTests } from '@/lib/db';

describe('getPool', () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    _resetPoolForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalEnv;
  });

  it('returns a pool when DATABASE_URL is set', () => {
    process.env.DATABASE_URL = 'postgres://app:app@localhost:5432/event_searcher';
    const pool = getPool();
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe('function');
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow(/DATABASE_URL/);
  });

  it('returns the same instance across calls (cached)', () => {
    process.env.DATABASE_URL = 'postgres://app:app@localhost:5432/event_searcher';
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run tests/lib/db.test.ts
```

期待結果: FAIL(`Cannot find module '@/lib/db'`)

- [ ] **Step 3: lib/db.ts を実装**

`lib/db.ts`:

```typescript
import { Pool } from 'pg';

let cached: Pool | null = null;

export function getPool(): Pool {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  cached = new Pool({ connectionString: url });
  return cached;
}

export function _resetPoolForTests(): void {
  cached = null;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run tests/lib/db.test.ts
```

期待結果: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/db.ts tests/lib/db.test.ts
git commit -m "feat(db): add getPool wrapper around pg.Pool"
```

---

## Task 3: Pool mock helper を追加

**Files:**
- Create: `tests/helpers/mock-pool.ts`

- [ ] **Step 1: mock-pool.ts を実装**

`tests/helpers/mock-pool.ts`:

```typescript
/**
 * Pool 互換の最小 fake。`pool.query(sql, params)` 呼び出しを記録し、
 * 事前に enqueue した結果を順番に返す。
 */
import type { Pool, QueryResult, QueryResultRow } from 'pg';

interface RecordedCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

export interface MockPool extends Pick<Pool, 'query'> {
  calls: readonly RecordedCall[];
  enqueue<R extends QueryResultRow = QueryResultRow>(result: Partial<QueryResult<R>>): void;
}

export function createMockPool(): MockPool {
  const calls: RecordedCall[] = [];
  const queue: Partial<QueryResult>[] = [];

  return {
    calls,
    enqueue(result) {
      queue.push(result as Partial<QueryResult>);
    },
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      const next = queue.shift();
      const rows = (next?.rows as readonly unknown[] | undefined) ?? [];
      return {
        rows,
        rowCount: next?.rowCount ?? rows.length,
        command: next?.command ?? 'SELECT',
        oid: next?.oid ?? 0,
        fields: next?.fields ?? [],
      } as QueryResult;
    }) as Pool['query'],
  };
}
```

- [ ] **Step 2: 型チェックが通ることを確認**

```bash
npx tsc --noEmit
```

期待結果: エラーなし。

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/mock-pool.ts
git commit -m "test: add MockPool helper for pg.Pool unit tests"
```

---

## Task 4: schema_migrations テーブル + 既存マイグレーション末尾追記

**Files:**
- Create: `db/migrations/0000_create_schema_migrations.sql`
- Modify: `db/migrations/0001_create_events.sql`(末尾)
- Modify: `db/migrations/0002_create_saved_keywords.sql`(末尾)
- Modify: `db/migrations/0003_create_search_cache.sql`(末尾)
- Modify: `db/migrations/0004_create_scrape_runs.sql`(末尾)
- Delete: `db/migrations/0005_grant_service_role.sql`

- [ ] **Step 1: 0000_create_schema_migrations.sql を作成**

```sql
-- db/migrations/0000_create_schema_migrations.sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations(filename) VALUES ('0000_create_schema_migrations.sql')
ON CONFLICT (filename) DO NOTHING;
```

- [ ] **Step 2: 0001 末尾に INSERT を追記**

`db/migrations/0001_create_events.sql` の末尾に以下を追加:

```sql

INSERT INTO schema_migrations(filename) VALUES ('0001_create_events.sql')
ON CONFLICT (filename) DO NOTHING;
```

- [ ] **Step 3: 0002 末尾に INSERT を追記**

`db/migrations/0002_create_saved_keywords.sql` の末尾に以下を追加:

```sql

INSERT INTO schema_migrations(filename) VALUES ('0002_create_saved_keywords.sql')
ON CONFLICT (filename) DO NOTHING;
```

- [ ] **Step 4: 0003 末尾に INSERT を追記**

`db/migrations/0003_create_search_cache.sql` の末尾に以下を追加:

```sql

INSERT INTO schema_migrations(filename) VALUES ('0003_create_search_cache.sql')
ON CONFLICT (filename) DO NOTHING;
```

- [ ] **Step 5: 0004 末尾に INSERT を追記**

`db/migrations/0004_create_scrape_runs.sql` の末尾に以下を追加:

```sql

INSERT INTO schema_migrations(filename) VALUES ('0004_create_scrape_runs.sql')
ON CONFLICT (filename) DO NOTHING;
```

- [ ] **Step 6: 0005 を削除**

```bash
rm db/migrations/0005_grant_service_role.sql
```

- [ ] **Step 7: Commit**

```bash
git add db/migrations/
git commit -m "refactor(db): track migrations via schema_migrations, drop service_role grant"
```

---

## Task 5: scripts/migrate.ts と package.json の migrate script

**Files:**
- Create: `scripts/migrate.ts`
- Modify: `package.json`

- [ ] **Step 1: scripts/migrate.ts を実装**

```typescript
// scripts/migrate.ts
// db/migrations/*.sql を schema_migrations で管理して未適用のものだけ流す。
// host から `npm run migrate` で実行することを想定。
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', quiet: true });

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations'))
        .rows.map(r => r.filename),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`applying ${file}...`);
      await pool.query(sql);
      appliedCount++;
    }

    console.log(`done. applied ${appliedCount} migration(s).`);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: package.json に migrate script を追加**

`package.json` の `scripts` セクションに以下を追加:

```json
"migrate": "tsx scripts/migrate.ts"
```

(既存の `"batch-fetch": "tsx scripts/batch-fetch.ts"` の隣に。)

- [ ] **Step 3: 型チェックが通ることを確認**

```bash
npx tsc --noEmit
```

期待結果: エラーなし。

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate.ts package.json
git commit -m "feat(db): add idempotent migrate runner for host execution"
```

---

## Task 6: lib/cache.ts を Pool ベースに

**Files:**
- Modify: `lib/cache.ts`

- [ ] **Step 1: lib/cache.ts を pg ベースに書き換え**

`lib/cache.ts` の DB アクセス部分を以下に置換(`generateCacheKey` は無変更):

```typescript
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
```

- [ ] **Step 2: 既存テストが通ることを確認**

```bash
npx vitest run tests/lib/cache.test.ts
```

期待結果: 4 passed(`generateCacheKey` のテストのみで DB アクセスは触らない)。

- [ ] **Step 3: Commit**

注: この時点で `lib/search/index.ts` 等が `getCachedEventIds(client, ...)` を Supabase 型で呼んでおり、`tsc --noEmit` を通すと型エラーが出る。これは続く Task 7-10 で連鎖修正されるため、ここでは型チェックを実行しない。最終的な型チェックは Task 11 で行う。

```bash
git add lib/cache.ts
git commit -m "refactor(cache): switch search_cache access from supabase to pg

Note: type errors propagate to lib/search/index.ts and route handlers
until Task 7-10 land. Type check resumes green at Task 11."
```

---

## Task 7: lib/search/index.ts を Pool ベースに

**Files:**
- Modify: `lib/search/index.ts`

- [ ] **Step 1: ファイル全体を以下で書き換え**

```typescript
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
import { prefecturesInArea, prefectureToArea, AREAS, type Area } from '@/lib/area';
import { isOnlineEvent } from '@/lib/online-detection';
import { RateLimiter } from '@/scrapers/http';
import type { RawEvent, SourceAdapter } from '@/scrapers/types';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter];
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
```

- [ ] **Step 2: 既存の関連テスト(あれば)を実行**

```bash
npx vitest run tests/lib/search-query.test.ts
```

期待結果: pass(`buildSearchQueryParams` のテストで DB に触れないため無関係)。

- [ ] **Step 3: Commit**

注: Task 6 と同じく型チェックは Task 11 まで保留。

```bash
git add lib/search/index.ts
git commit -m "refactor(search): rewrite searchEvents/runDbSearch in raw SQL via pg.Pool"
```

---

## Task 8: app/api/saved-keywords/route.ts を Pool ベースに

**Files:**
- Modify: `app/api/saved-keywords/route.ts`

- [ ] **Step 1: ファイル全体を以下で書き換え**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';

export const postSchema = z.object({ keyword: z.string().min(1).max(100) });

export async function GET() {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      'SELECT id, keyword, last_fetched_at, created_at FROM saved_keywords ORDER BY created_at DESC',
    );
    return NextResponse.json({ keywords: rows });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO saved_keywords (keyword)
       VALUES ($1)
       ON CONFLICT (keyword) DO UPDATE SET keyword = EXCLUDED.keyword
       RETURNING id, keyword, last_fetched_at, created_at`,
      [parsed.data.keyword],
    );
    return NextResponse.json({ keyword: rows[0] }, { status: 201 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: 既存テスト(postSchema)が通ることを確認**

```bash
npx vitest run tests/api/saved-keywords.test.ts
```

期待結果: 5 passed.

- [ ] **Step 3: Commit**

```bash
git add app/api/saved-keywords/route.ts
git commit -m "refactor(api): rewrite saved-keywords route with pg.Pool"
```

---

## Task 9: app/api/search/route.ts を Pool ベースに

**Files:**
- Modify: `app/api/search/route.ts`

- [ ] **Step 1: ファイル全体を以下で書き換え**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { searchEvents } from '@/lib/search';

export const searchInputSchema = z.object({
  q: z.string().default(''),
  from: z.string().transform(s => new Date(s)),
  to: z.string().transform(s => new Date(s)),
  areas: z.array(z.string()).default([]),
  include_online: z.boolean().default(false),
  on_sale_only: z.boolean().default(true),
}).refine(
  v => v.from.getTime() <= v.to.getTime(),
  { message: 'from must be <= to' },
);

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = searchInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid input', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const v = parsed.data;
  const pool = getPool();
  try {
    const result = await searchEvents(pool, {
      q: v.q,
      from: v.from,
      to: v.to,
      areas: v.areas,
      includeOnline: v.include_online,
      onSaleOnly: v.on_sale_only,
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    console.error('[search] error', e);
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json(
      { error: 'internal error', message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: 既存テスト(searchInputSchema)が通ることを確認**

```bash
npx vitest run tests/api/search.test.ts
```

期待結果: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add app/api/search/route.ts
git commit -m "refactor(api): switch search route to pg.Pool"
```

---

## Task 10: scripts/batch-fetch.ts を Pool ベースに

**Files:**
- Modify: `scripts/batch-fetch.ts`

- [ ] **Step 1: ファイル全体を以下で書き換え**

```typescript
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
import { prefectureToArea } from '../lib/area';
import { isOnlineEvent } from '../lib/online-detection';
import type { RawEvent, SourceAdapter } from '../scrapers/types';
import { RateLimiter } from '../scrapers/http';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter];
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
```

- [ ] **Step 2: 型チェックが通ることを確認**

```bash
npx tsc --noEmit
```

期待結果: エラーなし(`lib/supabase.ts` はまだ存在するので import 衝突しない)。

- [ ] **Step 3: 全テストを実行**

```bash
npx vitest run
```

期待結果: 既存の Supabase テスト(`tests/lib/supabase.test.ts`)以外は全て pass。`supabase.test.ts` は次タスクで削除する。

- [ ] **Step 4: Commit**

```bash
git add scripts/batch-fetch.ts
git commit -m "refactor(batch): rewrite batch-fetch with pg.Pool"
```

---

## Task 11: lib/supabase.ts と関連を撤去

**Files:**
- Delete: `lib/supabase.ts`
- Delete: `tests/lib/supabase.test.ts`
- Modify: `package.json`、`package-lock.json`

- [ ] **Step 1: lib/supabase.ts を削除**

```bash
rm lib/supabase.ts
```

- [ ] **Step 2: tests/lib/supabase.test.ts を削除**

```bash
rm tests/lib/supabase.test.ts
```

- [ ] **Step 3: @supabase/supabase-js を package.json から削除**

```bash
npm uninstall @supabase/supabase-js
```

- [ ] **Step 4: 型チェックが通ることを確認**

```bash
npx tsc --noEmit
```

期待結果: エラーなし。

- [ ] **Step 5: 全テストを実行**

```bash
npx vitest run
```

期待結果: 全 pass(supabase テストが消えた分テスト数は減る)。

- [ ] **Step 6: ビルドが通ることを確認**

```bash
npm run build
```

期待結果: `next build` 成功。

- [ ] **Step 7: Commit**

```bash
git add lib/ tests/lib/ package.json package-lock.json
git commit -m "chore: remove @supabase/supabase-js dependency and lib/supabase"
```

---

## Task 12: GitHub Actions と .vercel を撤去

**Files:**
- Delete: `.github/workflows/batch-fetch.yml`
- Delete: `.vercel/`(存在すれば)

- [ ] **Step 1: GitHub Actions の cron workflow を削除**

```bash
rm .github/workflows/batch-fetch.yml
```

- [ ] **Step 2: .vercel/ を削除(存在すれば)**

```bash
rm -rf .vercel
```

- [ ] **Step 3: Commit**

```bash
git add -A .github .vercel 2>/dev/null
git status --short
git commit -m "chore: remove GitHub Actions cron and .vercel artifacts"
```

注: `.vercel/` は `.gitignore` 済みなので git 上は変化なしの可能性あり。その場合は workflow ファイルだけのコミットになる。

---

## Task 13: .env.local.example を更新

**Files:**
- Modify: `.env.local.example`

- [ ] **Step 1: .env.local.example を以下で置換**

```
# host から `npm run migrate` / `npm run batch-fetch` / `npm run dev` を実行する用途。
# docker compose 経由ではコンテナ側で `db` ホスト名を参照するため app サービス側で override する。
DATABASE_URL=postgres://app:app@localhost:5432/event_searcher
```

- [ ] **Step 2: Commit**

```bash
git add .env.local.example
git commit -m "chore: replace SUPABASE_* with DATABASE_URL in env example"
```

---

## Task 14: Dockerfile と .dockerignore を追加

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: .dockerignore を作成**

```
node_modules
.next
.git
.gitignore
.env
.env.local
.env.*.local
.vercel
.playwright-mcp
.superpowers
.claude
.DS_Store
coverage
docs/superpowers
tests
*.tsbuildinfo
README.md
```

- [ ] **Step 2: Dockerfile を作成**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/scrapers ./scrapers
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/app ./app
COPY --from=builder /app/components ./components
EXPOSE 3000
CMD ["npm", "run", "start"]
```

注: `npm run start` は `next start` を起動する。`scripts/batch-fetch.ts` は `tsx` で走らせるため devDependency の `tsx` も必要だが、本 Dockerfile は `npm ci` で全依存(dev 含む)を入れているので runner ステージの `node_modules` 内に存在する。最適化(prod-only install)は YAGNI として今回は採用しない。

- [ ] **Step 3: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: add Dockerfile and .dockerignore for Next.js prod image"
```

---

## Task 15: docker-compose.yml と ofelia.ini を追加

**Files:**
- Create: `docker-compose.yml`
- Create: `docker/ofelia.ini`

- [ ] **Step 1: docker/ofelia.ini を作成**

```ini
[job-exec "batch-fetch"]
schedule = 0 21,9 * * *
container = event-searcher-app
command = npm run batch-fetch
```

- [ ] **Step 2: docker-compose.yml を作成**

```yaml
services:
  db:
    image: postgres:16-alpine
    container_name: event-searcher-db
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: event_searcher
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/migrations:/docker-entrypoint-initdb.d:ro
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d event_searcher"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  app:
    build:
      context: .
    container_name: event-searcher-app
    environment:
      DATABASE_URL: postgres://app:app@db:5432/event_searcher
      NODE_ENV: production
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  ofelia:
    image: mcuadros/ofelia:latest
    container_name: event-searcher-ofelia
    depends_on:
      - app
    command: daemon --config=/etc/ofelia/config.ini
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./docker/ofelia.ini:/etc/ofelia/config.ini:ro
    restart: unless-stopped

volumes:
  pgdata:
```

- [ ] **Step 3: 設定の整合性をチェック**

```bash
docker compose config
```

期待結果: 構文エラーなく、3 サービスが見える出力。

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docker/
git commit -m "build: add docker-compose with db, app, ofelia services"
```

---

## Task 16: ドキュメント更新

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `db/README.md`

- [ ] **Step 1: README.md を Docker 中心の手順に書き換え**

セクション構成:
1. 概要(変更なしでよい)
2. 必要なもの(Docker Desktop)
3. クイックスタート(下記)
4. 開発時の注意

クイックスタートを以下に置換(既存の Vercel/Supabase 言及は全削除):

```markdown
## クイックスタート

1. 環境変数を用意:
   ```bash
   cp .env.local.example .env.local
   # DATABASE_URL=postgres://app:app@localhost:5432/event_searcher が入っている
   ```

2. Docker Compose を起動:
   ```bash
   docker compose up -d --build
   ```

3. ブラウザで http://localhost:3000 を開く

4. キーワードを追加(/settings ページから、または curl):
   ```bash
   curl -X POST http://localhost:3000/api/saved-keywords \
     -H "Content-Type: application/json" \
     -d '{"keyword":"花江夏樹"}'
   ```

5. 即時バッチ実行(cron を待たない場合):
   ```bash
   docker compose exec app npm run batch-fetch
   ```

cron は `docker/ofelia.ini` で UTC `0 21,9 * * *`(JST 06:00 / 18:00)に `app` コンテナの `npm run batch-fetch` を起動する。
```

- [ ] **Step 2: docs/ARCHITECTURE.md を書き換え**

以下のセクションを Docker 文脈で書き直す:

- 「システム俯瞰」: spec の構成図を流用。Vercel + Supabase + GitHub Actions の表 → docker-compose 3 サービスの表。
- 「ディレクトリレイアウト」: `Dockerfile`、`docker-compose.yml`、`docker/ofelia.ini`、`scripts/migrate.ts` を追加。`.github/workflows/batch-fetch.yml` を削除。
- 「データフロー」: 内容自体は変更不要(検索戦略・バッチの流れは同じ)。出てくる名前を Vercel/Supabase → app/db に差し替えるのみ。
- 「環境変数」: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` の表 → `DATABASE_URL` の表に置換。
- 「デプロイ」: Vercel / GitHub Actions / Supabase の 3 つを「Docker Compose のセットアップ」に置換。
- 「オペレーション」: vercel logs → `docker compose logs -f app`、`gh workflow run` → `docker compose exec app npm run batch-fetch`、Supabase ダッシュボード → `psql postgres://app:app@localhost:5432/event_searcher`。
- 「セキュリティモデル」: service_role 経由 → loopback only + DB superuser、Deployment Protection 削除。
- 「トラブルシューティング」: Vercel 関係を削除し、Docker 関係(`docker compose ps` で状態、`docker compose logs db` で起動エラー、ボリュームを消したいときは `docker compose down -v`)を追加。
- 「既知の制限」: `Vercel cold start でレートリミッタ状態リセット` → `app コンテナ再起動でレートリミッタ状態リセット` に書き換え。

- [ ] **Step 3: db/README.md を書き換え**

以下に置換:

```markdown
# DB Migrations

| ファイル | 役割 |
|---|---|
| `0000_create_schema_migrations.sql` | `schema_migrations` トラッキングテーブル |
| `0001_create_events.sql` | events + IMMUTABLE wrapper + GIN/B-tree index |
| `0002_create_saved_keywords.sql` | saved_keywords |
| `0003_create_search_cache.sql` | search_cache + expires_at index |
| `0004_create_scrape_runs.sql` | scrape_runs + started_at index |

各ファイル末尾に `INSERT INTO schema_migrations(filename) ... ON CONFLICT DO NOTHING` を含むことで、直接実行しても `npm run migrate` 経由で実行しても idempotent。

## 初回セットアップ

`docker compose up -d --build` 時に `db` サービスが空の `pgdata` ボリュームを作り、`/docker-entrypoint-initdb.d` 経由で `db/migrations/*.sql` をファイル名昇順に自動実行する。

## 追加マイグレーション

既存ボリュームでは entrypoint は再実行されない。新規 `db/migrations/NNNN_xxx.sql` を作って:

```bash
npm run migrate
```

`scripts/migrate.ts` が `schema_migrations` を読んで未適用のものだけ流す。

## 既知の課題(将来タスク)

- `events.updated_at`: UPDATE 時の自動更新トリガーは未設定。アプリ側で明示渡しで対応。
- `search_cache` の期限切れ行クリーンアップ手段(pg_cron 等)未設定。
- RLS 未設定(loopback only 運用なので問題なし)。
```

- [ ] **Step 4: 表記が残っていないか確認**

```bash
grep -RIn -E "vercel|supabase" --include='*.md' .
```

期待結果: `.gitignore` の `.vercel` 行など、ノイズ予防のためのコメントを除き、Vercel / Supabase の言及がドキュメントから消えている。残骸があれば Step 1〜3 を再修正。

- [ ] **Step 5: Commit**

```bash
git add README.md docs/ARCHITECTURE.md db/README.md
git commit -m "docs: rewrite README/ARCHITECTURE/db README for local docker setup"
```

---

## Task 17: 動作確認(スモーク)

**Files:** なし(既存設定の検証のみ)

- [ ] **Step 1: 完全クリーンビルドで起動**

```bash
docker compose down -v 2>/dev/null
docker compose up -d --build
```

期待結果: 3 サービス(db / app / ofelia)が起動。`docker compose ps` で `Up` / `healthy`。

- [ ] **Step 2: db のヘルスチェックが通っていることを確認**

```bash
docker compose ps
```

期待結果: `event-searcher-db` の STATUS が `healthy`。

- [ ] **Step 3: マイグレーションが流れていることを確認**

```bash
docker compose exec db psql -U app -d event_searcher -c "SELECT filename FROM schema_migrations ORDER BY filename;"
```

期待結果: 0000〜0004 の 5 行が表示。

- [ ] **Step 4: app に HTTP リクエスト**

```bash
curl -i http://localhost:3000/
```

期待結果: HTTP/1.1 200。Next.js のトップページ HTML が返る。

- [ ] **Step 5: キーワードを 1 件追加**

```bash
curl -i -X POST http://localhost:3000/api/saved-keywords \
  -H "Content-Type: application/json" \
  -d '{"keyword":"花江夏樹"}'
```

期待結果: HTTP/1.1 201、`{"keyword":{"id":1,"keyword":"花江夏樹",...}}`。

- [ ] **Step 6: 即時バッチ実行**

```bash
docker compose exec app npm run batch-fetch
```

期待結果: `done. processed 1 keywords.` で正常終了。

- [ ] **Step 7: events 行が増えたことを確認**

```bash
docker compose exec db psql -U app -d event_searcher -c "SELECT COUNT(*) FROM events; SELECT COUNT(*) FROM scrape_runs;"
```

期待結果: events / scrape_runs ともに > 0。

- [ ] **Step 8: 検索 API にリクエスト(キーワードあり)**

```bash
curl -s -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "q":"花江夏樹",
    "from":"2026-05-10T00:00:00+09:00",
    "to":"2026-06-30T23:59:59+09:00"
  }' | head -c 600
```

期待結果: JSON で `meta.fetched_strategy:"batch"`(saved_keywords にあるため)。

- [ ] **Step 9: 全テスト + ビルドの最終確認**

```bash
npx vitest run
npm run build
```

期待結果: vitest 全 green、`next build` 成功。

- [ ] **Step 10: docker compose を落として確認**

```bash
docker compose down
docker compose up -d
sleep 5
curl -i http://localhost:3000/
```

期待結果: `pgdata` ボリュームは保持されているので events / saved_keywords は残る。HTTP 200。

- [ ] **Step 11: 動作確認結果を 1 つのコミットにまとめる(必要なら微調整)**

実機検証で発見した問題があれば修正してコミット。問題なしなら「verify-only」コミットは作らず、最終 PR 作成段階に入る。

---

## 実装完了の確認チェックリスト

実装後に以下が満たされていることを確認:

- [ ] `docker compose up -d --build` 直後に http://localhost:3000 が 200。
- [ ] `/settings` からキーワードを追加できる。
- [ ] `docker compose exec app npm run batch-fetch` が正常終了し、events / scrape_runs に行が増える。
- [ ] `npx vitest run` がローカル(host)でグリーン。
- [ ] `npm run build` が成功。
- [ ] `.github/workflows/batch-fetch.yml` / `lib/supabase.ts` / `db/migrations/0005_grant_service_role.sql` がリポジトリから消えている。
- [ ] `README.md` / `docs/ARCHITECTURE.md` / `db/README.md` に Vercel / Supabase / GitHub Actions の記述が残っていない。
- [ ] `package.json` に `@supabase/supabase-js` が残っていない、`pg` が入っている。

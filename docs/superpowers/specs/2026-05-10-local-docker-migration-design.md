# Vercel + Supabase → ローカル Docker への移行設計

- 日付: 2026-05-10
- 対象: `kh55/event-searcher`
- 前提: Vercel プロジェクトと Supabase プロジェクトは削除済み。GitHub Actions cron も停止予定。

## 目的

外部 SaaS(Vercel / Supabase / GitHub Actions cron)に依存していた構成を解体し、自分の Mac 上で `docker compose up -d` だけで完結する個人利用向けデプロイへ移行する。意図しない課金を避け、依存サービスの仕様変更や障害から切り離した運用にする。

## スコープ

含む:
- Next.js アプリと Postgres のコンテナ化
- `@supabase/supabase-js` から `pg`(node-postgres)生 SQL への置き換え
- バッチ実行(`scripts/batch-fetch.ts`)を ofelia コンテナで定期実行
- マイグレーションのローカル運用手段
- 関連ドキュメント(README / ARCHITECTURE / db/README)更新
- `.github/workflows/batch-fetch.yml` と `lib/supabase.ts` の削除

含まない(別 PR / 将来):
- `runDbSearch` の to_tsquery + GIN ベースへの本格化(known_constraints の "performers 長文タイトル取りこぼし" 解消)
- LAN 公開・Basic 認証
- Mac 起動時の自動 `docker compose up`(launchd 等)
- DB 接続を要する integration test の追加
- 既存データの移行(初期化前提)

## アーキテクチャ

### 構成図

```
┌──────────────────────── docker compose stack ────────────────────────┐
│                                                                      │
│   ┌──────────┐         ┌────────────────┐         ┌──────────────┐   │
│   │  ofelia  │         │      app       │         │      db      │   │
│   │  (cron)  │ ──exec─►│  Next.js 16    │ ───SQL─►│  postgres:16 │   │
│   │          │         │  prod build    │   pg    │   -alpine    │   │
│   │ 0 21,9 * │         │                │         │              │   │
│   └────┬─────┘         │  /api/search   │         │  events      │   │
│        │               │  /api/saved-kw │         │  saved_kwds  │   │
│        │               │                │         │  search_cache│   │
│        │               │  scripts/      │         │  scrape_runs │   │
│        │               │  batch-fetch   │         └──────┬───────┘   │
│        │               └───────┬────────┘                │           │
│        │                       │                         │           │
│        │ docker socket         │ 127.0.0.1:3000          │ volume    │
│        ▼                       ▼                         ▼           │
│   /var/run/docker.sock     host port 3000           pgdata           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                 ▲
                                 │ Browser (Mac local)
                                 │ http://localhost:3000
```

### サービス一覧

| サービス | イメージ | 役割 | 公開ポート |
|---|---|---|---|
| **db** | `postgres:16-alpine` | PostgreSQL 本体。永続ボリューム `pgdata`、初回起動時に `db/migrations/*.sql` を `/docker-entrypoint-initdb.d` 経由で自動実行 | 127.0.0.1:5432 |
| **app** | 自前 Dockerfile (multi-stage `next build` → `next start`) | Next.js プロダクションサーバー、API、`scripts/batch-fetch.ts` も同じイメージから実行 | 127.0.0.1:3000 |
| **ofelia** | `mcuadros/ofelia:latest` | Docker socket 経由で `app` コンテナに `npm run batch-fetch` を JST 06:00 / 18:00 に投入 | なし |

### ポート公開ポリシー

- `app` は `127.0.0.1:3000` のみ。Mac 外からは見えない。
- `db` は `127.0.0.1:5432` を host に公開し、`psql` / GUI / host 上での `npm run batch-fetch` を可能にする。
- すべて loopback bind なので Deployment Protection / Basic 認証は不要。

### 永続化

- `pgdata` 名前付きボリュームのみ。
- アプリは stateless、`.next` は image に焼き込み(`output: standalone` は使わず通常の `next start` を採用)。

## コード差し替え

### A. 新規ファイル

| ファイル | 内容 |
|---|---|
| `lib/db.ts` | `pg.Pool` を遅延初期化して export する `getPool()`。`process.env.DATABASE_URL` を使用。テスト用 `_resetPoolForTests()` も。 |
| `Dockerfile` | Node 20 multi-stage(deps → builder → runner)。`next build` → `next start` を実行。 |
| `.dockerignore` | `node_modules` / `.next` / `.git` / `.env*` / `.playwright-mcp` 等を除外。 |
| `docker-compose.yml` | db / app / ofelia の 3 サービス。`pgdata` volume、内部ネットワーク。 |
| `docker/ofelia.ini` | ofelia の job-exec 定義(下記参照)。 |
| `scripts/migrate.ts` | `db/migrations/*.sql` を `schema_migrations` テーブルで管理して未適用のものだけ流す helper。`tsx scripts/migrate.ts` から起動。 |
| `tests/helpers/mock-pool.ts` | `Pool` 互換の最小 fake(`query` のみ)。`{ rows, rowCount }` を返す。 |

### B. 書き換え対象

| ファイル | 主な変更 |
|---|---|
| `lib/supabase.ts` | **削除**。 |
| `lib/search/index.ts` | `getServerClient()` → `getPool()`。`runDbSearch` の `from('events').select('*').eq().gte().lte().or()...` を 1 本の SQL クエリに置換。`searchEvents` 内の `search_cache` 参照/書き込み、`scrape_runs` insert も SQL 直書き。`upsertEvents` は `INSERT ... ON CONFLICT (source, source_event_id) DO UPDATE SET ...`。 |
| `lib/cache.ts` | `search_cache` の SELECT/INSERT を `pg` で書き直し。`event_ids` は `BIGINT[]` を `number[]` で受ける(`pg` のデフォルト動作)。 |
| `app/api/search/route.ts` | `lib/supabase` 依存削除。`searchEvents` 経由なので変更は import 程度。 |
| `app/api/saved-keywords/route.ts` | `from('saved_keywords').select/insert/delete` → SQL 直書き。 |
| `scripts/batch-fetch.ts` | 同上。`upsertEvents` のシグネチャは `Pool` を受け取る形に。`dotenv` の読込は維持(host から実行する用途のため)。 |
| `tests/**` | Supabase クライアントの mock を `tests/helpers/mock-pool.ts` の Pool mock に置換(該当テストのみ)。 |

### C. SQL クエリ仕様(現状 1:1 移植)

`runDbSearch` の中核:

```sql
SELECT * FROM events
WHERE
  ($1::timestamptz IS NULL OR starts_at >= $1)
  AND ($2::timestamptz IS NULL OR starts_at <= $2)
  AND ($3::text[] IS NULL OR area = ANY($3))
  AND ($4::boolean IS NULL OR is_online = $4)
  AND ($5::boolean IS NULL OR ($5 = true AND ticket_status = 'on_sale'))
  AND (
    $6::text[] = '{}' OR EXISTS (
      SELECT 1 FROM unnest($6::text[]) AS kw
      WHERE
        title ILIKE '%' || kw || '%'
        OR description ILIKE '%' || kw || '%'
        OR performers @> ARRAY[kw]
    )
  )
ORDER BY starts_at ASC
LIMIT $7;
```

- 現行の `or('title.ilike.%q%,description.ilike.%q%,performers.cs.{"q"}')` と挙動を一致させる。
- `q` のサニタイズ(`,()"*\` 除去)は prepared statement なので本来不要だが、関数自体はそのまま残す(リグレッション最小化のため。検索結果の文字列比較に影響しないことは既存テストで担保される)。
- `keywords[]` は空配列なら全件、要素ありなら OR で絞り込み(空キーワード時の `saved_keywords` フォールバックは `lib/search/index.ts` 側のロジックを維持)。
- `LIMIT` は現行の上限を流用。

`upsertEvents` の中核:

```sql
INSERT INTO events (source, source_event_id, title, description, starts_at, ends_at,
                    venue_name, prefecture, area, is_online, ticket_url, ticket_status,
                    performers, tags, fetched_at, updated_at)
VALUES ($1, $2, ...)
ON CONFLICT (source, source_event_id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  ...
  updated_at = EXCLUDED.updated_at;
```

複数行の bulk upsert は、行数が小さく(1 バッチ最大数十件想定)Postgres の placeholder 上限($65535)に十分収まるため、行ごとに `($1, $2, ..., $N), ($N+1, ...)` を生成する素直な方式を採る。`unnest()` 経由の固定列方式は今回は採用しない。

### D. 削除する依存・設定

- `package.json`: `@supabase/supabase-js` 削除、`pg` + `@types/pg` 追加。
- `dotenv`: 維持。
- `db/migrations/0005_grant_service_role.sql`: **削除**(superuser で接続するため不要)。
- `db/migrations/0001_create_events.sql` の `events_search_doc` IMMUTABLE wrapper はそのまま維持(GIN index に必要)。

### E. 環境変数

| Before | After |
|---|---|
| `SUPABASE_URL` | (削除) |
| `SUPABASE_SERVICE_ROLE_KEY` | (削除) |
| (なし) | `DATABASE_URL=postgres://app:app@db:5432/event_searcher`(コンテナ内)<br/>`DATABASE_URL=postgres://app:app@localhost:5432/event_searcher`(host から `npm run batch-fetch` 時) |

`.env.local.example` は host 用の `DATABASE_URL` を記載。`docker-compose.yml` の `app` サービスはコンテナ用の値で override。

DB の認証情報(`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`)は compose の `db` サービスで定義。loopback only なので strong password ではなく `app/app` で固定して構わない(README に明記)。

## cron(ofelia)

`docker/ofelia.ini`:

```ini
[job-exec "batch-fetch"]
schedule = 0 21,9 * * *
container = event-searcher-app
command = npm run batch-fetch
```

- スケジュールは UTC(= JST 06:00 / 18:00)。
- Mac スリープ中は動かない。次回起動時に取得し直せれば許容(個人利用 first)。
- 即時実行: `docker compose exec app npm run batch-fetch`。
- ofelia ログ: `docker compose logs -f ofelia`。`scrape_runs` テーブルへの記録は無変更。

## マイグレーション運用

ファイル単位の idempotent 適用を `schema_migrations` テーブルで管理する。

### スキーマ

新規ファイル `db/migrations/0000_create_schema_migrations.sql` を先頭に追加:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

### 各マイグレーションファイルの規約

`db/migrations/NNNN_xxx.sql` の **末尾** に必ず以下を追記する:

```sql
INSERT INTO schema_migrations(filename) VALUES ('NNNN_xxx.sql')
ON CONFLICT (filename) DO NOTHING;
```

これにより「ファイル単体を直接実行しても」「`migrate.ts` 経由で実行しても」結果が同じになる。

### 初回起動時

Postgres 公式イメージは `pgdata` ボリュームが空のときに `/docker-entrypoint-initdb.d/*.sql` をファイル名昇順で実行する。`db/migrations/` をそのまま read-only マウントすれば全ファイルが順に流れ、各ファイル末尾の INSERT で `schema_migrations` にも記録される。

```yaml
db:
  volumes:
    - pgdata:/var/lib/postgresql/data
    - ./db/migrations:/docker-entrypoint-initdb.d:ro
```

### 追加マイグレーション

`pgdata` が残っている既存環境では entrypoint は二度と動かない。新規 `db/migrations/NNNN_xxx.sql` を追加したら host から `npm run migrate` を実行する。`scripts/migrate.ts` の処理:

1. `DATABASE_URL` で接続。
2. `schema_migrations` のスキーマがなければ作成(0000 と同じ DDL を `CREATE TABLE IF NOT EXISTS` で再宣言)。
3. `db/migrations/*.sql` をファイル名昇順で列挙。
4. `SELECT filename FROM schema_migrations` の集合と差分を取り、未適用のものだけ順番に実行。
5. 各ファイルは末尾 INSERT を含むので `schema_migrations` への記録は SQL 側で完了する。

### 既存ファイルの末尾追記

実装時に `0001`〜`0004` の末尾にも上記 INSERT 行を 1 行ずつ追記する(`0005_grant_service_role.sql` は削除されるため対象外)。

## セットアップ手順(README 反映用)

```bash
# 1. 環境変数
cp .env.local.example .env.local
# DATABASE_URL=postgres://app:app@localhost:5432/event_searcher が入っている

# 2. 起動
docker compose up -d --build

# 3. 動作確認
open http://localhost:3000

# 4. キーワード追加(ブラウザ /settings から、または curl)
curl -X POST http://localhost:3000/api/saved-keywords \
  -H "Content-Type: application/json" \
  -d '{"keyword":"花江夏樹"}'

# 5. 即時バッチ
docker compose exec app npm run batch-fetch
```

## テスト

- 既存の vitest 77 ケースを維持。
- Supabase クライアント mock を Pool mock(`tests/helpers/mock-pool.ts`)に置換。
- 純粋ロジック層(`area.ts`、`date.ts`、`online-detection.ts`、`ticket-status.ts`、各 adapter)は無変更。
- DB 接続を要する integration test は今回追加しない(MVP の現状維持)。

## ドキュメント更新

| ファイル | 変更点 |
|---|---|
| `README.md` | クイックスタートを `docker compose up -d` 中心に書き直し |
| `docs/ARCHITECTURE.md` | システム俯瞰を docker-compose 3 サービスに置換。「環境変数」「デプロイ」「オペレーション」「トラブルシューティング」「セキュリティモデル」を Docker 文脈で書き直し。Vercel / Supabase / GitHub Actions の記述削除。 |
| `db/README.md` | Supabase ダッシュボード手順削除、`docker-entrypoint-initdb.d` と `npm run migrate` の手順に置換。 |
| `AGENTS.md` / `CLAUDE.md` | 変更なし。 |

## 削除・後始末

- `.vercel/`(残っていれば)を削除。`.gitignore` の `.vercel` 行は予防のため維持。
- `.github/workflows/batch-fetch.yml` を削除。空になった `.github/workflows/` ディレクトリは残してよい。
- `package.json` から `@supabase/supabase-js` を削除し、`pg` / `@types/pg` を追加。`npm install` 再実行で lockfile 更新。
- メモ系(`project_state.md` / `architecture_doc_pointer.md`)は実装完了後に Docker 構成へ更新。

## 外部サービスの利用確認

| サービス | 課金 |
|---|---|
| `postgres:16-alpine` | OSS / Docker Hub free pull(無料) |
| `mcuadros/ofelia:latest` | OSS / Docker Hub free pull(無料) |
| `pg`(npm) | OSS(無料) |
| host PC のリソース | 自分の Mac のみ |

外部 SaaS は一切使わないため意図しない課金は発生しない。

## リスク・留意点

- **Mac スリープ中は cron が走らない** → 個人利用 first のため許容。
- **起動忘れ** → 自動起動が必要になれば将来 launchd 等で対応。
- **Docker socket マウント**(ofelia 用)は対象コンテナを root 同等にする。loopback only 運用なので許容。LAN / 外部公開時には要再検討。
- **`runDbSearch` 書き換えのリグレッション**: PostgREST `.cs.{X}` と SQL `performers @> ARRAY[X]` の意味が等価であること、GIN index が新クエリでも効くことをテストで担保。
- **PostgREST 非経由化**: 自動 REST API は失う。今回はフロント側からも常に `/api/*` 経由で叩く構成のため影響なし。

## 受け入れ条件

- `docker compose up -d --build` 直後に http://localhost:3000 が 200 を返す。
- `/settings` からキーワードを追加できる。
- `docker compose exec app npm run batch-fetch` が正常終了し、`events` / `scrape_runs` に行が増える。
- `vitest run` がローカル(host)でグリーン。`npm run build` が成功。
- `.github/workflows/batch-fetch.yml` / `lib/supabase.ts` / `db/migrations/0005_grant_service_role.sql` がリポジトリから消えている。
- ドキュメント(README / ARCHITECTURE / db/README)に Vercel / Supabase / GitHub Actions の記述が残っていない。

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

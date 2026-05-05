# DB Migrations

Run order: 0001 → 0002 → 0003 → 0004 → 0005.

| ファイル | 役割 |
|---|---|
| `0001_create_events.sql` | events テーブル + IMMUTABLE wrapper 関数 (`events_search_doc`) + GIN / B-tree index |
| `0002_create_saved_keywords.sql` | saved_keywords テーブル |
| `0003_create_search_cache.sql` | search_cache テーブル + expires_at index |
| `0004_create_scrape_runs.sql` | scrape_runs テーブル + started_at index |
| `0005_grant_service_role.sql` | `service_role` ロールへの GRANT(Supabase の "Automatically expose new tables: OFF" 補完) |

## ローカル(Supabase CLI)

```bash
supabase start
# DB URL を取得してから psql で実行
DB_URL=$(supabase status -o env | grep '^DB_URL=' | cut -d'=' -f2- | tr -d '"')
for f in db/migrations/*.sql; do psql "$DB_URL" -f "$f"; done
```

## 本番(Supabase クラウド)

Supabase ダッシュボードの SQL Editor に各ファイルを順に貼り付けて実行。

## 既知の課題(将来タスクで対応)

- `events.updated_at` は INSERT 時のデフォルトのみで、UPDATE 時の自動更新トリガーは未設定。バッチ取得側(Task 11/16)で明示的に値を渡すことで対応する。
- RLS(Row-Level Security)未設定。MVP は Service Role Key 経由のみで使用するため問題ないが、anon キーをフロントから直接使う構成に変える際はポリシー追加が必要。
- `search_cache` の期限切れ行クリーンアップ手段(pg_cron 等)未設定。

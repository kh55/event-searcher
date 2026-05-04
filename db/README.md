# DB Migrations

Run order: 0001 → 0002 → 0003 → 0004.

## ローカル(Supabase CLI)

```bash
supabase start
for f in db/migrations/*.sql; do supabase db execute --file "$f"; done
```

## 本番(Supabase クラウド)

Supabase ダッシュボードの SQL Editor に各ファイルを貼り付けて実行。

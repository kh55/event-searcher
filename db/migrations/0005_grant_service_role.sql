-- db/migrations/0005_grant_service_role.sql
--
-- Supabase でプロジェクト作成時に「Automatically expose new tables」を OFF にすると、
-- 新規テーブルが Data API ロール (anon / authenticated / service_role) に対して
-- 自動 GRANT されない。本アプリは server / batch から service_role キーで叩く前提
-- なので、ここで明示的に service_role に必要な権限を付与する。
--
-- anon / authenticated には GRANT しない (= ブラウザから直接 DB を叩かせない)。

GRANT ALL ON TABLE events, saved_keywords, search_cache, scrape_runs TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

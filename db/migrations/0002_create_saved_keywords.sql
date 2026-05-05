-- db/migrations/0002_create_saved_keywords.sql
CREATE TABLE saved_keywords (
  id              BIGSERIAL PRIMARY KEY,
  keyword         TEXT NOT NULL UNIQUE,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

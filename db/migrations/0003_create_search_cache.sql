-- db/migrations/0003_create_search_cache.sql
CREATE TABLE search_cache (
  cache_key  TEXT PRIMARY KEY,
  event_ids  BIGINT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_search_cache_expires_at ON search_cache (expires_at);

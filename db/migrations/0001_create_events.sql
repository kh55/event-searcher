-- db/migrations/0001_create_events.sql
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,
  venue_name      TEXT,
  prefecture      TEXT,
  area            TEXT,
  is_online       BOOLEAN NOT NULL DEFAULT false,
  ticket_url      TEXT,
  ticket_status   TEXT NOT NULL DEFAULT 'unknown',
  performers      TEXT[]   NOT NULL DEFAULT '{}',
  tags            TEXT[]   NOT NULL DEFAULT '{}',
  fetched_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_event_id)
);

-- IMMUTABLE wrapper: index 式に直接 to_tsvector + array_to_string を書くと
-- "ERROR: 42P17 functions in index expression must be marked IMMUTABLE" になる。
-- 原因は2つ:
--   (1) 'simple' リテラルから regconfig への暗黙キャストはカタログ検索を伴い STABLE 扱い
--       → 'simple'::regconfig と明示することで解決
--   (2) array_to_string(anyarray, text) 自体が STABLE と宣言されている
--       (text[] 入力では実質 deterministic だが、Postgres は他の型のために保守的に STABLE)
--       → text[] 専用の wrapper を IMMUTABLE で再宣言する
CREATE FUNCTION events_search_doc(t TEXT, d TEXT, p TEXT[])
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT to_tsvector(
    'simple'::regconfig,
    t || ' ' || COALESCE(d, '') || ' ' || array_to_string(p, ' ')
  )
$$;

CREATE INDEX idx_events_search ON events
  USING GIN (events_search_doc(title, description, performers));
CREATE INDEX idx_events_starts_at ON events (starts_at);
CREATE INDEX idx_events_area      ON events (area, starts_at);

INSERT INTO schema_migrations(filename) VALUES ('0001_create_events.sql')
ON CONFLICT (filename) DO NOTHING;

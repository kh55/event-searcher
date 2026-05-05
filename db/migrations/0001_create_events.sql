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

CREATE INDEX idx_events_search ON events
  USING GIN (to_tsvector(
    'simple',
    title || ' ' || COALESCE(description,'') || ' ' || array_to_string(performers,' ')
  ));
CREATE INDEX idx_events_starts_at ON events (starts_at);
CREATE INDEX idx_events_area      ON events (area, starts_at);

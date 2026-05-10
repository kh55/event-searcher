-- db/migrations/0004_create_scrape_runs.sql
CREATE TABLE scrape_runs (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  keyword       TEXT,
  trigger       TEXT NOT NULL,
  events_found  INT  NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX idx_scrape_runs_started_at ON scrape_runs (started_at DESC);

INSERT INTO schema_migrations(filename) VALUES ('0004_create_scrape_runs.sql')
ON CONFLICT (filename) DO NOTHING;

-- db/migrations/0000_create_schema_migrations.sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations(filename) VALUES ('0000_create_schema_migrations.sql')
ON CONFLICT (filename) DO NOTHING;

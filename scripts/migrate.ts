// scripts/migrate.ts
// db/migrations/*.sql を schema_migrations で管理して未適用のものだけ流す。
// host から `npm run migrate` で実行することを想定。
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', quiet: true });

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations'))
        .rows.map(r => r.filename),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`applying ${file}...`);
      await pool.query(sql);
      appliedCount++;
    }

    console.log(`done. applied ${appliedCount} migration(s).`);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

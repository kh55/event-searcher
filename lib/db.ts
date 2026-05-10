import { Pool } from 'pg';

let cached: Pool | null = null;

export function getPool(): Pool {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  cached = new Pool({ connectionString: url });
  return cached;
}

export function _resetPoolForTests(): void {
  cached = null;
}

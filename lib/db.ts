import { Pool, types } from 'pg';

// Coerce BIGINT (oid 20 / INT8) to number to maintain API contract with prior Supabase behavior.
// For our row counts (event IDs < Number.MAX_SAFE_INTEGER), this is safe.
types.setTypeParser(types.builtins.INT8, (val: string) => parseInt(val, 10));

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

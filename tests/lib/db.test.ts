import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPool, _resetPoolForTests } from '@/lib/db';

describe('getPool', () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    _resetPoolForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalEnv;
  });

  it('returns a pool when DATABASE_URL is set', () => {
    process.env.DATABASE_URL = 'postgres://app:app@localhost:5432/event_searcher';
    const pool = getPool();
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe('function');
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow(/DATABASE_URL/);
  });

  it('returns the same instance across calls (cached)', () => {
    process.env.DATABASE_URL = 'postgres://app:app@localhost:5432/event_searcher';
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });
});

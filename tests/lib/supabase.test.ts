// tests/lib/supabase.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getServerClient, _resetClientForTests } from '@/lib/supabase';

describe('getServerClient', () => {
  beforeEach(() => {
    _resetClientForTests();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key';
  });

  it('returns a client', () => {
    const client = getServerClient();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe('function');
  });

  it('throws when env is missing', () => {
    delete process.env.SUPABASE_URL;
    expect(() => getServerClient()).toThrow(/SUPABASE_URL/);
  });
});

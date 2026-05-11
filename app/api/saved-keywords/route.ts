import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';

export const postSchema = z.object({ keyword: z.string().min(1).max(100) });

export async function GET() {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      'SELECT id, keyword, last_fetched_at, created_at FROM saved_keywords ORDER BY created_at DESC',
    );
    return NextResponse.json({ keywords: rows });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO saved_keywords (keyword)
       VALUES ($1)
       ON CONFLICT (keyword) DO UPDATE SET keyword = EXCLUDED.keyword
       RETURNING id, keyword, last_fetched_at, created_at`,
      [parsed.data.keyword],
    );
    return NextResponse.json({ keyword: rows[0] }, { status: 201 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

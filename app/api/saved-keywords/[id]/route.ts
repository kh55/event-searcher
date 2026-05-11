import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const pool = getPool();
  try {
    await pool.query('DELETE FROM saved_keywords WHERE id = $1', [numId]);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

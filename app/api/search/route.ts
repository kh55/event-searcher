import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerClient } from '@/lib/supabase';
import { searchEvents } from '@/lib/search';

export const searchInputSchema = z.object({
  q: z.string().default(''),
  from: z.string().transform(s => new Date(s)),
  to: z.string().transform(s => new Date(s)),
  areas: z.array(z.string()).default([]),
  include_online: z.boolean().default(false),
  on_sale_only: z.boolean().default(true),
}).refine(
  v => v.from.getTime() <= v.to.getTime(),
  { message: 'from must be <= to' },
);

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = searchInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid input', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const v = parsed.data;
  const client = getServerClient();
  try {
    const result = await searchEvents(client, {
      q: v.q,
      from: v.from,
      to: v.to,
      areas: v.areas,
      includeOnline: v.include_online,
      onSaleOnly: v.on_sale_only,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[search] error', e);
    return NextResponse.json(
      { error: 'internal error', message: e?.message ?? 'unknown' },
      { status: 500 },
    );
  }
}

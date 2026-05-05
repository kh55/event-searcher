import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerClient } from '@/lib/supabase';

export const postSchema = z.object({ keyword: z.string().min(1).max(100) });

export async function GET() {
  const client = getServerClient();
  const { data, error } = await client
    .from('saved_keywords')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keywords: data });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const client = getServerClient();
  const { data, error } = await client
    .from('saved_keywords')
    .upsert({ keyword: parsed.data.keyword }, { onConflict: 'keyword' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keyword: data }, { status: 201 });
}

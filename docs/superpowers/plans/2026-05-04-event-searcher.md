# event-searcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 声優・アニメ作品名等のキーワードで全国のイベントを横断検索できる Web サービスの MVP を構築する。

**Architecture:** Next.js 15 (App Router) + Supabase (PostgreSQL) のモノリポ。スクレイピングは `SourceAdapter` インタフェースで抽象化し、ぴあ・Walkerplus のアダプタを実装。検索はバッチ巡回(GitHub Actions cron)で取り込んだ DB を主とし、未取得キーワードはオンデマンド取得+キャッシュ(6h)で補完するハイブリッド方式。

**Tech Stack:** Next.js 15, TypeScript, Supabase (PostgreSQL), Vitest, Cheerio + undici, GitHub Actions, Vercel

**Spec:** `docs/superpowers/specs/2026-05-04-event-searcher-design.md`

---

## Task 1: プロジェクトスキャフォールド

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.local.example`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`

- [ ] **Step 1: Next.js アプリを初期化(temp 経由でマージ)**

`create-next-app` は非空ディレクトリでは失敗するため、tempディレクトリで生成してから既存ファイルを上書きしないようにマージする。

```bash
TMP=$(mktemp -d)
npx create-next-app@latest "$TMP/scaffold" \
  --typescript --tailwind --eslint \
  --app --no-src-dir --import-alias="@/*" \
  --no-git --use-npm --turbopack
# 既存ファイル(.gitignore, docs/ 等)は上書きしない
cp -rn "$TMP/scaffold/." .
rm -rf "$TMP"
```

その後、次のステップで上書きしたくなかったファイルを確認:

```bash
git status
git diff -- .gitignore   # 既存の .gitignore はそのまま残っているはず
```

- [ ] **Step 2: 追加依存をインストール**

```bash
npm install @supabase/supabase-js cheerio undici zod
npm install -D vitest @vitest/ui @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @types/node
```

- [ ] **Step 3: vitest.config.ts を作成**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: [],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
```

- [ ] **Step 4: package.json にテストスクリプトを追加**

`scripts` セクションに以下を追加:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: .env.local.example を作成**

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

- [ ] **Step 6: .gitignore に Next.js の標準を追記**

既存の `.gitignore` の末尾に以下を追加(重複は気にしない):

```
.next/
next-env.d.ts
```

- [ ] **Step 7: スモークテストを作成**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from 'vitest';
describe('smoke', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 8: テストを実行して通ることを確認**

Run: `npm test`
Expected: `1 passed`

- [ ] **Step 9: dev サーバが起動することを確認**

Run: `npm run dev`
Expected: `http://localhost:3000` で Next.js デフォルトページ。確認したら Ctrl+C で停止。

- [ ] **Step 10: コミット**

```bash
git add -A
git commit -m "chore: scaffold Next.js + Vitest project"
```

---

## Task 2: DB マイグレーション SQL の作成

**Files:**
- Create: `db/migrations/0001_create_events.sql`
- Create: `db/migrations/0002_create_saved_keywords.sql`
- Create: `db/migrations/0003_create_search_cache.sql`
- Create: `db/migrations/0004_create_scrape_runs.sql`
- Create: `db/README.md`

- [ ] **Step 1: events テーブルの SQL を作成**

```sql
-- db/migrations/0001_create_events.sql
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,
  venue_name      TEXT,
  prefecture      TEXT,
  area            TEXT,
  is_online       BOOLEAN NOT NULL DEFAULT false,
  ticket_url      TEXT,
  ticket_status   TEXT NOT NULL DEFAULT 'unknown',
  performers      TEXT[]   NOT NULL DEFAULT '{}',
  tags            TEXT[]   NOT NULL DEFAULT '{}',
  fetched_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_event_id)
);

CREATE INDEX idx_events_search ON events
  USING GIN (to_tsvector(
    'simple',
    title || ' ' || COALESCE(description,'') || ' ' || array_to_string(performers,' ')
  ));
CREATE INDEX idx_events_starts_at ON events (starts_at);
CREATE INDEX idx_events_area      ON events (area, starts_at);
```

- [ ] **Step 2: saved_keywords テーブルの SQL を作成**

```sql
-- db/migrations/0002_create_saved_keywords.sql
CREATE TABLE saved_keywords (
  id              BIGSERIAL PRIMARY KEY,
  keyword         TEXT NOT NULL UNIQUE,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 3: search_cache テーブルの SQL を作成**

```sql
-- db/migrations/0003_create_search_cache.sql
CREATE TABLE search_cache (
  cache_key  TEXT PRIMARY KEY,
  event_ids  BIGINT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_search_cache_expires_at ON search_cache (expires_at);
```

- [ ] **Step 4: scrape_runs テーブルの SQL を作成**

```sql
-- db/migrations/0004_create_scrape_runs.sql
CREATE TABLE scrape_runs (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  keyword       TEXT,
  trigger       TEXT NOT NULL,
  events_found  INT  NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX idx_scrape_runs_started_at ON scrape_runs (started_at DESC);
```

- [ ] **Step 5: db/README.md を作成**

```markdown
# DB Migrations

Run order: 0001 → 0002 → 0003 → 0004.

## ローカル(Supabase CLI)

\`\`\`bash
supabase start
for f in db/migrations/*.sql; do supabase db execute --file "$f"; done
\`\`\`

## 本番(Supabase クラウド)

Supabase ダッシュボードの SQL Editor に各ファイルを貼り付けて実行。
```

- [ ] **Step 6: コミット**

```bash
git add db/
git commit -m "feat: add DB migrations for events, saved_keywords, search_cache, scrape_runs"
```

---

## Task 3: Supabase クライアントの作成

**Files:**
- Create: `lib/supabase.ts`
- Create: `tests/lib/supabase.test.ts`

- [ ] **Step 1: テストを書く(クライアント生成の最低限の動作)**

```ts
// tests/lib/supabase.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getServerClient } from '@/lib/supabase';

describe('getServerClient', () => {
  beforeEach(() => {
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
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- supabase`
Expected: Cannot find module `@/lib/supabase`

- [ ] **Step 3: クライアントを実装**

```ts
// lib/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getServerClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

// テスト用: キャッシュリセット
export function _resetClientForTests() { cached = null; }
```

- [ ] **Step 4: テスト実行**

```ts
// tests/lib/supabase.test.ts の beforeEach に追加
import { _resetClientForTests } from '@/lib/supabase';
beforeEach(() => { _resetClientForTests(); /* ... */ });
```

Run: `npm test -- supabase`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/supabase.ts tests/lib/supabase.test.ts
git commit -m "feat: add Supabase server client wrapper with env validation"
```

---

## Task 4: エリア変換ユーティリティ(lib/area.ts)

**Files:**
- Create: `lib/area.ts`
- Create: `tests/lib/area.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// tests/lib/area.test.ts
import { describe, it, expect } from 'vitest';
import { prefectureToArea, prefecturesInArea, AREAS } from '@/lib/area';

describe('prefectureToArea', () => {
  it.each([
    ['東京都', '関東'],
    ['神奈川県', '関東'],
    ['大阪府', '近畿'],
    ['愛知県', '東海'],
    ['北海道', '北海道/東北'],
    ['福島県', '北海道/東北'],
    ['新潟県', '北陸'],
    ['広島県', '中国/四国'],
    ['沖縄県', '九州/沖縄'],
  ])('%s -> %s', (pref, expected) => {
    expect(prefectureToArea(pref)).toBe(expected);
  });

  it('returns null for unknown prefecture', () => {
    expect(prefectureToArea('火星都')).toBeNull();
  });

  it('handles empty string', () => {
    expect(prefectureToArea('')).toBeNull();
  });
});

describe('prefecturesInArea', () => {
  it('関東 contains 7 prefectures', () => {
    const list = prefecturesInArea('関東');
    expect(list).toContain('東京都');
    expect(list).toContain('神奈川県');
    expect(list).toHaveLength(7);
  });
});

describe('AREAS', () => {
  it('exposes the 7 area names in order', () => {
    expect(AREAS).toEqual([
      '関東', '近畿', '東海', '北海道/東北', '北陸', '中国/四国', '九州/沖縄',
    ]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- area`
Expected: Cannot find module `@/lib/area`

- [ ] **Step 3: 実装**

```ts
// lib/area.ts
export const AREAS = [
  '関東', '近畿', '東海', '北海道/東北', '北陸', '中国/四国', '九州/沖縄',
] as const;
export type Area = typeof AREAS[number];

const AREA_TO_PREFS: Record<Area, string[]> = {
  '関東':       ['東京都','神奈川県','埼玉県','千葉県','茨城県','栃木県','群馬県'],
  '近畿':       ['大阪府','京都府','兵庫県','奈良県','滋賀県','和歌山県'],
  '東海':       ['愛知県','岐阜県','三重県','静岡県'],
  '北海道/東北': ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県'],
  '北陸':       ['新潟県','富山県','石川県','福井県','長野県','山梨県'],
  '中国/四国':   ['岡山県','広島県','鳥取県','島根県','山口県','香川県','徳島県','愛媛県','高知県'],
  '九州/沖縄':   ['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'],
};

const PREF_TO_AREA: Record<string, Area> = (() => {
  const map: Record<string, Area> = {};
  for (const area of AREAS) for (const p of AREA_TO_PREFS[area]) map[p] = area;
  return map;
})();

export function prefectureToArea(prefecture: string): Area | null {
  return PREF_TO_AREA[prefecture] ?? null;
}

export function prefecturesInArea(area: Area): string[] {
  return [...AREA_TO_PREFS[area]];
}
```

- [ ] **Step 4: テスト実行**

Run: `npm test -- area`
Expected: All tests pass

- [ ] **Step 5: コミット**

```bash
git add lib/area.ts tests/lib/area.test.ts
git commit -m "feat: add prefecture-to-area conversion utility"
```

---

## Task 5: 日付ユーティリティ(lib/date.ts)

**Files:**
- Create: `lib/date.ts`
- Create: `tests/lib/date.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// tests/lib/date.test.ts
import { describe, it, expect } from 'vitest';
import { getThisWeekend, getNextWeekend } from '@/lib/date';

// 全テストは JST 基準
// 2026-05-04 (月) を基準日にする

describe('getThisWeekend', () => {
  it('月曜から見ると今週末は今週の土日(2026-05-09 土〜2026-05-10 日)', () => {
    const now = new Date('2026-05-04T10:00:00+09:00'); // 月
    const r = getThisWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-08T15:00:00.000Z'); // 5/9 00:00 JST
    expect(r.to.toISOString()).toBe('2026-05-10T14:59:59.999Z');   // 5/10 23:59:59.999 JST
  });

  it('土曜の朝でも今週末はその土日', () => {
    const now = new Date('2026-05-09T08:00:00+09:00'); // 土
    const r = getThisWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-08T15:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-05-10T14:59:59.999Z');
  });

  it('日曜の夜でも今週末はその土日', () => {
    const now = new Date('2026-05-10T22:00:00+09:00'); // 日
    const r = getThisWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-08T15:00:00.000Z');
  });
});

describe('getNextWeekend', () => {
  it('月曜から見ると来週末は来週の土日', () => {
    const now = new Date('2026-05-04T10:00:00+09:00'); // 月
    const r = getNextWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-15T15:00:00.000Z'); // 5/16 00:00 JST
    expect(r.to.toISOString()).toBe('2026-05-17T14:59:59.999Z');
  });

  it('日曜から見ると来週末は次の土日', () => {
    const now = new Date('2026-05-10T10:00:00+09:00'); // 日
    const r = getNextWeekend(now);
    expect(r.from.toISOString()).toBe('2026-05-15T15:00:00.000Z');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- date`
Expected: Cannot find module

- [ ] **Step 3: 実装**

```ts
// lib/date.ts
const JST_OFFSET_MIN = 9 * 60;

function toJstParts(d: Date): { year: number; month: number; day: number; weekday: number } {
  // weekday: 0=Sun, 1=Mon, ..., 6=Sat
  const utcMs = d.getTime();
  const jstMs = utcMs + JST_OFFSET_MIN * 60 * 1000;
  const jst = new Date(jstMs);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    weekday: jst.getUTCDay(),
  };
}

function jstDateUtc(year: number, month: number, day: number, hour = 0, min = 0, sec = 0, ms = 0): Date {
  // JST の指定日時を UTC Date として返す
  return new Date(Date.UTC(year, month - 1, day, hour - 9, min, sec, ms));
}

export interface DateRange { from: Date; to: Date; }

function weekendOf(saturdayDateInJst: { year: number; month: number; day: number }): DateRange {
  const { year, month, day } = saturdayDateInJst;
  const from = jstDateUtc(year, month, day, 0, 0, 0, 0);
  const sunday = new Date(from);
  sunday.setUTCDate(sunday.getUTCDate() + 1);
  const sundayJst = toJstParts(sunday);
  const to = jstDateUtc(sundayJst.year, sundayJst.month, sundayJst.day, 23, 59, 59, 999);
  return { from, to };
}

function nearestSaturdayJst(now: Date, weeksAhead: number): { year: number; month: number; day: number } {
  const { year, month, day, weekday } = toJstParts(now);
  // 直近の土曜まで進める日数(土なら 0、日なら -1 → 6前にしたいが、仕様: 日曜の夜でも今週末)
  // 仕様: 日曜は「直前の土曜」を含む土日が今週末
  let offset: number;
  if (weekday === 0) offset = -1;          // 日 → -1 (前日が土)
  else if (weekday === 6) offset = 0;      // 土 → 当日
  else offset = 6 - weekday;               // 月-金 → 次の土曜まで
  offset += 7 * weeksAhead;
  const saturday = jstDateUtc(year, month, day, 0, 0, 0, 0);
  saturday.setUTCDate(saturday.getUTCDate() + offset);
  return toJstParts(saturday);
}

export function getThisWeekend(now: Date = new Date()): DateRange {
  return weekendOf(nearestSaturdayJst(now, 0));
}

export function getNextWeekend(now: Date = new Date()): DateRange {
  return weekendOf(nearestSaturdayJst(now, 1));
}
```

- [ ] **Step 4: テスト実行**

Run: `npm test -- date`
Expected: All tests pass

- [ ] **Step 5: コミット**

```bash
git add lib/date.ts tests/lib/date.test.ts
git commit -m "feat: add JST-based this/next weekend date range utilities"
```

---

## Task 6: 配信判定 + チケット状態正規化

**Files:**
- Create: `lib/online-detection.ts`
- Create: `lib/ticket-status.ts`
- Create: `tests/lib/online-detection.test.ts`
- Create: `tests/lib/ticket-status.test.ts`

- [ ] **Step 1: 配信判定のテストを書く**

```ts
// tests/lib/online-detection.test.ts
import { describe, it, expect } from 'vitest';
import { isOnlineEvent } from '@/lib/online-detection';

describe('isOnlineEvent', () => {
  it.each([
    ['【オンライン配信】トークイベント', '', '', true],
    ['ライブ',                          '生配信あり', '', true],
    ['ライブ',                          '',           'ライブ配信会場', true],
    ['ライブ',                          '',           'パシフィコ横浜', false],
    ['LIVE STREAMING SHOW',              '',           '', true],
    ['ライブビューイング併催',            '',           '', true],
    ['',                                 '',           '', false],
  ])('title=%s desc=%s venue=%s -> %s', (title, desc, venue, expected) => {
    expect(isOnlineEvent({ title, description: desc, venueName: venue })).toBe(expected);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- online`
Expected: FAIL

- [ ] **Step 3: 配信判定を実装**

```ts
// lib/online-detection.ts
const ONLINE_KEYWORDS = [
  '配信', 'オンライン', 'ライブビューイング', '生配信',
  'LIVE STREAMING', 'online',
];

export function isOnlineEvent(input: {
  title: string;
  description?: string;
  venueName?: string;
}): boolean {
  const haystack = [input.title, input.description, input.venueName]
    .filter(Boolean).join(' ').toLowerCase();
  return ONLINE_KEYWORDS.some(k => haystack.includes(k.toLowerCase()));
}
```

- [ ] **Step 4: テスト実行**

Run: `npm test -- online`
Expected: PASS

- [ ] **Step 5: チケット状態のテストを書く**

```ts
// tests/lib/ticket-status.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeTicketStatus } from '@/lib/ticket-status';

describe('normalizeTicketStatus', () => {
  it.each([
    ['発売中',     'on_sale'],
    ['販売中',     'on_sale'],
    ['チケット発売中', 'on_sale'],
    ['SOLD OUT',  'sold_out'],
    ['完売',       'sold_out'],
    ['終了',       'ended'],
    ['販売終了',   'ended'],
    ['抽選受付中', 'lottery'],
    ['先行抽選',   'lottery'],
    ['',           'unknown'],
    ['謎の状態',   'unknown'],
  ])('"%s" -> %s', (input, expected) => {
    expect(normalizeTicketStatus(input)).toBe(expected);
  });
});
```

- [ ] **Step 6: チケット状態を実装**

```ts
// lib/ticket-status.ts
export type TicketStatus = 'on_sale' | 'sold_out' | 'ended' | 'lottery' | 'unknown';

export function normalizeTicketStatus(rawText: string): TicketStatus {
  const t = (rawText || '').trim().toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('sold out') || t.includes('完売')) return 'sold_out';
  if (t.includes('抽選') || t.includes('先行')) return 'lottery';
  if (t.includes('終了') || t.includes('販売終了')) return 'ended';
  if (t.includes('発売中') || t.includes('販売中') || t.includes('受付中')) return 'on_sale';
  return 'unknown';
}
```

- [ ] **Step 7: テスト実行**

Run: `npm test -- ticket`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add lib/online-detection.ts lib/ticket-status.ts tests/lib/online-detection.test.ts tests/lib/ticket-status.test.ts
git commit -m "feat: add online-event detection and ticket-status normalization"
```

---

## Task 7: アダプタ型定義 + 共通HTTPユーティリティ

**Files:**
- Create: `scrapers/types.ts`
- Create: `scrapers/http.ts`
- Create: `tests/scrapers/http.test.ts`

- [ ] **Step 1: 型定義を作成**

```ts
// scrapers/types.ts
import type { TicketStatus } from '@/lib/ticket-status';

export interface SearchParams {
  keyword?: string;
  dateFrom: Date;
  dateTo: Date;
  prefectures?: string[];
  includeOnline: boolean;
}

export interface RawEvent {
  sourceEventId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
  venueName?: string;
  prefecture?: string;
  isOnline: boolean;
  ticketUrl?: string;
  ticketStatus: TicketStatus;
  performers: string[];
  tags: string[];
}

export interface SourceAdapter {
  readonly source: string;
  search(params: SearchParams): Promise<RawEvent[]>;
}
```

- [ ] **Step 2: HTTP ユーティリティのテストを書く**

```ts
// tests/scrapers/http.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchHtml, USER_AGENT } from '@/scrapers/http';

describe('fetchHtml', () => {
  it('GET でテキストを取得し、UA ヘッダを付ける', async () => {
    const calls: { url: string; init: any }[] = [];
    const mockFetch = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response('<html>ok</html>', { status: 200 });
    });
    const html = await fetchHtml('https://example.com', { fetch: mockFetch as any });
    expect(html).toBe('<html>ok</html>');
    expect(calls[0].init.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('non-2xx で例外を投げる', async () => {
    const mockFetch = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(fetchHtml('https://example.com', { fetch: mockFetch as any }))
      .rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npm test -- http`
Expected: Cannot find module

- [ ] **Step 4: HTTPユーティリティを実装**

```ts
// scrapers/http.ts
export const USER_AGENT = 'event-searcher/0.1 (+https://github.com/your/event-searcher)';

export interface FetchHtmlOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchHtml(url: string, opts: FetchHtmlOptions = {}): Promise<string> {
  const f = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await f(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,*/*;q=0.8',
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 並列実行のための簡易レートリミッタ
export class RateLimiter {
  private last = 0;
  constructor(private minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const wait = this.last + this.minIntervalMs - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.last = Date.now();
  }
}
```

- [ ] **Step 5: テスト実行**

Run: `npm test -- http`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add scrapers/types.ts scrapers/http.ts tests/scrapers/http.test.ts
git commit -m "feat: add scraper types and HTTP utility with rate limiter"
```

---

## Task 8: ぴあアダプタ(scrapers/pia.ts)

**Files:**
- Create: `scrapers/pia.ts`
- Create: `scrapers/__fixtures__/pia/search-result.html`
- Create: `tests/scrapers/pia.test.ts`

> **重要**: 実際の HTML を保存してから書く。サイト構造変更時にここから検知できる。

- [ ] **Step 1: 実 HTML を取得して fixture に保存**

```bash
mkdir -p scrapers/__fixtures__/pia
curl -A "event-searcher/0.1" \
  'https://t.pia.jp/pia/search.do?searchType=keyword&kw=花江夏樹' \
  > scrapers/__fixtures__/pia/search-result.html
```

取得した HTML の構造をブラウザの開発者ツールで確認し、以下を特定する:

- 検索結果の各イベントを囲むセレクタ
- タイトル、日付、会場、チケット URL、販売状態 のセレクタ

(確認結果はコメントとしてアダプタに残す)

- [ ] **Step 2: アダプタのテストを書く**

> **注**: 実 HTML 構造を確認した後、ここで `expected` を実データに合わせる。以下はテンプレ。

```ts
// tests/scrapers/pia.test.ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { piaAdapter } from '@/scrapers/pia';

const FIXTURE = readFileSync(
  join(__dirname, '../../scrapers/__fixtures__/pia/search-result.html'),
  'utf-8',
);

describe('piaAdapter.search', () => {
  it('parses fixture and returns RawEvent[] with required fields', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await piaAdapter.search(
      {
        keyword: '花江夏樹',
        dateFrom: new Date('2026-05-01'),
        dateTo: new Date('2026-05-31'),
        includeOnline: true,
      },
      { fetch: fakeFetch as any },
    );
    expect(events.length).toBeGreaterThan(0);
    const e = events[0];
    expect(e.title).toMatch(/.+/);
    expect(e.startsAt).toBeInstanceOf(Date);
    expect(e.sourceEventId).toMatch(/.+/);
    expect(['on_sale','sold_out','ended','lottery','unknown']).toContain(e.ticketStatus);
  });

  it('returns empty array when no results', async () => {
    const empty = '<html><body><p>該当するイベントはありません</p></body></html>';
    const fakeFetch = vi.fn(async () => new Response(empty, { status: 200 }));
    const events = await piaAdapter.search(
      { keyword: 'noresult', dateFrom: new Date(), dateTo: new Date(), includeOnline: true },
      { fetch: fakeFetch as any },
    );
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npm test -- pia`
Expected: Cannot find module `@/scrapers/pia`

- [ ] **Step 4: アダプタを実装**

```ts
// scrapers/pia.ts
import * as cheerio from 'cheerio';
import { fetchHtml, FetchHtmlOptions } from './http';
import { SourceAdapter, SearchParams, RawEvent } from './types';
import { isOnlineEvent } from '@/lib/online-detection';
import { normalizeTicketStatus } from '@/lib/ticket-status';

const BASE_URL = 'https://t.pia.jp/pia/search.do';

function buildUrl(params: SearchParams): string {
  const q = new URLSearchParams();
  q.set('searchType', 'keyword');
  if (params.keyword) q.set('kw', params.keyword);
  // 都道府県は API 仕様確認後に追加
  return `${BASE_URL}?${q.toString()}`;
}

function parsePiaDate(text: string): Date | null {
  // ぴあの日付表記: 例 "2026/05/09 (土) 18:00"
  const m = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // JST → UTC
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 9, +mi));
}

export const piaAdapter: SourceAdapter & {
  search: (params: SearchParams, opts?: FetchHtmlOptions) => Promise<RawEvent[]>;
} = {
  source: 'pia',
  async search(params, opts = {}) {
    const url = buildUrl(params);
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);
    const events: RawEvent[] = [];

    // 注: 実 HTML 確認後にセレクタ調整
    // 以下は構造例。fixture を見ながら調整する
    $('.event-list-item').each((_, el) => {
      const $el = $(el);
      const title = $el.find('.event-title').text().trim();
      const dateText = $el.find('.event-date').text().trim();
      const venue = $el.find('.event-venue').text().trim();
      const url = $el.find('a.event-link').attr('href') ?? '';
      const statusText = $el.find('.ticket-status').text().trim();
      const startsAt = parsePiaDate(dateText);
      if (!title || !startsAt) return;
      const sourceEventId = url.split('/').filter(Boolean).pop() ?? `${title}-${dateText}`;
      events.push({
        sourceEventId,
        title,
        startsAt,
        venueName: venue || undefined,
        ticketUrl: url ? new URL(url, BASE_URL).toString() : undefined,
        ticketStatus: normalizeTicketStatus(statusText),
        isOnline: isOnlineEvent({ title, venueName: venue }),
        performers: [],
        tags: [],
      });
    });

    return events;
  },
};
```

> **重要**: Step 1 で fixture HTML を確認した結果に応じてセレクタを修正すること。`.event-list-item`、`.event-title` 等は仮置き。

- [ ] **Step 5: テスト実行 → セレクタ調整 → 再実行**

Run: `npm test -- pia`
fixture と現実装が合うまで反復。

- [ ] **Step 6: コミット**

```bash
git add scrapers/pia.ts scrapers/__fixtures__/pia/ tests/scrapers/pia.test.ts
git commit -m "feat: add pia.jp adapter with HTML fixture-based tests"
```

---

## Task 9: Walkerplus アダプタ(scrapers/walkerplus.ts)

**Files:**
- Create: `scrapers/walkerplus.ts`
- Create: `scrapers/__fixtures__/walkerplus/search-result.html`
- Create: `tests/scrapers/walkerplus.test.ts`

> Task 8 と同じパターン。fixture 取得 → セレクタ確認 → テスト → 実装。

- [ ] **Step 1: 実 HTML を取得**

```bash
mkdir -p scrapers/__fixtures__/walkerplus
curl -A "event-searcher/0.1" \
  'https://www.walkerplus.com/event_list/keyword/花江夏樹/' \
  > scrapers/__fixtures__/walkerplus/search-result.html
```

(実際の検索 URL はサイトを確認して調整)

- [ ] **Step 2: アダプタのテストを書く**

```ts
// tests/scrapers/walkerplus.test.ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkerplusAdapter } from '@/scrapers/walkerplus';

const FIXTURE = readFileSync(
  join(__dirname, '../../scrapers/__fixtures__/walkerplus/search-result.html'),
  'utf-8',
);

describe('walkerplusAdapter.search', () => {
  it('parses fixture and returns RawEvent[]', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const events = await walkerplusAdapter.search(
      {
        keyword: '花江夏樹',
        dateFrom: new Date('2026-05-01'),
        dateTo: new Date('2026-05-31'),
        includeOnline: true,
      },
      { fetch: fakeFetch as any },
    );
    expect(events.length).toBeGreaterThan(0);
    const e = events[0];
    expect(e.title).toMatch(/.+/);
    expect(e.startsAt).toBeInstanceOf(Date);
    expect(e.sourceEventId).toMatch(/.+/);
    expect(['on_sale','sold_out','ended','lottery','unknown']).toContain(e.ticketStatus);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npm test -- walkerplus`
Expected: Cannot find module

- [ ] **Step 4: アダプタを実装**

```ts
// scrapers/walkerplus.ts
import * as cheerio from 'cheerio';
import { fetchHtml, FetchHtmlOptions } from './http';
import { SourceAdapter, SearchParams, RawEvent } from './types';
import { isOnlineEvent } from '@/lib/online-detection';
import { normalizeTicketStatus } from '@/lib/ticket-status';

const BASE_URL = 'https://www.walkerplus.com';

function buildUrl(params: SearchParams): string {
  const kw = encodeURIComponent(params.keyword ?? '');
  return `${BASE_URL}/event_list/keyword/${kw}/`;
}

function parseDate(text: string): Date | null {
  // Walkerplus: 例 "2026年5月9日(土)" or "2026/05/09"
  const m = text.match(/(\d{4})[年\/](\d{1,2})[月\/](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, -9, 0));
}

export const walkerplusAdapter: SourceAdapter & {
  search: (params: SearchParams, opts?: FetchHtmlOptions) => Promise<RawEvent[]>;
} = {
  source: 'walkerplus',
  async search(params, opts = {}) {
    const url = buildUrl(params);
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);
    const events: RawEvent[] = [];

    // 注: fixture を見ながらセレクタ確定
    $('.m-eventcard').each((_, el) => {
      const $el = $(el);
      const title = $el.find('.m-eventcard__title').text().trim();
      const dateText = $el.find('.m-eventcard__date').text().trim();
      const venue = $el.find('.m-eventcard__venue').text().trim();
      const href = $el.find('a').attr('href') ?? '';
      const statusText = $el.find('.m-eventcard__status').text().trim();
      const startsAt = parseDate(dateText);
      if (!title || !startsAt) return;
      const sourceEventId = href.replace(/[^a-zA-Z0-9]/g, '') || `${title}-${dateText}`;
      events.push({
        sourceEventId,
        title,
        startsAt,
        venueName: venue || undefined,
        ticketUrl: href ? new URL(href, BASE_URL).toString() : undefined,
        ticketStatus: normalizeTicketStatus(statusText),
        isOnline: isOnlineEvent({ title, venueName: venue }),
        performers: [],
        tags: [],
      });
    });

    return events;
  },
};
```

> **重要**: fixture を見てセレクタを実際の HTML に合わせる。

- [ ] **Step 5: テスト → 調整 → 再実行**

Run: `npm test -- walkerplus`

- [ ] **Step 6: コミット**

```bash
git add scrapers/walkerplus.ts scrapers/__fixtures__/walkerplus/ tests/scrapers/walkerplus.test.ts
git commit -m "feat: add walkerplus adapter with HTML fixture-based tests"
```

---

## Task 10: キャッシュモジュール(lib/cache.ts)

**Files:**
- Create: `lib/cache.ts`
- Create: `tests/lib/cache.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// tests/lib/cache.test.ts
import { describe, it, expect } from 'vitest';
import { generateCacheKey } from '@/lib/cache';

describe('generateCacheKey', () => {
  it('同じ入力は同じキー', () => {
    const k1 = generateCacheKey({ q: 'x', from: '2026-01', to: '2026-02', areas: ['関東'], includeOnline: false, onSaleOnly: true });
    const k2 = generateCacheKey({ q: 'x', from: '2026-01', to: '2026-02', areas: ['関東'], includeOnline: false, onSaleOnly: true });
    expect(k1).toBe(k2);
  });

  it('areas の順序に依存しない', () => {
    const k1 = generateCacheKey({ q: 'x', from: 'a', to: 'b', areas: ['関東','近畿'], includeOnline: false, onSaleOnly: true });
    const k2 = generateCacheKey({ q: 'x', from: 'a', to: 'b', areas: ['近畿','関東'], includeOnline: false, onSaleOnly: true });
    expect(k1).toBe(k2);
  });

  it('q が違えばキーも違う', () => {
    const a = generateCacheKey({ q: 'a', from: '', to: '', areas: [], includeOnline: false, onSaleOnly: true });
    const b = generateCacheKey({ q: 'b', from: '', to: '', areas: [], includeOnline: false, onSaleOnly: true });
    expect(a).not.toBe(b);
  });

  it('64文字の hex を返す', () => {
    const k = generateCacheKey({ q: '', from: '', to: '', areas: [], includeOnline: false, onSaleOnly: true });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- cache`

- [ ] **Step 3: 実装**

```ts
// lib/cache.ts
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SearchKey {
  q: string;
  from: string;       // ISO
  to: string;         // ISO
  areas: string[];
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export function generateCacheKey(k: SearchKey): string {
  const norm = {
    q: k.q ?? '',
    from: k.from,
    to: k.to,
    areas: [...k.areas].sort(),
    includeOnline: !!k.includeOnline,
    onSaleOnly: !!k.onSaleOnly,
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

const TTL_HOURS = 6;

export async function getCachedEventIds(
  client: SupabaseClient,
  key: string,
): Promise<bigint[] | null> {
  const { data, error } = await client
    .from('search_cache')
    .select('event_ids,expires_at')
    .eq('cache_key', key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.event_ids;
}

export async function setCachedEventIds(
  client: SupabaseClient,
  key: string,
  eventIds: bigint[] | number[],
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  const { error } = await client
    .from('search_cache')
    .upsert({ cache_key: key, event_ids: eventIds, expires_at: expiresAt });
  if (error) throw error;
}
```

- [ ] **Step 4: テスト実行**

Run: `npm test -- cache`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/cache.ts tests/lib/cache.test.ts
git commit -m "feat: add search cache module with sha256 keys and 6h TTL"
```

---

## Task 11: 検索サービス(lib/search/)

**Files:**
- Create: `lib/search/query.ts`
- Create: `lib/search/index.ts`
- Create: `tests/lib/search-query.test.ts`

- [ ] **Step 1: クエリビルダのテストを書く**

```ts
// tests/lib/search-query.test.ts
import { describe, it, expect } from 'vitest';
import { buildSearchQueryParams } from '@/lib/search/query';

describe('buildSearchQueryParams', () => {
  it('全文検索条件 + 日付 + on_sale_only でパラメータが揃う', () => {
    const p = buildSearchQueryParams({
      q: '花江夏樹',
      from: new Date('2026-05-09T00:00:00Z'),
      to:   new Date('2026-05-10T23:59:59Z'),
      areas: ['関東'],
      includeOnline: false,
      onSaleOnly: true,
    });
    expect(p.q).toBe('花江夏樹');
    expect(p.fromIso).toBe('2026-05-09T00:00:00.000Z');
    expect(p.toIso).toBe('2026-05-10T23:59:59.000Z');
    expect(p.areas).toEqual(['関東']);
    expect(p.includeOnline).toBe(false);
    expect(p.onSaleOnly).toBe(true);
  });

  it('areas が空のときは null', () => {
    const p = buildSearchQueryParams({
      q: '', from: new Date(), to: new Date(), areas: [],
      includeOnline: true, onSaleOnly: false,
    });
    expect(p.areas).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- search-query`

- [ ] **Step 3: クエリビルダを実装**

```ts
// lib/search/query.ts
export interface SearchInput {
  q: string;
  from: Date;
  to: Date;
  areas: string[];
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export interface QueryParams {
  q: string;
  fromIso: string;
  toIso: string;
  areas: string[] | null;
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export function buildSearchQueryParams(input: SearchInput): QueryParams {
  return {
    q: input.q ?? '',
    fromIso: input.from.toISOString(),
    toIso: input.to.toISOString(),
    areas: input.areas.length > 0 ? input.areas : null,
    includeOnline: !!input.includeOnline,
    onSaleOnly: !!input.onSaleOnly,
  };
}
```

- [ ] **Step 4: 検索オーケストレーションを実装**

```ts
// lib/search/index.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateCacheKey, getCachedEventIds, setCachedEventIds } from '@/lib/cache';
import { buildSearchQueryParams, SearchInput } from './query';
import { piaAdapter } from '@/scrapers/pia';
import { walkerplusAdapter } from '@/scrapers/walkerplus';
import { prefecturesInArea, prefectureToArea, AREAS, type Area } from '@/lib/area';
import { isOnlineEvent } from '@/lib/online-detection';
import type { RawEvent, SourceAdapter } from '@/scrapers/types';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter];

export type FetchStrategy = 'batch' | 'cache' | 'on_demand';

export interface SearchResult {
  events: any[];
  meta: {
    fetched_strategy: FetchStrategy;
    fetched_at: string;
    sources_succeeded: string[];
    sources_failed: string[];
  };
}

export async function searchEvents(
  client: SupabaseClient,
  input: SearchInput,
): Promise<SearchResult> {
  const params = buildSearchQueryParams(input);
  const cacheKey = generateCacheKey({
    q: params.q,
    from: params.fromIso,
    to: params.toIso,
    areas: params.areas ?? [],
    includeOnline: params.includeOnline,
    onSaleOnly: params.onSaleOnly,
  });

  // 1. saved_keywords にあるか確認(あればバッチ取得済みとみなす)
  let strategy: FetchStrategy = 'batch';
  if (input.q) {
    const { data: saved } = await client
      .from('saved_keywords')
      .select('id')
      .eq('keyword', input.q)
      .maybeSingle();
    if (!saved) {
      // 2. キャッシュを確認
      const cached = await getCachedEventIds(client, cacheKey);
      if (cached) strategy = 'cache';
      else {
        // 3. オンデマンド取得
        await runOnDemandFetch(client, input);
        const ids = await runDbSearch(client, params).then(rows => rows.map(r => r.id));
        await setCachedEventIds(client, cacheKey, ids);
        strategy = 'on_demand';
      }
    }
  }

  const events = await runDbSearch(client, params);
  return {
    events,
    meta: {
      fetched_strategy: strategy,
      fetched_at: new Date().toISOString(),
      sources_succeeded: ADAPTERS.map(a => a.source),
      sources_failed: [],
    },
  };
}

async function runOnDemandFetch(client: SupabaseClient, input: SearchInput): Promise<void> {
  const params = {
    keyword: input.q,
    dateFrom: input.from,
    dateTo: input.to,
    prefectures: input.areas
      .filter((a): a is Area => (AREAS as readonly string[]).includes(a))
      .flatMap(a => prefecturesInArea(a)),
    includeOnline: input.includeOnline,
  };
  const settled = await Promise.allSettled(ADAPTERS.map(a => a.search(params)));
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status !== 'fulfilled') continue;
    const adapter = ADAPTERS[i];
    await upsertEvents(client, adapter.source, result.value);
  }
}

async function upsertEvents(
  client: SupabaseClient,
  source: string,
  raws: RawEvent[],
): Promise<void> {
  if (raws.length === 0) return;
  const rows = raws.map(r => ({
    source,
    source_event_id: r.sourceEventId,
    title: r.title,
    description: r.description ?? null,
    starts_at: r.startsAt.toISOString(),
    ends_at: r.endsAt?.toISOString() ?? null,
    venue_name: r.venueName ?? null,
    prefecture: r.prefecture ?? null,
    area: r.prefecture ? prefectureToArea(r.prefecture) : null,
    is_online: r.isOnline || isOnlineEvent({
      title: r.title, description: r.description, venueName: r.venueName,
    }),
    ticket_url: r.ticketUrl ?? null,
    ticket_status: r.ticketStatus,
    performers: r.performers,
    tags: r.tags,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await client
    .from('events')
    .upsert(rows, { onConflict: 'source,source_event_id' });
  if (error) throw error;
}

async function runDbSearch(
  client: SupabaseClient,
  p: ReturnType<typeof buildSearchQueryParams>,
): Promise<any[]> {
  let query = client
    .from('events')
    .select('*')
    .gte('starts_at', p.fromIso)
    .lte('starts_at', p.toIso)
    .order('starts_at', { ascending: true })
    .limit(200);

  if (p.q) {
    // performers の部分一致 + title の ILIKE
    // PostgREST の OR は文字列で書く
    query = query.or(`title.ilike.%${p.q}%,description.ilike.%${p.q}%`);
  }
  if (p.areas) {
    if (p.includeOnline) query = query.or(`area.in.(${p.areas.join(',')}),is_online.eq.true`);
    else query = query.in('area', p.areas);
  }
  if (!p.includeOnline) query = query.eq('is_online', false);
  if (p.onSaleOnly) query = query.in('ticket_status', ['on_sale','lottery']);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
```

- [ ] **Step 5: テスト実行**

Run: `npm test -- search-query`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add lib/search/ tests/lib/search-query.test.ts
git commit -m "feat: add search service with hybrid fetch strategy"
```

---

## Task 12: /api/search ルートハンドラ

**Files:**
- Create: `app/api/search/route.ts`
- Create: `tests/api/search.test.ts`

- [ ] **Step 1: 入力スキーマのテストを書く**

```ts
// tests/api/search.test.ts
import { describe, it, expect } from 'vitest';
import { searchInputSchema } from '@/app/api/search/route';

describe('searchInputSchema', () => {
  it('正しい入力をパースできる', () => {
    const r = searchInputSchema.parse({
      q: '花江夏樹',
      from: '2026-05-09T00:00:00+09:00',
      to:   '2026-05-10T23:59:59+09:00',
      areas: ['関東'],
      include_online: false,
      on_sale_only: true,
    });
    expect(r.q).toBe('花江夏樹');
    expect(r.from).toBeInstanceOf(Date);
  });

  it('既定値が補完される', () => {
    const r = searchInputSchema.parse({
      from: '2026-05-09T00:00:00Z',
      to:   '2026-05-10T23:59:59Z',
    });
    expect(r.q).toBe('');
    expect(r.areas).toEqual([]);
    expect(r.include_online).toBe(false);
    expect(r.on_sale_only).toBe(true);
  });

  it('from > to ならエラー', () => {
    expect(() => searchInputSchema.parse({
      from: '2026-06-01T00:00:00Z', to: '2026-05-01T00:00:00Z',
    })).toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- api/search`

- [ ] **Step 3: ルートハンドラを実装**

```ts
// app/api/search/route.ts
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
```

- [ ] **Step 4: テスト実行**

Run: `npm test -- api/search`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/api/search/route.ts tests/api/search.test.ts
git commit -m "feat: add /api/search route handler with zod validation"
```

---

## Task 13: /api/saved-keywords ルートハンドラ

**Files:**
- Create: `app/api/saved-keywords/route.ts`
- Create: `app/api/saved-keywords/[id]/route.ts`

- [ ] **Step 1: GET/POST のルートを実装**

```ts
// app/api/saved-keywords/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerClient } from '@/lib/supabase';

const postSchema = z.object({ keyword: z.string().min(1).max(100) });

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
```

- [ ] **Step 2: DELETE のルートを実装**

```ts
// app/api/saved-keywords/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerClient } from '@/lib/supabase';

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const client = getServerClient();
  const { error } = await client.from('saved_keywords').delete().eq('id', numId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: 動作確認(dev サーバ起動して curl)**

(オプション。実 DB が必要なら Supabase ローカル起動後)

```bash
npm run dev &
curl -X POST http://localhost:3000/api/saved-keywords \
  -H 'Content-Type: application/json' -d '{"keyword":"花江夏樹"}'
curl http://localhost:3000/api/saved-keywords
```

- [ ] **Step 4: コミット**

```bash
git add app/api/saved-keywords/
git commit -m "feat: add saved-keywords CRUD API"
```

---

## Task 14: 検索ページ UI

**Files:**
- Create: `components/SearchForm.tsx`
- Create: `components/FilterBar.tsx`
- Create: `components/ResultCard.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: ResultCard コンポーネントを作成**

```tsx
// components/ResultCard.tsx
'use client';

interface Event {
  id: number;
  title: string;
  starts_at: string;
  venue_name?: string;
  prefecture?: string;
  is_online: boolean;
  ticket_status: string;
  ticket_url?: string;
  source: string;
  performers: string[];
}

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  on_sale: { text: '販売中', color: '#10b981' },
  lottery: { text: '抽選受付中', color: '#f59e0b' },
  sold_out: { text: 'SOLD OUT', color: '#ef4444' },
  ended: { text: '販売終了', color: '#6b7280' },
  unknown: { text: '状態不明', color: '#9ca3af' },
};

export function ResultCard({ event }: { event: Event }) {
  const status = STATUS_LABELS[event.ticket_status] ?? STATUS_LABELS.unknown;
  const date = new Date(event.starts_at);
  const dateStr = date.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="border rounded-md p-3 mb-2 bg-white">
      <div className="flex justify-between text-xs text-gray-500">
        <span>{dateStr}</span>
        <span style={{ background: status.color }} className="text-white px-2 py-0.5 rounded-full">
          {status.text}
        </span>
      </div>
      <div className="font-semibold mt-1">{event.title}</div>
      <div className="text-sm text-gray-700">
        {event.is_online ? 'オンライン' : `${event.prefecture ?? ''} / ${event.venue_name ?? ''}`}
      </div>
      {event.performers.length > 0 && (
        <div className="text-xs text-gray-600 mt-1">出演: {event.performers.join(', ')}</div>
      )}
      <div className="flex gap-2 mt-2 items-center">
        {event.ticket_url && (
          <a href={event.ticket_url} target="_blank" rel="noopener noreferrer"
             className="text-xs text-blue-600 underline">チケットページ →</a>
        )}
        <span className="text-xs text-gray-400">via {event.source}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: FilterBar コンポーネントを作成**

```tsx
// components/FilterBar.tsx
'use client';
import { AREAS, type Area } from '@/lib/area';

export interface Filters {
  datePreset: 'this_weekend' | 'next_weekend' | 'this_month' | 'custom';
  areas: Area[];
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export function FilterBar({ filters, onChange }: {
  filters: Filters; onChange: (f: Filters) => void;
}) {
  const toggleArea = (a: Area) => {
    const next = filters.areas.includes(a)
      ? filters.areas.filter(x => x !== a)
      : [...filters.areas, a];
    onChange({ ...filters, areas: next });
  };
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs uppercase text-gray-500 mb-1">日付</div>
        <div className="flex gap-2 flex-wrap">
          {(['this_weekend','next_weekend','this_month'] as const).map(p => (
            <button key={p}
              onClick={() => onChange({ ...filters, datePreset: p })}
              className={`px-3 py-1 rounded ${filters.datePreset === p ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}>
              {p === 'this_weekend' ? '今週末' : p === 'next_weekend' ? '来週末' : '今月'}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase text-gray-500 mb-1">エリア</div>
        <div className="flex gap-2 flex-wrap">
          {AREAS.map(a => (
            <button key={a} onClick={() => toggleArea(a)}
              className={`px-3 py-1 rounded ${filters.areas.includes(a) ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-4 text-sm">
        <label><input type="checkbox" checked={filters.onSaleOnly}
          onChange={e => onChange({ ...filters, onSaleOnly: e.target.checked })} /> 販売中のみ</label>
        <label><input type="checkbox" checked={filters.includeOnline}
          onChange={e => onChange({ ...filters, includeOnline: e.target.checked })} /> 配信を含める</label>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 検索フォーム + ページを作成**

```tsx
// app/page.tsx
'use client';
import { useState } from 'react';
import { ResultCard } from '@/components/ResultCard';
import { FilterBar, Filters } from '@/components/FilterBar';
import { getThisWeekend, getNextWeekend } from '@/lib/date';

function rangeFor(preset: Filters['datePreset']) {
  const now = new Date();
  if (preset === 'this_weekend') return getThisWeekend(now);
  if (preset === 'next_weekend') return getNextWeekend(now);
  // this_month
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { from, to };
}

export default function HomePage() {
  const [keyword, setKeyword] = useState('');
  const [filters, setFilters] = useState<Filters>({
    datePreset: 'this_weekend',
    areas: ['関東'],
    includeOnline: false,
    onSaleOnly: true,
  });
  const [events, setEvents] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function search() {
    setLoading(true);
    try {
      const range = rangeFor(filters.datePreset);
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: keyword,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          areas: filters.areas,
          include_online: filters.includeOnline,
          on_sale_only: filters.onSaleOnly,
        }),
      });
      const data = await res.json();
      setEvents(data.events ?? []);
      setMeta(data.meta ?? null);
    } finally {
      setLoading(false);
    }
  }

  async function saveKeyword() {
    if (!keyword) return;
    await fetch('/api/saved-keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword }),
    });
    alert(`"${keyword}" を保存しました`);
  }

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">event-searcher</h1>
      <div className="flex gap-2 mb-4">
        <input value={keyword} onChange={e => setKeyword(e.target.value)}
          placeholder="キーワード(声優名・作品名など)"
          className="flex-1 border rounded px-3 py-2"
          onKeyDown={e => { if (e.key === 'Enter') search(); }} />
        <button onClick={search} disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded">検索</button>
      </div>
      <div className="mb-4"><FilterBar filters={filters} onChange={setFilters} /></div>
      {meta && (
        <div className="text-xs text-gray-500 mb-2">
          {events.length}件 / {meta.fetched_strategy} / {new Date(meta.fetched_at).toLocaleString('ja-JP')}
        </div>
      )}
      <div>{events.map(e => <ResultCard key={e.id} event={e} />)}</div>
      {events.length > 0 && (
        <div className="text-center mt-4">
          <button onClick={saveKeyword}
            className="px-4 py-2 border rounded">★ このキーワードを保存</button>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: dev サーバで動作確認**

```bash
npm run dev
```

`http://localhost:3000` を開いて検索フォームが表示されることを確認(API叩いてエラーになるのは Supabase 接続前なので想定内)。

- [ ] **Step 5: コミット**

```bash
git add app/page.tsx components/
git commit -m "feat: add search page UI with filters and result cards"
```

---

## Task 15: 設定ページ UI(saved keywords 管理)

**Files:**
- Create: `app/settings/page.tsx`

- [ ] **Step 1: 設定ページを作成**

```tsx
// app/settings/page.tsx
'use client';
import { useEffect, useState } from 'react';

interface SavedKeyword { id: number; keyword: string; created_at: string; }

export default function SettingsPage() {
  const [keywords, setKeywords] = useState<SavedKeyword[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/saved-keywords');
    const data = await res.json();
    setKeywords(data.keywords ?? []);
    setLoading(false);
  }

  async function remove(id: number) {
    if (!confirm('削除しますか?')) return;
    await fetch(`/api/saved-keywords/${id}`, { method: 'DELETE' });
    load();
  }

  useEffect(() => { load(); }, []);

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">設定 / 保存キーワード</h1>
      <a href="/" className="text-blue-600 underline text-sm">← 検索に戻る</a>
      <ul className="mt-4 space-y-2">
        {loading && <li>読み込み中…</li>}
        {!loading && keywords.length === 0 && <li className="text-gray-500">保存キーワードはありません</li>}
        {keywords.map(k => (
          <li key={k.id} className="flex justify-between items-center border rounded px-3 py-2">
            <span>{k.keyword}</span>
            <button onClick={() => remove(k.id)} className="text-red-600 text-sm">削除</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 2: dev サーバで動作確認**

`http://localhost:3000/settings` を開いて表示確認。

- [ ] **Step 3: コミット**

```bash
git add app/settings/
git commit -m "feat: add settings page for saved keywords management"
```

---

## Task 16: バッチ取得スクリプト + GitHub Actions

**Files:**
- Create: `scripts/batch-fetch.ts`
- Create: `.github/workflows/batch-fetch.yml`

- [ ] **Step 1: バッチスクリプトを作成**

```ts
// scripts/batch-fetch.ts
import { getServerClient } from '../lib/supabase';
import { piaAdapter } from '../scrapers/pia';
import { walkerplusAdapter } from '../scrapers/walkerplus';
import { prefectureToArea } from '../lib/area';
import { isOnlineEvent } from '../lib/online-detection';
import type { RawEvent, SourceAdapter } from '../scrapers/types';
import { RateLimiter } from '../scrapers/http';

const ADAPTERS: SourceAdapter[] = [piaAdapter, walkerplusAdapter];
const limiter = new RateLimiter(2000); // 2秒/リクエスト

async function main() {
  const client = getServerClient();
  const { data: keywords, error } = await client
    .from('saved_keywords').select('id,keyword');
  if (error) throw error;
  if (!keywords || keywords.length === 0) {
    console.log('no saved keywords; nothing to fetch.');
    return;
  }

  // 1ヶ月先までを対象に取得
  const now = new Date();
  const dateFrom = now;
  const dateTo = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

  for (const k of keywords) {
    for (const adapter of ADAPTERS) {
      await limiter.wait();
      const startedAt = new Date();
      let status: 'success' | 'failed' = 'success';
      let count = 0;
      let errMsg: string | null = null;
      try {
        const events = await adapter.search({
          keyword: k.keyword,
          dateFrom, dateTo,
          includeOnline: true,
        });
        await upsertEvents(client, adapter.source, events);
        count = events.length;
      } catch (e: any) {
        status = 'failed';
        errMsg = e?.message ?? String(e);
        console.error(`[${adapter.source}] ${k.keyword}:`, e);
      }
      await client.from('scrape_runs').insert({
        source: adapter.source,
        keyword: k.keyword,
        trigger: 'cron',
        events_found: count,
        status,
        error_message: errMsg,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
      });
    }
    await client.from('saved_keywords')
      .update({ last_fetched_at: new Date().toISOString() }).eq('id', k.id);
  }

  // 古いイベントを削除
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  await client.from('events').delete().lt('starts_at', cutoff);

  console.log(`done. processed ${keywords.length} keywords.`);
}

async function upsertEvents(client: any, source: string, raws: RawEvent[]) {
  if (raws.length === 0) return;
  const rows = raws.map(r => ({
    source,
    source_event_id: r.sourceEventId,
    title: r.title,
    description: r.description ?? null,
    starts_at: r.startsAt.toISOString(),
    ends_at: r.endsAt?.toISOString() ?? null,
    venue_name: r.venueName ?? null,
    prefecture: r.prefecture ?? null,
    area: r.prefecture ? prefectureToArea(r.prefecture) : null,
    is_online: r.isOnline || isOnlineEvent({
      title: r.title, description: r.description, venueName: r.venueName,
    }),
    ticket_url: r.ticketUrl ?? null,
    ticket_status: r.ticketStatus,
    performers: r.performers,
    tags: r.tags,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await client.from('events')
    .upsert(rows, { onConflict: 'source,source_event_id' });
  if (error) throw error;
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: package.json にスクリプトを追加**

`scripts` に追加:
```json
"batch-fetch": "tsx scripts/batch-fetch.ts"
```

`tsx` を devDependency に追加:
```bash
npm install -D tsx
```

- [ ] **Step 3: GitHub Actions ワークフローを作成**

```yaml
# .github/workflows/batch-fetch.yml
name: batch-fetch

on:
  schedule:
    - cron: '0 21,9 * * *'   # JST 06:00 / 18:00
  workflow_dispatch: {}

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run batch-fetch
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

- [ ] **Step 4: ローカルで dry-run(Supabase 接続情報があれば)**

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run batch-fetch
```

- [ ] **Step 5: コミット**

```bash
git add scripts/batch-fetch.ts .github/workflows/batch-fetch.yml package.json package-lock.json
git commit -m "feat: add batch-fetch script and GitHub Actions cron"
```

---

## Task 17: README + 最終調整

**Files:**
- Create: `README.md`

- [ ] **Step 1: README を作成**

```markdown
# event-searcher

声優・アニメ作品名等のキーワードで、ライブ・コンサート・トーク・展示など全国のイベントを横断検索できる Web サービス(MVP)。

## 機能

- キーワード(声優名・作品名・会場名) + 期間 + エリアで検索
- 「今週末/来週末/今月」のプリセット
- 販売中のみ表示 / 配信を含めるかのトグル
- 推しキーワードの保存(バッチで継続取得)

## セットアップ

\`\`\`bash
cp .env.local.example .env.local  # 値を埋める
npm install
\`\`\`

### DB マイグレーション

Supabase ダッシュボードの SQL Editor に `db/migrations/*.sql` を順番に流す。

### 開発サーバ

\`\`\`bash
npm run dev
\`\`\`

### バッチ実行(ローカル)

\`\`\`bash
npm run batch-fetch
\`\`\`

### テスト

\`\`\`bash
npm test
\`\`\`

## 構成

- 設計仕様: \`docs/superpowers/specs/2026-05-04-event-searcher-design.md\`
- 実装計画: \`docs/superpowers/plans/2026-05-04-event-searcher.md\`

## デプロイ

- フロント/API: Vercel(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_*` を Secrets に)
- バッチ: GitHub Actions(同じ Secrets を Repo Secrets に)
- DB: Supabase クラウド(無料枠)
```

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: add README with setup and run instructions"
```

---

## まとめ

タスク完了後の確認:
1. `npm test` が全部 pass
2. `npm run build` が通る(型エラーなし)
3. dev サーバで主要画面が表示できる
4. Supabase に接続して、検索 / 保存キーワード追加 / バッチ実行が動く
5. GitHub Actions の `workflow_dispatch` でバッチが手動実行できる

## 次フェーズ候補(本計画外)

- LiveFans / アニメイト等のソース追加
- 通知機能(週次ダイジェスト・新着アラート)
- ユーザー認証 + 個人別お気に入り
- 検索結果のスコアリング(キーワード一致度)

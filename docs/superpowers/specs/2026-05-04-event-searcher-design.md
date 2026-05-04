# event-searcher 設計仕様

- 作成日: 2026-05-04
- ステータス: ドラフト(ユーザーレビュー待ち)

## 1. 概要

声優名・アニメ作品名などのキーワードで、全国のライブ・コンサート・トークイベント・展示などを横断検索できる Web サービス。

「今週末ヒマ → 行けるイベントないかな」という発見モードと、「推しの○○のイベント、来週末あるかな」という指名検索の両方に応える。

### 主要ユースケース

1. ユーザーが日付プリセット(今週末/来週末)とエリア(関東等)を選び、キーワード入力 → 該当するイベントが時系列で並ぶ。
2. 気になるキーワードを「推しリスト」として保存 → バッチで継続取得され、再検索時は即座に結果が返る。
3. チケット販売中のイベントだけを表示。配信限定イベントはデフォルト非表示(設定でON可)。

### スコープ

- **MVP対象**: キーワード/期間/エリア検索、販売中フィルタ、配信フィルタ、お気に入り保存、2サイトからのデータ取得
- **MVP対象外**: ユーザー認証、通知(メール/プッシュ)、推奨アルゴリズム、課金、多言語、モバイルアプリ
- **将来検討**: 通知、ソース追加(LiveFans 等)、認証、推し別ダッシュボード

### 利用規模の前提

- 当面は個人利用(1ユーザー、1日数十回のリクエスト想定)
- 将来公開時を見据え、ホスティング・スケールの選択は無料枠から段階的に拡張可能なものを採用

## 2. アーキテクチャ概要

```
Browser (Next.js Client)
    │ /api/search?q=...
    ▼
Next.js Server (App Router / Route Handlers)
    │  Search Service:
    │    1. saved_keywords にあれば DB 即返却
    │    2. search_cache にあれば DB 経由で返却
    │    3. なければ Adapter を並列実行 → DB UPSERT → 返却
    ▼
Supabase (PostgreSQL)
    events / saved_keywords / search_cache / scrape_runs
    ▲
    │ UPSERT
Scraper Workers (同プロセス内モジュール)
    pia / walkerplus アダプタ(SourceAdapter インタフェース)
    ▲
    │ 起動契機:
    │  (a) GitHub Actions cron(1日2回)
    │  (b) Server Action からのオンデマンド
```

**設計原則**:

- スクレイピングはサイトごとの **Adapter** に閉じ込め、`SourceAdapter` インタフェースに揃える
- バッチもオンデマンドも同じアダプタを呼ぶ(コード重複なし)
- フロントは API のみ叩く。スクレイピングロジックはサーバー側に閉じる

## 3. 技術スタック

| レイヤ | 採用技術 | 補足 |
|---|---|---|
| フロント | Next.js 15 (App Router) + React | Server Components を活用 |
| API | Next.js Route Handlers / Server Actions | 別サービスは立てない |
| DB | Supabase (PostgreSQL) | 無料枠で開始 |
| 言語 | TypeScript | フロント/バック共通 |
| スクレイピング | `undici` + `cheerio` | 静的HTMLが基本 |
| フォールバック | Playwright | JS必須サイト用(MVPでは未使用) |
| バッチ | GitHub Actions cron | 06:00/18:00 JST |
| ホスティング | Vercel | Next.js と相性が良い |
| ロギング | Vercel Logs + `scrape_runs` テーブル | MVPはこれで足りる |

## 4. データモデル

```sql
-- 4.1 イベント本体
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL,                -- 'pia' | 'walkerplus'
  source_event_id TEXT NOT NULL,                -- 元サイトの一意ID
  title           TEXT NOT NULL,
  description     TEXT,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,
  venue_name      TEXT,
  prefecture      TEXT,                         -- '東京都' '大阪府' …
  area            TEXT,                         -- '関東' '近畿' …(派生)
  is_online       BOOLEAN NOT NULL DEFAULT false,
  ticket_url      TEXT,
  ticket_status   TEXT NOT NULL DEFAULT 'unknown',
                                                -- 'on_sale' | 'sold_out'
                                                -- | 'ended' | 'lottery' | 'unknown'
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

-- 4.2 推しキーワード(お気に入り)
CREATE TABLE saved_keywords (
  id              BIGSERIAL PRIMARY KEY,
  keyword         TEXT NOT NULL UNIQUE,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4.3 オンデマンド検索のキャッシュ
CREATE TABLE search_cache (
  cache_key  TEXT PRIMARY KEY,                  -- sha256(q + filter)
  event_ids  BIGINT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL               -- 既定 6時間後
);

-- 4.4 スクレイピング実行ログ
CREATE TABLE scrape_runs (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  keyword       TEXT,
  trigger       TEXT NOT NULL,                  -- 'cron' | 'on_demand'
  events_found  INT  NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,                  -- 'success' | 'failed' | 'partial'
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ
);
```

### エリアプリセット(コード上の定数)

| エリア名 | 都道府県 |
|---|---|
| 関東 | 東京・神奈川・埼玉・千葉・茨城・栃木・群馬 |
| 近畿 | 大阪・京都・兵庫・奈良・滋賀・和歌山 |
| 東海 | 愛知・岐阜・三重・静岡 |
| 北海道/東北 | 北海道・青森・岩手・宮城・秋田・山形・福島 |
| 北陸 | 新潟・富山・石川・福井・長野・山梨 |
| 中国/四国 | 岡山・広島・鳥取・島根・山口・香川・徳島・愛媛・高知 |
| 九州/沖縄 | 福岡・佐賀・長崎・熊本・大分・宮崎・鹿児島・沖縄 |
| オンライン | (`is_online = true` の特別扱い) |

`prefecture` から `area` への変換は **書き込み時に決定** し、検索クエリを単純化する。

## 5. データソース取得戦略

### MVP のソース

| サイト | 強み | 取得方法 |
|---|---|---|
| **ぴあ (t.pia.jp)** | チケット販売状況が正確、エリア検索あり | URLパラメータでHTML取得 → Cheerio |
| **Walkerplus イベント** | カテゴリ豊富、トーク・展示・推し関連が多い | HTML取得 → Cheerio |

LiveFans やアニメイト等の追加は次フェーズ。

### Adapter インタフェース

```ts
// scrapers/types.ts
export interface SearchParams {
  keyword?: string;
  dateFrom: Date;
  dateTo: Date;
  prefectures?: string[];   // ['東京都', '神奈川県', ...]
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
  ticketStatus: 'on_sale' | 'sold_out' | 'ended' | 'lottery' | 'unknown';
  performers: string[];
  tags: string[];
}

export interface SourceAdapter {
  readonly source: string;             // 'pia' | 'walkerplus'
  search(params: SearchParams): Promise<RawEvent[]>;
}
```

### バッチ巡回(GitHub Actions cron)

- スケジュール: 毎日 06:00 / 18:00 JST
- 対象: `saved_keywords` 全件 × 各アダプタ
- 動き:
  1. キーワードごとに各アダプタで `search()`
  2. RawEvent を `events` に UPSERT(`(source, source_event_id)` で衝突解決)
  3. `prefecture → area` 変換、`is_online` 判定をここで適用
  4. `starts_at < NOW() - 1日` の終了イベントを削除(肥大化防止)
  5. 実行結果を `scrape_runs` に記録

### オンデマンド取得

1. ユーザーが未保存キーワードで検索
2. `search_cache` をチェック → ヒットなら DB から取り出して返却
3. 未ヒットなら各アダプタを **並列実行**(`Promise.allSettled`)
4. 取得した RawEvent を DB に UPSERT
5. キャッシュキー(`sha256(q + filter)`)で `search_cache` を作成、TTL 6h
6. DB 検索クエリで結果を返却(同じパスでバッチ済み・キャッシュ済み・新規取得を統一処理)

### 配信判定ロジック

タイトル/説明/会場名のいずれかに以下のいずれかを含む場合 `is_online = true`:
- `配信` / `オンライン` / `ライブビューイング` / `生配信` / `LIVE STREAMING` / `online`

False positive は許容(MVP段階では十分)。

### スクレイピングのお作法

- User-Agent: `event-searcher/0.1 (+contact-email)` で名乗る
- レート制限: 各サイトに `>= 2 sec/req`、並列度は最大3
- robots.txt: 起動時に各アダプタが該当 path を確認、disallow なら無効化
- 取得したテキストは検索結果へのリンク集としてのみ表示。本文の再配布は行わない

## 6. 検索フロー

### API: `POST /api/search`

リクエスト:
```json
{
  "q": "花江夏樹",
  "from": "2026-05-09T00:00:00+09:00",
  "to":   "2026-05-10T23:59:59+09:00",
  "areas": ["関東"],
  "include_online": false,
  "on_sale_only": true
}
```

レスポンス:
```json
{
  "events": [
    {
      "id": 123,
      "title": "花江夏樹トーク&朗読 SPECIAL NIGHT",
      "starts_at": "2026-05-09T18:00:00+09:00",
      "venue_name": "Zepp DiverCity TOKYO",
      "prefecture": "東京都",
      "is_online": false,
      "ticket_status": "on_sale",
      "ticket_url": "https://t.pia.jp/...",
      "source": "pia",
      "performers": ["花江夏樹", "内田雄馬"]
    }
  ],
  "meta": {
    "fetched_strategy": "batch",
    "fetched_at": "2026-05-04T12:00:00Z",
    "sources_succeeded": ["pia", "walkerplus"],
    "sources_failed": []
  }
}
```

### DB 検索クエリ(疑似 SQL)

```sql
SELECT * FROM events
WHERE
  (:q IS NULL
    OR to_tsvector('simple', title || ' ' || COALESCE(description,'')
                              || ' ' || array_to_string(performers,' '))
       @@ plainto_tsquery('simple', :q)
    OR EXISTS (SELECT 1 FROM unnest(performers) p WHERE p ILIKE '%' || :q || '%'))
  AND starts_at BETWEEN :from AND :to
  AND (:areas IS NULL
       OR area = ANY(:areas)
       OR (:include_online AND is_online))
  AND (:include_online OR is_online = false)
  AND (:on_sale_only = false OR ticket_status IN ('on_sale','lottery'))
ORDER BY starts_at ASC
LIMIT 200;
```

### 「今週末/来週末」ロジック(JST 基準)

- 今週末: 直近の土曜 00:00 〜 翌日曜 23:59
- 来週末: 来週土曜 00:00 〜 翌日曜 23:59

クライアント側で日付を計算して `from`/`to` に変換する。

### お気に入りキーワード保存

1. 検索結果ページに「★ このキーワードを保存」ボタン
2. 押下で `saved_keywords` に INSERT(UNIQUE 制約で重複は無視)
3. 次回バッチ実行時に自動で取得対象に入る

## 7. UI 設計

### 主要画面: 検索ページ(1画面完結型)

- 上部: キーワード入力欄 + 検索ボタン
- 中段:
  - 日付プリセット(今週末 / 来週末 / 今月 / カスタム)
  - エリアチップ(関東 / 近畿 / 東海 / 北海道-東北 / 北陸 / 中国-四国 / 九州-沖縄 / オンライン、複数選択可)
  - トグル(販売中のみ ON既定 / 配信を含む OFF既定)
- 下部: 結果リスト
  - 各カード: 開演日時 / 販売ステータスバッジ / タイトル / 会場(都道府県+施設名) / 出演者 / 出典 / チケットページへのリンク
  - 結果ヘッダに件数と取得鮮度(`fetched_strategy` を表示)
- リスト末尾: 「★ このキーワードを保存」ボタン

### 設定/お気に入りページ(MVP最小限)

- 保存キーワード一覧と削除ボタン
- 既定のエリア(チェック状態の初期値)
- 既定の「配信を含むか」トグル

## 8. エラー処理

| 状況 | 挙動 |
|---|---|
| 1ソースだけ失敗 | 他ソースの結果は返す。`meta.sources_failed` に記録、UIで「○○から取得できませんでした」を表示 |
| 全ソース失敗 | 直近キャッシュがあれば「古いデータです」付きで返す。なければエラーレスポンス |
| HTML構造が変わってパース失敗 | スナップショットテストで CI が落ちる → 検知。本番では空配列を返し、`scrape_runs` にエラー記録 |
| レートリミット | 指数バックオフで最大3回リトライ。失敗時は一時失敗扱い |
| robots.txt が disallow | アダプタを起動時に無効化(DBに古いデータが残るが新規取得は止まる) |

## 9. テスト戦略

### ユニットテスト(Vitest)

- 各アダプタの **HTML スナップショットテスト**: `__fixtures__/<source>/*.html` を用意し、パース結果(RawEvent)を検証。本物のサイトは叩かない。
- 配信判定 / エリア変換 / 日付変換 / キャッシュキー生成 などのピュアロジック。

### 結合テスト(Vitest + Supabase ローカル)

- `/api/search` エンドポイントの動作確認(全フィルタ組合せ)
- DB 検索クエリの挙動(全文検索・配列ILIKE 含む)

### スモークテスト(週1 CI)

- 実際にぴあ・Walkerplus に接続してパースが通るかを確認
- 失敗したらリポジトリの Issue を自動作成 → アダプタ修正

### TDD 方針

- アダプタは「fixture HTML → expected RawEvent[]」で先にテストを書く(サイト変更時の検知器になる)
- 検索 API は先にケース(空クエリ、期間外、全フィルタON/OFF)を書いてから実装

## 10. デプロイ・運用

| 項目 | 構成 |
|---|---|
| 開発 | ローカル `npm run dev` + Supabase ローカル |
| 本番 | Vercel(Next.js) + Supabase クラウド(無料枠) |
| バッチ | GitHub Actions cron |
| シークレット | `.env.local`(開発)/ Vercel・GHA Secrets(本番) |
| モニタリング | MVP は Vercel ログ + `scrape_runs`。後で Sentry 検討 |

## 11. ディレクトリ構成(想定)

```
event-searcher/
├── app/
│   ├── page.tsx                    # 検索ページ
│   ├── settings/page.tsx           # 設定ページ
│   └── api/
│       └── search/route.ts         # 検索 API
├── lib/
│   ├── search/                     # 検索サービス
│   ├── cache/                      # search_cache 操作
│   ├── area.ts                     # 都道府県 ↔ エリア変換
│   └── date.ts                     # 今週末/来週末ロジック
├── scrapers/
│   ├── types.ts                    # SourceAdapter インタフェース
│   ├── pia.ts
│   ├── walkerplus.ts
│   └── __fixtures__/               # スナップショット HTML
├── db/
│   └── migrations/                 # SQL マイグレーション
├── scripts/
│   └── batch-fetch.ts              # GitHub Actions から起動
├── tests/
└── docs/superpowers/specs/
```

## 12. オープン課題 / 将来の検討項目

- ぴあ・Walkerplus の **利用規約と robots.txt の最終確認**(実装前に必ず実施)
- 公開時のレート制限・利用規約・プライバシーポリシー(個人利用フェーズでは不要)
- LiveFans・アニメイト等のソース追加
- 通知機能(週次ダイジェスト、新着アラート)
- ログイン・ユーザー別お気に入り
- スクレイピング方針が破綻した場合の代替策(公式 RSS、Atomフィードがあれば移行)

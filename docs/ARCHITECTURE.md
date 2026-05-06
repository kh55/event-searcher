# Architecture

声優・アニメ作品名等のキーワードでライブ / コンサート / トーク / 展示を横断検索する Web サービス(MVP・個人利用 first)。本ドキュメントは現行の構成・データフロー・運用手順をまとめる。

詳細な設計判断の経緯は `docs/superpowers/specs/2026-05-04-event-searcher-design.md` を、初期実装の段取りは `docs/superpowers/plans/2026-05-04-event-searcher.md` を参照。

---

## システム俯瞰

```
                          ┌─────────────────────┐
                          │   GitHub Actions    │
                          │  cron 21,9 * * *    │  (UTC = JST 06:00 / 18:00)
                          │  scripts/batch-fetch│
                          └──────────┬──────────┘
                                     │ saved_keywords を全件 fetch して
                                     │ 各 adapter で外部スクレイプ → upsert
                                     ▼
┌──────────┐   POST  ┌─────────────────────────┐  CRUD  ┌──────────────┐
│ Browser  │ ──────► │ Vercel (Next.js 16)     │ ─────► │  Supabase    │
│ (User)   │         │  app/page.tsx           │        │  PostgreSQL  │
│          │ ◄────── │  app/settings           │        │  + PostgREST │
└──────────┘   JSON  │  app/api/search         │        │              │
                     │  app/api/saved-keywords │        │  events      │
                     └────────────┬────────────┘        │  saved_kwds  │
                                  │                     │  search_cache│
                                  │ on-demand scrape    │  scrape_runs │
                                  ▼                     └──────┬───────┘
                          ┌─────────────────┐                  ▲
                          │ pia.jp adapter  │ ────upsert──────┘
                          │ walkerplus      │
                          │ peatix (JSON)   │
                          └─────────────────┘
```

3 つのインフラを束ねる構成:

| 役割 | サービス | 責務 |
|---|---|---|
| **フロント / API** | Vercel(Next.js 16 Functions) | 検索 UI、`/api/search`、`/api/saved-keywords` の REST、on-demand スクレイプの起点 |
| **データベース** | Supabase(PostgreSQL + PostgREST 自動 API) | events / saved_keywords / search_cache / scrape_runs の永続化 |
| **バッチ** | GitHub Actions(cron + workflow_dispatch) | saved_keywords を起点に外部スクレイプ → upsert を 1 日 2 回回す |

すべての DB アクセスは **Supabase の `service_role` キー** で行い、ブラウザから DB を直接叩く経路は持たない。

---

## ディレクトリレイアウト

```
event-searcher/
├── app/                       Next.js App Router
│   ├── page.tsx               検索 UI
│   ├── settings/page.tsx      保存キーワード CRUD UI
│   ├── layout.tsx             ルート HTML / メタデータ
│   └── api/
│       ├── search/route.ts            POST /api/search
│       └── saved-keywords/route.ts    GET / POST / DELETE
├── lib/                       ドメインロジック
│   ├── search/
│   │   ├── index.ts           searchEvents (戦略選択 / on-demand / 結果返却)
│   │   └── query.ts           入力 → DB クエリパラメータ変換
│   ├── cache.ts               search_cache の sha256 キー生成 + 6h TTL
│   ├── area.ts                都道府県 ↔ エリア (関東 / 近畿 等)
│   ├── date.ts                JST 基準の「今週末/来週末/今月」レンジ
│   ├── online-detection.ts    タイトル/説明から配信判定
│   ├── ticket-status.ts       on_sale / sold_out / lottery / unknown 正規化
│   └── supabase.ts            getServerClient() (Service Role キャッシュ)
├── scrapers/                  外部サイトアダプタ
│   ├── types.ts               SourceAdapter / RawEvent / SearchParams
│   ├── http.ts                fetchHtml / fetchJson / RateLimiter
│   ├── pia.ts                 piaAdapter (t.pia.jp)
│   ├── walkerplus.ts          walkerplusAdapter (walkerplus.com)
│   ├── peatix.ts              peatixAdapter (peatix-api.com / JSON)
│   └── __fixtures__/          各 adapter の HTML / JSON フィクスチャ
├── scripts/
│   └── batch-fetch.ts         cron + ローカル実行のエントリ
├── db/
│   ├── README.md              マイグレーション運用メモ
│   └── migrations/            0001 → 0005 (順番実行)
├── tests/                     vitest (lib / scrapers / api 各層)
└── .github/workflows/
    └── batch-fetch.yml        cron + workflow_dispatch
```

`app/api/*` は Next.js のサーバ関数として Vercel にデプロイされる。`scripts/batch-fetch.ts` は tsx で Node スクリプトとして GitHub Actions runner 上で動く。両者で `lib/` `scrapers/` を共有する。

---

## データフロー

### 1. 検索リクエスト(`POST /api/search`)

`searchEvents()`(`lib/search/index.ts`)が以下のロジックで戦略選択する。

```
入力: { q, from, to, areas, includeOnline, onSaleOnly }

q が空文字  ─────────► strategy = "db_only"   (DB のみ参照)
q あり
 ├─ saved_keywords に登録あり ─► strategy = "batch"     (cron が取込済みとみなす)
 ├─ search_cache に有効 entry ─► strategy = "cache"     (6h TTL)
 └─ いずれもなし              ─► strategy = "on_demand" (各 adapter 直叩き → upsert → cache 登録)

最後に runDbSearch() で events から実際の行を取得して返す。
```

`on_demand` 経路は逐次 + 2 秒間隔のレートリミッタ(モジュールスコープ `RateLimiter(2000)`)で外部負荷を抑制する。各 adapter 呼び出しは `scrape_runs` に `trigger='on_demand'` で記録される。

レスポンスの `meta.fetched_strategy` で実際の戦略が、`sources_succeeded` / `sources_failed` で adapter 結果が観測できる。

### 2. バッチ実行(GitHub Actions cron)

`scripts/batch-fetch.ts`(`npm run batch-fetch`):

```
1. saved_keywords を全件取得
2. for keyword in keywords:
     for adapter in [pia, walkerplus, peatix]:
       ├ rate limit 2s wait
       ├ adapter.search(keyword, dateFrom=now, dateTo=now+30d, includeOnline=true)
       ├ events を upsert (UNIQUE(source, source_event_id) で衝突解決)
       └ scrape_runs に trigger='cron' で 1 行記録
     saved_keywords.last_fetched_at を更新
3. 古い行を削除 (events.starts_at < now - 24h)
```

cron は UTC `0 21,9 * * *` = JST 06:00 / 18:00。`workflow_dispatch:` で手動実行も可。

### 3. 保存キーワード CRUD

`/api/saved-keywords`(GET / POST / DELETE)で `saved_keywords` テーブルに対する単純な CRUD を提供。`/settings` ページから操作する。

保存キーワードがあると、その語の検索は次の cron で `events` に取り込まれ、ユーザーが検索したときは `strategy='batch'` で即返る(on-demand スクレイプを発火しない)。

---

## DB スキーマ概要

| テーブル | 役割 | 主要列 |
|---|---|---|
| `events` | 取り込み済みイベント本体 | `(source, source_event_id) UNIQUE`, `starts_at`, `area`, `is_online`, `ticket_status`, `description`, `performers[]`, GIN インデックス `events_search_doc(title, description, performers)` |
| `saved_keywords` | 推しキーワード | `keyword UNIQUE`, `last_fetched_at` |
| `search_cache` | on-demand 結果のキャッシュ | `cache_key PK` (sha256), `event_ids BIGINT[]`, `expires_at`(6h) |
| `scrape_runs` | スクレイプ実行ログ | `source`, `keyword`, `trigger ('cron'|'on_demand')`, `events_found`, `status`, `error_message` |

マイグレーションは `db/migrations/0001_create_events.sql` 〜 `0005_grant_service_role.sql` の **順番実行**。0005 は `service_role` ロールに対する GRANT(Supabase の "Automatically expose new tables: OFF" を補完する)。

詳細は `db/README.md` 参照。

---

## 環境変数

| 名前 | 用途 | 設定先 | sensitive |
|---|---|---|---|
| `SUPABASE_URL` | Supabase REST API エンドポイント `https://xxxx.supabase.co` | ローカル: `.env.local` / Vercel: Production env / GitHub Actions: repo secrets | No(URL は秘密ではない) |
| `SUPABASE_SERVICE_ROLE_KEY` | RLS バイパス用 Service Role JWT(`eyJhbGc...`) | 同上 | **Yes**(管理者権限のため漏えい時は即 rotate) |

`anon` キーや `NEXT_PUBLIC_*` は使用しない(ブラウザから DB を直接叩かない設計のため)。

---

## デプロイ

### Vercel(フロント / API)

- フレームワークプリセット: **Next.js**(自動検出)
- Production ブランチ: `main`
- main への push で自動デプロイ
- Deployment Protection: **Vercel Authentication 有効**(個人利用 first のため)
- 環境変数は Production スコープに `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` を登録

### GitHub Actions(バッチ)

- ワークフロー: `.github/workflows/batch-fetch.yml`
- スケジュール: `0 21,9 * * *`(UTC)
- 手動実行: Actions タブ → `batch-fetch` → `Run workflow`
- Repo secrets に `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` を登録

### Supabase(DB)

- リージョン: Northeast Asia (Tokyo)
- プラン: Free tier
- 設定: Data API ON / Automatically expose new tables OFF / Automatic RLS ON
- アクセスは `service_role` のみ(`anon` / `authenticated` 未 GRANT)

---

## オペレーション

### 新しいキーワードを追加して定期取得対象にする

```bash
curl -X POST https://event-searcher.vercel.app/api/saved-keywords \
  -H "Content-Type: application/json" \
  -d '{"keyword":"花江夏樹"}'
```

または `/settings` ページの UI から。次の cron 実行(JST 06:00 or 18:00)から取り込み開始。

### 即時に取り込みたい(cron を待たずに)

```bash
gh workflow run batch-fetch.yml --ref main
```

### スクレイプ実行履歴を確認

Supabase ダッシュボード → Table Editor → `scrape_runs` を `started_at DESC` で開く。`trigger='cron'` がバッチ、`'on_demand'` がユーザー検索起点。

### Vercel 関数ログを見る(障害時)

```bash
vercel logs --no-branch --environment=production --status-code=500 --since=30m --expand
```

過去 30 分の 500 系をスタックトレース込みで表示。

### 環境変数を更新したあとの反映

Vercel 側で env を追加 / 変更しただけでは既存デプロイには伝播しない。再デプロイが必要:

```bash
vercel --prod    # CLI で即時再デプロイ
# または: 空コミット push で自動デプロイ起動
```

### 古いキャッシュを強制無効化したい

`search_cache` テーブルを TRUNCATE するか、対象行を DELETE。次回検索で on-demand 取得し直しになる。

---

## セキュリティモデル

- **DB アクセス**: 全経路 `service_role` キー経由。RLS は有効化されているが、`service_role` がバイパスする
- **`anon` ロール**: 何も GRANT されていない。仮にキーが漏れても全テーブル read/write 不可
- **API 認証**: 現状なし。Vercel Deployment Protection で「ログイン中の自分」だけがアクセスできる構成
- **検索クエリのサニタイズ**: `lib/search/index.ts` で PostgREST `or()` フィルタの予約文字 (`,()"*\`) を入力から除去(filter injection 防止)
- **シークレットのログ出力**: なし。Vercel/Actions/Supabase のログにキーが出力される箇所は無い

将来公開する場合は最低限:
- `/api/saved-keywords` への認証(Supabase Auth で個人テナント化)
- レート制限(IP ベースまたは Supabase Auth ベース)
- Deployment Protection を解除してパスワード保護に切り替え or 撤廃

---

## 既知の制限

実装メモ・既知の挙動は各ファイル冒頭の JSDoc に記載されている。代表例:

- **pia adapter**: `dateFrom` / `dateTo` を API に渡さないため範囲外イベントも upsert される(`runDbSearch` の `starts_at` フィルタで最終的に絞り込まれる)
- **pia adapter**: 検索結果 HTML フラグメントに description が含まれないため `RawEvent.description` は常に undefined
- **walkerplus adapter**: 1 ページ目(約 10 件)しか取得しない
- **walkerplus adapter**: クライアント側で `keyword` をタイトル / 会場名に部分一致でフィルタ(walkerplus 自体がキーワード検索を提供しないため)
- **peatix adapter**: 検索 JSON API は `dateFrom/dateTo` を受け付けないため、クライアント側 `startsAt` フィルタで絞り込む。`description` / `performers` は API 応答に含まれないため空(`group.name` は主催であって出演者ではないので入れていない)
- **`array_to_string`** が `STABLE` のため、events の GIN index は `events_search_doc()` IMMUTABLE wrapper を介して張る
- **events 古データ削除**: `starts_at < now - 24h` で削除。長期イベント(展示など)で `starts_at` 過去 + `ends_at` 未来は消える
- **`updated_at` 自動更新トリガー未設定**: アプリ側で明示的に `updated_at: now` を渡してカバー
- **on-demand 経路のレートリミット**: モジュールスコープなので Vercel の cold start 毎に状態リセット。同一インスタンスへの連続リクエストには有効、別インスタンス間では無効

---

## トラブルシューティング

| 症状 | 確認すること | よくある原因 |
|---|---|---|
| `/api/search` が 500 | `vercel logs --status-code=500 --expand` | 環境変数が Vercel に未登録 / 別スコープ / 再デプロイ未実施 |
| DB クエリが `permission denied` | Supabase ダッシュボードでテーブルの GRANT 状況 | `service_role` への GRANT 漏れ(`db/migrations/0005_grant_service_role.sql` を再実行) |
| マイグレーションが `42P17 IMMUTABLE` | 0001 に IMMUTABLE wrapper 関数が含まれているか | 旧版 SQL を貼った可能性。`db/migrations/0001_create_events.sql` を最新で取り直す |
| GitHub Actions cron が `SUPABASE_URL is not set` | repo secrets に登録されているか | Settings → Secrets and variables → Actions に追加 |
| ローカル `npm run batch-fetch` が `SUPABASE_URL is not set` | `.env.local` が存在するか / 正しいキーで埋まっているか | `.env.local.example` をコピーして値を埋める |
| 検索結果が常に 0 件 | `scrape_runs` で `events_found` を見る / `events` テーブルに行があるか | adapter 側でキーワード一致しない / 期間外 / クライアント側フィルタで除外 |

---

## 関連ドキュメント

- `README.md` — クイックスタート
- `db/README.md` — マイグレーション運用
- `docs/superpowers/specs/2026-05-04-event-searcher-design.md` — 設計仕様(意思決定の経緯)
- `docs/superpowers/plans/2026-05-04-event-searcher.md` — 初期実装の段取り

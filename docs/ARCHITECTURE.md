# Architecture

気になるキーワードでライブ / コンサート / トーク / 展示など各種イベントを横断検索する Web サービス(MVP・個人利用 first)。ジャンルは特に絞っていない。本ドキュメントは現行の構成・データフロー・運用手順をまとめる。

詳細な設計判断の経緯は `docs/superpowers/specs/2026-05-04-event-searcher-design.md` を、初期実装の段取りは `docs/superpowers/plans/2026-05-04-event-searcher.md` を参照。

---

## システム俯瞰

```
                          ┌─────────────────────┐
                          │  ofelia (cron)      │
                          │  0 21,9 * * * UTC   │  (= JST 06:00 / 18:00)
                          │  → app: batch-fetch │
                          └──────────┬──────────┘
                                     │ saved_keywords を全件 fetch して
                                     │ 各 adapter で外部スクレイプ → upsert
                                     ▼
┌──────────┐   POST  ┌─────────────────────────┐  SQL   ┌──────────────┐
│ Browser  │ ──────► │ app (Next.js 16)        │ ─────► │  db          │
│ (User)   │         │  app/page.tsx           │        │  PostgreSQL  │
│ localhost│ ◄────── │  app/settings           │        │  (pg image)  │
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

docker-compose 上の 3 サービス構成:

| サービス | イメージ | 責務 |
|---|---|---|
| **app** | local build(`Dockerfile`、Next.js 16) | 検索 UI、`/api/search`、`/api/saved-keywords` の REST、on-demand スクレイプの起点、`npm run batch-fetch` の実行体 |
| **db** | `postgres:16` | events / saved_keywords / search_cache / scrape_runs の永続化(volume `pgdata`)、初回起動時に `db/migrations/*.sql` を `/docker-entrypoint-initdb.d` 経由で適用 |
| **ofelia** | `mcuadros/ofelia` | `docker/ofelia.ini` の cron 設定に従って `app` コンテナで `npm run batch-fetch` を定期起動 |

`app` は `127.0.0.1:3000`(loopback only)に bind し、`db` は docker network 内部からのみアクセス可能。外部公開ポートは持たない。

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
│   └── db.ts                  pg Pool / クエリヘルパ
├── scrapers/                  外部サイトアダプタ
│   ├── types.ts               SourceAdapter / RawEvent / SearchParams
│   ├── http.ts                fetchHtml / fetchJson / RateLimiter
│   ├── pia.ts                 piaAdapter (t.pia.jp)
│   ├── walkerplus.ts          walkerplusAdapter (walkerplus.com)
│   ├── peatix.ts              peatixAdapter (peatix-api.com / JSON)
│   └── __fixtures__/          各 adapter の HTML / JSON フィクスチャ
├── scripts/
│   ├── batch-fetch.ts         cron + ローカル実行のエントリ
│   └── migrate.ts             schema_migrations を読んで未適用 SQL を流すツール
├── db/
│   ├── README.md              マイグレーション運用メモ
│   └── migrations/            0000 → 0004 (順番実行)
├── tests/                     vitest (lib / scrapers / api 各層)
├── Dockerfile                 app サービスのビルド定義
├── docker-compose.yml         db / app / ofelia の 3 サービス定義
└── docker/
    └── ofelia.ini             cron スケジュール(UTC 0 21,9 * * *)
```

`app/api/*` は Next.js のサーバ関数として `app` コンテナ内で動く。`scripts/batch-fetch.ts` は tsx で Node スクリプトとして同じ `app` コンテナ内で ofelia から `exec` 起動される。両者で `lib/` `scrapers/` を共有する。

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

### 2. バッチ実行(ofelia cron)

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

cron は UTC `0 21,9 * * *` = JST 06:00 / 18:00。`docker compose exec app npm run batch-fetch` で手動実行も可。

### 3. 保存キーワード CRUD

`/api/saved-keywords`(GET / POST / DELETE)で `saved_keywords` テーブルに対する単純な CRUD を提供。`/settings` ページから操作する。

保存キーワードがあると、その語の検索は次の cron で `events` に取り込まれ、ユーザーが検索したときは `strategy='batch'` で即返る(on-demand スクレイプを発火しない)。

---

## DB スキーマ概要

| テーブル | 役割 | 主要列 |
|---|---|---|
| `events` | 取り込み済みイベント本体 | `(source, source_event_id) UNIQUE`, `starts_at`, `area`, `is_online`, `ticket_status`, `description`, `performers[]`, GIN インデックス `events_search_doc(title, description, performers)` |
| `saved_keywords` | 保存キーワード(バッチ継続取得対象) | `keyword UNIQUE`, `last_fetched_at` |
| `search_cache` | on-demand 結果のキャッシュ | `cache_key PK` (sha256), `event_ids BIGINT[]`, `expires_at`(6h) |
| `scrape_runs` | スクレイプ実行ログ | `source`, `keyword`, `trigger ('cron'|'on_demand')`, `events_found`, `status`, `error_message` |
| `schema_migrations` | 適用済みマイグレーションのトラッキング | `filename PK`, `applied_at` |

マイグレーションは `db/migrations/0000_create_schema_migrations.sql` 〜 `0004_create_scrape_runs.sql` の **順番実行**。初回は `db` コンテナの `/docker-entrypoint-initdb.d` から自動実行され、以後の追加分は `npm run migrate`(`scripts/migrate.ts`)で `schema_migrations` を見て未適用分のみ流す。

詳細は `db/README.md` 参照。

---

## 環境変数

| 名前 | 用途 | 設定先 | sensitive |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL 接続文字列 `postgres://app:app@<host>:5432/event_searcher` | ローカル CLI: `.env.local`(host=`localhost`)/ コンテナ内: `docker-compose.yml` の env で host=`db` に上書き | No(loopback 限定運用のため) |

ホスト側から `npm run dev` や `npm run migrate` を実行するときは `.env.local` の `DATABASE_URL` が `localhost:5432` を指していることが前提。`app` コンテナ内では `docker-compose.yml` の `environment:` が `db:5432` へ書き換える。

---

## デプロイ

### Docker Compose のセットアップ

1. `cp .env.local.example .env.local`(`DATABASE_URL` の雛形が入っている)
2. `docker compose up -d --build`
   - `db` サービスが初回起動時に `pgdata` ボリュームを新規作成し、`db/migrations/*.sql` をファイル名昇順に自動適用
   - `app` サービスが `Dockerfile` の multi-stage build を実行し、`npm run build` 済みの Next.js をプロダクションモードで起動
   - `ofelia` サービスが `docker/ofelia.ini` を読み込み、cron で `app` コンテナの `npm run batch-fetch` を発火するよう待機
3. `http://localhost:3000` にアクセス(loopback only)

追加マイグレーションを当てるときは:

```bash
npm run migrate
```

`scripts/migrate.ts` が `schema_migrations` テーブルを見て未適用の `db/migrations/*.sql` だけを流す。マイグレーションはホストから実行する(コンテナイメージに `db/migrations/` を同梱していないため `docker compose exec app` では失敗する)。

---

## オペレーション

### 新しいキーワードを追加して定期取得対象にする

```bash
curl -X POST http://localhost:3000/api/saved-keywords \
  -H "Content-Type: application/json" \
  -d '{"keyword":"花江夏樹"}'
```

または `/settings` ページの UI から。次の cron 実行(JST 06:00 or 18:00)から取り込み開始。

### 即時に取り込みたい(cron を待たずに)

```bash
docker compose exec app npm run batch-fetch
```

### スクレイプ実行履歴を確認

```bash
psql postgres://app:app@localhost:5432/event_searcher \
  -c "SELECT started_at, source, keyword, trigger, events_found, status FROM scrape_runs ORDER BY started_at DESC LIMIT 20;"
```

`trigger='cron'` がバッチ、`'on_demand'` がユーザー検索起点。

### app の関数ログを見る(障害時)

```bash
docker compose logs -f app
```

直近に絞るなら `--since=30m`、エラーだけ拾うなら `| grep -i error`。

### 環境変数を更新したあとの反映

`docker-compose.yml` を編集した場合は:

```bash
docker compose up -d --build
```

で再ビルド + 再起動。`.env.local` を編集しただけで効くのはホスト側 CLI からの実行のみで、コンテナには伝播しない。

### 古いキャッシュを強制無効化したい

`search_cache` テーブルを TRUNCATE するか、対象行を DELETE。次回検索で on-demand 取得し直しになる。

```bash
psql postgres://app:app@localhost:5432/event_searcher -c "TRUNCATE search_cache;"
```

---

## セキュリティモデル

- **DB アクセス**: `app` コンテナから docker network 内部の `db:5432` に対して `app` ロール(superuser of `event_searcher`)で接続。docker network 外からは到達不可
- **公開範囲**: `app` の `3000/tcp` は `127.0.0.1` への loopback only bind。`db` はホストにポート公開しない設定(必要なら `docker compose exec db psql` か明示的なポートフォワード)
- **API 認証**: 現状なし。loopback only であることで「自分のマシンの自分」だけがアクセスできる構成
- **検索クエリのサニタイズ**: `lib/search/index.ts` で入力から SQL 注入相当の予約文字を除去(filter injection 防止)
- **シークレットのログ出力**: なし。`DATABASE_URL` 自体は秘密として扱う必要があるが、loopback のみで運用するためログ閲覧は手元限定

将来公開する場合は最低限:

- `/api/saved-keywords` への認証(セッション or 簡易 Basic 認証)
- レート制限(IP ベース)
- `app` の bind を `0.0.0.0` に変えるならその前にリバプロ + TLS + 認証を必ず置く
- `db` ロールをアプリ用に分離(現状の `app` superuser 運用は loopback 前提)

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
- **on-demand 経路のレートリミット**: モジュールスコープなので `app` コンテナ再起動毎に状態リセット。同一プロセスへの連続リクエストには有効、再起動を挟むと無効

---

## トラブルシューティング

| 症状 | 確認すること | よくある原因 |
|---|---|---|
| サービスの状態確認 | `docker compose ps` | `app` / `db` / `ofelia` が `Up` になっているか |
| `/api/search` が 500 | `docker compose logs -f app` | `DATABASE_URL` が未設定 / DB が起動しきっていない |
| DB が起動しない | `docker compose logs db` | volume の権限・破損、初回マイグレーション SQL の構文エラー |
| マイグレーションが `42P17 IMMUTABLE` | 0001 に IMMUTABLE wrapper 関数が含まれているか | 旧版 SQL を貼った可能性。`db/migrations/0001_create_events.sql` を最新で取り直す |
| ローカル `npm run batch-fetch`(ホスト)が `DATABASE_URL is not set` | `.env.local` が存在するか / 正しい値で埋まっているか | `.env.local.example` をコピーして値を埋める |
| 検索結果が常に 0 件 | `scrape_runs` で `events_found` を見る / `events` テーブルに行があるか | adapter 側でキーワード一致しない / 期間外 / クライアント側フィルタで除外 |
| データを完全リセットしたい | `docker compose down -v` で volume ごと破棄 | `up -d --build` で再度マイグレーションから流し直し |

---

## 関連ドキュメント

- `README.md` — クイックスタート
- `db/README.md` — マイグレーション運用
- `docs/superpowers/specs/2026-05-04-event-searcher-design.md` — 設計仕様(意思決定の経緯)
- `docs/superpowers/plans/2026-05-04-event-searcher.md` — 初期実装の段取り

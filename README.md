# event-searcher

気になるキーワードで、ライブ・コンサート・トーク・展示など全国のイベントを横断検索できる Web サービス(MVP)。

## 機能

- キーワード(アーティスト・作品・会場・イベント名など) + 期間 + エリアで検索
- 「今週末/来週末/今月」のプリセット
- 販売中のみ表示 / 配信を含めるかのトグル
- 保存キーワードのバッチ継続取得

## セットアップ

```bash
cp .env.local.example .env.local  # 値を埋める
npm install
```

### DB マイグレーション

Supabase ダッシュボードの SQL Editor に `db/migrations/*.sql` を `0001` → `0005` の順で流す。詳細は `db/README.md`。

Supabase プロジェクトを新規作成するときの推奨設定: **Data API: ON / Automatically expose new tables: OFF / Automatic RLS: ON**(0005 で `service_role` のみに GRANT する前提)。

### 開発サーバ

```bash
npm run dev
```

### バッチ実行(ローカル)

```bash
npm run batch-fetch
```

### テスト

```bash
npm test
```

## 構成

- **アーキテクチャ全体**: `docs/ARCHITECTURE.md`(データフロー / ディレクトリ / DB スキーマ / 運用手順)
- 設計仕様: `docs/superpowers/specs/2026-05-04-event-searcher-design.md`
- 実装計画: `docs/superpowers/plans/2026-05-04-event-searcher.md`

## デプロイ

- フロント / API: Vercel(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` を Production env に登録)
- バッチ: GitHub Actions(同じ 2 つを repo secrets に登録)
- DB: Supabase クラウド(Free tier、Tokyo リージョン推奨)

詳細手順は `docs/ARCHITECTURE.md` の「デプロイ」「オペレーション」「トラブルシューティング」を参照。

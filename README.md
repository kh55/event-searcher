# event-searcher

声優・アニメ作品名等のキーワードで、ライブ・コンサート・トーク・展示など全国のイベントを横断検索できる Web サービス(MVP)。

## 機能

- キーワード(声優名・作品名・会場名) + 期間 + エリアで検索
- 「今週末/来週末/今月」のプリセット
- 販売中のみ表示 / 配信を含めるかのトグル
- 推しキーワードの保存(バッチで継続取得)

## セットアップ

```bash
cp .env.local.example .env.local  # 値を埋める
npm install
```

### DB マイグレーション

Supabase ダッシュボードの SQL Editor に `db/migrations/*.sql` を順番に流す。

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

- 設計仕様: `docs/superpowers/specs/2026-05-04-event-searcher-design.md`
- 実装計画: `docs/superpowers/plans/2026-05-04-event-searcher.md`

## デプロイ

- フロント/API: Vercel(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_*` を Secrets に)
- バッチ: GitHub Actions(同じ Secrets を Repo Secrets に)
- DB: Supabase クラウド(無料枠)

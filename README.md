# event-searcher

気になるキーワードで、ライブ・コンサート・トーク・展示など全国のイベントを横断検索できる Web サービス(MVP)。

## 機能

- キーワード(アーティスト・作品・会場・イベント名など) + 期間 + エリアで検索
- 「今週末/来週末/今月」のプリセット
- 販売中のみ表示 / 配信を含めるかのトグル
- 保存キーワードのバッチ継続取得

## 必要なもの

- Docker Desktop(Compose v2 同梱版)

## クイックスタート

1. 環境変数を用意:

   ```bash
   cp .env.local.example .env.local
   # DATABASE_URL=postgres://app:app@localhost:5432/event_searcher が入っている
   ```

2. Docker Compose を起動:

   ```bash
   docker compose up -d --build
   ```

3. ブラウザで http://localhost:3000 を開く

4. キーワードを追加(/settings ページから、または curl):

   ```bash
   curl -X POST http://localhost:3000/api/saved-keywords \
     -H "Content-Type: application/json" \
     -d '{"keyword":"花江夏樹"}'
   ```

5. 即時バッチ実行(cron を待たない場合):

   ```bash
   docker compose exec app npm run batch-fetch
   ```

cron は `docker/ofelia.ini` で UTC `0 21,9 * * *`(JST 06:00 / 18:00)に `app` コンテナの `npm run batch-fetch` を起動する。

## 開発時の注意

ホストから直接 Node を動かす場合(`npm run dev` / `npm test` など)は、`.env.local` の `DATABASE_URL` は `localhost` を指している必要がある。コンテナ内部から DB に繋ぐ場合のホスト名は `db` で、これは `docker-compose.yml` の環境変数で上書きされる。

## テスト

```bash
npm test
```

## 構成

- **アーキテクチャ全体**: `docs/ARCHITECTURE.md`(データフロー / ディレクトリ / DB スキーマ / 運用手順)
- 設計仕様: `docs/superpowers/specs/2026-05-04-event-searcher-design.md`
- 実装計画: `docs/superpowers/plans/2026-05-04-event-searcher.md`

詳細な運用手順(ログ確認・マイグレーション・トラブルシューティング)は `docs/ARCHITECTURE.md` の「オペレーション」「トラブルシューティング」を参照。

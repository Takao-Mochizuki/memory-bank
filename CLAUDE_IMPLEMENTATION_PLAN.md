# Memory Bank 差分実装計画

この文書は `memory-bank` を `memory-lancedb-pro` に近い実用水準へ段階的に改善するための計画書です。
目的は「参考実装のコードをコピーせず」「安全性を優先しつつ」「機能差分を埋める」ことです。

## 前提

- 参考実装は `win4r/memory-lancedb-pro`
- 方針は「コードを読むだけ、コピーしない」
- 現在の `memory-bank` は以下を実装済み
  - ハイブリッド検索
  - Cross-Encoder リランキング
  - スコープ分離
  - 時間減衰
  - 近時ブースト
  - ノイズフィルター
  - 自動想起
  - 自動キャプチャ
  - 簡易リフレクション
  - 管理ツール

## 現在の主な差分

`memory-bank` に未実装または弱い要素:

- MMR による検索結果の多様性制御
- 長文優遇や長文偏重を抑える length normalization
- クエリの長さや内容に応じた adaptive retrieval
- `project:` `user:` `custom:` などを含む高度なスコープ体系
- エージェントごとの scope access 制御
- 独立した管理 CLI
- 多段の reflection pipeline
- task-aware embeddings

## 実装優先順位

### Phase 1: 検索品質の改善

優先度: 最優先
難易度: 中
目的: 記憶検索の質をすぐ上げる

実装対象:

- MMR / 重複除去
- length normalization

対象ファイル:

- `src/retriever.ts`
- 必要なら `src/store.ts`
- テスト追加: `test/retrieval.test.ts`

完了条件:

- 類似した記憶が上位を独占しない
- 長すぎる記憶が不自然に上位固定されにくい
- スコアの説明可能性を壊さない

Claude への指示:

- `src/retriever.ts` に MMR ベースの多様性選択を追加する
- ベクトル類似度または既存スコアを使って重複した候補を間引く
- length normalization をスコアリングパイプラインへ追加する
- 既存の `minScore`、`recencyBoost`、`timeDecay` と競合しないように調整する
- 変更後の挙動を検証するテストを追加する

### Phase 2: Adaptive Retrieval

優先度: 高
難易度: 中
目的: 問い合わせごとに検索戦略を最適化する

実装対象:

- クエリ長に応じた candidate pool 調整
- ベクトル検索と BM25 の重み自動調整
- 必要なら短文・長文で `minScore` を調整

対象ファイル:

- `src/retriever.ts`
- `openclaw.plugin.json`
- テスト追加: `test/retrieval.test.ts`

完了条件:

- 短いキーワード検索と長い自然文検索で結果品質が改善する
- 設定なしでも安全なデフォルトで動作する
- 手動設定で adaptive を無効化できる

Claude への指示:

- adaptive retrieval を optional な設定として追加する
- `query.length` だけでなく token 近似や単語数ベースも検討する
- 実装は単純なヒューリスティクスでよく、過度に複雑にしない
- `openclaw.plugin.json` の schema と `README.md` の設定例も更新する

### Phase 3: 高度なスコープ管理

優先度: 高
難易度: 中から高
目的: マルチエージェント環境での誤参照と越権アクセスを減らす

実装対象:

- `global` `agent:*` だけでなく `project:` `user:` `custom:` などの拡張
- scope access 制御
- 明示的スコープの許可リスト

対象ファイル:

- `src/scopes.ts`
- `src/tools.ts`
- `index.ts`
- `openclaw.plugin.json`
- テスト追加: `test/scopes.test.ts`

完了条件:

- エージェントごとにアクセス可能スコープを制御できる
- 未許可スコープへの保存・検索が拒否される
- 既存の `agent:` フォールバックを壊さない

Claude への指示:

- スコープ名のバリデーションを厳格化する
- `resolve()` と `isValid()` だけでなく `canAccess()` 相当の概念を追加する
- ツール実行時に必ずアクセスチェックを通す
- 設定 schema とテストを一緒に更新する

### Phase 4: 管理 CLI の追加

優先度: 中
難易度: 中
目的: OpenClaw 外から安全に点検しやすくする

実装対象:

- read-only を基本にした CLI
- list / stats / inspect / export 程度から開始

対象ファイル:

- `package.json`
- 新規 `cli.ts`
- 必要なら `src/store.ts`
- `README.md`

完了条件:

- `npm run cli -- stats` のような形で統計が見られる
- 初期版は削除や一括更新を入れない
- 既存データを壊さない

Claude への指示:

- まず read-only コマンドだけを実装する
- destructive な操作は後回しにする
- CLI は OpenClaw 本体に依存しない形を優先する

### Phase 5: Reflection 強化

優先度: 中
難易度: 高
目的: セッション要約だけでなく再利用可能な学びを抽出する

実装対象:

- セッション要約と lesson 抽出の分離
- 重複 lesson の抑制
- カテゴリ別抽出の精度改善

対象ファイル:

- `src/reflection.ts`
- `index.ts`
- `skills/lesson/SKILL.md`
- テスト追加: `test/reflection.test.ts`

完了条件:

- 単なる会話ログ保存ではなく、再利用価値のある lesson が残る
- autoCapture と二重保存しにくい
- 不正カテゴリや壊れた JSON を安全に捨てる

Claude への指示:

- 現在の session summary 方式を維持しつつ、lesson 抽出を段階的に追加する
- LLM 出力を信用しすぎず、必ずバリデーションを通す
- 同一 lesson の重複保存を防ぐ設計を検討する

### Phase 6: Task-Aware Embeddings

優先度: 低
難易度: 中から高
目的: 将来的な精度改善

実装対象:

- 保存用と検索用で前処理を分ける
- カテゴリや用途別の embedding strategy

対象ファイル:

- `src/embedder.ts`
- `src/retriever.ts`
- `README.md`

完了条件:

- 通常ケースで既存精度を悪化させない
- 無効化可能
- ベンチマーク方針がある

Claude への指示:

- 最初は prefixing や軽い前処理に留める
- モデル切替や複数 provider 前提の複雑化は避ける

## 実装ルール

- 参考実装のコードをコピーしない
- `eval` `exec` 動的 import の乱用を避ける
- 新しい外部通信先を増やさない
- schema 変更時は `openclaw.plugin.json` と `README.md` を必ず同期する
- 機能追加時は対応テストを追加する
- まず read-only / safe-by-default を優先する

## Claude への依頼テンプレート

以下をそのまま Claude に渡してよい:

```text
memory-bank を段階的に改善したいです。
参考対象は memory-lancedb-pro ですが、コードはコピーしないでください。

作業対象:
- リポジトリ: memory-bank
- 計画書: CLAUDE_IMPLEMENTATION_PLAN.md

今回は Phase 1 から着手してください。

要件:
- MMR / 重複除去を追加
- length normalization を追加
- 既存挙動を大きく壊さない
- openclaw.plugin.json の schema とズレが出るなら調整
- テストを追加
- README に必要なら追記

出力してほしいもの:
1. 変更方針の要約
2. 修正対象ファイル
3. 実装
4. テスト結果
5. 残課題
```

## すでに対応済みの安全修正

- `src/reflection.ts`
  - 不正カテゴリを除外する検証を追加済み
- `README.md`
  - 実機確認手順を追記済み
- `test/reflection.test.ts`
  - 未定義カテゴリを除外するテストを追加済み

## 次の実作業

最初に着手すべき実装:

1. `src/retriever.ts` に MMR を追加
2. `src/retriever.ts` に length normalization を追加
3. `test/retrieval.test.ts` を新設
4. 必要なら `README.md` に retrieval 設定例を追記

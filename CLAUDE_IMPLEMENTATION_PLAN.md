# Memory Bank 実装状況と改善計画

この文書は `memory-bank` プラグインの実装状況を管理する計画書です。
最終更新: 2026-03-08

## 前提

- 参考実装は `win4r/memory-lancedb-pro`（コードは読むだけ、コピーしない）
- テスト: 87/87 全パス
- Git: master ブランチ、GitHub にプッシュ済み

## 実装済み機能一覧

### 初期実装（コードレビュー修正済み）

| 機能 | ファイル | 状態 |
|------|---------|------|
| ハイブリッド検索（Vector + BM25） | `src/retriever.ts` | 完了 |
| Cross-Encoder リランキング | `src/retriever.ts` | 完了 |
| スコープ分離（global / agent:） | `src/scopes.ts` | 完了 |
| 時間減衰 | `src/retriever.ts` | 完了 |
| 近時ブースト | `src/retriever.ts` | 完了 |
| ノイズフィルター | `src/noise-filter.ts` | 完了 |
| 自動想起（before_agent_start） | `index.ts` | 完了 |
| 自動キャプチャ（agent_end） | `index.ts` | 完了 |
| 簡易リフレクション | `src/reflection.ts`, `index.ts` | 完了 |
| 管理ツール（memory_list, memory_stats） | `src/tools.ts` | 完了 |
| FTS インデックス自動作成 | `src/store.ts` | 完了（F-04修正） |
| SQL インジェクション防止 | `src/store.ts` | 完了（F-07修正） |
| autoCapture + reflection 二重保存防止 | `index.ts` | 完了（F-03修正） |
| memory_update 時のベクトル再生成 | `src/tools.ts` | 完了（F-11修正） |

### Phase 1: MMR + Length Normalization — 完了

| 機能 | ファイル | 状態 |
|------|---------|------|
| MMR（Maximal Marginal Relevance） | `src/retriever.ts` L123付近 | 完了 |
| Length Normalization | `src/retriever.ts` L92付近 | 完了 |
| `mmrLambda` 設定 | `openclaw.plugin.json` | 完了 |
| `lengthNormAnchor` 設定 | `openclaw.plugin.json` | 完了 |
| テスト | `test/retrieval.test.ts` (MMR 5件 + lengthNorm 6件) | 完了 |

### Phase 2: Adaptive Retrieval — 完了

| 機能 | ファイル | 状態 |
|------|---------|------|
| クエリ長ベースの重み自動調整 | `src/retriever.ts` `adaptConfig()` L219付近 | 完了 |
| 短文→BM25重視、長文→ベクトル重視 | `src/retriever.ts` | 完了 |
| `adaptive` 設定（default: true） | `openclaw.plugin.json` | 完了 |
| テスト | `test/retrieval.test.ts` (adaptConfig 6件) | 完了 |

### Phase 3: Scope Access Control — 完了

| 機能 | ファイル | 状態 |
|------|---------|------|
| `project:` / `user:` プレフィックス | `src/scopes.ts` | 完了 |
| `canAccess(agentId, scope)` | `src/scopes.ts` L60付近 | 完了 |
| `agentAccess` 設定（ワイルドカード `*` 対応） | `openclaw.plugin.json` | 完了 |
| ツール実行時アクセスチェック | `src/tools.ts` (store, recall, list) | 完了 |
| テスト | `test/scopes.test.ts` (18件) | 完了 |

### Phase 4: CLI管理ツール — 完了

| 機能 | ファイル | 状態 |
|------|---------|------|
| `stats` / `list` / `inspect` / `export` コマンド | `cli.ts` | 完了 |
| 読み取り専用（destructive操作なし） | `cli.ts` | 完了 |
| `bin` フィールド + `cli` スクリプト | `package.json` | 完了 |
| テスト | `test/cli.test.ts` (8件) | 完了 |

### Phase 5: Lesson Extraction — 完了

| 機能 | ファイル | 状態 |
|------|---------|------|
| `LESSON_PROMPT` 定義 | `src/reflection.ts` | 完了 |
| `extractLessons()` — 重複チェック付き保存 | `src/reflection.ts` | 完了 |
| `isDuplicate()` — コサイン類似度≥0.9で重複判定 | `src/reflection.ts` | 完了 |
| agent_end での教訓自動抽出 | `index.ts` | 完了 |
| `/lesson` スキル | `skills/lesson/SKILL.md` | 完了 |
| テスト | `test/reflection.test.ts` (cosineSim 6件 + isDup 3件 + extract 5件 + prompt 1件) | 完了 |

### Phase 6: Task-Aware Embeddings — 完了

| 機能 | ファイル | 状態 |
|------|---------|------|
| `EmbedTask = "store" \| "query"` 型 | `src/embedder.ts` | 完了 |
| `TASK_PREFIXES` テーブル（nomic, mxbai） | `src/embedder.ts` | 完了 |
| `applyTaskPrefix()` | `src/embedder.ts` L97付近 | 完了 |
| `taskAware` 設定（default: true） | `openclaw.plugin.json` | 完了 |
| VectorCache のタスク別キー | `src/embedder.ts` | 完了 |
| store/update 時に `"store"` タスク指定 | `src/tools.ts`, `index.ts` | 完了 |
| テスト | `test/embedder.test.ts` (7件) | 完了 |

## テスト内訳

| ファイル | テスト数 |
|---------|---------|
| `test/cli.test.ts` | 8 |
| `test/embedder.test.ts` | 7 |
| `test/noise-filter.test.ts` | 7 |
| `test/reflection.test.ts` | 24 |
| `test/retrieval.test.ts` | 24 |
| `test/scopes.test.ts` | 17 |
| **合計** | **87** |

## 実装ルール

- 参考実装のコードをコピーしない
- `eval` `exec` 動的 import の乱用を避ける
- 新しい外部通信先を増やさない
- schema 変更時は `openclaw.plugin.json` を必ず同期する
- 機能追加時は対応テストを追加する
- read-only / safe-by-default を優先する

## 今後の改善候補（未着手）

以下は現時点では未実装だが、将来的に検討可能な項目:

- **カテゴリ別 embedding strategy**: カテゴリに応じた前処理の分岐
- **CLI の write 操作**: delete / bulk-update 等の破壊的コマンド（慎重に）
- **ベンチマーク**: 検索精度の定量的評価フレームワーク
- **README の設定例充実**: 全設定項目の使用例
- **`custom:` スコーププレフィックス**: ユーザー定義の任意スコープ

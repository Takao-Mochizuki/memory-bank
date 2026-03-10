# memory-bank — OpenClaw 長期記憶プラグイン

## プロジェクト概要
エージェントがセッションを超えて記憶を保持・検索できる OpenClaw プラグイン。LanceDB（ベクトルDB）にメモリを永続化し、ハイブリッド検索（Vector + BM25）で関連記憶を自動注入する。

## ステークホルダー
- **オーナー/開発**: 5dmgmt）

## 技術スタック
- **言語**: TypeScript（ESM）
- **ランタイム**: Node.js（jiti でTS直接実行）
- **ベクトルDB**: LanceDB (`@lancedb/lancedb`)
- **Embedding**: OpenAI API（`openai` パッケージ、Ollama等OpenAI互換も可）
- **テスト**: Node.js built-in test runner (`node --test`)
- **ライセンス**: MIT

## 現在のフェーズ
初期開発（v0.1.0）

## ドメイン文脈
- **6ツール**: memory_store / memory_recall / memory_update / memory_delete / memory_list / memory_stats
- **ハイブリッド検索**: Vector + BM25 を RRF で統合、Adaptive Retrieval、MMR多様性制御、Time Decay
- **自動機能**: Auto-Recall（会話開始時）、Auto-Capture（セッション終了時）、Reflection（セッション要約）、Lesson Extraction
- **スコープ分離**: Global / Agent / User / Project でメモリを分離、Scope ACL
- **CLI**: stats / list / inspect / export / import

## ソースコード構成
```
index.ts          # プラグインエントリポイント（activate）
cli.ts            # CLIエントリポイント
src/
  embedder.ts     # Embedding生成（Task-Aware前処理）
  store.ts        # LanceDBストア操作
  retriever.ts    # ハイブリッド検索エンジン
  tools.ts        # 6ツール定義
  reflection.ts   # セッション要約・教訓抽出
  scopes.ts       # スコープ分離・ACL
  noise-filter.ts # 挨拶・定型文の自動除外
test/             # テスト（87件）
```

## コンベンション
- ファイル名: kebab-case
- ESM (`"type": "module"`)
- テスト実行: `npm test`（`node --import jiti/register --test test/*.test.ts`）

## 重要な技術的注意点
- **activate は同期関数**: OpenClaw は async な `activate()` の戻り値を無視する。非同期初期化は `initPromise` パターンで遅延実行し、フック・ツール内部で `await initPromise` する設計
- **agent_end フックの発火条件**: `/reset`、`/new`、チャネル経由のセッション終了時のみ発火。CLI単発実行では発火しない
- **BM25検索**: LanceDB の `.search(query, "text")` は embedding function 必須でエラーになる。`.query().fullTextSearch(query)` を使用
- **設定パス**: `plugins.entries.memory-bank.config` の下に置く（`plugins.memory-bank` 直下はエラー）
- **外部通信**: Embedding API のみ（eval/exec不使用）

## Claude Code 運用ルール
- トークン70%超えたら `/compact`
- 新タスク開始時は `/clear`
- 長い会話は精度低下の原因 → こまめに `/compact`

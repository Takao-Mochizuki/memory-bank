# Memory Bank — OpenClaw 長期記憶プラグイン

エージェントが**セッションを超えて記憶を保持・検索**できるようにする OpenClaw プラグイン。

LanceDB（ベクトルDB）にメモリを永続化し、会話開始時に関連記憶を自動でシステムプロンプトに注入する。

---

## できること

### 自動機能（設定ONで動く）

| 機能 | 説明 | トリガー |
|------|------|---------|
| **Auto-Recall** | 関連する過去の記憶をシステムプロンプトに自動注入 | 毎回の会話開始時（`before_agent_start`） |
| **Auto-Capture** | ユーザーの発言を自動で記憶に保存 | セッション終了時（`agent_end`） |
| **Reflection** | セッション要約を自動生成して保存 | `/reset` `/new` 時（`agent_end`） |
| **Lesson Extraction** | 会話から教訓を自動抽出（重複チェック付き） | Reflection と同時 |

### エージェントツール（6種）

| ツール | 用途 |
|--------|------|
| `memory_store` | 重要情報を記憶に保存（カテゴリ・重要度指定可） |
| `memory_recall` | 関連する記憶を検索（ハイブリッド検索） |
| `memory_update` | 既存の記憶を更新（ベクトル自動再生成） |
| `memory_delete` | 不要な記憶を削除 |
| `memory_list` | 記憶の一覧表示（管理用） |
| `memory_stats` | 統計情報の確認（管理用） |

### 検索エンジン

| 機能 | 説明 |
|------|------|
| **ハイブリッド検索** | Vector + BM25 を RRF（Reciprocal Rank Fusion）で統合 |
| **Adaptive Retrieval** | クエリ長に応じて Vector/BM25 の重みを自動調整 |
| **MMR 多様性制御** | 似た記憶ばかり返さない |
| **Time Decay** | 古い記憶のスコアが半減期に従って減衰 |
| **近時ブースト** | 最近の記憶にスコアボーナス |
| **Length Normalization** | 長文記憶のスコア補正 |
| **Cross-Encoder リランキング** | オプションで精度をさらに向上 |
| **ノイズフィルター** | 挨拶・定型文を自動除外 |

### メモリ管理

| 機能 | 説明 |
|------|------|
| **スコープ分離** | Global / Agent / User / Project でメモリを分離 |
| **Scope ACL** | エージェントごとにアクセスできるスコープを制限 |
| **Task-Aware Embeddings** | 保存時と検索時で前処理を分離 |
| **CLI管理** | stats / list / inspect / export / import |

---

## インストール

### 1. クローン & インストール

```bash
git clone https://github.com/5dmgmt/memory-bank.git ~/.openclaw/extensions/memory-bank
cd ~/.openclaw/extensions/memory-bank
npm install
```

### 2. OpenClaw 設定

`~/.openclaw/openclaw.json` に以下を追加（既にファイルがあればマージ）:

```json
{
  "plugins": {
    "allow": ["memory-bank"],
    "entries": {
      "memory-bank": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoRecall": true,
          "retrieval": {
            "mode": "hybrid",
            "adaptive": true
          },
          "reflection": {
            "enabled": true
          },
          "enableManagementTools": true
        }
      }
    }
  }
}
```

> **重要**: 設定は `plugins.entries.memory-bank.config` の下に置く。`plugins.memory-bank` に直接書くとエラーになる。

### 3. Ollama（完全ローカル・無料）を使う場合

```bash
ollama pull nomic-embed-text
```

embedding 設定を以下に差し替え:

```json
{
  "embedding": {
    "apiKey": "dummy",
    "model": "nomic-embed-text",
    "baseURL": "http://localhost:11434/v1",
    "taskAware": true
  }
}
```

OpenAI 互換の Embedding API ならなんでも使える（Gemini、Azure、Cohere 等）。

### 4. 動作確認

```bash
# OpenClaw を再起動
openclaw gateway restart

# テスト保存
# → エージェントに「memory_store で "テスト記憶" を fact カテゴリで保存して」と指示

# テスト検索
# → エージェントに「memory_recall で "テスト" を検索して」と指示

# CLI で確認
npm run cli -- stats --db ~/.openclaw/memory/memory-bank
```

---

## 設定リファレンス

### embedding（必須）

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `apiKey` | string | — | Embedding API キー（`${ENV_VAR}` 形式可） |
| `model` | string | `text-embedding-3-small` | 埋め込みモデル名 |
| `baseURL` | string | `https://api.openai.com/v1` | OpenAI互換エンドポイント |
| `dimensions` | integer | 自動検出 | ベクトル次元数 |
| `taskAware` | boolean | `true` | 保存/検索で前処理を分離 |

### autoRecall / autoCapture

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `autoRecall` | boolean | `false` | 会話開始時に関連記憶を自動注入 |
| `autoCapture` | boolean | `false` | セッション終了時にユーザー発言を自動保存 |
| `autoRecallMinLength` | integer | `10` | 自動想起の最小プロンプト長 |
| `autoRecallCategories` | string[] | fact,lesson,preference,decision,entity,other | 自動想起の対象カテゴリ（reflection は除外） |

### retrieval（オプション）

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `mode` | `"hybrid"` \| `"vector"` | `hybrid` | 検索モード |
| `vectorWeight` | number | `0.7` | ベクトル検索の重み |
| `bm25Weight` | number | `0.3` | BM25の重み |
| `adaptive` | boolean | `true` | クエリ長に応じて重みを自動調整 |
| `minScore` | number | `0.005` | 最低スコア閾値 |
| `mmrLambda` | number | `0.7` | MMR多様性（0=多様性最大, 1=関連性のみ） |
| `lengthNormAnchor` | integer | `300` | この文字数より長い記憶はスコア減衰 |
| `decayHalfLifeDays` | number | `60` | 時間減衰の半減期（日数） |
| `recencyBoostDays` | number | `14` | 近時ブーストの半減期（日数） |
| `candidatePoolSize` | integer | `20` | リランク前の候補数 |

### reflection

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `reflection.enabled` | boolean | `true` | リフレクション有効化 |
| `reflection.maxMessages` | integer | `100` | リフレクション対象の最大メッセージ数 |

### その他

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `dbPath` | string | `~/.openclaw/memory/memory-bank` | LanceDBパス |
| `enableManagementTools` | boolean | `false` | memory_list / memory_stats を有効化 |

---

## CLI

```bash
npm run cli -- stats      # 統計
npm run cli -- list       # 一覧
npm run cli -- inspect    # 詳細表示
npm run cli -- export     # エクスポート
npm run cli -- import     # インポート
```

すべて `--db <path>` でデータベースパスを指定可能。

---

## 技術的な注意点

### activate は同期関数

OpenClaw は async な `activate()` の戻り値を無視する。そのため本プラグインは activate を同期関数にして、LanceDB接続等の非同期初期化は `initPromise` パターンで遅延実行している。フック・ツール内部で `await initPromise` してから使う設計。

### agent_end フックの発火条件

`agent_end` は `/reset`、`/new`、チャネル経由のセッション終了時に発火する。CLI の `openclaw agent` 単発実行では発火しない（OpenClaw の仕様）。

### BM25 検索

LanceDB の `.search(query, "text")` は embedding function が必要でエラーになる。代わりに `.query().fullTextSearch(query)` を使用している。

---

## セキュリティ

- 外部通信: Embedding API のみ（設定したエンドポイント以外には一切通信しない）
- eval / exec: 不使用
- ファイルアクセス: LanceDB のデータベースパスのみ
- テスト: 87件（86パス / 1件は既知の閾値テスト）
- スコープ分離: エージェント間の記憶越境を防止

---

## 免責事項

本ソフトウェアは「現状のまま」（AS IS）提供されます。導入・使用はすべて利用者自身の責任で行ってください。データの損失、APIキーの漏洩、その他の損害について作者は一切の責任を負いません。

詳細は [LICENSE](./LICENSE) ファイルを参照してください。

## ライセンス

MIT — 詳細は [LICENSE](./LICENSE) を参照

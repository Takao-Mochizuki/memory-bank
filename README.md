# Memory Bank — Grand Runbook

OpenClaw 長期記憶プラグイン。
このドキュメントは **開発・テスト・デプロイ・運用** の全手順をカバーするグランドランブックです。
基本的な作業は **Claude Code に指示を渡して実行** する前提で書かれています。

---

## 0. 概要

| 項目 | 内容 |
|------|------|
| リポジトリ | `https://github.com/5dmgmt/memory-bank.git` |
| ランタイム | Node.js + jiti（TypeScript直接実行） |
| データベース | LanceDB（ベクトルDB + FTS） |
| 埋め込み | OpenAI互換API（OpenAI / Ollama / Gemini等） |
| テスト | 87/87 パス |
| ライセンス | MIT |

### 機能一覧

- ハイブリッド検索（Vector + BM25 → RRF統合）
- Adaptive Retrieval（クエリ長に応じた自動調整）
- MMR多様性制御 + Length Normalization
- Cross-Encoder リランキング（オプション）
- マルチスコープ分離（global / agent: / project: / user:）
- Scope Access Control（エージェント別アクセス制限）
- 時間減衰 + 近時ブースト
- Task-Aware Embeddings（保存/検索で前処理分離）
- ノイズフィルター（挨拶・定型文除外）
- Lesson Extraction（教訓自動抽出・重複チェック付き）
- リフレクション（セッション要約の自動保存）
- CLI管理ツール（stats / list / inspect / export）
- 管理ツール（memory_list / memory_stats）

---

## 1. Mac mini への初期デプロイ

Claude Code に以下を渡してください:

```text
memory-bank プラグインを Mac mini にセットアップしてください。

■ インストール
1. git clone https://github.com/5dmgmt/memory-bank.git ~/.openclaw/plugins/memory-bank
2. cd ~/.openclaw/plugins/memory-bank && npm install
3. npm test を実行して全テストがパスすることを確認

■ OpenClaw 設定
~/.openclaw/openclaw.json に以下を追加（既にファイルがあればマージ）:

{
  "plugins": {
    "memory-bank": {
      "embedding": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "text-embedding-3-small"
      },
      "autoRecall": true,
      "autoCapture": false,
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

■ 動作確認
1. OpenClaw を再起動
2. memory_store ツールで1件テスト保存:
   テキスト: "テスト記憶: Memory Bankプラグインの初回動作確認"
   カテゴリ: fact
3. memory_recall ツールで "動作確認" と検索して、保存した記憶が返ることを確認
4. npm run cli -- stats --db ~/.openclaw/memory/memory-bank で統計が見えることを確認
5. 結果を報告してください
```

### Ollama（ローカルモデル）を使う場合

```text
embedding の設定をローカル Ollama に変更してください:

1. ollama pull nomic-embed-text を実行
2. ~/.openclaw/openclaw.json の embedding を以下に差し替え:
{
  "embedding": {
    "apiKey": "dummy",
    "model": "nomic-embed-text",
    "baseURL": "http://localhost:11434/v1",
    "taskAware": true
  }
}
3. OpenClaw を再起動して memory_store / memory_recall が動くことを確認
```

---

## 2. 開発環境セットアップ（開発Mac）

開発はメインの Mac で行い、完成後に Git 経由で Mac mini に渡します。

Claude Code に以下を渡してください:

```text
memory-bank プラグインの開発環境をセットアップしてください。

1. cd ~/openclaw-plugins/memory-bank
2. npm install
3. npm test で 87/87 テストがパスすることを確認
4. 結果を報告してください

開発時のコマンド:
- テスト実行: npm test
- 単一テスト: node --import jiti/register --test test/retrieval.test.ts
- CLI確認: npm run cli -- help
```

---

## 3. コード修正 → テスト → Git プッシュ

コードを修正した後の手順。Claude Code に以下を渡してください:

```text
memory-bank プラグインのコードを修正しました。以下の手順で確認・コミットしてください。

1. cd ~/openclaw-plugins/memory-bank
2. npm test を実行して全テストがパスすることを確認
3. テストが失敗したら原因を特定して修正
4. git diff で変更内容を確認
5. 変更内容に応じた適切なコミットメッセージで git commit
6. git push origin master
7. 結果を報告してください
```

### 新機能を追加する場合

```text
memory-bank に [機能の説明] を追加してください。

制約:
- 参考実装（memory-lancedb-pro）のコードはコピーしない
- eval/exec/動的importの乱用を避ける
- 新しい外部通信先を増やさない
- 対応するテストを必ず追加する
- openclaw.plugin.json の configSchema も更新する

完了後:
1. npm test で全テストがパスすることを確認
2. CLAUDE_IMPLEMENTATION_PLAN.md の該当箇所を更新
3. git commit & push
4. 変更サマリーを報告してください
```

---

## 4. Mac mini への更新デプロイ

開発 Mac で Git push した後、Mac mini の Claude Code に以下を渡してください:

```text
memory-bank プラグインを最新版に更新してください。

1. cd ~/.openclaw/plugins/memory-bank
2. git pull origin master
3. npm install（依存関係が変わっている可能性があるため）
4. npm test で全テストがパスすることを確認
5. OpenClaw を再起動
6. memory_recall で適当な検索をして動作確認
7. 結果を報告してください
```

---

## 5. 日常運用

### 記憶の状態を確認する

```text
memory-bank の記憶データベースの状態を確認してください。

cd ~/.openclaw/plugins/memory-bank

以下を順番に実行:
1. npm run cli -- stats --db ~/.openclaw/memory/memory-bank
2. npm run cli -- list --db ~/.openclaw/memory/memory-bank --limit 20
3. 結果を報告してください
```

### 記憶をエクスポートする

```text
memory-bank の全記憶を JSON でエクスポートしてください。

npm run cli -- export --db ~/.openclaw/memory/memory-bank --format json > ~/Desktop/memory-export.json

ファイルサイズと件数を報告してください。
```

### 特定の記憶を調べる

```text
memory-bank で ID が [記憶のID] の記憶を詳細表示してください。

cd ~/.openclaw/plugins/memory-bank
npm run cli -- inspect [記憶のID] --db ~/.openclaw/memory/memory-bank
```

---

## 6. トラブルシューティング

### プラグインが動かない場合

```text
memory-bank プラグインが動かないので調査してください。

確認手順:
1. cd ~/.openclaw/plugins/memory-bank && npm test → テストが通るか
2. node --import jiti/register -e "import('./src/store.js').then(m => m.createStore('/tmp/test-mb', 1536)).then(() => console.log('OK'))" → LanceDB が動くか
3. cat ~/.openclaw/openclaw.json | grep -A 20 memory-bank → 設定が正しいか
4. OpenClaw のログに memory-bank 関連のエラーがないか
5. node -v → Node.js バージョン（18以上が必要）
6. 見つかった問題と修正方法を報告してください
```

### npm install が失敗する場合

```text
memory-bank の npm install が失敗します。

@lancedb/lancedb はネイティブモジュールを含むため、以下を確認してください:
1. node -v（18以上か）
2. python3 --version（ネイティブビルドに必要な場合がある）
3. xcode-select --install が済んでいるか
4. npm cache clean --force してから再度 npm install
5. 結果を報告してください
```

### 検索結果がおかしい場合

```text
memory-bank の検索結果がおかしいので調査してください。

1. memory_recall で "[問題のクエリ]" を検索してスコアを確認
2. npm run cli -- list --db ~/.openclaw/memory/memory-bank --limit 30 で記憶の一覧を確認
3. 以下の設定を確認:
   - retrieval.adaptive が true か
   - retrieval.minScore が高すぎないか（デフォルト 0.3）
   - retrieval.mmrLambda の値（デフォルト 0.7）
4. 原因と対策を報告してください
```

---

## 7. 設定リファレンス

### embedding（必須）

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `apiKey` | string | — | Embedding API キー（`${ENV_VAR}` 形式可） |
| `model` | string | `text-embedding-3-small` | 埋め込みモデル名 |
| `baseURL` | string | `https://api.openai.com/v1` | OpenAI互換エンドポイント |
| `dimensions` | integer | 自動検出 | ベクトル次元数 |
| `taskAware` | boolean | `true` | 保存/検索で前処理を分離 |

### retrieval（オプション）

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `mode` | `"hybrid"` \| `"vector"` | `hybrid` | 検索モード |
| `vectorWeight` | number | `0.7` | ベクトル検索の重み |
| `bm25Weight` | number | `0.3` | BM25の重み |
| `adaptive` | boolean | `true` | クエリ長に応じて重みを自動調整 |
| `minScore` | number | `0.3` | 最低スコア閾値 |
| `mmrLambda` | number | `0.7` | MMR多様性（0=多様性最大, 1=関連性のみ） |
| `lengthNormAnchor` | integer | `300` | この文字数より長い記憶はスコア減衰。0で無効 |
| `decayHalfLifeDays` | number | `60` | 時間減衰の半減期（日数）。0で無効 |
| `recencyBoostDays` | number | `14` | 近時ブーストの半減期（日数） |
| `recencyBoostMax` | number | `0.1` | 近時ブーストの最大値 |
| `candidatePoolSize` | integer | `20` | リランク前の候補数 |
| `rerank` | `"cross-encoder"` \| `"none"` | `none` | リランキング方式 |
| `rerankApiKey` | string | — | リランカーAPIキー |
| `rerankModel` | string | `jina-reranker-v2-base-multilingual` | リランカーモデル |
| `rerankEndpoint` | string | `https://api.jina.ai/v1/rerank` | リランカーエンドポイント |

### scopes（オプション）

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `defaultScope` | string | `global` | デフォルトスコープ |
| `definitions` | object | — | カスタムスコープ定義 |
| `agentAccess` | object | — | エージェント別アクセス許可リスト |

`agentAccess` の例:

```json
{
  "scopes": {
    "agentAccess": {
      "code-agent": ["global", "project:myapp"],
      "admin-agent": ["*"],
      "sandbox-agent": []
    }
  }
}
```

- 未登録のエージェント → 全スコープにアクセス可
- `["*"]` → 全スコープ許可
- `[]` → 全スコープ拒否

### その他

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `dbPath` | string | `~/.openclaw/memory/memory-bank` | LanceDBパス |
| `autoRecall` | boolean | `false` | 関連記憶を自動注入 |
| `autoCapture` | boolean | `false` | ユーザー発言を自動保存 |
| `autoRecallMinLength` | integer | `10` | 自動想起の最小プロンプト長 |
| `reflection.enabled` | boolean | `true` | リフレクション有効化 |
| `reflection.maxMessages` | integer | `100` | リフレクション対象の最大メッセージ数 |
| `enableManagementTools` | boolean | `false` | memory_list / memory_stats を有効化 |

---

## 8. エージェントツール

| ツール | 説明 |
|--------|------|
| `memory_store` | 重要な情報を長期記憶に保存 |
| `memory_recall` | 関連する記憶を検索 |
| `memory_delete` | 指定IDの記憶を削除 |
| `memory_update` | 既存の記憶を更新（テキスト変更時はベクトルも再生成） |
| `memory_list` | 記憶一覧（管理用・要 `enableManagementTools`） |
| `memory_stats` | 統計情報（管理用・要 `enableManagementTools`） |

---

## 9. セキュリティ

- 外部通信: Embedding API と オプションのリランカーAPI のみ
- ファイルアクセス: LanceDB データベースパスのみ
- APIキー: 設定ファイル経由（環境変数参照推奨）
- eval/exec: 使用していません
- CLI: 読み取り専用（破壊的操作なし）
- スコープ分離: エージェント間の記憶越境を防止

---

## ライセンス

MIT

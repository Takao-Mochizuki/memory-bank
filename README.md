# Memory Bank

OpenClaw 長期記憶プラグイン — ハイブリッド検索、スコープ分離、時間減衰、リフレクション機能付き。

## 機能

- **ハイブリッド検索**: Vector + BM25 を RRF（Reciprocal Rank Fusion）で統合
- **Cross-Encoder リランキング**: Jina等のリランカーAPIで検索精度向上（オプション）
- **マルチスコープ分離**: Global / Agent / User レベルでメモリを分離
- **時間減衰 + 近時ブースト**: 古い記憶は徐々にフェード、新しい記憶を優先
- **ノイズフィルター**: 挨拶・定型文・短すぎるテキストを自動除外
- **リフレクション**: セッション終了時に会話から学びを自動抽出
- **管理ツール**: memory_list, memory_stats でデバッグ・監視

## インストール（Mac mini）

```bash
cd ~/.openclaw/plugins/
git clone https://github.com/5dmgmt/memory-bank.git
cd memory-bank
npm install
```

その後、OpenClaw 側でこのプラグインディレクトリを読み込む設定にし、ゲートウェイまたは OpenClaw 本体を再起動してください。

最小確認手順:

```bash
cd ~/.openclaw/plugins/memory-bank
npm test
```

実機で確認する項目:

1. OpenClaw 起動時に `memory-bank` がロードされる
2. `memory_store` と `memory_recall` がツール一覧に出る
3. 1件保存して 1件検索できる
4. `autoRecall` や `reflection` を有効化しても起動失敗しない

## 設定

`~/.openclaw/openclaw.json` にプラグイン設定を追加:

```json
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
        "vectorWeight": 0.7,
        "bm25Weight": 0.3
      },
      "reflection": {
        "enabled": true
      }
    }
  }
}
```

### Ollama（ローカル）で使う場合

```json
{
  "embedding": {
    "apiKey": "dummy",
    "model": "nomic-embed-text",
    "baseURL": "http://localhost:11434/v1"
  }
}
```

## エージェントツール

| ツール | 説明 |
|--------|------|
| `memory_store` | 重要な情報を長期記憶に保存 |
| `memory_recall` | 関連する記憶を検索 |
| `memory_delete` | 指定IDの記憶を削除 |
| `memory_update` | 既存の記憶を更新 |
| `memory_list` | 記憶一覧（管理用） |
| `memory_stats` | 統計情報（管理用） |

## セキュリティ

- 外部通信: Embedding API と オプションのリランカーAPI のみ
- ファイルアクセス: LanceDB データベースパスのみ
- APIキー: 設定ファイル経由（環境変数参照推奨）
- eval/exec: 使用していません

## ライセンス

MIT

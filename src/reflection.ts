/**
 * リフレクションモジュール
 * セッション終了時に会話から学びを抽出し、長期記憶として保存
 */

import { CATEGORIES } from "./store.js";
import type { MemoryStore, MemoryCategory } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { ScopeManager } from "./scopes.js";

export interface ReflectionConfig {
  enabled: boolean;
  maxMessages: number;
  timeoutMs: number;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  enabled: true,
  maxMessages: 100,
  timeoutMs: 20000,
};

export interface ReflectionItem {
  text: string;
  category: MemoryCategory;
  importance: number;
}

/**
 * 会話メッセージから保存すべき学びを抽出するプロンプト
 * エージェント自身がこのプロンプトに従って抽出を行う
 */
export const REFLECTION_PROMPT = `以下の会話を振り返り、長期記憶として保存すべき重要な情報を抽出してください。

抽出すべきもの:
- ユーザーの好み・設定（preference）
- 技術的な事実・知識（fact）
- 決定事項・方針（decision）
- 人物・組織の情報（entity）
- 教訓・反省（reflection）

各項目を以下のJSON形式で出力:
[
  {"text": "内容", "category": "カテゴリ", "importance": 0.0-1.0}
]

ルール:
- 各エントリは500文字以内
- 重複を避ける
- 一般的すぎる情報は除外
- 最大10件まで`;

/**
 * 抽出された学びを長期記憶に保存
 */
export async function storeReflections(
  items: ReflectionItem[],
  store: MemoryStore,
  embedder: Embedder,
  scopeManager: ScopeManager,
  agentId?: string,
): Promise<string[]> {
  const scope = scopeManager.resolve(agentId);
  const ids: string[] = [];

  for (const item of items) {
    if (item.text.trim().length < 5) continue;

    const vector = await embedder.embed(item.text);
    const id = await store.add({
      text: item.text,
      vector,
      category: item.category,
      scope,
      importance: Math.min(1, Math.max(0, item.importance)),
      metadata: JSON.stringify({ source: "reflection", agentId }),
    });
    ids.push(id);
  }

  return ids;
}

/**
 * リフレクションの JSON 出力をパース（堅牢に）
 */
export function parseReflectionOutput(output: string): ReflectionItem[] {
  // JSON配列を探す
  const jsonMatch = output.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item: any) =>
          typeof item.text === "string" &&
          typeof item.category === "string" &&
          typeof item.importance === "number" &&
          CATEGORIES.includes(item.category as MemoryCategory),
      )
      .map((item: any) => ({
        text: item.text.slice(0, 500),
        category: item.category as MemoryCategory,
        importance: Math.min(1, Math.max(0, item.importance)),
      }));
  } catch {
    return [];
  }
}

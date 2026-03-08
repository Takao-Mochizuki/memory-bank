/**
 * リフレクションモジュール
 * セッション終了時に会話から学びを抽出し、長期記憶として保存
 */

import { createHash } from "node:crypto";
import { CATEGORIES } from "./store.js";
import type { MemoryStore, MemoryCategory } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { ScopeManager } from "./scopes.js";

/** テキストの正規化ハッシュ（重複排除の一意キー） */
function textHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * 並行実行時の二重保存を防ぐインフライトセット
 * extractLessons の呼び出し間で共有される
 */
const inflightLessons = new Set<string>();

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
 * セッション要約用プロンプト
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
 * 教訓抽出用プロンプト
 * セッション要約とは異なり、再利用可能な教訓に特化
 */
export const LESSON_PROMPT = `以下の会話から、今後のセッションで再利用可能な「教訓」を抽出してください。

教訓の例:
- 「この API は rate limit が厳しいので、バッチ処理時は 1 秒間隔を空ける」
- 「ユーザーは日本語での回答を好む」
- 「このプロジェクトでは ESLint の --fix を手動で走らせる必要がある」

抽出しないもの:
- 一回限りの作業メモ（「ファイルXを修正した」など）
- 一般常識（「テストは大事」など）
- セッション要約（それは別途保存される）

各教訓を以下のJSON形式で出力:
[
  {"text": "教訓の内容", "category": "カテゴリ", "importance": 0.0-1.0}
]

カテゴリは以下のいずれか: preference, fact, decision, entity, reflection
importanceは再利用頻度の見込みに基づいて設定（高いほど頻繁に役立つ）

ルール:
- 各エントリは500文字以内
- 具体的かつ実行可能な内容にする
- 最大5件まで`;

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

/** 重複チェック時のコサイン類似度閾値 */
const DUPLICATE_THRESHOLD = 0.9;

/**
 * 2つの正規化済みベクトル間のコサイン類似度を計算
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 候補テキストが既存記憶と重複しているかを判定
 * store.search で近傍を取得し、コサイン類似度で判定する
 */
export async function isDuplicate(
  candidateVector: number[],
  store: MemoryStore,
  scope: string,
): Promise<boolean> {
  const neighbors = await store.search(candidateVector, scope, 3);
  for (const hit of neighbors) {
    const sim = cosineSimilarity(candidateVector, hit.entry.vector);
    if (sim >= DUPLICATE_THRESHOLD) return true;
  }
  return false;
}

/**
 * セッションメッセージから再利用可能な教訓を抽出し、重複チェック後に保存
 */
export async function extractLessons(
  items: ReflectionItem[],
  embedder: Embedder,
  store: MemoryStore,
  scope: string,
  agentId?: string,
): Promise<string[]> {
  const ids: string[] = [];

  for (const item of items) {
    if (item.text.trim().length < 5) continue;

    // TOCTOU 防止: テキストハッシュで並行実行時の二重保存を排除
    const hash = textHash(item.text);
    const lockKey = `${scope}:${hash}`;
    if (inflightLessons.has(lockKey)) continue;
    inflightLessons.add(lockKey);

    try {
      const vector = await embedder.embed(item.text);

      // 重複チェック: 類似度0.9以上の既存記憶があればスキップ
      const duplicate = await isDuplicate(vector, store, scope);
      if (duplicate) continue;

      const id = await store.add({
        text: item.text,
        vector,
        category: item.category,
        scope,
        importance: Math.min(1, Math.max(0, item.importance)),
        metadata: JSON.stringify({ source: "lesson", agentId, textHash: hash }),
      });
      ids.push(id);
    } finally {
      // 一定時間後にロック解除（メモリリーク防止）
      setTimeout(() => inflightLessons.delete(lockKey), 30_000);
    }
  }

  return ids;
}

/**
 * リフレクションの JSON 出力をパース（堅牢に）
 */
export function parseReflectionOutput(output: string): ReflectionItem[] {
  // 入力サイズ制限（ReDoS防止 + JSON.parse メモリ制限）
  const truncated = output.length > 50000 ? output.slice(0, 50000) : output;
  // JSON配列を探す
  const jsonMatch = truncated.match(/\[[\s\S]*?\]/);
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

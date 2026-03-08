/**
 * ハイブリッド検索エンジン
 * ベクトル検索 + BM25 を RRF（Reciprocal Rank Fusion）で統合
 * MMR による多様性制御、length normalization、Cross-Encoder リランキング
 */

import type { MemoryStore, SearchHit, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "none";
  rerankApiKey?: string;
  rerankModel: string;
  rerankEndpoint: string;
  candidatePoolSize: number;
  recencyBoostDays: number;
  recencyBoostMax: number;
  decayHalfLifeDays: number;
  /** MMR の多様性パラメータ (0=多様性最大, 1=関連性最大, デフォルト: 0.7) */
  mmrLambda: number;
  /** length normalization のアンカー文字数 (デフォルト: 300, 0で無効) */
  lengthNormAnchor: number;
}

export interface RetrievalResult {
  entry: MemoryEntry;
  score: number;
  sources: string[];
}

export const DEFAULT_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "none",
  rerankModel: "jina-reranker-v2-base-multilingual",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  candidatePoolSize: 20,
  recencyBoostDays: 14,
  recencyBoostMax: 0.1,
  decayHalfLifeDays: 60,
  mmrLambda: 0.7,
  lengthNormAnchor: 300,
};

/**
 * RRF（Reciprocal Rank Fusion）スコア計算
 * 複数の検索結果リストを統合するための標準手法
 */
function computeRRF(rankings: Map<string, number>[], weights: number[], k = 60): Map<string, number> {
  const fused = new Map<string, number>();

  for (let i = 0; i < rankings.length; i++) {
    const ranking = rankings[i];
    const weight = weights[i];
    for (const [id, rank] of ranking) {
      const current = fused.get(id) || 0;
      fused.set(id, current + weight / (k + rank));
    }
  }

  return fused;
}

/**
 * 近時ブースト — 新しい記憶ほどスコアが高い
 */
function recencyBoost(timestampMs: number, halfLifeDays: number, maxBoost: number): number {
  if (halfLifeDays <= 0 || maxBoost <= 0) return 0;
  const ageDays = (Date.now() - timestampMs) / 86_400_000;
  return maxBoost * Math.exp(-ageDays * (Math.LN2 / halfLifeDays));
}

/**
 * 時間減衰 — 古い記憶のスコアを徐々に下げる
 * フロア 0.5x（完全に忘れない）
 */
function timeDecay(timestampMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = (Date.now() - timestampMs) / 86_400_000;
  return 0.5 + 0.5 * Math.exp(-ageDays * (Math.LN2 / halfLifeDays));
}

/**
 * Length normalization — 長いテキストがキーワード密度でスコアを稼ぐのを抑制
 * anchor より短いテキストは微増、長いテキストは徐々にペナルティ
 * 式: 1 / (1 + log2(charLen / anchor))  (charLen > anchor のとき)
 */
export function lengthNorm(textLength: number, anchor: number): number {
  if (anchor <= 0) return 1;
  if (textLength <= anchor) {
    // 短いテキストには軽微なブースト (最大 1.1x)
    return 1 + 0.1 * (1 - textLength / anchor);
  }
  return 1 / (1 + Math.log2(textLength / anchor));
}

/**
 * コサイン類似度（正規化済みベクトル前提でなくても動く汎用版）
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
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * MMR（Maximal Marginal Relevance）— 多様性と関連性のバランス
 *
 * スコア順の候補リストから、類似した候補を間引いて多様性を確保する。
 * lambda=1 で純粋なスコア順（MMR無効相当）、lambda=0 で多様性最大。
 */
export function applyMMR(
  candidates: RetrievalResult[],
  limit: number,
  lambda: number,
): RetrievalResult[] {
  if (candidates.length <= 1 || lambda >= 1) return candidates.slice(0, limit);

  const selected: RetrievalResult[] = [];
  const remaining = [...candidates];

  // 最高スコアの候補は無条件で選択
  selected.push(remaining.shift()!);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevanceScore = candidate.score;

      // 既選択候補との最大類似度
      let maxSimilarity = 0;
      for (const sel of selected) {
        const sim = cosineSimilarity(candidate.entry.vector, sel.entry.vector);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }

      // MMR スコア = λ * relevance - (1-λ) * max_similarity
      const mmrScore = lambda * relevanceScore - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

/**
 * Cross-Encoder リランキング
 */
async function rerankWithCrossEncoder(
  query: string,
  candidates: RetrievalResult[],
  config: RetrievalConfig,
): Promise<RetrievalResult[]> {
  if (!config.rerankApiKey || candidates.length === 0) return candidates;

  const documents = candidates.map((c) => c.entry.text);

  const response = await fetch(config.rerankEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.rerankApiKey}`,
    },
    body: JSON.stringify({
      model: config.rerankModel,
      query,
      documents,
      top_n: candidates.length,
    }),
  });

  if (!response.ok) {
    return candidates;
  }

  const data = (await response.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };

  return data.results
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map((r) => ({
      ...candidates[r.index],
      score: r.relevance_score,
      sources: [...candidates[r.index].sources, "rerank"],
    }));
}

export interface MemoryRetriever {
  recall(query: string, scope: string, limit: number): Promise<RetrievalResult[]>;
}

/**
 * Retriever を生成
 */
export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  userConfig: Partial<RetrievalConfig> = {},
): MemoryRetriever {
  const config: RetrievalConfig = { ...DEFAULT_CONFIG, ...userConfig };

  return {
    async recall(query: string, scope: string, limit: number): Promise<RetrievalResult[]> {
      const poolSize = config.candidatePoolSize;

      // 1. ベクトル検索
      const queryVector = await embedder.embed(query);
      const vectorHits = await store.search(queryVector, scope, poolSize);

      // ベクトル結果のランキング
      const vectorRanking = new Map<string, number>();
      vectorHits.forEach((hit, i) => vectorRanking.set(hit.entry.id, i + 1));

      // エントリをIDで参照できるように
      const entryMap = new Map<string, MemoryEntry>();
      vectorHits.forEach((h) => entryMap.set(h.entry.id, h.entry));

      let fusedScores: Map<string, number>;

      if (config.mode === "hybrid") {
        // 2. BM25 フルテキスト検索
        const textHits = await store.searchFullText(query, scope, poolSize);
        textHits.forEach((h) => entryMap.set(h.entry.id, h.entry));

        const bm25Ranking = new Map<string, number>();
        textHits.forEach((hit, i) => bm25Ranking.set(hit.entry.id, i + 1));

        // 3. RRF 融合
        fusedScores = computeRRF(
          [vectorRanking, bm25Ranking],
          [config.vectorWeight, config.bm25Weight],
        );
      } else {
        // ベクトルのみ
        fusedScores = new Map<string, number>();
        for (const [id, rank] of vectorRanking) {
          fusedScores.set(id, 1 / (60 + rank));
        }
      }

      // 4. スコアリングパイプライン
      let results: RetrievalResult[] = [];

      for (const [id, rawScore] of fusedScores) {
        const entry = entryMap.get(id);
        if (!entry) continue;

        // 時間減衰
        const decay = timeDecay(entry.timestamp, config.decayHalfLifeDays);
        // 近時ブースト
        const boost = recencyBoost(entry.timestamp, config.recencyBoostDays, config.recencyBoostMax);
        // 重要度ボーナス
        const importanceBonus = (entry.importance - 0.5) * 0.05;
        // Length normalization
        const lenNorm = lengthNorm(entry.text.length, config.lengthNormAnchor);

        const finalScore = rawScore * decay * lenNorm + boost + importanceBonus;

        if (finalScore >= config.minScore) {
          const sources: string[] = [];
          if (vectorRanking.has(id)) sources.push("vector");
          if (config.mode === "hybrid") sources.push("bm25");

          results.push({ entry, score: finalScore, sources });
        }
      }

      // 5. スコア降順ソート
      results.sort((a, b) => b.score - a.score);

      // 6. オプション: Cross-Encoder リランキング
      if (config.rerank === "cross-encoder" && config.rerankApiKey) {
        results = await rerankWithCrossEncoder(query, results.slice(0, poolSize), config);
      }

      // 7. MMR — 多様性制御（リランキング後に適用）
      if (config.mmrLambda < 1) {
        results = applyMMR(results, limit, config.mmrLambda);
      } else {
        results = results.slice(0, limit);
      }

      return results;
    },
  };
}

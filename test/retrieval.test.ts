import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lengthNorm, cosineSimilarity, applyMMR } from "../src/retriever.ts";
import type { RetrievalResult } from "../src/retriever.ts";
import type { MemoryEntry } from "../src/store.ts";

// テスト用ヘルパー: ダミーの RetrievalResult を生成
function makeResult(
  id: string,
  score: number,
  textLength: number,
  vector: number[],
): RetrievalResult {
  const entry: MemoryEntry = {
    id,
    text: "x".repeat(textLength),
    vector,
    category: "fact",
    scope: "global",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
  };
  return { entry, score, sources: ["vector"] };
}

// ========================================================================
// Length Normalization
// ========================================================================
describe("lengthNorm", () => {
  it("アンカーより短いテキストに微増ブースト", () => {
    const norm = lengthNorm(100, 300);
    assert.ok(norm > 1, `expected > 1, got ${norm}`);
    assert.ok(norm <= 1.1, `expected <= 1.1, got ${norm}`);
  });

  it("アンカーと同じ長さで 1.0", () => {
    const norm = lengthNorm(300, 300);
    assert.equal(norm, 1);
  });

  it("アンカーの2倍で < 1", () => {
    const norm = lengthNorm(600, 300);
    assert.ok(norm < 1, `expected < 1, got ${norm}`);
    // 1 / (1 + log2(2)) = 1/2 = 0.5
    assert.ok(Math.abs(norm - 0.5) < 0.001, `expected ~0.5, got ${norm}`);
  });

  it("アンカーの4倍でさらに低下", () => {
    const norm600 = lengthNorm(600, 300);
    const norm1200 = lengthNorm(1200, 300);
    assert.ok(norm1200 < norm600, `1200 should score lower than 600`);
  });

  it("anchor=0 で無効（常に1.0）", () => {
    assert.equal(lengthNorm(100, 0), 1);
    assert.equal(lengthNorm(10000, 0), 1);
  });

  it("textLength=0 で最大ブースト", () => {
    const norm = lengthNorm(0, 300);
    assert.ok(Math.abs(norm - 1.1) < 0.001, `expected ~1.1, got ${norm}`);
  });
});

// ========================================================================
// Cosine Similarity
// ========================================================================
describe("cosineSimilarity", () => {
  it("同一ベクトルで 1.0", () => {
    const v = [1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 0.0001);
  });

  it("直交ベクトルで 0.0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 0.0001);
  });

  it("反対方向で -1.0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 0.0001);
  });

  it("空ベクトルで 0", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("長さ不一致で 0", () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });
});

// ========================================================================
// MMR (Maximal Marginal Relevance)
// ========================================================================
describe("applyMMR", () => {
  it("lambda=1 でスコア順そのまま（MMR無効）", () => {
    const candidates = [
      makeResult("a", 0.9, 100, [1, 0, 0]),
      makeResult("b", 0.8, 100, [1, 0, 0]),  // a と同一ベクトル
      makeResult("c", 0.7, 100, [0, 1, 0]),
    ];
    const result = applyMMR(candidates, 3, 1.0);
    assert.equal(result.length, 3);
    assert.equal(result[0].entry.id, "a");
    assert.equal(result[1].entry.id, "b");
    assert.equal(result[2].entry.id, "c");
  });

  it("lambda < 1 で類似候補を間引いて多様性確保", () => {
    const candidates = [
      makeResult("a", 0.9, 100, [1, 0, 0]),
      makeResult("b", 0.85, 100, [0.99, 0.01, 0]),  // a とほぼ同一
      makeResult("c", 0.7, 100, [0, 1, 0]),           // a と直交（多様）
    ];
    const result = applyMMR(candidates, 2, 0.5);
    assert.equal(result.length, 2);
    assert.equal(result[0].entry.id, "a");
    // 2番目は c（多様なほう）が b（類似したほう）より優先されるべき
    assert.equal(result[1].entry.id, "c");
  });

  it("候補が1件以下ならそのまま返す", () => {
    const single = [makeResult("a", 0.9, 100, [1, 0])];
    assert.equal(applyMMR(single, 5, 0.5).length, 1);
    assert.equal(applyMMR([], 5, 0.5).length, 0);
  });

  it("limit で件数を制限", () => {
    const candidates = [
      makeResult("a", 0.9, 100, [1, 0]),
      makeResult("b", 0.8, 100, [0, 1]),
      makeResult("c", 0.7, 100, [1, 1]),
    ];
    const result = applyMMR(candidates, 2, 0.7);
    assert.equal(result.length, 2);
  });

  it("最高スコアの候補は常に最初に選択される", () => {
    const candidates = [
      makeResult("top", 0.95, 100, [1, 0, 0]),
      makeResult("diverse", 0.5, 100, [0, 1, 0]),
    ];
    const result = applyMMR(candidates, 2, 0.1); // 多様性重視でもトップは変わらない
    assert.equal(result[0].entry.id, "top");
  });
});

// ========================================================================
// 統合テスト: lengthNorm がスコアに与える影響
// ========================================================================
describe("lengthNorm integration", () => {
  it("同一スコアなら短いテキストが長いテキストより上位", () => {
    const anchor = 300;
    const shortNorm = lengthNorm(100, anchor);
    const longNorm = lengthNorm(1000, anchor);
    assert.ok(shortNorm > longNorm, `short(${shortNorm}) should > long(${longNorm})`);
  });

  it("reduction は緩やか（極端に罰しない）", () => {
    // アンカーの10倍でも 0.2 以上はある
    const norm = lengthNorm(3000, 300);
    assert.ok(norm > 0.2, `expected > 0.2, got ${norm}`);
  });
});

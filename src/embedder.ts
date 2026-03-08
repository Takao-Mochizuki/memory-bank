/**
 * 埋め込みベクトル生成モジュール
 * OpenAI互換APIを使用して任意のプロバイダーに対応
 * Task-Aware Embeddings: 保存用と検索用で前処理を分離
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

/**
 * ホスト名が localhost 系かどうかを判定
 */
function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * IP アドレスがプライベート/予約済みかどうか判定
 */
function isPrivateIP(ip: string): boolean {
  const patterns = [
    /^169\.254\./,                      // リンクローカル（AWS/GCP メタデータ）
    /^10\./,                            // RFC1918
    /^172\.(1[6-9]|2\d|3[01])\./,      // RFC1918
    /^192\.168\./,                      // RFC1918
    /^127\./,                           // loopback 全域
    /^0\./,                             // 0.0.0.0/8
    /^::1$/,                            // IPv6 loopback
    /^fe80:/i,                          // IPv6 リンクローカル
    /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/i,  // IPv6-mapped private IPv4
    /^fc00:/i,                          // IPv6 ユニークローカル
    /^fd/i,                             // IPv6 ユニークローカル
  ];
  return patterns.some((p) => p.test(ip));
}

/**
 * SSRF防止: URL の同期バリデーション（ホスト名文字列チェック）
 *
 * 戦略:
 * - localhost は Ollama 等ローカル用途で許可
 * - 既知の wildcard DNS サービスをブロック
 * - IP リテラルがプライベートならブロック
 * - スキーマ制限: http/https のみ
 */
export function validateEndpointURL(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`memory-bank: ${label} の URL が不正です: ${url}`);
  }

  // スキーマ制限
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`memory-bank: ${label} は http/https のみ許可されています: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // localhost は許可（Ollama等のローカルサービス用）
  if (isLocalhost(hostname)) return;

  // Wildcard DNS サービスをブロック（DNS rebinding 対策）
  const wildcardDnsPatterns = [
    /\.nip\.io$/, /\.sslip\.io$/, /\.xip\.io$/,
    /\.lvh\.me$/, /\.localtest\.me$/, /\.vcap\.me$/,
  ];
  for (const pattern of wildcardDnsPatterns) {
    if (pattern.test(hostname)) {
      throw new Error(`memory-bank: ${label} に wildcard DNS サービスは指定できません: ${hostname}`);
    }
  }

  // IP リテラルがプライベートならブロック
  if (isPrivateIP(hostname) || isPrivateIP(hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error(`memory-bank: ${label} にプライベートアドレスは指定できません: ${hostname}`);
  }

  // クラウドメタデータ
  if (/^metadata\.google\.internal$/i.test(hostname)) {
    throw new Error(`memory-bank: ${label} にメタデータエンドポイントは指定できません: ${hostname}`);
  }
}

/**
 * SSRF防止: DNS 解決後の実 IP アドレスを検証（非同期）
 * 攻撃者管理ドメインが private IP に解決されるケースを防ぐ
 */
export async function validateEndpointDNS(url: string, label: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // localhost は許可済み
  if (isLocalhost(hostname)) return;

  // IP リテラルは同期チェック済み
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) return;

  // DNS 解決して全 A/AAAA レコードを検証
  const addresses = await lookup(hostname, { all: true });
  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new Error(
        `memory-bank: ${label} のホスト "${hostname}" がプライベート IP (${addr.address}) に解決されました。SSRF 防止のためブロックします。`,
      );
    }
  }
}

// ベクトル次元数のルックアップテーブル
const KNOWN_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "gemini-embedding-001": 768,
};

/** embedding の用途 */
export type EmbedTask = "store" | "query";

/**
 * task-aware prefix テーブル
 * 一部のモデル（nomic, mxbai等）は prefix でタスク種別を切り替える
 */
const TASK_PREFIXES: Record<string, Record<EmbedTask, string>> = {
  "nomic-embed-text": {
    store: "search_document: ",
    query: "search_query: ",
  },
  "mxbai-embed-large": {
    store: "",
    query: "Represent this sentence for searching relevant passages: ",
  },
};

export interface EmbedderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;
  /** task-aware embeddings を有効化 (デフォルト: true) */
  taskAware?: boolean;
}

export interface Embedder {
  embed(text: string, task?: EmbedTask): Promise<number[]>;
  embedBatch(texts: string[], task?: EmbedTask): Promise<number[][]>;
  readonly dimensions: number;
  readonly taskAwareEnabled: boolean;
}

/**
 * LRUキャッシュ — 同一テキスト+タスクの再埋め込みを防止
 */
class VectorCache {
  private entries = new Map<string, { vector: number[]; at: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 512, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private hash(text: string, task?: EmbedTask): string {
    const input = task ? `${task}:${text}` : text;
    return createHash("sha256").update(input).digest("hex").slice(0, 20);
  }

  get(text: string, task?: EmbedTask): number[] | undefined {
    const key = this.hash(text, task);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: 再挿入で最新に
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.vector;
  }

  set(text: string, task: EmbedTask | undefined, vector: number[]): void {
    const key = this.hash(text, task);
    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { vector, at: Date.now() });
  }
}

/**
 * テキストに task prefix を付与
 */
export function applyTaskPrefix(text: string, model: string, task: EmbedTask, enabled: boolean): string {
  if (!enabled) return text;
  const prefixes = TASK_PREFIXES[model];
  if (!prefixes) return text;
  const prefix = prefixes[task];
  return prefix ? prefix + text : text;
}

/**
 * Embedder を生成
 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  const baseURL = config.baseURL || "https://api.openai.com/v1";
  // SSRF防止: プライベートネットワークへのリクエストをブロック（localhost は Ollama 用に許可）
  validateEndpointURL(baseURL, "embedding.baseURL");

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
  });

  const model = config.model || "text-embedding-3-small";
  const dimensions = config.dimensions || KNOWN_DIMENSIONS[model] || 1536;
  const cache = new VectorCache();
  const taskAwareEnabled = config.taskAware !== false; // デフォルト true

  // DNS 解決ベースの SSRF 検証（毎回実行 — DNS rebinding 対策）
  async function callApi(texts: string[]): Promise<number[][]> {
    await validateEndpointDNS(baseURL, "embedding.baseURL");
    const response = await client.embeddings.create({
      model,
      input: texts,
    });
    // APIレスポンスをインデックス順にソート
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  }

  return {
    get dimensions() {
      return dimensions;
    },

    get taskAwareEnabled() {
      return taskAwareEnabled;
    },

    async embed(text: string, task?: EmbedTask): Promise<number[]> {
      const cached = cache.get(text, task);
      if (cached) return cached;

      const processed = applyTaskPrefix(text, model, task || "query", taskAwareEnabled);
      const [vector] = await callApi([processed]);
      cache.set(text, task, vector);
      return vector;
    },

    async embedBatch(texts: string[], task?: EmbedTask): Promise<number[][]> {
      const results: (number[] | null)[] = texts.map((t) => cache.get(t, task) || null);
      const uncached: { index: number; text: string }[] = [];

      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) uncached.push({ index: i, text: texts[i] });
      }

      if (uncached.length > 0) {
        const processed = uncached.map((u) =>
          applyTaskPrefix(u.text, model, task || "query", taskAwareEnabled),
        );
        const vectors = await callApi(processed);
        for (let j = 0; j < uncached.length; j++) {
          results[uncached[j].index] = vectors[j];
          cache.set(uncached[j].text, task, vectors[j]);
        }
      }

      return results as number[][];
    },
  };
}

/**
 * モデル名からベクトル次元数を推定
 */
export function inferDimensions(model: string): number {
  return KNOWN_DIMENSIONS[model] || 1536;
}

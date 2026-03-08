/**
 * Memory Bank — OpenClaw 長期記憶プラグイン
 *
 * ハイブリッド検索（Vector + BM25）、スコープ分離、
 * 時間減衰、リフレクション機能を備えた長期記憶システム
 *
 * 重要: OpenClaw は async な activate を無視するため、
 * フック・ツール登録は同期的に行い、非同期初期化は内部で遅延実行する。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import { realpathSync, existsSync } from "node:fs";

import { createEmbedder } from "./src/embedder.js";
import { createStore } from "./src/store.js";
import { createRetriever } from "./src/retriever.js";
import { createScopeManager } from "./src/scopes.js";
import { registerCoreTools, registerManagementTools } from "./src/tools.js";
import { DEFAULT_REFLECTION_CONFIG, extractLessons, parseReflectionOutput } from "./src/reflection.js";
import { isNoise } from "./src/noise-filter.js";
import type { MemoryStore } from "./src/store.js";
import type { Embedder } from "./src/embedder.js";
import type { MemoryRetriever } from "./src/retriever.js";
import type { ScopeManager } from "./src/scopes.js";

// プラグイン設定の型
interface PluginConfig {
  embedding: {
    apiKey: string;
    model?: string;
    baseURL?: string;
    dimensions?: number;
    taskAware?: boolean;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallCategories?: string[];
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    minScore?: number;
    rerank?: "cross-encoder" | "none";
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    candidatePoolSize?: number;
    recencyBoostDays?: number;
    recencyBoostMax?: number;
    decayHalfLifeDays?: number;
    mmrLambda?: number;
    lengthNormAnchor?: number;
    adaptive?: boolean;
  };
  reflection?: {
    enabled?: boolean;
    maxMessages?: number;
    timeoutMs?: number;
  };
  scopes?: {
    defaultScope?: string;
    definitions?: Record<string, { description?: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
}

/**
 * dbPath のチルダ展開 + パストラバーサル防止
 */
function expandPath(p: string): string {
  let expanded: string;
  if (p.startsWith("~/") || p === "~") {
    expanded = join(homedir(), p.slice(2));
  } else {
    expanded = p;
  }
  // 正規化してトラバーサルを解決
  const resolved = resolve(expanded);
  const home = homedir();

  // 論理パスの検証（relative で判定）
  const rel = relative(home, resolved);
  if (rel.startsWith("..") || resolve(home, rel) !== resolved) {
    throw new Error(`memory-bank: dbPath はホームディレクトリ配下のみ指定可能です: ${resolved}`);
  }

  // symlink 対策: 既存パスの実体パスがホーム配下か検証
  // 親ディレクトリを遡って存在する最深のパスを realpath で検証
  let checkPath = resolved;
  while (!existsSync(checkPath)) {
    const parent = resolve(checkPath, "..");
    if (parent === checkPath) break; // ルートに到達
    checkPath = parent;
  }
  if (existsSync(checkPath)) {
    const realHome = realpathSync(home);
    const realCheck = realpathSync(checkPath);
    const realRel = relative(realHome, realCheck);
    if (realRel.startsWith("..") || resolve(realHome, realRel) !== realCheck) {
      throw new Error(`memory-bank: dbPath の実体パスがホームディレクトリ外を指しています: ${realCheck}`);
    }
  }

  return resolved;
}

/**
 * 非同期初期化の結果を保持するコンテナ
 * フック内で await initPromise して使う
 */
interface PluginDeps {
  store: MemoryStore;
  embedder: Embedder;
  retriever: MemoryRetriever;
  scopeManager: ScopeManager;
}

/**
 * プラグイン activate（同期）
 * OpenClaw がプラグイン読み込み時に呼び出す
 *
 * OpenClaw は async activate の戻り値を無視するため、
 * ツール・フック登録はすべて同期的に行い、
 * 非同期初期化（LanceDB接続等）は initPromise として遅延実行する。
 */
export default function activate(api: OpenClawPluginApi, _config?: PluginConfig) {
  const config: PluginConfig = _config || (api as any).pluginConfig;
  if (!config?.embedding) {
    throw new Error("memory-bank: embedding config is required. Check plugins.entries.memory-bank.config in openclaw.json");
  }

  // Embedder は同期で作れる（API呼び出しはしない）
  const embedder = createEmbedder({
    apiKey: config.embedding.apiKey,
    model: config.embedding.model || "text-embedding-3-small",
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
  });

  const scopeManager = createScopeManager(config.scopes);

  // 非同期初期化（Store → Retriever）を Promise として保持
  const initPromise: Promise<PluginDeps> = (async () => {
    const dbPath = expandPath(config.dbPath || "~/.openclaw/memory/memory-bank");
    const store = await createStore(dbPath, embedder.dimensions);
    const retriever = createRetriever(store, embedder, config.retrieval);
    return { store, embedder, retriever, scopeManager };
  })();

  // 初期化エラーをログに出す（APIキー等を含む可能性があるため message のみ）
  initPromise.catch((err) => {
    console.error("[memory-bank] initialization failed:", err instanceof Error ? err.message : String(err));
  });

  // ツール登録 — ツールファクトリ内で initPromise を await する
  registerCoreTools(api, { initPromise, embedder, scopeManager });

  if (config.enableManagementTools) {
    registerManagementTools(api, { initPromise, embedder, scopeManager });
  }

  // 自動想起 — before_agent_start フック（同期登録、内部で await）
  if (config.autoRecall) {
    const minLength = config.autoRecallMinLength ?? 10;
    const allowedCategories = new Set(
      config.autoRecallCategories || ["fact", "lesson", "preference", "decision", "entity", "other"],
    );

    /** autoRecall のクエリ最大文字数（API コスト / DoS 防止） */
    const maxRecallQueryLength = 1000;

    api.on("before_agent_start", async (event: any, ctx: any) => {
      const rawPrompt = event?.prompt || "";
      if (typeof rawPrompt !== "string" || rawPrompt.trim().length < minLength) return;

      // 入力長制限: 巨大プロンプトをそのまま embed しない
      const prompt = rawPrompt.length > maxRecallQueryLength
        ? rawPrompt.slice(0, maxRecallQueryLength)
        : rawPrompt;

      try {
        const { retriever, scopeManager: sm } = await initPromise;
        const agentId = ctx?.agentId;
        const scope = sm.resolve(agentId);

        const poolSize = Math.max(10, allowedCategories.size < 6 ? 15 : 5);
        const results = await retriever.recall(prompt, scope, poolSize);
        const filtered = results.filter((r) => allowedCategories.has(r.entry.category));
        const top = filtered.slice(0, 5);

        if (top.length > 0) {
          const memories = top
            .map((r) => `- [${r.entry.category}] ${r.entry.text}`)
            .join("\n");

          return {
            prependContext: `\n\n## 関連する長期記憶（Memory Bank）\n${memories}\n`,
          };
        }
      } catch (err) {
        // 自動想起の失敗はサイレントに
      }
    });
  }

  // 自動キャプチャ — agent_end フック（同期登録、内部で await）
  if (config.autoCapture) {
    api.on("agent_end", async (event: any, ctx: any) => {
      try {
        const { store, embedder: emb, scopeManager: sm } = await initPromise;
        const messages = event?.messages || [];
        const agentId = ctx?.agentId;

        for (const msg of messages) {
          if (msg.role !== "user") continue;
          const text = typeof msg.content === "string" ? msg.content : "";
          if (text.length < 10 || isNoise(text)) continue;

          const scope = sm.resolve(agentId);
          const truncated = text.slice(0, 500);
          const vector = await emb.embed(truncated, "store");
          await store.add({
            text: truncated,
            vector,
            category: "other",
            scope,
            importance: 0.5,
            metadata: JSON.stringify({ source: "auto-capture", agentId }),
          });
        }
      } catch {
        // 自動キャプチャの失敗はサイレント
      }
    });
  }

  // リフレクション — agent_end フック（同期登録、内部で await）
  // reflection config — 既知キーのみマージ（プロトタイプ汚染防止）
  const userReflection = config.reflection || {};
  const reflectionConfig: typeof DEFAULT_REFLECTION_CONFIG = {
    enabled: typeof userReflection.enabled === "boolean" ? userReflection.enabled : DEFAULT_REFLECTION_CONFIG.enabled,
    maxMessages: typeof userReflection.maxMessages === "number" ? userReflection.maxMessages : DEFAULT_REFLECTION_CONFIG.maxMessages,
    timeoutMs: typeof userReflection.timeoutMs === "number" ? userReflection.timeoutMs : DEFAULT_REFLECTION_CONFIG.timeoutMs,
  };

  if (reflectionConfig.enabled) {
    api.on("agent_end", async (event: any, ctx: any) => {
      try {
        const { store, embedder: emb, scopeManager: sm } = await initPromise;
        const messages = event?.messages || [];
        if (messages.length < 3) return;

        const agentId = ctx?.agentId;
        const lastMessages = messages.slice(-reflectionConfig.maxMessages);

        const targetRoles = config.autoCapture
          ? ["assistant"]
          : ["user", "assistant"];
        const conversationSummary = lastMessages
          .filter((m: any) => targetRoles.includes(m.role))
          .map((m: any) => {
            const raw = m.content;
            let text: string;
            if (typeof raw === "string") {
              text = raw;
            } else if (Array.isArray(raw)) {
              text = raw
                .map((b: any) => {
                  if (typeof b === "string") return b;
                  if (b?.type === "text") return b.text || "";
                  if (b?.type === "tool_use") return `toolCall:${b.name || "unknown"}`;
                  if (b?.type === "tool_result") return `toolResult:${typeof b.content === "string" ? b.content.slice(0, 50) : ""}`;
                  if (b?.type === "thinking") return "thinking";
                  if (b?.type === "image" || b?.type === "image_url") return "[image]";
                  if (b?.text) return b.text;
                  return b?.type || "";
                })
                .filter(Boolean)
                .join(" ");
            } else if (raw && typeof raw === "object") {
              // 単一オブジェクト（非配列）
              text = raw.text || raw.type || JSON.stringify(raw).slice(0, 200);
            } else {
              text = String(raw ?? "");
            }
            return `${m.role}: ${text.slice(0, 200)}`;
          })
          .join("\n");

        if (conversationSummary.length > 50) {
          const scope = sm.resolve(agentId);
          const vector = await emb.embed(conversationSummary.slice(0, 1000), "store");
          await store.add({
            text: `[Session Summary] ${conversationSummary.slice(0, 500)}`,
            vector,
            category: "reflection",
            scope,
            importance: 0.6,
            metadata: JSON.stringify({
              source: "session-reflection",
              agentId,
              messageCount: messages.length,
            }),
          });

          const lastAssistantMsg = lastMessages
            .filter((m: any) => m.role === "assistant")
            .pop();
          const assistantText = lastAssistantMsg
            ? String(lastAssistantMsg.content || "")
            : "";
          if (assistantText.length > 0) {
            const lessonCandidates = parseReflectionOutput(assistantText);
            if (lessonCandidates.length > 0) {
              await extractLessons(lessonCandidates, emb, store, scope, agentId);
            }
          }
        }
      } catch (e) {
        console.warn("[memory-bank] Reflection failed:", e instanceof Error ? e.message : String(e));
      }
    });
  }
}

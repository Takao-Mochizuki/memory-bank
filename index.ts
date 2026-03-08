/**
 * Memory Bank — OpenClaw 長期記憶プラグイン
 *
 * ハイブリッド検索（Vector + BM25）、スコープ分離、
 * 時間減衰、リフレクション機能を備えた長期記憶システム
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";

import { createEmbedder } from "./src/embedder.js";
import { createStore } from "./src/store.js";
import { createRetriever } from "./src/retriever.js";
import { createScopeManager } from "./src/scopes.js";
import { registerCoreTools, registerManagementTools } from "./src/tools.js";
import { DEFAULT_REFLECTION_CONFIG } from "./src/reflection.js";
import { isNoise } from "./src/noise-filter.js";

// プラグイン設定の型
interface PluginConfig {
  embedding: {
    apiKey: string;
    model?: string;
    baseURL?: string;
    dimensions?: number;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  autoRecallMinLength?: number;
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
  };
  reflection?: {
    enabled?: boolean;
    maxMessages?: number;
    timeoutMs?: number;
  };
  scopes?: {
    defaultScope?: string;
    definitions?: Record<string, { description?: string }>;
  };
  enableManagementTools?: boolean;
}

/**
 * dbPath のチルダ展開
 */
function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * プラグイン activate
 * OpenClaw がプラグイン読み込み時に呼び出す
 */
export default async function activate(api: OpenClawPluginApi, config: PluginConfig) {
  // 1. Embedder 初期化
  const embedder = createEmbedder({
    apiKey: config.embedding.apiKey,
    model: config.embedding.model || "text-embedding-3-small",
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
  });

  // 2. Store 初期化
  const dbPath = expandPath(config.dbPath || "~/.openclaw/memory/memory-bank");
  const store = await createStore(dbPath, embedder.dimensions);

  // 3. Scope Manager
  const scopeManager = createScopeManager(config.scopes);

  // 4. Retriever
  const retriever = createRetriever(store, embedder, config.retrieval);

  // 5. ツール登録
  const deps = { store, retriever, embedder, scopeManager };
  registerCoreTools(api, deps);

  if (config.enableManagementTools) {
    registerManagementTools(api, deps);
  }

  // 6. 自動想起 — ユーザーメッセージ受信時に関連記憶を注入
  if (config.autoRecall) {
    const minLength = config.autoRecallMinLength ?? 10;

    api.on("before_agent_start", async (context: any) => {
      const prompt = context?.prompt || context?.message?.text || "";
      if (typeof prompt !== "string" || prompt.trim().length < minLength) return;

      const agentId = context?.agentId;
      const scope = scopeManager.resolve(agentId);

      try {
        const results = await retriever.recall(prompt, scope, 5);
        if (results.length > 0) {
          const memories = results
            .map((r) => `- [${r.entry.category}] ${r.entry.text}`)
            .join("\n");

          context.systemMessage = [
            context.systemMessage || "",
            "\n\n## 関連する長期記憶\n",
            memories,
          ].join("");
        }
      } catch (err) {
        // 自動想起の失敗はサイレントに — エージェントの動作を止めない
      }
    });
  }

  // 7. 自動キャプチャ — エージェント終了時にユーザー発言を記憶
  if (config.autoCapture) {
    api.on("agent_end", async (context: any) => {
      const messages = context?.messages || [];
      const agentId = context?.agentId;

      for (const msg of messages) {
        if (msg.role !== "user") continue;
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text.length < 10 || isNoise(text)) continue;

        const scope = scopeManager.resolve(agentId);
        try {
          const vector = await embedder.embed(text);
          await store.add({
            text: text.slice(0, 500),
            vector,
            category: "other",
            scope,
            importance: 0.5,
            metadata: JSON.stringify({ source: "auto-capture", agentId }),
          });
        } catch {
          // 自動キャプチャの失敗はサイレント
        }
      }
    });
  }

  // 8. リフレクション — セッション終了時に学びを抽出
  const reflectionConfig = {
    ...DEFAULT_REFLECTION_CONFIG,
    ...(config.reflection || {}),
  };

  if (reflectionConfig.enabled) {
    api.on("agent_end", async (context: any) => {
      const messages = context?.messages || [];
      if (messages.length < 3) return; // 短すぎるセッションはスキップ

      const agentId = context?.agentId;

      try {
        const lastMessages = messages.slice(-reflectionConfig.maxMessages);
        // autoCapture 有効時はアシスタント発言のみでサマリー生成（二重保存防止）
        const targetRoles = config.autoCapture
          ? ["assistant"]
          : ["user", "assistant"];
        const conversationSummary = lastMessages
          .filter((m: any) => targetRoles.includes(m.role))
          .map((m: any) => `${m.role}: ${String(m.content || "").slice(0, 200)}`)
          .join("\n");

        if (conversationSummary.length > 50) {
          const scope = scopeManager.resolve(agentId);
          const vector = await embedder.embed(conversationSummary.slice(0, 1000));
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
        }
      } catch (e) {
        console.warn("[memory-bank] Reflection failed:", e);
      }
    });
  }
}

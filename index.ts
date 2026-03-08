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
import { DEFAULT_REFLECTION_CONFIG, extractLessons, parseReflectionOutput } from "./src/reflection.js";
import { isNoise } from "./src/noise-filter.js";

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
export default async function activate(api: OpenClawPluginApi, _config?: PluginConfig) {
  const config: PluginConfig = _config || (api as any).pluginConfig;
  if (!config?.embedding) {
    throw new Error("memory-bank: embedding config is required. Check plugins.entries.memory-bank.config in openclaw.json");
  }
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
    // reflection はセッション内部記録なので autoRecall から除外（デフォルト）
    const allowedCategories = new Set(
      config.autoRecallCategories || ["fact", "lesson", "preference", "decision", "entity", "other"],
    );

    api.on("before_agent_start", async (event: any, ctx: any) => {
      const prompt = event?.prompt || "";
      if (typeof prompt !== "string" || prompt.trim().length < minLength) return;

      const agentId = ctx?.agentId;
      const scope = scopeManager.resolve(agentId);

      try {
        // 多めに取得してカテゴリフィルタ後に上位5件
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
        // 自動想起の失敗はサイレントに — エージェントの動作を止めない
      }
    });
  }

  // 7. 自動キャプチャ — エージェント終了時にユーザー発言を記憶
  if (config.autoCapture) {
    api.on("agent_end", async (event: any, ctx: any) => {
      const messages = event?.messages || [];
      const agentId = ctx?.agentId;

      for (const msg of messages) {
        if (msg.role !== "user") continue;
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text.length < 10 || isNoise(text)) continue;

        const scope = scopeManager.resolve(agentId);
        try {
          const vector = await embedder.embed(text, "store");
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
    api.on("agent_end", async (event: any, ctx: any) => {
      const messages = event?.messages || [];
      if (messages.length < 3) return; // 短すぎるセッションはスキップ

      const agentId = ctx?.agentId;

      try {
        const lastMessages = messages.slice(-reflectionConfig.maxMessages);
        // autoCapture 有効時はアシスタント発言のみでサマリー生成（二重保存防止）
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
              // content blocks 配列 — text 部分だけ結合
              text = raw
                .map((b: any) => (typeof b === "string" ? b : b?.text || b?.type || ""))
                .filter(Boolean)
                .join(" ");
            } else {
              text = JSON.stringify(raw ?? "");
            }
            return `${m.role}: ${text.slice(0, 200)}`;
          })
          .join("\n");

        if (conversationSummary.length > 50) {
          const scope = scopeManager.resolve(agentId);
          const vector = await embedder.embed(conversationSummary.slice(0, 1000), "store");
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

          // 教訓抽出: セッション要約テキストから parseReflectionOutput で候補を取得し、重複チェック付きで保存
          // 注: 実際の LLM 呼び出しは agent_end コンテキストで行えないため、
          // conversationSummary をそのまま parseReflectionOutput に渡す
          // （LLM が LESSON_PROMPT に従って出力した JSON がメッセージ内にある場合に抽出される）
          const lastAssistantMsg = lastMessages
            .filter((m: any) => m.role === "assistant")
            .pop();
          const assistantText = lastAssistantMsg
            ? String(lastAssistantMsg.content || "")
            : "";
          if (assistantText.length > 0) {
            const lessonCandidates = parseReflectionOutput(assistantText);
            if (lessonCandidates.length > 0) {
              await extractLessons(lessonCandidates, embedder, store, scope, agentId);
            }
          }
        }
      } catch (e) {
        console.warn("[memory-bank] Reflection failed:", e);
      }
    });
  }
}

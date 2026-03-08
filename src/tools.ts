/**
 * エージェントツール登録
 * OpenClaw の registerTool API を通じて LLM に公開するメモリ操作ツール
 *
 * initPromise パターン: activate が同期のため、
 * ツールの execute 内で await initPromise してから deps を使う
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryStore, MemoryCategory } from "./store.js";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { Embedder } from "./embedder.js";
import type { ScopeManager } from "./scopes.js";
import { isNoise } from "./noise-filter.js";
import { CATEGORIES } from "./store.js";

interface ToolDeps {
  store: MemoryStore;
  retriever: MemoryRetriever;
  embedder: Embedder;
  scopeManager: ScopeManager;
  agentId?: string;
}

interface LazyToolDeps {
  initPromise: Promise<{ store: MemoryStore; retriever: MemoryRetriever; embedder: Embedder; scopeManager: ScopeManager }>;
  embedder: Embedder;
  scopeManager: ScopeManager;
}

/**
 * OpenClaw registerTool の execute 戻り値形式に変換
 */
function toolResult(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function clampNumber(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

/** ツール入力テキストの最大文字数（API コスト / メモリ DoS 防止） */
const MAX_TEXT_LENGTH = 5000;
/** 検索クエリの最大文字数 */
const MAX_QUERY_LENGTH = 1000;

function formatResults(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: Math.round(r.score * 1000) / 1000,
    sources: r.sources,
  }));
}

/**
 * 基本メモリツールを登録
 */
export function registerCoreTools(api: OpenClawPluginApi, lazyDeps: ToolDeps | LazyToolDeps): void {
  // initPromise があれば遅延パターン、なければ直接参照
  const getDeps = "initPromise" in lazyDeps
    ? async (ctx?: any) => {
        const resolved = await (lazyDeps as LazyToolDeps).initPromise;
        return { ...resolved, agentId: ctx?.agentId } as ToolDeps;
      }
    : async (ctx?: any) => ({ ...(lazyDeps as ToolDeps), agentId: ctx?.agentId || (lazyDeps as ToolDeps).agentId });

  // memory_store — 記憶を保存
  api.registerTool({
    name: "memory_store",
    description:
      "重要な情報を長期記憶に保存する。ユーザーの好み、技術的事実、決定事項、教訓など。",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "保存するテキスト（500文字以内推奨）",
        },
        category: {
          type: "string",
          enum: [...CATEGORIES],
          description: "カテゴリ: preference, fact, decision, entity, reflection, other",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "重要度 0.0〜1.0（デフォルト: 0.7）",
        },
        scope: {
          type: "string",
          description: "スコープ（省略時はデフォルトスコープ）",
        },
      },
      required: ["text", "category"],
    },
    async execute(_id: string, params: any, ctx?: any) {
      const deps = await getDeps(ctx);
      let text = String(params.text || "").trim();
      if (!text || text.length < 3) {
        return toolResult({ error: "テキストが短すぎます（最低3文字）" });
      }
      // 入力サイズ制限（API コスト / メモリ DoS 防止）
      if (text.length > MAX_TEXT_LENGTH) {
        text = text.slice(0, MAX_TEXT_LENGTH);
      }
      if (isNoise(text)) {
        return toolResult({ error: "この内容はノイズとして判定されました。より具体的な情報を保存してください。" });
      }

      const category = CATEGORIES.includes(params.category) ? params.category : "other";
      const importance = clampNumber(params.importance ?? 0.7, 0, 1, 0.7);
      const scope = deps.scopeManager.resolve(deps.agentId, params.scope);

      if (deps.agentId && !deps.scopeManager.canAccess(deps.agentId, scope)) {
        return toolResult({ error: `アクセス拒否: エージェント "${deps.agentId}" はスコープ "${scope}" にアクセスできません` });
      }

      const vector = await deps.embedder.embed(text, "store");
      const id = await deps.store.add({
        text,
        vector,
        category,
        scope,
        importance,
        metadata: JSON.stringify({ agentId: deps.agentId }),
      });

      return toolResult({ stored: true, id, category, scope, importance });
    },
  });

  // memory_recall — 記憶を検索
  api.registerTool({
    name: "memory_recall",
    description:
      "長期記憶から関連する情報を検索する。質問やキーワードで過去の記憶を呼び出す。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索クエリ（質問やキーワード）",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "最大件数（デフォルト: 5）",
        },
        scope: {
          type: "string",
          description: "検索スコープ（省略時はデフォルト）",
        },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any, ctx?: any) {
      const deps = await getDeps(ctx);
      let query = String(params.query || "").trim();
      if (!query) return toolResult({ error: "検索クエリが空です" });
      // クエリサイズ制限
      if (query.length > MAX_QUERY_LENGTH) {
        query = query.slice(0, MAX_QUERY_LENGTH);
      }

      const limit = clampNumber(params.limit ?? 5, 1, 20, 5);
      const scope = deps.scopeManager.resolve(deps.agentId, params.scope);

      if (deps.agentId && !deps.scopeManager.canAccess(deps.agentId, scope)) {
        return toolResult({ error: `アクセス拒否: エージェント "${deps.agentId}" はスコープ "${scope}" にアクセスできません` });
      }

      const results = await deps.retriever.recall(query, scope, limit);
      return toolResult({
        count: results.length,
        memories: formatResults(results),
      });
    },
  });

  // memory_delete — 記憶を削除
  api.registerTool({
    name: "memory_delete",
    description: "指定IDの記憶を削除する。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "削除する記憶のID",
        },
      },
      required: ["id"],
    },
    async execute(_id: string, params: any, ctx?: any) {
      const deps = await getDeps(ctx);
      const id = String(params.id || "").trim();
      if (!id) return toolResult({ error: "IDが指定されていません" });

      // スコープACLチェック: 対象記憶のスコープにアクセス権があるか確認
      const entry = await deps.store.getById(id);
      if (!entry) return toolResult({ error: "記憶が見つかりません", id });
      if (deps.agentId && !deps.scopeManager.canAccess(deps.agentId, entry.scope)) {
        return toolResult({ error: `アクセス拒否: エージェント "${deps.agentId}" はスコープ "${entry.scope}" にアクセスできません` });
      }

      const deleted = await deps.store.remove(id);
      return toolResult({ deleted, id });
    },
  });

  // memory_update — 記憶を更新
  api.registerTool({
    name: "memory_update",
    description: "既存の記憶のテキストやカテゴリを更新する。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "更新する記憶のID",
        },
        text: {
          type: "string",
          description: "新しいテキスト",
        },
        category: {
          type: "string",
          enum: [...CATEGORIES],
          description: "新しいカテゴリ",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "新しい重要度",
        },
      },
      required: ["id"],
    },
    async execute(_id: string, params: any, ctx?: any) {
      const deps = await getDeps(ctx);
      const id = String(params.id || "").trim();
      if (!id) return toolResult({ error: "IDが指定されていません" });

      // スコープACLチェック: 対象記憶のスコープにアクセス権があるか確認
      const existing = await deps.store.getById(id);
      if (!existing) return toolResult({ error: "記憶が見つかりません", id });
      if (deps.agentId && !deps.scopeManager.canAccess(deps.agentId, existing.scope)) {
        return toolResult({ error: `アクセス拒否: エージェント "${deps.agentId}" はスコープ "${existing.scope}" にアクセスできません` });
      }

      const fields: any = {};
      if (params.text) {
        fields.text = String(params.text).slice(0, MAX_TEXT_LENGTH);
        fields.vector = await deps.embedder.embed(fields.text, "store");
      }
      if (params.category && CATEGORIES.includes(params.category)) {
        fields.category = params.category;
      }
      if (typeof params.importance === "number") {
        fields.importance = clampNumber(params.importance, 0, 1, 0.7);
      }

      const updated = await deps.store.update(id, fields);
      return toolResult({ updated, id });
    },
  });
}

/**
 * 管理ツールを登録（enableManagementTools=true の場合のみ）
 */
export function registerManagementTools(api: OpenClawPluginApi, lazyDeps: ToolDeps | LazyToolDeps): void {
  const getDeps = "initPromise" in lazyDeps
    ? async () => { const r = await (lazyDeps as LazyToolDeps).initPromise; return r; }
    : async () => lazyDeps as ToolDeps;

  // memory_list — 全記憶一覧
  api.registerTool({
    name: "memory_list",
    description: "保存されている記憶の一覧を表示する（管理用）。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "スコープ" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "最大件数" },
        offset: { type: "integer", minimum: 0, description: "オフセット" },
      },
    },
    async execute(_id: string, params: any, ctx?: any) {
      const deps = await getDeps();
      const agentId = ctx?.agentId;
      const scope = deps.scopeManager.resolve(agentId, params.scope);

      if (agentId && !deps.scopeManager.canAccess(agentId, scope)) {
        return toolResult({ error: `アクセス拒否` });
      }

      const limit = clampNumber(params.limit ?? 10, 1, 50, 10);
      const offset = clampNumber(params.offset ?? 0, 0, 10000, 0);
      const entries = await deps.store.listAll(scope, limit, offset);
      return toolResult({
        count: entries.length,
        offset,
        entries: entries.map((e) => ({
          id: e.id,
          text: e.text.slice(0, 200),
          category: e.category,
          importance: e.importance,
          timestamp: new Date(e.timestamp).toISOString(),
        })),
      });
    },
  });

  // memory_stats — 統計情報
  api.registerTool({
    name: "memory_stats",
    description: "メモリストアの統計情報を表示する。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "スコープ（省略時は全体）" },
      },
    },
    async execute(_id: string, params: any, ctx?: any) {
      const deps = await getDeps();
      const agentId = ctx?.agentId;

      // 対象スコープの決定: 指定があればそれを使い、ACL制限付きエージェントは自スコープに限定
      const requestedScope = params.scope || (agentId ? deps.scopeManager.resolve(agentId) : undefined);

      // スコープACLチェック
      if (requestedScope && agentId && !deps.scopeManager.canAccess(agentId, requestedScope)) {
        return toolResult({ error: `アクセス拒否` });
      }

      // ACL制限があるエージェントには全体件数を見せない
      const scopeCount = requestedScope
        ? await deps.store.count(requestedScope)
        : await deps.store.count();
      return toolResult({
        entries: scopeCount,
        scope: requestedScope || "all",
        vectorDimensions: deps.embedder.dimensions,
      });
    },
  });
}

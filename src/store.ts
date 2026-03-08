/**
 * LanceDB ストレージレイヤー
 * メモリエントリの永続化と基本検索を担当
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";

/** scope / id に使える文字を制限（SQLインジェクション防止） */
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_:@.\-\u3000-\u9fff\uff00-\uffef]+$/;

// LanceDB は動的インポート（ネイティブモジュールのため）
let lancedbModule: typeof import("@lancedb/lancedb") | null = null;

async function loadLanceDB() {
  if (!lancedbModule) {
    lancedbModule = await import("@lancedb/lancedb");
  }
  return lancedbModule;
}

// 記憶カテゴリ
export const CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

export type MemoryCategory = (typeof CATEGORIES)[number];

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: MemoryCategory;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string; // JSON文字列
}

export interface SearchHit {
  entry: MemoryEntry;
  distance: number;
}

export interface MemoryStore {
  add(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string>;
  search(vector: number[], scope: string, limit: number): Promise<SearchHit[]>;
  searchFullText(query: string, scope: string, limit: number): Promise<SearchHit[]>;
  getById(id: string): Promise<MemoryEntry | null>;
  remove(id: string): Promise<boolean>;
  listAll(scope: string, limit: number, offset: number): Promise<MemoryEntry[]>;
  count(scope?: string): Promise<number>;
  update(id: string, fields: Partial<Pick<MemoryEntry, "text" | "vector" | "category" | "importance" | "metadata">>): Promise<boolean>;
}

/**
 * ストレージパスの検証と作成
 * LanceDB の connect(path) は path 自体をディレクトリとして扱う
 */
function ensureStoragePath(dbPath: string): string {
  if (!existsSync(dbPath)) {
    mkdirSync(dbPath, { recursive: true });
  }
  accessSync(dbPath, constants.R_OK | constants.W_OK);
  return dbPath;
}

const TABLE_NAME = "memories";

/**
 * LanceDB ベースのメモリストアを生成
 */
export async function createStore(dbPath: string, vectorDim: number): Promise<MemoryStore> {
  const lancedb = await loadLanceDB();
  const validPath = ensureStoragePath(dbPath);
  const db = await lancedb.connect(validPath);

  // テーブル取得または作成
  let table: Awaited<ReturnType<typeof db.openTable>>;
  const tableNames = await db.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
  } else {
    // 初期ダミーレコードでスキーマ定義
    const seed: MemoryEntry = {
      id: "__seed__",
      text: "",
      vector: new Array(vectorDim).fill(0),
      category: "other",
      scope: "_system",
      importance: 0,
      timestamp: 0,
      metadata: "{}",
    };
    table = await db.createTable(TABLE_NAME, [seed]);

    // FTS インデックス作成（ハイブリッド検索の BM25 側に必要）
    try {
      await table.createIndex("text", { config: lancedb.Index.fts() });
    } catch (e) {
      console.warn("[memory-bank] FTS index creation failed, hybrid search will fall back to vector-only:", e);
    }
  }

  function sqlEscape(s: string): string {
    if (!SAFE_IDENTIFIER.test(s)) {
      // 安全な文字以外はシングルクォートエスケープ + バックスラッシュ除去
      return s.replace(/\\/g, "").replace(/'/g, "''");
    }
    return s;
  }

  return {
    async add(entry) {
      const id = randomUUID();
      const row: MemoryEntry = {
        ...entry,
        id,
        timestamp: Date.now(),
      };
      await table.add([row]);
      return id;
    },

    async search(vector, scope, limit) {
      const results = await table
        .search(vector)
        .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
        .limit(limit)
        .toArray();

      return results.map((row: any) => ({
        entry: {
          id: row.id,
          text: row.text,
          vector: row.vector,
          category: row.category,
          scope: row.scope,
          importance: row.importance,
          timestamp: row.timestamp,
          metadata: row.metadata || "{}",
        },
        distance: row._distance ?? 0,
      }));
    },

    async searchFullText(query, scope, limit) {
      // LanceDBのフルテキスト検索（利用可能な場合）
      // フォールバック: 全件取得してJSでフィルタリング
      try {
        const results = await table
          .search(query, "text")
          .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
          .limit(limit)
          .toArray();

        return results.map((row: any) => ({
          entry: {
            id: row.id,
            text: row.text,
            vector: row.vector || [],
            category: row.category,
            scope: row.scope,
            importance: row.importance,
            timestamp: row.timestamp,
            metadata: row.metadata || "{}",
          },
          distance: row._distance ?? row._score ?? 0,
        }));
      } catch (e) {
        console.warn("[memory-bank] Full-text search failed, falling back to vector-only:", e);
        return [];
      }
    },

    async getById(id) {
      const results = await table
        .query()
        .where(`id = '${sqlEscape(id)}'`)
        .limit(1)
        .toArray();
      if (results.length === 0) return null;
      const row: any = results[0];
      return {
        id: row.id,
        text: row.text,
        vector: row.vector,
        category: row.category,
        scope: row.scope,
        importance: row.importance,
        timestamp: row.timestamp,
        metadata: row.metadata || "{}",
      };
    },

    async remove(id) {
      await table.delete(`id = '${sqlEscape(id)}'`);
      return true;
    },

    async listAll(scope, limit, offset) {
      const results = await table
        .query()
        .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
        .limit(limit + offset)
        .toArray();

      return results.slice(offset).map((row: any) => ({
        id: row.id,
        text: row.text,
        vector: row.vector,
        category: row.category,
        scope: row.scope,
        importance: row.importance,
        timestamp: row.timestamp,
        metadata: row.metadata || "{}",
      }));
    },

    async count(scope) {
      const filter = scope
        ? `scope = '${sqlEscape(scope)}' AND id != '__seed__'`
        : "id != '__seed__'";
      // ベクトルをロードせずIDのみ取得してカウント
      const results = await table.query().select(["id"]).where(filter).toArray();
      return results.length;
    },

    async update(id, fields) {
      const existing = await this.getById(id);
      if (!existing) return false;
      const updated = { ...existing, ...fields };
      await table.update({ where: `id = '${sqlEscape(id)}'`, values: updated });
      return true;
    },
  };
}

#!/usr/bin/env node
/**
 * memory-bank CLI — OpenClaw 外からメモリストアを点検する管理ツール
 * read-only 操作のみ
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "./src/store.ts";
import { sqlEscape } from "./src/store.ts";

const TABLE_NAME = "memories";

// ── 引数パーサー ──

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!command && !arg.startsWith("-")) {
      command = arg;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

// ── DB アクセス (LanceDB 直接) ──

async function openTable(dbPath: string) {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(dbPath);
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    console.error(`Error: Table "${TABLE_NAME}" not found in ${dbPath}`);
    process.exit(1);
  }
  return db.openTable(TABLE_NAME);
}

function rowToEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    vector: row.vector || [],
    category: row.category,
    scope: row.scope,
    importance: row.importance,
    timestamp: row.timestamp,
    metadata: row.metadata || "{}",
  };
}

async function queryAll(table: Awaited<ReturnType<typeof openTable>>, scope?: string, limit?: number): Promise<MemoryEntry[]> {
  let filter = "id != '__seed__'";
  if (scope) {
    filter += ` AND scope = '${sqlEscape(scope)}'`;
  }
  let q = table.query().where(filter);
  if (limit) {
    q = q.limit(limit);
  }
  const rows = await q.toArray();
  return rows.map(rowToEntry);
}

// ── DB パス解決 ──

function resolveDbPath(flags: Record<string, string>): string {
  const dbPath = flags["db"] || process.env.MEMORY_BANK_DB;
  if (!dbPath) {
    console.error("Error: DB path required. Use --db <path> or set MEMORY_BANK_DB env var.");
    process.exit(1);
  }
  return dbPath;
}

// ── ヘルパー ──

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

export function printHelp(): void {
  console.log(`memory-bank CLI — メモリストア管理ツール

Usage:
  memory-bank <command> [options]

Commands:
  stats                          全体統計（件数、スコープ別件数）
  list [--scope <scope>] [--limit <n>]  記憶一覧（テキスト200文字切り詰め）
  inspect <id>                   特定IDの記憶の全フィールド表示
  export [--scope <scope>] [--format json]  JSON形式でエクスポート
  obsidian-export --vault <path> Obsidian保管庫にMarkdownエクスポート
  help                           このヘルプを表示

Global options:
  --db <path>                    DBパス（または MEMORY_BANK_DB 環境変数）`);
}

// ── コマンド実装 ──

async function cmdStats(flags: Record<string, string>): Promise<void> {
  const table = await openTable(resolveDbPath(flags));
  const entries = await queryAll(table);

  console.log(`Total memories: ${entries.length}`);

  if (entries.length === 0) return;

  const scopeCounts = new Map<string, number>();
  for (const entry of entries) {
    scopeCounts.set(entry.scope, (scopeCounts.get(entry.scope) || 0) + 1);
  }

  console.log("\nBy scope:");
  for (const [scope, count] of [...scopeCounts.entries()].sort()) {
    console.log(`  ${scope}: ${count}`);
  }
}

async function cmdList(flags: Record<string, string>): Promise<void> {
  const rawLimit = parseInt(flags["limit"] || "20", 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 20;
  const scope = flags["scope"];
  const table = await openTable(resolveDbPath(flags));
  const entries = await queryAll(table, scope, limit);

  if (entries.length === 0) {
    console.log("No memories found.");
    return;
  }

  for (const entry of entries) {
    console.log(`[${entry.id}] (${entry.scope}/${entry.category}) ${truncate(entry.text, 200)}`);
  }
  console.log(`\n${entries.length} entries shown.`);
}

async function cmdInspect(flags: Record<string, string>, positional: string[]): Promise<void> {
  const id = positional[0];
  if (!id) {
    console.error("Error: inspect requires an <id> argument.");
    process.exit(1);
  }

  const table = await openTable(resolveDbPath(flags));
  const rows = await table.query().where(`id = '${sqlEscape(id)}'`).limit(1).toArray();

  if (rows.length === 0) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }

  const entry = rowToEntry(rows[0]);
  console.log(`ID:         ${entry.id}`);
  console.log(`Scope:      ${entry.scope}`);
  console.log(`Category:   ${entry.category}`);
  console.log(`Importance: ${entry.importance}`);
  console.log(`Timestamp:  ${formatTimestamp(entry.timestamp)}`);
  console.log(`Metadata:   ${entry.metadata}`);
  console.log(`Vector dim: ${entry.vector.length}`);
  console.log(`Text:\n${entry.text}`);
}

async function cmdExport(flags: Record<string, string>): Promise<void> {
  const scope = flags["scope"];
  const table = await openTable(resolveDbPath(flags));
  const entries = await queryAll(table, scope);

  // vector フィールドは省略（巨大なため）
  const output = entries.map(({ vector, ...rest }) => rest);
  console.log(JSON.stringify(output, null, 2));
}

// ── Obsidian Export ──

function entryToMarkdown(entry: MemoryEntry): string {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  const title = entry.text.slice(0, 50).replace(/\n/g, " ");
  return `---
id: ${entry.id}
category: ${entry.category}
scope: ${entry.scope}
importance: ${entry.importance}
date: ${date}
tags: [${entry.category}, ${entry.scope}]
---

# ${title}

${entry.text}
`;
}

async function cmdObsidianExport(flags: Record<string, string>): Promise<void> {
  const vaultPath = flags["vault"];
  if (!vaultPath) {
    console.error("Error: --vault <path> is required for obsidian-export.");
    process.exit(1);
  }

  const table = await openTable(resolveDbPath(flags));
  const allEntries = await queryAll(table);

  if (allEntries.length === 0) {
    console.log("No memories found to export.");
    return;
  }

  // Filter: keep valuable memories only
  // - Non-reflection categories: always include
  // - Reflection: only importance >= 0.85 (manually flagged as important)
  const minReflectionImportance = parseFloat(flags["min-reflection-importance"] ?? "0.85");
  const entries = allEntries.filter((e) => {
    if (e.category !== "reflection") return true;
    return (e.importance ?? 0) >= minReflectionImportance;
  });
  const skipped = allEntries.length - entries.length;
  if (skipped > 0) {
    console.log(`Filtered: ${skipped} low-importance reflections excluded (threshold: ${minReflectionImportance})`);
  }

  // Ensure vault directory exists
  if (!existsSync(vaultPath)) {
    mkdirSync(vaultPath, { recursive: true });
  }

  // Group by category
  const byCategory = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const cat = entry.category || "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(entry);
  }

  // Write category files
  for (const [category, catEntries] of byCategory) {
    const content = catEntries.map(entryToMarkdown).join("\n---\n\n");
    writeFileSync(join(vaultPath, `${category}.md`), content, "utf-8");
    console.log(`  ${category}.md — ${catEntries.length} entries`);
  }

  // Write all.md (filtered)
  const allContent = entries.map(entryToMarkdown).join("\n---\n\n");
  writeFileSync(join(vaultPath, "all.md"), allContent, "utf-8");
  console.log(`  all.md — ${entries.length} entries`);

  // Write _index.md
  const now = new Date().toISOString();
  const categoryStats = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, arr]) => `| ${cat} | ${arr.length} |`)
    .join("\n");

  const indexContent = `---
last_sync: ${now}
total: ${entries.length}
---

# Memory Bank Index

**Total memories:** ${entries.length}
**Last sync:** ${now}

## Categories

| Category | Count |
|----------|-------|
${categoryStats}
`;
  writeFileSync(join(vaultPath, "_index.md"), indexContent, "utf-8");
  console.log(`  _index.md`);

  console.log(`\nExported ${entries.length} memories to ${vaultPath}`);
}

// ── メインエントリ ──

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv);

  switch (command) {
    case "stats":
      await cmdStats(flags);
      break;
    case "list":
      await cmdList(flags);
      break;
    case "inspect":
      await cmdInspect(flags, positional);
      break;
    case "export":
      await cmdExport(flags);
      break;
    case "obsidian-export":
      await cmdObsidianExport(flags);
      break;
    case "help":
    case "":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// モジュールとしてインポートされた場合は実行しない
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

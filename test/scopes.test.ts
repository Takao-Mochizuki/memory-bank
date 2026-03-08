import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createScopeManager } from "../src/scopes.ts";

describe("ScopeManager", () => {
  it("デフォルトスコープを返す", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve(), "global");
  });

  it("カスタムデフォルトスコープ", () => {
    const sm = createScopeManager({ defaultScope: "workspace" });
    assert.equal(sm.resolve(), "workspace");
  });

  it("agentIdがあればagent:プレフィックスのスコープを返す", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve("my-agent"), "agent:my-agent");
  });

  it("明示的スコープが定義済みならそちらを優先", () => {
    const sm = createScopeManager({
      definitions: { project: { description: "プロジェクト用" } },
    });
    assert.equal(sm.resolve("my-agent", "project"), "project");
  });

  it("未定義の明示的スコープはagent:にフォールバック", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve("my-agent", "unknown-scope"), "agent:my-agent");
  });

  it("agent:プレフィックスのスコープは有効と判定", () => {
    const sm = createScopeManager();
    assert.equal(sm.isValid("agent:test"), true);
  });

  it("組み込みスコープを列挙", () => {
    const sm = createScopeManager();
    const scopes = sm.listScopes();
    assert.ok(scopes.includes("global"));
    assert.ok(scopes.includes("_system"));
  });
});

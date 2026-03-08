import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReflectionOutput } from "../src/reflection.ts";

describe("parseReflectionOutput", () => {
  it("正常なJSON配列をパース", () => {
    const input = `[{"text":"テスト","category":"fact","importance":0.8}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "テスト");
    assert.equal(result[0].category, "fact");
    assert.equal(result[0].importance, 0.8);
  });

  it("テキスト中のJSON配列を抽出", () => {
    const input = `以下が抽出結果です:\n[{"text":"学び","category":"reflection","importance":0.9}]\n以上です。`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "学び");
  });

  it("複数アイテムをパース", () => {
    const input = `[
      {"text":"項目1","category":"fact","importance":0.8},
      {"text":"項目2","category":"preference","importance":0.6}
    ]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 2);
  });

  it("不正な入力で空配列を返す", () => {
    assert.deepEqual(parseReflectionOutput("no json here"), []);
    assert.deepEqual(parseReflectionOutput(""), []);
    assert.deepEqual(parseReflectionOutput("{not an array}"), []);
  });

  it("importanceを0-1にクランプ", () => {
    const input = `[{"text":"test","category":"fact","importance":5.0}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].importance, 1);
  });

  it("負のimportanceを0にクランプ", () => {
    const input = `[{"text":"test","category":"fact","importance":-0.5}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].importance, 0);
  });

  it("textを500文字に切り詰め", () => {
    const longText = "あ".repeat(600);
    const input = `[{"text":"${longText}","category":"fact","importance":0.7}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].text.length, 500);
  });

  it("必須フィールドが欠けたアイテムを除外", () => {
    const input = `[
      {"text":"valid","category":"fact","importance":0.8},
      {"category":"fact","importance":0.8},
      {"text":"no-cat","importance":0.8},
      {"text":"no-imp","category":"fact"}
    ]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "valid");
  });
});

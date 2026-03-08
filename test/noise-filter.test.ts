import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNoise, filterNoise } from "../src/noise-filter.ts";

describe("isNoise", () => {
  it("短すぎるテキストをノイズと判定", () => {
    assert.equal(isNoise("hi"), true);
    assert.equal(isNoise("ok"), true);
    assert.equal(isNoise(""), true);
    assert.equal(isNoise("ab"), true);
  });

  it("英語の挨拶・定型をノイズと判定", () => {
    assert.equal(isNoise("hello"), true);
    assert.equal(isNoise("Hello!"), true);
    assert.equal(isNoise("thanks"), true);
    assert.equal(isNoise("Thank you."), true);
    assert.equal(isNoise("sure"), true);
    assert.equal(isNoise("got it"), true);
  });

  it("日本語の挨拶・定型をノイズと判定", () => {
    assert.equal(isNoise("こんにちは"), true);
    assert.equal(isNoise("ありがとう"), true);
    assert.equal(isNoise("はい"), true);
    assert.equal(isNoise("了解"), true);
    assert.equal(isNoise("わかりました"), true);
  });

  it("エージェントの断り文句をノイズと判定", () => {
    assert.equal(isNoise("I can't do that"), true);
    assert.equal(isNoise("Sorry, I cannot help"), true);
    assert.equal(isNoise("申し訳ございません"), true);
  });

  it("メタ質問をノイズと判定", () => {
    assert.equal(isNoise("What can you do?"), true);
    assert.equal(isNoise("あなたは誰ですか"), true);
  });

  it("実質的な内容はノイズでないと判定", () => {
    assert.equal(isNoise("TypeScriptでは型推論が強力です"), false);
    assert.equal(isNoise("LanceDBのベクトル検索を使ってメモリを実装する"), false);
    assert.equal(isNoise("The deployment failed with exit code 1"), false);
    assert.equal(isNoise("Remember to use hybrid retrieval"), false);
  });
});

describe("filterNoise", () => {
  it("ノイズエントリを除外", () => {
    const results = [
      { entry: { text: "hello" }, score: 0.9 },
      { entry: { text: "LanceDBの設定方法" }, score: 0.8 },
      { entry: { text: "ok" }, score: 0.7 },
    ];
    const filtered = filterNoise(results);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].entry.text, "LanceDBの設定方法");
  });
});

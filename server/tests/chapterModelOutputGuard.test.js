const test = require("node:test");
const assert = require("node:assert/strict");
const { assertChapterModelOutput } = require("../dist/services/novel/runtime/chapterModelOutputGuard.js");
const details = { source: "test" };

test("known standalone assistant refusals are rejected without exposing response content", () => {
  for (const content of [
    "由于程序代码的局限，我没法办到。",
    "由于程序代码的局限，我没法办到。\n\n由于程序代码的局限，我没法办到。",
    "请恕我爱莫能助，我只是一个语言模型，不能理解或回复你的这个问题。",
    "很抱歉，我无法生成这一章。",
    "I'm sorry, I cannot help with this request.",
  ]) {
    assert.throws(() => assertChapterModelOutput(content, details), error => {
      assert.equal(error.code, "CHAPTER_MODEL_REFUSAL");
      assert.ok(!error.message.includes(content));
      return true;
    });
  }
});

test("character dialogue and first-person narrative remain valid", () => {
  for (const content of [
    "“由于程序代码的局限，我没法办到。”屏幕亮了一下，门锁仍未打开。",
    "「作为AI，我无法提供这个答案。」傀儡转身走进门里。",
    "我无法完成这个计划。门后的钟声响起，我只好寻找另一条路。",
    "由于天气的局限，我们没法沿着原路返回。",
  ]) assert.equal(assertChapterModelOutput(content, details), content);
});

test("empty content still has its distinct error contract", () => {
  assert.throws(() => assertChapterModelOutput(" ", details), error => error.code === "CHAPTER_EMPTY_CONTENT");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readStreamError } from "./sseErrors.ts";

test("stream preflight preserves an actionable chapter conflict", async () => {
  const response = new Response(JSON.stringify({ success: false, message: "本章正在生成，请等待完成。" }), { status: 409 });
  assert.equal(await readStreamError(response), "本章正在生成，请等待完成。");
});

test("stream preflight preserves provider failures and handles HTML proxy errors", async () => {
  const provider = new Response(JSON.stringify({ error: { message: "请先完成模型授权。" } }), { status: 401 });
  assert.equal(await readStreamError(provider), "请先完成模型授权。");
  const proxy = new Response("<html>Bad Gateway</html>", { status: 502 });
  assert.equal(await readStreamError(proxy), "请求失败，状态码 502");
});

const test = require("node:test");
const assert = require("node:assert/strict");

test("SDK reasoning options remain isolated across concurrent calls and unrelated fetches", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(init.body) });
    return new Response("OK");
  };
  const { withChatGPTNetwork } = require("../dist/platform/llm/chatgptPlan/chatGPTNetwork.js");
  const url = "https://api.openai.com/v1/responses";
  const init = { method: "POST", body: JSON.stringify({ model: "test", input: "OK", store: false, stream: true }) };
  try {
    await Promise.all([
      withChatGPTNetwork(async () => { await Promise.resolve(); await fetch(url, init); }, "medium"),
      withChatGPTNetwork(async () => { await Promise.resolve(); await fetch(url, init); }, "max"),
      withChatGPTNetwork(() => fetch("https://example.com/v1/responses", init), "high"),
      fetch(url, init),
    ]);
    const efforts = calls.map(({ body }) => body.reasoning?.effort).filter(Boolean).sort();
    assert.deepEqual(efforts, ["max", "medium"]);
    assert.equal(calls.filter(({ body }) => !body.reasoning).length, 2);
    assert.ok(calls.every(({ body }) => body.store === false && body.stream === true && body.input === "OK"));
    assert.equal(JSON.parse(init.body).reasoning, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

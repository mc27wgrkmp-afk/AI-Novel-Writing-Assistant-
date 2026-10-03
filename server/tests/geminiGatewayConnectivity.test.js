const test = require("node:test");
const assert = require("node:assert/strict");
let errorMessage;
let calls = [];
let structuredCalls = 0;
const mocks = {
  "../dist/llm/factory.js": {
    resolveLLMClientOptions: async (provider, options) => ({ provider, ...options }),
    getLLM: async (provider, options) => ({ invoke: async () => {
      calls.push({ provider, model: options.model, protocol: options.requestProtocol });
      if (errorMessage) throw new Error(errorMessage);
      return { content: "ok" };
    } }),
  },
  "../dist/llm/modelRouter.js": { MODEL_ROUTE_TASK_TYPES: [] },
  "../dist/llm/structuredInvoke.js": {
    invokeStructuredLlmDetailed: async () => { structuredCalls++; throw new Error("unexpected structured probe"); },
  },
};
for (const [path, exports] of Object.entries(mocks)) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { llmConnectivityService } = require("../dist/llm/connectivity.js");
const { getGeminiGatewayBlockMessage } = require("../dist/llm/geminiGatewayAvailability.js");

test("paused gateway tests the selected model once and stops all later probes", async () => {
  errorMessage = "502 upstream error: Gemini paused: verification or upstream restriction requires manual recovery";
  calls = []; structuredCalls = 0;
  const result = await llmConnectivityService.testConnection({ provider: "custom_gemini", model: "gemini-3.6-flash", probeMode: "both" });
  assert.equal(result.ok, false);
  assert.equal(result.model, "gemini-3.6-flash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gemini-3.6-flash");
  assert.equal(structuredCalls, 0);
  assert.equal(result.structured, null);
  assert.match(result.plain.error, /切换 Gemini 型号无法解除暂停/);
});

test("cooldown and new upstream rejection also stop protocol and format retries", async () => {
  for (const message of ["Gateway cooling down after upstream failure; retry in 200 seconds", "Gemini upstream rejected request: BardErrorInfo [1060]"]) {
    errorMessage = message; calls = []; structuredCalls = 0;
    const result = await llmConnectivityService.testConnection({ provider: "custom_gemini", model: "gemini-3.5-flash-thinking-lite", probeMode: "both" });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(structuredCalls, 0);
  }
});

test("unrelated provider failures are not classified as a Gemini pause", () => {
  assert.equal(getGeminiGatewayBlockMessage(new Error("HTTP 404 model not found")), null);
  assert.equal(getGeminiGatewayBlockMessage(new Error("request timeout")), null);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
let calls = 0;
const mocks = {
  "../dist/db/prisma.js": { prisma: {} },
  "../dist/llm/factory.js": {
    resolveLLMClientOptions: async (provider, options) => ({ ...options, provider, model: options.model, temperature: 0.1, requestProtocol: "openai_compatible" }),
    createLLMFromResolvedOptions: () => ({ stream: async function* () { calls++; throw new Error("502 upstream error: Gemini paused: verification required"); } }),
  },
  "../dist/llm/modelRouter.js": { toStructuredOutputStrategy: () => "prompt_json" },
  "../dist/llm/structuredFallbackSettings.js": { getStructuredFallbackSettings: async () => ({ enabled: true, provider: "custom_gemini", model: "gemini-3.5-flash-thinking-lite", retryCount: 3, temperature: 0.1 }) },
  "../dist/platform/llm/live/llmLiveSession.js": { beginLlmLiveSession: () => new Proxy({}, { get: () => () => {} }) },
};
for (const [path, exports] of Object.entries(mocks)) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { invokeStructuredLlmDetailed } = require("../dist/llm/structuredInvoke.js");

test("explicit gateway pause prevents transport retries and fallback to another model on that gateway", async () => {
  await assert.rejects(invokeStructuredLlmDetailed({
    provider: "custom_gemini", model: "gemini-3.6-flash", label: "pause-test",
    schema: z.object({ status: z.literal("ok") }), systemPrompt: "test", userPrompt: "test", structuredStrategy: "prompt_json",
  }), /Gemini paused/);
  assert.equal(calls, 1);
});

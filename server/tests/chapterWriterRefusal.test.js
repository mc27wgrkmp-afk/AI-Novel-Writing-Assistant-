const test = require("node:test");
const assert = require("node:assert/strict");
let extensionCalls = 0;
const response = "由于程序代码的局限，我没法办到。";
const mocks = {
  "../dist/db/prisma.js": { prisma: { novel: { findUnique: async () => null } } },
  "../dist/prompting/core/promptRunner.js": {
    streamTextPrompt: async () => ({
      stream: (async function* () { yield { content: response }; })(),
      complete: Promise.resolve({ output: response }),
    }),
    runTextPrompt: async () => { extensionCalls++; throw new Error("unexpected continuation"); },
  },
  "../dist/prompting/context/promptContextResolution.js": {
    resolvePromptContextBlocksForAsset: async ({ fallbackBlocks }) => ({ blocks: fallbackBlocks }),
  },
  "../dist/prompting/prompts/novel/chapterLayeredContext.js": {
    buildChapterWriterContextBlocks: () => [],
    resolveTargetWordRange: () => ({ minWordCount: 2400, maxWordCount: 3600 }),
    sanitizeWriterContextBlocks: blocks => ({ allowedBlocks: blocks, removedBlockIds: [] }),
  },
  "../dist/services/novel/NovelContinuationService.js": { NovelContinuationService: class {} },
};
for (const [path, exports] of Object.entries(mocks)) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { ChapterWritingGraph } = require("../dist/services/novel/chapterWritingGraph.js");

test("writer refusal stops before normalization, length continuation, and persistence", async () => {
  let normalizationCalls = 0;
  let saveCalls = 0;
  const graph = new ChapterWritingGraph({
    enforceOpeningDiversity: async () => { normalizationCalls++; throw new Error("unexpected normalization"); },
    saveDraftAndArtifacts: async () => { saveCalls++; },
    logInfo: () => {}, logWarn: () => {},
  });
  const writer = await graph.createChapterStream({
    novelId: "n", novelTitle: "小说", chapter: { id: "c", order: 2, title: "第二章" },
    contextPackage: { continuation: { enabled: false }, chapterWriteContext: { chapterMission: { targetWordCount: 3000 } } },
    options: {},
  });
  for await (const _chunk of writer.stream) {}
  await assert.rejects(writer.onDone(response), error => error.code === "CHAPTER_MODEL_REFUSAL");
  assert.equal(normalizationCalls, 0);
  assert.equal(extensionCalls, 0);
  assert.equal(saveCalls, 0);
});

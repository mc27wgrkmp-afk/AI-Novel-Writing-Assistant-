const test = require("node:test");
const assert = require("node:assert/strict");
// This boundary must reject before any persistence call; never open the user's DB.
const dbId = require.resolve("../../dist/db/prisma.js");
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { prisma: {} } };
const { ChapterRuntimeCoordinator } = require("../../dist/services/novel/runtime/ChapterRuntimeCoordinator.js");
const { NovelCorePipelineService } = require("../../dist/services/novel/novelCorePipelineService.js");
const { ChapterRegenerationService } = require("../../dist/services/novel/production/regeneration/index.js");

for (const [owner, methods] of [
  [ChapterRuntimeCoordinator, ["createChapterStream", "createRepairStream", "runPipelineChapter"]],
  [NovelCorePipelineService, ["startPipelineJob", "resumePipelineJob", "retryPipelineJob"]],
  [ChapterRegenerationService, ["createStream"]],
]) {
  for (const method of methods) {
    test(`${owner.name}.${method} rejects before DB, draft mutation or model invocation`, async () => {
      // No dependencies: any access before rejecting would throw a different error.
      await assert.rejects(owner.prototype[method].call({}, "novel", "chapter"), (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /AI 负责大纲与章节剧本/);
        return true;
      });
    });
  }
}

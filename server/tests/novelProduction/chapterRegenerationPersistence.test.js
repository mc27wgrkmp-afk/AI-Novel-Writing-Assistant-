const test = require("node:test");
const assert = require("node:assert/strict");
const dbPath = require.resolve("../../dist/db/prisma.js");
let updateMany;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { chapter: { updateMany: (input) => updateMany(input) } } } };
const { ChapterLifecycleService } = require("../../dist/services/novel/runtime/lifecycle/ChapterLifecycleService.js");

test("regenerated manuscript is saved atomically with optimistic content guard and fresh review status", async () => {
  let calls = 0;
  updateMany = async (input) => {
    calls++;
    assert.deepEqual(input.where, { id: "c", novelId: "n", chapterStatus: "generating", content: "旧稿" });
    assert.deepEqual(input.data, { content: "新稿", generationState: "drafted", chapterStatus: "pending_review", qualityScore: null, continuityScore: null, characterScore: null, pacingScore: null, riskFlags: null, repairHistory: null });
    return { count: 1 };
  };
  await new ChapterLifecycleService().saveRegeneratedContent({ novelId: "n", chapterId: "c", content: "新稿", expectedContent: "旧稿" });
  assert.equal(calls, 1);
});

test("regeneration refuses to overwrite a concurrent manuscript edit", async () => {
  updateMany = async () => ({ count: 0 });
  await assert.rejects(new ChapterLifecycleService().saveRegeneratedContent({ novelId: "n", chapterId: "c", content: "新稿", expectedContent: "旧稿" }), /正文或生成状态已变化/);
});

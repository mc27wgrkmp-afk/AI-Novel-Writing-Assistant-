const test = require("node:test");
const assert = require("node:assert/strict");
// These approval-boundary tests inject persistence; no database is opened.
const prismaPath = require.resolve("../dist/db/prisma.js");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {} } };
const { DirectorConflictRecoveryService } = require("../dist/services/novel/director/recovery/conflicts/DirectorConflictRecoveryService.js");
const { directorConflictRecoverySchema } = require("../dist/prompting/prompts/director/conflictRecovery.prompts.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");
const sharedServices = require("../dist/services/novel/application/sharedNovelServices.js");

const option = (kind = "chapter_contract") => ({
  id: "option-1", title: "保留容量上限", summary: "让幸存者在盲区外接应。",
  changes: ["调整转移场景"], preserves: ["大纲主线", "正文"], tradeoff: "接应风险增加。",
  instruction: "保留三人容量，幸存者在盲区外接应。",
  repair: { kind, chapterId: kind === "chapter_contract" ? "chapter-1" : null, stepId: null },
});
function fixture() {
  const writes = [];
  const workflow = {
    bootstrapTask: async (input) => { writes.push(["seed", input]); },
    markTaskWaitingApproval: async (id, input) => { writes.push(["review", input]); },
  };
  const service = new DirectorConflictRecoveryService(workflow);
  const record = {
    plan: { id: "plan-1", taskId: "task-1", summary: "容量设定与转移安排冲突。",
      outlinePriority: "保留转移主线与三人上限", conflicts: [], options: [option()],
      recommendedOptionId: "option-1", createdAt: "2026-10-04" },
    contentFingerprint: "content-1", failureFingerprint: "failure-1",
  };
  const loaded = {
    task: { id: "task-1", novelId: "novel-1", status: "failed", pendingManualRecovery: false },
    seed: { conflictRecovery: record }, record,
    context: { chapters: [{ id: "chapter-1" }] },
    contentFingerprint: "content-1", failureFingerprint: "failure-1",
  };
  service.load = async () => loaded;
  return { service, loaded, record, writes };
}
const selection = { planId: "plan-1", optionId: "option-1" };

test("conflict analysis requires two or three options and a valid recommendation", () => {
  const base = { summary: "冲突", outlinePriority: "主线", conflicts: [], options: [option(), option()], recommendedOptionIndex: 1 };
  assert.equal(directorConflictRecoverySchema.safeParse(base).success, true);
  assert.equal(directorConflictRecoverySchema.safeParse({ ...base, options: [option()] }).success, false);
  assert.equal(directorConflictRecoverySchema.safeParse({ ...base, options: Array(4).fill(option()) }).success, false);
  assert.equal(directorConflictRecoverySchema.safeParse({ ...base, recommendedOptionIndex: 2 }).success, false);
});

test("analysis saves proposals without applying creative changes or resuming the task", async (t) => {
  const { service, loaded, writes } = fixture();
  const original = promptRunner.runStructuredPrompt;
  t.after(() => { promptRunner.runStructuredPrompt = original; });
  promptRunner.runStructuredPrompt = async () => ({ output: {
    summary: "容量设定与转移安排冲突。", outlinePriority: "保留主线", conflicts: [],
    options: [option(), { ...option(), title: "分批转移" }], recommendedOptionIndex: 0,
  } });
  const plan = await service.generate("task-1");
  assert.equal(plan.options.length, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "seed");
  assert.equal(writes[0][1].seedPayload.conflictRecovery.selectedOptionId, undefined);
  assert.equal(loaded.task.status, "failed");
});

test("unknown or already selected options cannot be applied", async () => {
  const { service, record } = fixture();
  await assert.rejects(service.validateSelection("task-1", { ...selection, optionId: "missing" }), /失效/);
  record.selectedOptionId = "option-1";
  await assert.rejects(service.validateSelection("task-1", selection), /失效/);
});

test("AI cannot propose changes to a chapter outside the supplied scope", async (t) => {
  const { service, writes } = fixture();
  const original = promptRunner.runStructuredPrompt;
  t.after(() => { promptRunner.runStructuredPrompt = original; });
  promptRunner.runStructuredPrompt = async () => ({ output: {
    summary: "冲突", outlinePriority: "主线", conflicts: [], recommendedOptionIndex: 0,
    options: [{ ...option(), repair: { kind: "chapter_contract", chapterId: "foreign-chapter", stepId: null } }, option()],
  } });
  await assert.rejects(service.generate("task-1"), /不存在的章节/);
  assert.equal(writes.length, 0);
});

test("analysis is discarded when saved content changes during the model call", async (t) => {
  const { service, loaded, writes } = fixture();
  const original = promptRunner.runStructuredPrompt;
  t.after(() => { promptRunner.runStructuredPrompt = original; });
  let reads = 0;
  service.load = async () => ({ ...loaded, contentFingerprint: ++reads === 1 ? "content-1" : "edited-content" });
  promptRunner.runStructuredPrompt = async () => ({ output: {
    summary: "冲突", outlinePriority: "主线", conflicts: [], options: [option(), option()], recommendedOptionIndex: 0,
  } });
  await assert.rejects(service.generate("task-1"), /分析期间/);
  assert.equal(writes.length, 0);
});

test("changes to novel content invalidate proposals both before and after queueing", async () => {
  const { service, loaded } = fixture();
  loaded.contentFingerprint = "edited-content";
  await assert.rejects(service.validateSelection("task-1", selection), /已变化/);
  await assert.rejects(service.validateSelection("task-1", selection, false), /已变化/);
});

test("a changed failure or resumed task needs fresh analysis before queueing", async () => {
  const { service, loaded } = fixture();
  loaded.failureFingerprint = "new-failure";
  await assert.rejects(service.validateSelection("task-1", selection), /已变化/);
  loaded.failureFingerprint = "failure-1";
  loaded.task.status = "running";
  await assert.rejects(service.validateSelection("task-1", selection), /状态已变化/);
});

test("selected chapter repair snapshots first, carries the approved instructions and pauses for review", async (t) => {
  const { service, writes } = fixture();
  const original = sharedServices.getSharedNovelServices;
  t.after(() => { sharedServices.getSharedNovelServices = original; });
  const calls = [];
  sharedServices.getSharedNovelServices = () => ({
    createNovelSnapshot: async (...args) => { calls.push(["snapshot", args]); },
    ensureChapterExecutionContract: async (...args) => { calls.push(["repair", args]); },
  });
  const handled = await service.applySelected("task-1", selection, async () => assert.fail("Unexpected broader repair"));
  assert.equal(handled, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["snapshot", "repair"]);
  assert.equal(calls[1][1][1], "chapter-1");
  assert.equal(calls[1][1][2].forceRefresh, true);
  assert.match(calls[1][1][2].guidance, /三人容量/);
  assert.match(calls[1][1][2].guidance, /保留现有正文，不重写大纲主线/);
  assert.equal(writes.find(([kind]) => kind === "review")[1].checkpointType, "step_review_required");
  assert.ok(writes.at(-1)[1].seedPayload.conflictRecovery.appliedAt);
});

test("technical retry leaves creative content alone", async () => {
  const { service, record, writes } = fixture();
  record.plan.options = [option("retry")];
  assert.equal(await service.applySelected("task-1", selection, async () => assert.fail("Unexpected repair")), false);
  assert.deepEqual(writes.map(([kind]) => kind), ["seed"]);
});

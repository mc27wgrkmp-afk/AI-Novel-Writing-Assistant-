const test = require("node:test");
const assert = require("node:assert/strict");
const dbPath = require.resolve("../dist/db/prisma.js");
const events = [];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  prisma: { directorEvent: { create: async (input) => { events.push(input.data); } } },
} };
const { generateChapterTaskSheetDetail, canAutomaticallyResolveContractConflict } = require("../dist/services/novel/volume/chapterDetail/chapterExecutionContractGeneration.js");
const { ChapterTaskSheetQualityGateService } = require("../dist/services/novel/volume/ChapterTaskSheetQualityGateService.js");
const runner = require("../dist/prompting/core/promptRunner.js");
const blocks = require("../dist/prompting/prompts/novel/volume/contextBlocks.js");

const localConflict = {
  status: "repairable", canEnterExecution: true, recommendedHandling: "repair_contract",
  summary: "诱饵撤离路径没有交代", repairGuidance: ["主角在判定结束前沿已验证路径进入缝隙"],
  issues: [], confidence: 0.9,
};
const passed = { ...localConflict, status: "passed", recommendedHandling: "use_as_is", repairGuidance: [], summary: "因果完整" };
function generated() {
  return {
    purpose: "引开危险", exclusiveEvent: "第一次轮换", endingState: "全员存活", nextChapterEntryState: "准备转移",
    conflictLevel: 3, revealLevel: 2, targetWordCount: 3000, mustAvoid: "不要新增能力", payoffRefs: [], taskSheet: "按已知规则轮换诱饵",
    sceneCards: [1, 2, 3].map((n) => ({ key: `s${n}`, title: `场景${n}`, purpose: "轮换保护",
      mustAdvance: ["主角撤回保护位置"], mustPreserve: ["已有规则"], entryState: "受到威胁", exitState: "完成轮换",
      forbiddenExpansion: ["不得新增免疫能力"], targetWordCount: 1000 })),
  };
}
function mock(t, assessments) {
  events.length = 0;
  const previous = [runner.runStructuredPrompt, blocks.buildVolumeChapterDetailContextBlocks, ChapterTaskSheetQualityGateService.prototype.evaluate];
  const inputs = [];
  runner.runStructuredPrompt = async (input) => { inputs.push(input.promptInput); return { output: generated() }; };
  blocks.buildVolumeChapterDetailContextBlocks = () => [];
  ChapterTaskSheetQualityGateService.prototype.evaluate = async () => assessments.shift();
  t.after(() => {
    [runner.runStructuredPrompt, blocks.buildVolumeChapterDetailContextBlocks, ChapterTaskSheetQualityGateService.prototype.evaluate] = previous;
  });
  return inputs;
}
const input = (options = {}) => ({
  promptInput: { novel: {}, workspace: { novelId: "novel-1" }, storyMacroPlan: null, strategyPlan: null,
    targetVolume: { id: "volume-1" }, targetBeatSheet: null,
    targetChapter: { id: "chapter-1", chapterOrder: 6, title: "轮换诱饵", summary: "零牺牲过关", targetWordCount: 3000 },
    detailMode: "task_sheet" },
  options: { entrypoint: "auto_director", taskId: "task-1", ...options },
});

test("automatic local repair uses structured assessment, excludes replan and manual editing", () => {
  assert.equal(canAutomaticallyResolveContractConflict(localConflict, { entrypoint: "auto_director" }), true);
  assert.equal(canAutomaticallyResolveContractConflict({ ...localConflict, recommendedHandling: "replan_window" }, { entrypoint: "auto_director" }), false);
  assert.equal(canAutomaticallyResolveContractConflict(localConflict, { chapterTaskSheetQualityMode: "manual" }), false);
});
test("AI fixes a local conflict from the previous draft and returns without a manual gate", async (t) => {
  const inputs = mock(t, [localConflict, passed]);
  const result = await generateChapterTaskSheetDetail(input());
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].guidance, /大纲主线/);
  assert.match(inputs[1].guidance, /主角在判定结束前/);
  assert.equal(inputs[1].targetChapter.taskSheet, "按已知规则轮换诱饵");
  assert.equal(result.taskSheet, "按已知规则轮换诱饵");
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "info");
});
test("residual local advice is retained for execution after two AI repairs", async (t) => {
  const inputs = mock(t, [localConflict, localConflict, localConflict]);
  const result = await generateChapterTaskSheetDetail(input());
  assert.equal(inputs.length, 3);
  assert.match(result.taskSheet, /主角在判定结束前/);
  assert.equal(events[0].severity, "warning");
});
test("explicit replan decisions still stop instead of silently changing the mainline", async (t) => {
  mock(t, [{ ...localConflict, recommendedHandling: "replan_window" }]);
  await assert.rejects(generateChapterTaskSheetDetail(input()), /诱饵撤离/);
  assert.equal(events.length, 0);
});
test("manual workflows keep their confirmation boundary", async (t) => {
  const inputs = mock(t, [{ ...localConflict, status: "needs_confirmation", canEnterExecution: false }]);
  await assert.rejects(generateChapterTaskSheetDetail(input({ entrypoint: "manual", chapterTaskSheetQualityMode: "manual" })), /诱饵撤离/);
  assert.equal(inputs.length, 1);
});

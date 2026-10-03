const test = require("node:test");
const assert = require("node:assert/strict");
// These are service contract tests; never initialize or mutate a user's database.
const prismaPath = require.resolve("../dist/db/prisma.js");
require.cache[prismaPath] = {
  id: prismaPath, filename: prismaPath, loaded: true,
  exports: { prisma: { novelWorkflowTask: {}, novel: {}, $transaction: undefined } },
};
const {
  normalizeDirectorRunMode,
  applyDirectorRunModeContract,
} = require("../dist/services/novel/director/runtime/novelDirectorHelpers.js");
const { NovelDirectorContinueRuntime } = require("../dist/services/novel/director/runtime/novelDirectorContinueRuntime.js");
const { NovelDirectorAutoExecutionRuntime } = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionRuntime.js");
const { DirectorProductionExperienceService, buildProductionExperienceSeed } = require("../dist/services/novel/director/commands/DirectorProductionExperienceService.js");
const { prisma } = require("../dist/db/prisma.js");

for (const runMode of ["auto_to_ready", "auto_to_execution", "full_book_autopilot"]) {
  test(`${runMode} retains selected planning scope without starting prose`, async () => {
    const plan = { mode: "chapter_range", startOrder: 4, endOrder: 9 };
    const request = applyDirectorRunModeContract({ runMode, autoExecutionPlan: plan });
    assert.equal(request.runMode, "auto_to_ready");
    assert.deepEqual(request.autoExecutionPlan, plan);
    const runtime = new NovelDirectorAutoExecutionRuntime(new Proxy({}, {
      get() { throw new Error("prose runtime dependencies must not be accessed"); },
    }));
    await assert.rejects(runtime.runFromReady({ taskId: "task", novelId: "book", request }), /止于大纲与章节剧本/);
  });
}
test("stage review remains available during planning", () => {
  assert.equal(normalizeDirectorRunMode("stage_review"), "stage_review");
});

for (const checkpointType of ["production_experience_required", "chapter_batch_ready", "replan_required"]) {
  test(`legacy ${checkpointType} continuation prepares scripts instead of resuming prose`, async () => {
    let background;
    let pipelineInput;
    const directorInput = { runMode: "full_book_autopilot", candidate: { workingTitle: "故事" }, autoExecutionPlan: { mode: "chapter_range", startOrder: 4, endOrder: 9 } };
    const runtime = new NovelDirectorContinueRuntime({
      workflowService: {
        getTaskById: async () => ({ lane: "auto_director", status: "waiting_approval", novelId: "book", checkpointType, currentStage: "chapter_execution", seedPayloadJson: JSON.stringify({ directorInput }) }),
        bootstrapTask: async () => {},
        markTaskRunning: async () => {},
      },
      directorRuntime: { initializeRun: async () => {}, recordRunResumed: async () => {} },
      continueCandidateStageTask: async () => false,
      resolveAssetFirstRecovery: async () => null,
      assertHighMemoryStartAllowed: async () => {},
      buildDirectorSeedPayload: (request, novelId, extra) => ({ directorInput: request, novelId, ...extra }),
      scheduleBackgroundRun: (_taskId, runner) => { background = runner; },
      runDirectorPipeline: async (input) => { pipelineInput = input; },
      autoExecutionRuntime: { runFromReady: async () => assert.fail("must not resume prose") },
    });
    await runtime.continueTask("task", { continuationMode: "auto_execute_range" });
    await background();
    assert.equal(pipelineInput.startPhase, "structured_outline");
    assert.equal(pipelineInput.input.runMode, "auto_to_ready");
    assert.deepEqual(pipelineInput.input.autoExecutionPlan, directorInput.autoExecutionPlan);
  });
}

test("choosing a creation interface saves preference and never queues generation", async () => {
  const original = {
    findUnique: prisma.novelWorkflowTask.findUnique,
    taskUpdate: prisma.novelWorkflowTask.update,
    novelUpdate: prisma.novel.update,
    transaction: prisma.$transaction,
  };
  const seed = { directorInput: { runMode: "full_book_autopilot", autoExecutionPlan: { mode: "chapter_range", startOrder: 4, endOrder: 9 } } };
  let savedSeed;
  prisma.novelWorkflowTask.findUnique = async () => ({ id: "task", novelId: "book", lane: "auto_director", checkpointType: "workflow_completed", seedPayloadJson: JSON.stringify(seed) });
  prisma.novelWorkflowTask.update = async ({ data }) => { savedSeed = JSON.parse(data.seedPayloadJson); };
  prisma.novel.update = async () => {};
  prisma.$transaction = async (calls) => Promise.all(calls);
  try {
    const service = new DirectorProductionExperienceService({ enqueueContinueCommand: () => assert.fail("must not queue generation") });
    const result = await service.select("task", "professional");
    assert.equal(result.backgroundStarted, false);
    assert.equal(result.commandId, undefined);
    assert.equal(savedSeed.directorInput.runMode, "auto_to_ready");
    assert.deepEqual(savedSeed.directorInput.autoExecutionPlan, seed.directorInput.autoExecutionPlan);
    assert.equal(buildProductionExperienceSeed(seed, "simple").productionExperience, "simple");
  } finally {
    prisma.novelWorkflowTask.findUnique = original.findUnique;
    prisma.novelWorkflowTask.update = original.taskUpdate;
    prisma.novel.update = original.novelUpdate;
    prisma.$transaction = original.transaction;
  }
});

function createChapter(id, order, title) {
  return {
    id,
    chapterOrder: order,
    title,
    summary: `${title} summary`,
    purpose: null,
    exclusiveEvent: null,
    endingState: null,
    nextChapterEntryState: null,
    conflictLevel: null,
    revealLevel: null,
    targetWordCount: null,
    mustAvoid: null,
    taskSheet: null,
    sceneCards: null,
    payoffRefs: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBeatSheet() {
  return {
    volumeId: "volume-1",
    volumeSortOrder: 1,
    status: "generated",
    beats: [
      {
        key: "opening",
        label: "Opening",
        summary: "Opening summary",
        chapterSpanHint: "1-2章",
        mustDeliver: ["Opening"],
      },
    ],
  };
}

function createSceneCards(chapter) {
  return JSON.stringify({
    targetWordCount: chapter.targetWordCount ?? 3000,
    lengthBudget: {
      targetWordCount: chapter.targetWordCount ?? 3000,
      softMinWordCount: 2500,
      softMaxWordCount: 3400,
      hardMaxWordCount: 3800,
    },
    scenes: [
      {
        key: `${chapter.id}-scene-1`,
        title: `${chapter.title} scene 1`,
        purpose: "推进本章目标",
        mustAdvance: ["主线"],
        mustPreserve: ["人物动机"],
        entryState: "进入冲突",
        exitState: "压力升级",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
      {
        key: `${chapter.id}-scene-2`,
        title: `${chapter.title} scene 2`,
        purpose: "升级选择压力",
        mustAdvance: ["冲突"],
        mustPreserve: ["设定边界"],
        entryState: "压力升级",
        exitState: "代价显形",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
      {
        key: `${chapter.id}-scene-3`,
        title: `${chapter.title} scene 3`,
        purpose: "形成章末钩子",
        mustAdvance: ["章末推进"],
        mustPreserve: ["后续入口"],
        entryState: "代价显形",
        exitState: "进入下一章",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
    ],
  });
}

function applyCompleteChapterDetail(chapter) {
  chapter.purpose = `${chapter.title} purpose`;
  chapter.exclusiveEvent = `${chapter.title} exclusive event`;
  chapter.endingState = `${chapter.title} ending state`;
  chapter.nextChapterEntryState = `${chapter.title} next entry`;
  chapter.conflictLevel = 4;
  chapter.revealLevel = 3;
  chapter.targetWordCount = 3000;
  chapter.mustAvoid = `${chapter.title} avoid`;
  chapter.taskSheet = `${chapter.title} task sheet`;
  chapter.sceneCards = createSceneCards(chapter);
}

function mapWorkspaceChapterToExecution(chapter) {
  return {
    id: chapter.id,
    order: chapter.chapterOrder,
    content: "",
    generationState: "planned",
    chapterStatus: "unplanned",
    conflictLevel: chapter.conflictLevel,
    revealLevel: chapter.revealLevel,
    targetWordCount: chapter.targetWordCount,
    mustAvoid: chapter.mustAvoid,
    taskSheet: chapter.taskSheet,
    sceneCards: chapter.sceneCards,
  };
}


const { runDirectorStructuredOutlinePhase } = require("../dist/services/novel/director/phases/novelDirectorStructuredOutlinePhase.js");
for (const runMode of ["auto_to_ready", "full_book_autopilot"]) {
  test(`${runMode} prepares default ten chapter scripts and completes planning without resetting prose`, async () => {
    let workspace = {
      novelId: "book", beatSheets: [{ ...createBeatSheet(), beats: [{ ...createBeatSheet().beats[0], chapterSpanHint: "1-10章" }] }],
      volumes: [{ id: "volume-1", sortOrder: 1, title: "首卷", chapters: Array.from({ length: 10 }, (_, index) => ({ ...createChapter(`chapter-${index + 1}`, index + 1, `事件${index + 1}`), beatKey: "opening" })) }],
    };
    const generated = [];
    let checkpoint;
    const volumeService = {
      generateVolumes: async (_novelId, options) => {
        assert.equal(options.scope, "chapter_detail");
        const next = clone(options.draftWorkspace);
        const chapter = next.volumes[0].chapters.find((item) => item.id === options.targetChapterId);
        applyCompleteChapterDetail(chapter);
        generated.push(chapter.id);
        return next;
      },
      updateVolumesWithOptions: async (_novelId, next) => { workspace = clone(next); return workspace; },
      syncVolumeChaptersWithOptions: async (_novelId, input) => {
        assert.equal(input.preserveContent, true);
        assert.equal(input.applyDeletes, false);
      },
    };
    await runDirectorStructuredOutlinePhase({
      taskId: "task", novelId: "book", request: { runMode, candidate: { workingTitle: "故事" } }, baseWorkspace: workspace,
      dependencies: {
        volumeService,
        workflowService: { bootstrapTask: async () => {}, markTaskRunning: async () => {}, recordCheckpoint: async (_id, value) => { checkpoint = value; } },
        novelContextService: {
          listChapters: async () => workspace.volumes[0].chapters.map((chapter) => ({ ...mapWorkspaceChapterToExecution(chapter), content: "作者原有正文" })),
          updateNovel: async (_novelId, patch) => assert.notEqual(patch.projectStatus, "completed"),
        },
      },
      callbacks: { markDirectorTaskRunning: async () => {}, buildDirectorSeedPayload: (_request, novelId, extra) => ({ novelId, ...extra }) },
    });
    assert.equal(generated.length, 10);
    assert.equal(checkpoint.stage, "structured_outline");
    assert.equal(checkpoint.checkpointType, "workflow_completed");
    assert.equal(checkpoint.progress, 1);
    assert.equal(checkpoint.seedPayload.directorSession.isBackgroundRunning, false);
    assert.equal(checkpoint.seedPayload.directorSession.phase, "structured_outline");
    assert.equal(checkpoint.seedPayload.autoExecution.enabled, false);
    assert.match(checkpoint.itemLabel, /章节剧本已完成/);
  });
}

const { NovelDirectorPipelineRuntime } = require("../dist/services/novel/director/novelDirectorPipelineRuntime.js");
test("explicit legacy execution approval cannot dispatch prose after script completion", async () => {
  const steps = [];
  const runtime = new NovelDirectorPipelineRuntime({
    runtimeOrchestrator: {
      runStepModule: async ({ module }) => { steps.push(module.id); },
      runChapterExecutionNode: async () => assert.fail("completed scripts must never dispatch prose"),
    },
  });
  runtime.resolveSafePipelineStartPhase = async () => "structured_outline";
  runtime.loadVolumeWorkspaceForOutline = async () => ({ volumes: [{ id: "volume-1" }] });
  runtime.runStructuredOutlineNode = async () => false;
  runtime.isModuleFactCompleted = async () => false;
  await runtime.runPipeline({
    taskId: "task", novelId: "book", startPhase: "structured_outline",
    input: { runMode: "full_book_autopilot" },
    approveCurrentGate: true, approveAutoExecutionScope: true,
  });
  assert.equal(steps.length, 1);
});

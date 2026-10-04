const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../dist/db/prisma.js");
const prisma = { novelWorkflowTask: {}, chapter: {}, volumePlanVersion: {}, $transaction: null };
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma } };
const { prepareScriptBatch, advanceScriptBatch, hashScriptBatchArtifacts } = require("../dist/services/novel/director/commands/scriptBatches/ScriptBatchState.js");
const { DirectorScriptBatchAcceptanceService } = require("../dist/services/novel/director/commands/scriptBatches/DirectorScriptBatchAcceptanceService.js");
const { NovelDirectorContinueRuntime } = require("../dist/services/novel/director/runtime/novelDirectorContinueRuntime.js");
const { DirectorCommandService } = require("../dist/services/novel/director/commands/DirectorCommandService.js");

function chapters(startOrder, endOrder) {
  return Array.from({ length: endOrder - startOrder + 1 }, (_, index) => ({ id: `chapter-${startOrder + index}`, order: startOrder + index, title: `事件${startOrder + index}`, taskSheet: "人物行动、阻碍、选择和结果", sceneCards: JSON.stringify({ scenes: Array.from({ length: 3 }, (_, sceneIndex) => ({ key: `scene-${sceneIndex}`, title: "入场", purpose: "行动导致变化", entryState: "尚未找到线索", exitState: "线索引出新目标", targetWordCount: 800 })) }) }));
}
function fixture(scope = { startOrder: 1, endOrder: 7 }) {
  const batch = { ...prepareScriptBatch(scope), status: "waiting_acceptance" };
  const data = chapters(batch.startOrder, batch.endOrder);
  const workspace = { volumes: [{ id: "volume-1", chapters: data.map((chapter) => ({ ...chapter, chapterOrder: chapter.order, summary: "完整的大纲事件" })) }] };
  prisma.volumePlanVersion.findFirst = async () => ({ contentJson: JSON.stringify(workspace) });
  batch.artifactHash = hashScriptBatchArtifacts(data, batch, workspace);
  const row = { id: "task", lane: "auto_director", novelId: "book", checkpointType: "chapter_script_batch_ready", status: "waiting_approval", seedPayloadJson: JSON.stringify({ scriptBatch: batch, scriptBatchScope: scope, directorInput: { runMode: "auto_to_ready", candidate: { workingTitle: "故事" } } }) };
  const queued = [];
  prisma.novelWorkflowTask.findUnique = async () => row;
  prisma.chapter.findMany = async () => data;
  prisma.novelWorkflowTask.updateMany = async ({ where, data: patch }) => {
    if (where.seedPayloadJson !== row.seedPayloadJson || where.checkpointType !== row.checkpointType || where.status !== row.status || row.cancelRequestedAt) return { count: 0 };
    Object.assign(row, patch);
    return { count: 1 };
  };
  prisma.$transaction = async (runner) => runner(prisma);
  const service = new DirectorScriptBatchAcceptanceService({ enqueueAcceptedScriptBatchCommand: async (_id, input) => { queued.push(input); return { commandId: "next-command" }; } });
  return { row, data, batch, queued, service, scope, workspace };
}

test("batches follow 1-3, 4-6, 7 with preserved selected scope", () => {
  const scope = { startOrder: 1, endOrder: 7 };
  const first = prepareScriptBatch(scope);
  const second = advanceScriptBatch(first, scope);
  const third = advanceScriptBatch(second, scope);
  const final = advanceScriptBatch(third, scope);
  assert.deepEqual([first.startOrder, first.endOrder, second.startOrder, second.endOrder, third.startOrder, third.endOrder], [1, 3, 4, 6, 7, 7]);
  assert.equal(final.status, "all_accepted");
  const explicit = prepareScriptBatch({ startOrder: 4, endOrder: 9 });
  assert.equal(explicit.startOrder, 4);
  assert.equal(explicit.endOrder, 6);
  assert.equal(explicit.totalChapterCount, 6);
  assert.equal(explicit.acceptedThroughChapterOrder, 3);
});

test("accepting the current artifacts queues only the next planning batch", async () => {
  const { service, batch, row, queued } = fixture();
  const result = await service.accept("task", batch);
  assert.equal(result.completed, false);
  assert.equal(result.acceptedThroughChapterOrder, 3);
  assert.equal(result.scriptBatch.startOrder, 4);
  assert.equal(result.scriptBatch.endOrder, 6);
  assert.equal(result.scriptBatch.status, "preparing");
  assert.equal(row.checkpointType, null);
  assert.equal(queued.length, 1);
  assert.deepEqual(JSON.parse(row.seedPayloadJson).directorInput.autoExecutionPlan, { mode: "chapter_range", startOrder: 4, endOrder: 6 });
  await assert.rejects(service.accept("task", batch), /已经验收/);
  assert.equal(queued.length, 1);
});

test("final batch becomes completed only after explicit acceptance", async () => {
  const { service, batch, row, queued } = fixture({ startOrder: 4, endOrder: 6 });
  const result = await service.accept("task", batch);
  assert.equal(result.completed, true);
  assert.equal(result.scriptBatch.status, "all_accepted");
  assert.equal(row.status, "succeeded");
  assert.equal(row.checkpointType, "workflow_completed");
  assert.equal(queued.length, 0);
});

test("stale artifact hash cannot accept modified scripts; fresh read can", async () => {
  const { service, batch, data, row } = fixture();
  const originalSeed = row.seedPayloadJson;
  data[1].taskSheet = "修改后的完整行动链";
  await assert.rejects(service.accept("task", batch), /已修改/);
  assert.equal(row.seedPayloadJson, originalSeed);
  const current = await service.inspect("task");
  assert.notEqual(current.artifactHash, batch.artifactHash);
  const result = await service.accept("task", current);
  assert.equal(result.acceptedThroughChapterOrder, 3);
});

test("missing scripts and changed ranges cannot be accepted", async () => {
  const { service, batch, data } = fixture();
  await assert.rejects(service.accept("task", { ...batch, endOrder: 6 }), /范围已变化/);
  data[2].sceneCards = "";
  await assert.rejects(service.accept("task", batch), /剧本不完整/);
});

test("concurrent acceptance loses CAS and never queues another batch", async () => {
  const { service, batch, queued } = fixture();
  prisma.novelWorkflowTask.updateMany = async () => ({ count: 0 });
  await assert.rejects(service.accept("task", batch), /状态已变化/);
  assert.equal(queued.length, 0);
});

test("forced legacy continue cannot bypass pending acceptance", async () => {
  const { row } = fixture();
  const runtime = new NovelDirectorContinueRuntime({ workflowService: { getTaskById: async () => row }, directorRuntime: { initializeRun: () => assert.fail("must not mutate pending review") } });
  await assert.rejects(runtime.continueTask("task", { forceResume: true, continuationMode: "auto_execute_range" }), /先检查并验收/);
});

test("queue entry rejects generic recovery while scripts await acceptance", async () => {
  const { row } = fixture();
  const service = new DirectorCommandService({ getTaskById: async () => row });
  await assert.rejects(service.enqueueContinueCommand("task", { forceResume: true }), /先检查并验收/);
  await assert.rejects(service.enqueueApproveGateCommand("task"), /先检查并验收/);
});

test("outline edits invalidate the reviewed snapshot and empty outlines block acceptance", async () => {
  const { service, batch, workspace } = fixture();
  workspace.volumes[0].chapters[0].summary = "重新安排的桥段";
  await assert.rejects(service.accept("task", batch), /已修改/);
  workspace.volumes[0].chapters[0].summary = "";
  await assert.rejects(service.accept("task", batch), /剧本不完整/);
});

test("invalid or empty scene cards block acceptance", async () => {
  for (const value of ["not-json", JSON.stringify({ scenes: [] }), JSON.stringify({ scenes: [null, null, null] }), JSON.stringify({ scenes: [{ title: "缺少行动和结果" }] })]) {
    const { service, batch, data } = fixture();
    data[0].sceneCards = value;
    await assert.rejects(service.accept("task", batch), /剧本不完整/);
  }
});


test("canceled or failed tasks retaining a checkpoint cannot accept or enqueue", async () => {
  for (const patch of [{ status: "cancelled" }, { status: "failed" }, { cancelRequestedAt: new Date() }]) {
    const { service, batch, row, queued } = fixture();
    Object.assign(row, patch);
    await assert.rejects(service.accept("task", batch), /未处于可验收状态/);
    assert.equal(queued.length, 0);
  }
});

const { DirectorCommandLeaseService } = require("../dist/services/novel/director/commands/leases/DirectorCommandLeaseService.js");
test("an active prior command cannot consume accepted batch continuation or overlap its lease", async () => {
  const { row } = fixture();
  const seed = JSON.parse(row.seedPayloadJson);
  seed.scriptBatch = advanceScriptBatch(seed.scriptBatch, seed.scriptBatchScope);
  row.seedPayloadJson = JSON.stringify(seed);
  const old = { id: "old-confirm", taskId: "task", novelId: "book", commandType: "confirm_candidate", status: "running" };
  const commands = [old];
  let creates = 0;
  let candidateGuards = 0;
  let claimGuards = 0;
  prisma.directorRunCommand = {
    findFirst: async ({ where }) => {
      if (where.task) {
        assert.deepEqual(where.task.directorCommands.none.status.in, ["leased", "running"]);
        candidateGuards += 1;
        if (commands.some((command) => ["leased", "running"].includes(command.status))) return null;
        return commands.find((command) => command.status === "queued") ?? null;
      }
      return commands.find((command) => command.commandType === where.commandType && command.payloadJson === where.payloadJson && where.status.in.includes(command.status)) ?? null;
    },
    create: async ({ data }) => {
      creates += 1;
      const created = { id: "next-batch", ...data, leaseExpiresAt: null };
      commands.push(created);
      return created;
    },
    updateMany: async ({ where, data }) => {
      assert.deepEqual(where.task.directorCommands.none.status.in, ["leased", "running"]);
      claimGuards += 1;
      if (commands.some((command) => ["leased", "running"].includes(command.status))) return { count: 0 };
      Object.assign(commands.find((command) => command.id === where.id), data);
      return { count: 1 };
    },
    findUnique: async ({ where }) => commands.find((command) => command.id === where.id) ?? null,
  };
  const service = new DirectorCommandService({ getTaskById: async () => row });
  service.recoverStaleLeases = async () => 0;
  service.markCommandAcceptedOnTask = async () => { row.status = "queued"; };
  const accepted = { acceptedThroughChapterOrder: 3, artifactHash: "a".repeat(64) };
  const first = await service.enqueueAcceptedScriptBatchCommand("task", accepted);
  const duplicate = await service.enqueueAcceptedScriptBatchCommand("task", accepted);
  assert.equal(first.commandId, "next-batch");
  assert.equal(duplicate.commandId, "next-batch");
  assert.equal(creates, 1);
  assert.equal(old.status, "running");
  const lease = new DirectorCommandLeaseService({});
  assert.equal(await lease.leaseNextCommand({ workerId: "worker", leaseMs: 1000 }), null);
  old.status = "succeeded";
  const next = await lease.leaseNextCommand({ workerId: "worker", leaseMs: 1000 });
  assert.equal(next.id, "next-batch");
  assert.equal(candidateGuards, 2);
  assert.equal(claimGuards, 1);
});

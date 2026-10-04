const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../dist/db/prisma.js");
require.cache[prismaPath] = {
  id: prismaPath, filename: prismaPath, loaded: true,
  exports: { prisma: new Proxy({}, { get() { throw new Error("acceptance checkpoint must not query legacy prose jobs"); } }) },
};
const { syncActiveAutoDirectorAutoExecutionTaskState } = require("../dist/services/novel/workflow/novelWorkflowAutoDirectorReconciliation.js");
const { resolveWorkflowStageFromCheckpoint, resolveWorkflowApprovalPointForCheckpoint } = require("../../shared/dist/types/directorWorkflowStepCatalog.js");

test("legacy prose reconciliation cannot clear a waiting script batch", async () => {
  const result = await syncActiveAutoDirectorAutoExecutionTaskState({
    taskId: "task", row: {
      lane: "auto_director", novelId: "book", status: "waiting_approval",
      checkpointType: "chapter_script_batch_ready",
      seedPayloadJson: JSON.stringify({ autoExecution: { pipelineJobId: "legacy-job" } }),
    },
  });
  assert.deepEqual(result, { active: false, healed: false });
});

test("script batch checkpoint belongs to structured planning and has no automatic approval", () => {
  assert.equal(resolveWorkflowStageFromCheckpoint({ checkpointType: "chapter_script_batch_ready" }), "structured_outline");
  assert.equal(resolveWorkflowApprovalPointForCheckpoint("chapter_script_batch_ready"), null);
});

const { NovelWorkflowApplicationService } = require("../dist/services/novel/workflow/NovelWorkflowApplicationService.js");
const waitingTask = {
  id: "task", novelId: "book", lane: "auto_director", status: "waiting_approval",
  checkpointType: "chapter_script_batch_ready",
  seedPayloadJson: JSON.stringify({ scriptBatch: { status: "waiting_acceptance" } }),
};
const application = new NovelWorkflowApplicationService({
  getTaskById: async () => waitingTask,
  updateTaskWithRetry: async () => assert.fail("generic mutation must not advance acceptance"),
  updateWorkflowTaskWithNotifications: async () => assert.fail("generic mutation must not advance acceptance"),
});

test("generic bootstrap cannot replace the waiting batch seed", async () => {
  await assert.rejects(application.bootstrapTask({ workflowTaskId: "task", lane: "auto_director", seedPayload: { scriptBatch: { status: "preparing" } } }), /验收本批/);
});

test("generic running and checkpoint writes cannot clear manual acceptance", async () => {
  await assert.rejects(application.markTaskRunning("task", { stage: "structured_outline", clearCheckpoint: true, itemLabel: "下一批" }), /验收本批/);
  await assert.rejects(application.recordCheckpoint("task", { stage: "structured_outline", checkpointType: "workflow_completed", checkpointSummary: "完成", itemLabel: "完成" }), /验收本批/);
});

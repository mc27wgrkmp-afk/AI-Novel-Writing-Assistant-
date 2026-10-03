const test = require("node:test");
const assert = require("node:assert/strict");

const { MANUAL_PROSE_HANDOFF_MESSAGE } = require("../dist/services/novel/production/authoring/index.js");

const {
  NovelPipelineRuntimeService,
} = require("../dist/services/novel/NovelPipelineRuntimeService.js");

test("resumePendingPipelineJobs hands old queued and running prose jobs back to the author after restart", async () => {
  const calls = [];
  const runtimeService = new NovelPipelineRuntimeService({
    async listPendingCancellationPipelineJobs() {
      return [];
    },
    async listRecoverablePipelineJobs() {
      return [
        { id: "job-queued", status: "queued" },
        { id: "job-running", status: "running" },
      ];
    },
    async listStaleRecoverablePipelineJobs() {
      return [];
    },
    async markPipelineJobCancelled(jobId) {
      calls.push(["cancelled", jobId]);
    },
    async resumePipelineJob(jobId) {
      calls.push(["resume", jobId]);
    },
    async markPipelineJobFailed(jobId, message) {
      calls.push(["failed", jobId, message]);
    },
    async markPipelineJobPendingManualRecovery(jobId, message) {
      calls.push(["pending", jobId, message]);
    },
  });

  await runtimeService.resumePendingPipelineJobs();

  assert.deepEqual(calls, [
    ["pending", "job-queued", MANUAL_PROSE_HANDOFF_MESSAGE],
    ["pending", "job-running", MANUAL_PROSE_HANDOFF_MESSAGE],
  ]);
});

test("resumePendingPipelineJobs settles pending cancellations before handing back old prose jobs", async () => {
  const calls = [];
  const runtimeService = new NovelPipelineRuntimeService({
    async listPendingCancellationPipelineJobs() {
      return [{ id: "job-cancelling", status: "cancelled" }];
    },
    async listRecoverablePipelineJobs() {
      return [{ id: "job-running", status: "running" }];
    },
    async listStaleRecoverablePipelineJobs() {
      return [];
    },
    async markPipelineJobCancelled(jobId) {
      calls.push(["cancelled", jobId]);
    },
    async resumePipelineJob(jobId) {
      calls.push(["resume", jobId]);
    },
    async markPipelineJobFailed(jobId, message) {
      calls.push(["failed", jobId, message]);
    },
    async markPipelineJobPendingManualRecovery(jobId, message) {
      calls.push(["pending", jobId, message]);
    },
  });

  await runtimeService.resumePendingPipelineJobs();

  assert.deepEqual(calls, [
    ["cancelled", "job-cancelling"],
    ["pending", "job-running", MANUAL_PROSE_HANDOFF_MESSAGE],
  ]);
});

test("recoverStalePipelineJobs preserves a manual recovery checkpoint when resume throws", async () => {
  const calls = [];
  const runtimeService = new NovelPipelineRuntimeService({
    async listPendingCancellationPipelineJobs() {
      return [];
    },
    async listRecoverablePipelineJobs() {
      return [];
    },
    async listStaleRecoverablePipelineJobs() {
      return [{ id: "job-stale", status: "running" }];
    },
    async markPipelineJobCancelled(jobId) {
      calls.push(["cancelled", jobId]);
    },
    async resumePipelineJob() {
      throw new Error("缺少章节上下文");
    },
    async markPipelineJobFailed(jobId, message) {
      calls.push(["failed", jobId, message]);
    },
    async markPipelineJobPendingManualRecovery(jobId, message) {
      calls.push(["pending", jobId, message]);
    },
  });

  await runtimeService.recoverStalePipelineJobs(new Date("2026-04-03T00:00:00+08:00"), 60_000);

  assert.deepEqual(calls, [
    ["pending", "job-stale", MANUAL_PROSE_HANDOFF_MESSAGE],
  ]);
});

test("markPendingPipelineJobsForManualRecovery settles cancellations and marks recoverable jobs", async () => {
  const calls = [];
  const runtimeService = new NovelPipelineRuntimeService({
    async listPendingCancellationPipelineJobs() {
      return [{ id: "job-cancelling", status: "cancelled" }];
    },
    async listRecoverablePipelineJobs() {
      return [
        { id: "job-queued", status: "queued" },
        { id: "job-running", status: "running" },
      ];
    },
    async listStaleRecoverablePipelineJobs() {
      return [];
    },
    async markPipelineJobCancelled(jobId) {
      calls.push(["cancelled", jobId]);
    },
    async markPipelineJobPendingManualRecovery(jobId, message) {
      calls.push(["pending", jobId, message]);
    },
    async resumePipelineJob(jobId) {
      calls.push(["resume", jobId]);
    },
    async markPipelineJobFailed(jobId, message) {
      calls.push(["failed", jobId, message]);
    },
  });

  await runtimeService.markPendingPipelineJobsForManualRecovery();

  assert.deepEqual(calls, [
    ["cancelled", "job-cancelling"],
    ["pending", "job-queued", MANUAL_PROSE_HANDOFF_MESSAGE],
    ["pending", "job-running", MANUAL_PROSE_HANDOFF_MESSAGE],
  ]);
});

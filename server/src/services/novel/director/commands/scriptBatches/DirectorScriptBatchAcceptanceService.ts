import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import type { DirectorScriptBatchAcceptanceRequest, DirectorScriptBatchAcceptanceResponse, DirectorScriptBatchState } from "@ai-novel/shared/types/novelDirector";
import { prisma } from "../../../../../db/prisma";
import { AppError } from "../../../../../middleware/errorHandler";
import { parseSeedPayload } from "../../../workflow/novelWorkflow.shared";
import type { DirectorWorkflowSeedPayload } from "../../runtime/novelDirectorHelpers";
import { DirectorCommandService } from "../DirectorCommandService";
import { advanceScriptBatch, hashScriptBatchArtifacts } from "./ScriptBatchState";

interface ScriptBatchWorkspacePort {
  volumePlanVersion: {
    findFirst(input: {
      where: { novelId: string; status: "active" };
      orderBy: Array<{ version: "desc" }>;
      select: { contentJson: true };
    }): PromiseLike<{ contentJson: string } | null>;
  };
}

export class DirectorScriptBatchAcceptanceService {
  constructor(private readonly commandService = new DirectorCommandService()) {}

  /** A fresh read hash lets edited scripts be reviewed without changing task state. */
  async inspect(taskId: string): Promise<DirectorScriptBatchState | null> {
    const task = await prisma.novelWorkflowTask.findUnique({ where: { id: taskId } });
    if (!task || task.lane !== "auto_director") throw new AppError("自动导演任务不存在。", 404);
    const seed = parseSeedPayload<DirectorWorkflowSeedPayload>(task.seedPayloadJson) ?? {};
    const batch = seed.scriptBatch;
    if (!batch || batch.status !== "waiting_acceptance" || !task.novelId) return batch ?? null;
    const chapters = await prisma.chapter.findMany({
      where: { novelId: task.novelId, order: { gte: batch.startOrder, lte: batch.endOrder } },
      orderBy: { order: "asc" },
    });
    const workspace = await this.loadWorkspace(task.novelId, prisma);
    return { ...batch, artifactHash: hashScriptBatchArtifacts(chapters, batch, workspace) };
  }

  private async loadWorkspace(novelId: string, db: ScriptBatchWorkspacePort): Promise<Pick<VolumePlanDocument, "volumes">> {
    const version = await db.volumePlanVersion.findFirst({
      where: { novelId, status: "active" }, orderBy: [{ version: "desc" }], select: { contentJson: true },
    });
    if (!version) throw new AppError("章节大纲缺失，请补齐后再验收。", 409);
    try {
      const workspace = JSON.parse(version.contentJson) as Pick<VolumePlanDocument, "volumes">;
      if (!Array.isArray(workspace.volumes)) throw new Error("missing volumes");
      return workspace;
    } catch { throw new AppError("章节大纲无法读取，请修复后再验收。", 409); }
  }

  async accept(taskId: string, input: DirectorScriptBatchAcceptanceRequest): Promise<DirectorScriptBatchAcceptanceResponse> {
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.novelWorkflowTask.findUnique({ where: { id: taskId } });
      if (!task || task.lane !== "auto_director" || !task.novelId) throw new AppError("自动导演任务不存在。", 404);
      if (task.status !== "waiting_approval" || task.cancelRequestedAt) {
        throw new AppError("本任务未处于可验收状态，请先恢复或重新准备本批剧本。", 409);
      }
      const seed = parseSeedPayload<DirectorWorkflowSeedPayload>(task.seedPayloadJson) ?? {};
      const batch = seed.scriptBatch;
      const scope = seed.scriptBatchScope;
      if (task.checkpointType !== "chapter_script_batch_ready" || batch?.status !== "waiting_acceptance" || !scope) {
        throw new AppError("本批剧本未进入验收状态，或已经验收。请刷新后查看。", 409);
      }
      if (input.startOrder !== batch.startOrder || input.endOrder !== batch.endOrder) {
        throw new AppError("待验收章节范围已变化，请刷新后重新检查。", 409);
      }
      const chapters = await tx.chapter.findMany({
        where: { novelId: task.novelId, order: { gte: batch.startOrder, lte: batch.endOrder } },
        orderBy: { order: "asc" },
      });
      const workspace = await this.loadWorkspace(task.novelId, tx);
      const currentHash = hashScriptBatchArtifacts(chapters, batch, workspace);
      if (input.artifactHash !== currentHash) {
        throw new AppError("章节剧本已修改，请刷新并检查最新内容后再验收。", 409);
      }
      const nextBatch = advanceScriptBatch(batch, scope);
      const completed = nextBatch.status === "all_accepted";
      const nextSeed: DirectorWorkflowSeedPayload = {
        ...seed,
        scriptBatch: { ...nextBatch, ...(completed ? { artifactHash: currentHash } : {}) },
        directorInput: seed.directorInput ? {
          ...seed.directorInput,
          runMode: "auto_to_ready",
          autoExecutionPlan: { ...seed.directorInput.autoExecutionPlan, mode: "chapter_range", startOrder: nextBatch.startOrder, endOrder: nextBatch.endOrder },
        } : seed.directorInput,
        directorSession: seed.directorSession ? { ...seed.directorSession, isBackgroundRunning: false, phase: "structured_outline" } : seed.directorSession,
      };
      const updated = await tx.novelWorkflowTask.updateMany({
        where: { id: taskId, status: "waiting_approval", cancelRequestedAt: null, checkpointType: "chapter_script_batch_ready", seedPayloadJson: task.seedPayloadJson },
        data: {
          seedPayloadJson: JSON.stringify(nextSeed),
          status: completed ? "succeeded" : "waiting_approval",
          currentStage: "structured_outline",
          currentItemKey: completed ? "workflow_completed" : "chapter_detail_bundle",
          currentItemLabel: completed ? "所选范围的章节剧本已全部验收" : `第 ${nextBatch.startOrder}-${nextBatch.endOrder} 章剧本待准备`,
          checkpointType: completed ? "workflow_completed" : null,
          checkpointSummary: completed ? "大纲与章节剧本已全部验收，可按剧本创作正文。" : null,
          progress: completed ? 1 : Math.min(0.99, (batch.endOrder - scope.startOrder + 1) / batch.totalChapterCount),
          pendingManualRecovery: false,
          finishedAt: completed ? new Date() : null,
          lastError: null,
        },
      });
      if (updated.count !== 1) throw new AppError("本批剧本状态已变化，请刷新后查看。", 409);
      return { workflowTaskId: taskId, acceptedThroughChapterOrder: batch.endOrder, completed, scriptBatch: nextSeed.scriptBatch! };
    });
    if (result.completed) return result;
    // Acceptance is persisted before scheduling; a retry recovers this same next batch.
    const command = await this.commandService.enqueueAcceptedScriptBatchCommand(taskId, { acceptedThroughChapterOrder: result.acceptedThroughChapterOrder, artifactHash: input.artifactHash });
    return { ...result, commandId: command.commandId };
  }
}

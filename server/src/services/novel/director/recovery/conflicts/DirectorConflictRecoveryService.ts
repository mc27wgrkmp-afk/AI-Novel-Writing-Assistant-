import { createHash, randomUUID } from "node:crypto";
import type { DirectorConflictRecoveryPlan, DirectorConflictRecoveryRecord } from "@ai-novel/shared/types/directorConflictRecovery";
import type { DirectorStepCalibrationRequest } from "@ai-novel/shared/types/novelDirector";
import { prisma } from "../../../../../db/prisma";
import { AppError } from "../../../../../middleware/errorHandler";
import { runStructuredPrompt } from "../../../../../prompting/core/promptRunner";
import { directorConflictRecoveryPrompt } from "../../../../../prompting/prompts/director/conflictRecovery.prompts";
import { getSharedNovelServices } from "../../../application/sharedNovelServices";
import { NovelWorkflowService } from "../../../workflow/NovelWorkflowService";
import { parseSeedPayload, parseResumeTarget } from "../../../workflow/novelWorkflow.shared";
import { getDirectorLlmOptionsFromSeedPayload, type DirectorWorkflowSeedPayload } from "../../runtime/novelDirectorHelpers";
import { DIRECTOR_PLANNING_STEP_IDS, DIRECTOR_STRUCTURED_OUTLINE_STEP_IDS } from "../../workflowStepRuntime/directorWorkflowStepIds";

const allowedStepIds = [
  DIRECTOR_PLANNING_STEP_IDS.story_macro,
  DIRECTOR_PLANNING_STEP_IDS.book_contract,
];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const excerpt = (value: string | null | undefined, limit = 6000) => value?.slice(0, limit) ?? null;
type Selection = { planId: string; optionId: string };

export class DirectorConflictRecoveryService {
  constructor(private readonly workflow = new NovelWorkflowService()) {}

  private async load(taskId: string) {
    const task = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!task?.novelId || task.lane !== "auto_director") {
      throw new AppError("没有找到这本小说的自动导演任务。", 404);
    }
    const seed = parseSeedPayload<DirectorWorkflowSeedPayload>(task.seedPayloadJson) ?? {};
    const targetIds = [parseResumeTarget(task.resumeTargetJson)?.chapterId, seed.resumeTarget?.chapterId,
      seed.autoExecution?.nextChapterId, task.currentItemKey].filter((id): id is string => Boolean(id));
    const target = await prisma.chapter.findFirst({ where: { novelId: task.novelId, id: { in: targetIds } } })
      ?? await prisma.chapter.findFirst({
        where: { novelId: task.novelId, chapterStatus: { in: ["unplanned", "pending_generation", "needs_repair"] } },
        orderBy: { order: "asc" },
      });
    const [novel, chapters] = await Promise.all([
      prisma.novel.findUnique({
        where: { id: task.novelId },
        select: { title: true, description: true, outline: true, structuredOutline: true, updatedAt: true,
          storyMacroPlan: true, bookContract: true,
          volumePlans: { orderBy: { sortOrder: "asc" }, select: {
            id: true, title: true, summary: true, mainPromise: true, protagonistChange: true, climax: true, nextVolumeHook: true,
          } },
        },
      }),
      prisma.chapter.findMany({
        where: { novelId: task.novelId, ...(target ? { order: { gte: Math.max(1, target.order - 1), lte: target.order + 1 } } : {}) },
        orderBy: { order: "asc" }, take: 3,
        select: { id: true, title: true, order: true, expectation: true, taskSheet: true, sceneCards: true,
          content: true, updatedAt: true, volumeChapterPlans: { select: { summary: true, purpose: true } } },
      }),
    ]);
    if (!novel) throw new AppError("小说不存在。", 404);
    const context = {
      novel: { ...novel, outline: excerpt(novel.outline, 12000), structuredOutline: excerpt(novel.structuredOutline, 8000),
        storyMacroPlan: novel.storyMacroPlan ? {
          decomposition: excerpt(novel.storyMacroPlan.decompositionJson, 12000),
          lockedFields: novel.storyMacroPlan.lockedFieldsJson,
          constraints: excerpt(novel.storyMacroPlan.constraintEngineJson),
        } : null,
      },
      failure: { message: task.lastError, checkpointSummary: task.checkpointSummary, currentAction: task.currentItemLabel },
      targetChapterId: target?.id ?? null,
      chapters: chapters.map((chapter) => ({ ...chapter, content: excerpt(chapter.content, 4000),
        taskSheet: excerpt(chapter.taskSheet, 8000), sceneCards: excerpt(chapter.sceneCards, 12000) })),
      allowedStepIds,
    };
    return {
      task, seed, context,
      contentFingerprint: digest({ novel, chapters }),
      failureFingerprint: digest({ error: task.lastError, checkpoint: task.checkpointType, item: task.currentItemKey }),
    };
  }

  private assertNeedsDecision(task: { status: string; pendingManualRecovery: boolean }) {
    if (task.status !== "failed" && !task.pendingManualRecovery) {
      throw new AppError("任务状态已变化，请刷新执行详情后再处理。", 409);
    }
  }

  async getPlan(taskId: string): Promise<DirectorConflictRecoveryPlan | null> {
    const loaded = await this.load(taskId);
    const record = loaded.seed.conflictRecovery;
    return record && !record.selectedOptionId && !record.appliedAt
      && record.contentFingerprint === loaded.contentFingerprint
      && record.failureFingerprint === loaded.failureFingerprint ? record.plan : null;
  }

  async generate(taskId: string, userNote?: string): Promise<DirectorConflictRecoveryPlan> {
    const loaded = await this.load(taskId);
    this.assertNeedsDecision(loaded.task);
    const result = await runStructuredPrompt({
      asset: directorConflictRecoveryPrompt,
      promptInput: { context: loaded.context, userNote },
      options: { ...getDirectorLlmOptionsFromSeedPayload(loaded.seed), temperature: 0.3, maxTokens: 6000,
        novelId: loaded.task.novelId!, taskId, stage: "conflict_recovery", entrypoint: "auto_director" },
    });
    const options = result.output.options.map((option, index) => ({ ...option, id: `option-${index + 1}` }));
    for (const option of options) {
      if (option.repair.kind === "chapter_contract" && !loaded.context.chapters.some((chapter) => chapter.id === option.repair.chapterId)) {
        throw new AppError("AI 方案指定了不存在的章节，请重新分析。", 422);
      }
      if (option.repair.kind === "workflow_step" && !allowedStepIds.includes(option.repair.stepId ?? "")) {
        throw new AppError("AI 方案指定了不可执行的修改步骤，请重新分析。", 422);
      }
    }
    const fresh = await this.load(taskId);
    this.assertNeedsDecision(fresh.task);
    if (fresh.contentFingerprint !== loaded.contentFingerprint || fresh.failureFingerprint !== loaded.failureFingerprint) {
      throw new AppError("分析期间小说或报错发生变化，请重新分析。", 409);
    }
    const plan: DirectorConflictRecoveryPlan = {
      id: randomUUID(), taskId, summary: result.output.summary, outlinePriority: result.output.outlinePriority,
      conflicts: result.output.conflicts, options,
      recommendedOptionId: options[result.output.recommendedOptionIndex].id,
      createdAt: new Date().toISOString(),
    };
    await this.workflow.bootstrapTask({ workflowTaskId: taskId, novelId: loaded.task.novelId, lane: "auto_director",
      seedPayload: { conflictRecovery: { plan, contentFingerprint: loaded.contentFingerprint, failureFingerprint: loaded.failureFingerprint } },
    });
    return plan;
  }

  async validateSelection(taskId: string, selection: Selection, beforeQueue = true) {
    const loaded = await this.load(taskId);
    if (beforeQueue) this.assertNeedsDecision(loaded.task);
    const record: DirectorConflictRecoveryRecord | null | undefined = loaded.seed.conflictRecovery;
    const option = record?.plan.id === selection.planId
      ? record.plan.options.find((candidate) => candidate.id === selection.optionId)
      : null;
    if (!record || !option || record.appliedAt || record.selectedOptionId) {
      throw new AppError("这个方案已失效或正在执行，请重新分析当前问题。", 409);
    }
    if (record.contentFingerprint !== loaded.contentFingerprint
      || (beforeQueue && record.failureFingerprint !== loaded.failureFingerprint)) {
      throw new AppError("小说内容或报错已变化，请重新分析后再选择方案。", 409);
    }
    return { ...loaded, record, option };
  }

  async applySelected(taskId: string, selection: Selection, calibrate: (input: DirectorStepCalibrationRequest) => Promise<unknown>): Promise<boolean> {
    const { task, seed, record, option } = await this.validateSelection(taskId, selection, false);
    const selectedRecord = { ...record, selectedOptionId: option.id };
    await this.workflow.bootstrapTask({ workflowTaskId: taskId, novelId: task.novelId, lane: "auto_director",
      seedPayload: { conflictRecovery: selectedRecord },
    });
    if (option.repair.kind === "retry") return false;
    const services = getSharedNovelServices();
    await services.createNovelSnapshot(task.novelId!, "before_pipeline", `before-conflict-resolution-${record.plan.id}`);
    const instruction = [
      `以已保存大纲主线为先：${record.plan.outlinePriority}`,
      `用户选择方案：${option.title}`,
      option.instruction,
      `必须保留：${option.preserves.join("；")}`,
      "只修改用户选择的范围，保留现有正文，不重写大纲主线。",
    ].join("\n");
    if (option.repair.kind === "workflow_step") {
      await calibrate({ stepId: option.repair.stepId!, action: "improve", instruction });
    } else {
      await services.ensureChapterExecutionContract(task.novelId!, option.repair.chapterId!, {
        ...getDirectorLlmOptionsFromSeedPayload(seed), guidance: instruction, forceRefresh: true,
        taskId, entrypoint: "auto_director",
      });
      await this.workflow.markTaskWaitingApproval(taskId, {
        stage: "structured_outline", itemKey: "chapter_detail_bundle", itemLabel: "所选方案已应用，请检查章节规划",
        checkpointType: "step_review_required", checkpointSummary: `已按「${option.title}」调整章节规划。请检查后确认继续。`,
        chapterId: option.repair.chapterId!,
        seedPayload: { stepReview: { stepId: DIRECTOR_STRUCTURED_OUTLINE_STEP_IDS.chapter_detail_bundle,
          nodeKey: "volume_chapter_detail_bundle_generate",
          label: "章节规划", targetType: "chapter", targetId: option.repair.chapterId!, completedAt: new Date().toISOString() } },
      });
    }
    await this.workflow.bootstrapTask({ workflowTaskId: taskId, novelId: task.novelId, lane: "auto_director",
      seedPayload: { conflictRecovery: { ...selectedRecord, appliedAt: new Date().toISOString() } },
    });
    return true;
  }
}

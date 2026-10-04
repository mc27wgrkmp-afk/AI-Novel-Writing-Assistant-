import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import type {
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import type { VolumeGenerationPhaseEvent } from "../../volume/volumeModels";
import { getChapterTitleDiversityIssue } from "../../volume/chapterTitleDiversity";
import { buildNovelEditResumeTarget } from "../../workflow/novelWorkflow.shared";
import { logMemoryUsage } from "../../../../runtime/memoryTelemetry";
import {
  buildDirectorSessionState,
  type DirectorWorkflowSeedPayload,
} from "../runtime/novelDirectorHelpers";
import {
  buildChapterDetailBundleLabel,
  buildChapterDetailBundleProgress,
  DIRECTOR_PROGRESS,
  type DirectorProgressItemKey,
} from "../projections/novelDirectorProgress";
import {
  buildDirectorAutoExecutionState,
  countDirectorAutoExecutionChapterRange,
  hasDirectorSyncedChapterExecutionContext,
  normalizeDirectorAutoExecutionPlan,
  resolveDirectorAutoExecutionPlanChapterRange,
} from "../automation/novelDirectorAutoExecution";
import {
  flattenPreparedOutlineChapters,
  resolveStructuredOutlineRecoveryCursor,
  type StructuredOutlineDetailMode,
  type StructuredOutlineRecoveryCursor,
} from "../recovery/novelDirectorStructuredOutlineRecovery";
import { runDirectorTrackedStep } from "../projections/directorProgressTracker";
import { parseSeedPayload } from "../../workflow/novelWorkflow.shared";
import { prepareScriptBatch, resolveScriptBatchScope, hashScriptBatchArtifacts } from "../commands/scriptBatches";
import type { DirectorPhaseCallbacks, DirectorPhaseDependencies } from "./novelDirectorPhaseTypes";

function buildChapterOrderRangeLabel(startOrder: number, endOrder: number): string {
  return startOrder === endOrder ? `第 ${startOrder} 章` : `第 ${startOrder}-${endOrder} 章`;
}

function buildFastStartPlanningGuidance(request: DirectorConfirmRequest): string | undefined {
  const preparation = request.startupPreparation;
  if (!preparation || preparation.strategy !== "fast_start") {
    return undefined;
  }
  return [
    "本次采用快速开篇：首个可执行节奏段只规划开篇路线，不提前锁死远期章节。",
    `首批路线必须覆盖 ${preparation.routeWindow.min}-${preparation.routeWindow.target} 章，形成行动、阻碍、选择和结果完整的因果链。`,
    "本次选择范围内的每章都需完整细化任务单与场景卡，范围外章节可保留为简略路线。",
  ].join("\n");
}

function findMissingSelectedChapterOrders(
  selectedOrders: number[],
  range: { startOrder: number; endOrder: number },
): number[] {
  const selected = new Set(selectedOrders);
  const missing: number[] = [];
  for (let order = range.startOrder; order <= range.endOrder; order += 1) {
    if (!selected.has(order)) {
      missing.push(order);
    }
  }
  return missing;
}

async function syncPreparedChapterExecutionContext(input: {
  novelId: string;
  workspace: VolumePlanDocument;
  targetVolumeId: string;
  targetChapterId: string;
  dependencies: DirectorPhaseDependencies;
}): Promise<void> {
  const targetVolume = input.workspace.volumes.find((volume) => volume.id === input.targetVolumeId);
  const targetChapter = targetVolume?.chapters.find((chapter) => chapter.id === input.targetChapterId);
  if (!targetChapter) {
    return;
  }
  if (!targetChapter.taskSheet?.trim() && !targetChapter.sceneCards?.trim()) {
    return;
  }

  await input.dependencies.volumeService.syncVolumeChaptersWithOptions(input.novelId, {
    volumes: input.workspace.volumes,
    preserveContent: true,
    applyDeletes: false,
    executionContractChapterRange: {
      startOrder: targetChapter.chapterOrder,
      endOrder: targetChapter.chapterOrder,
    },
  }, {
    emitEvent: false,
    syncPayoffLedger: false,
  });
}

function buildStructuredOutlinePhaseUpdate(event: VolumeGenerationPhaseEvent): {
  itemKey: DirectorProgressItemKey;
  itemLabel: string;
  progress: number;
} | null {
  if (event.scope === "beat_sheet") {
    return {
      itemKey: "beat_sheet",
      itemLabel: event.label.trim() || (event.phase === "load_context" ? "正在整理节奏板上下文" : "正在生成节奏板"),
      progress: DIRECTOR_PROGRESS.beatSheet,
    };
  }
  if (event.scope === "chapter_list") {
    return {
      itemKey: "chapter_list",
      itemLabel: event.label.trim() || (event.phase === "load_context" ? "正在整理拆章上下文" : "正在生成章节列表"),
      progress: DIRECTOR_PROGRESS.chapterList,
    };
  }
  if (event.scope === "rebalance") {
    return {
      itemKey: "chapter_list",
      itemLabel: event.label.trim() || "正在校准相邻卷衔接",
      progress: 0.8,
    };
  }
  return null;
}

function buildStructuredOutlineCursorKey(cursor: StructuredOutlineRecoveryCursor): string {
  return [
    cursor.step,
    cursor.volumeId ?? "",
    cursor.chapterId ?? "",
    cursor.detailMode ?? "",
    cursor.beatKey ?? "",
    cursor.preparedVolumeIds.length,
    cursor.selectedChapters.length,
    cursor.completedChapterCount,
    cursor.totalChapterCount,
    cursor.completedDetailSteps,
    cursor.totalDetailSteps,
  ].join("|");
}

async function persistStructuredOutlineVolumeSnapshot(input: {
  taskId: string;
  novelId: string;
  workspace: VolumePlanDocument;
  itemKey: "beat_sheet" | "chapter_list";
  scope: "beat_sheet" | "chapter_list";
  volumeId?: string | null;
  dependencies: Pick<DirectorPhaseDependencies, "volumeService">;
}): Promise<VolumePlanDocument> {
  return input.dependencies.volumeService.updateVolumesWithOptions(input.novelId, input.workspace, {
    emitEvent: false,
    syncPayoffLedger: false,
    memoryTelemetry: {
      taskId: input.taskId,
      stage: "structured_outline",
      itemKey: input.itemKey,
      scope: input.scope,
      entrypoint: "auto_director",
      volumeId: input.volumeId,
    },
  });
}

export async function runDirectorStructuredOutlinePhase(input: {
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  baseWorkspace: VolumePlanDocument;
  dependencies: DirectorPhaseDependencies;
  callbacks: DirectorPhaseCallbacks;
}): Promise<void> {
  const { taskId, novelId, request, baseWorkspace, dependencies, callbacks } = input;
  logMemoryUsage({
    event: "start",
    component: "runDirectorStructuredOutlinePhase",
    taskId,
    novelId,
    stage: "structured_outline",
    scope: "structured_outline",
    entrypoint: "auto_director",
    volumeCount: baseWorkspace.volumes.length,
    chapterCount: baseWorkspace.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: baseWorkspace.beatSheets.length,
  });
  const firstVolume = baseWorkspace.volumes[0];
  if (!firstVolume) {
    throw new Error("自动导演未能生成可用卷骨架。");
  }
  const savedTask = await dependencies.workflowService.getTaskById(taskId);
  const savedSeed = parseSeedPayload<DirectorWorkflowSeedPayload>(savedTask?.seedPayloadJson) ?? {};
  // Duplicate background delivery must preserve the human acceptance checkpoint.
  if (savedSeed.scriptBatch?.status === "waiting_acceptance" || savedSeed.scriptBatch?.status === "all_accepted") return;
  const scriptBatchScope = resolveScriptBatchScope(request, baseWorkspace, savedSeed.scriptBatchScope);
  const scriptBatch = prepareScriptBatch(scriptBatchScope, savedSeed.scriptBatch);
  const detailPlan = normalizeDirectorAutoExecutionPlan({
    ...request.autoExecutionPlan,
    mode: "chapter_range",
    startOrder: scriptBatch.startOrder,
    endOrder: scriptBatch.endOrder,
  });
  const batchRequest: DirectorConfirmRequest = { ...request, autoExecutionPlan: detailPlan };
  const fastStartGuidance = buildFastStartPlanningGuidance(request);
  const sortedVolumes = baseWorkspace.volumes
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder);
  if (detailPlan.mode === "volume" && (detailPlan.volumeOrder ?? 1) > sortedVolumes.length) {
    throw new Error(`当前卷规划只有 ${sortedVolumes.length} 卷，无法准备第 ${detailPlan.volumeOrder} 卷剧本。`);
  }

  const directorSession = buildDirectorSessionState({
    runMode: request.runMode,
    phase: "structured_outline",
    isBackgroundRunning: true,
  });
  const initialRecoveryCursor = resolveStructuredOutlineRecoveryCursor({
    workspace: baseWorkspace,
    plan: detailPlan,
    allowPartialChapterListReady: false,
  });
  const runningResumeTarget = buildNovelEditResumeTarget({
    novelId,
    taskId,
    stage: "structured",
    volumeId: initialRecoveryCursor.volumeId ?? firstVolume.id,
    chapterId: initialRecoveryCursor.chapterId,
  });
  await dependencies.workflowService.bootstrapTask({
    workflowTaskId: taskId,
    novelId,
    lane: "auto_director",
    title: request.candidate.workingTitle,
    seedPayload: callbacks.buildDirectorSeedPayload(batchRequest, novelId, {
      directorSession,
      resumeTarget: runningResumeTarget,
      scriptBatch,
      scriptBatchScope,
    }),
  });

  let workspace = baseWorkspace;
  let previousCursorKey: string | null = null;
  while (true) {
    const recoveryCursor = resolveStructuredOutlineRecoveryCursor({
      workspace,
      plan: detailPlan,
      allowPartialChapterListReady: false,
    });
    const cursorKey = buildStructuredOutlineCursorKey(recoveryCursor);
    if (cursorKey === previousCursorKey) {
      throw new Error("自动导演结构化大纲恢复没有推进，请检查章节规划生成结果后重试。");
    }
    previousCursorKey = cursorKey;

    if (recoveryCursor.step === "beat_sheet") {
      const targetVolume = workspace.volumes.find((volume) => volume.id === recoveryCursor.volumeId);
      if (!targetVolume) {
        throw new Error("自动导演恢复时缺少待生成节奏板的目标卷。");
      }
      workspace = await runDirectorTrackedStep({
        taskId,
        stage: "structured_outline",
        itemKey: "beat_sheet",
        itemLabel: `正在生成第 ${targetVolume.sortOrder} 卷节奏板`,
        progress: DIRECTOR_PROGRESS.beatSheet,
        volumeId: targetVolume.id,
        callbacks,
        run: async ({ updateStatus, signal }) => dependencies.volumeService.generateVolumes(novelId, {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          scope: "beat_sheet",
          guidance: fastStartGuidance,
          targetVolumeId: targetVolume.id,
          draftWorkspace: workspace,
          taskId,
          entrypoint: "auto_director",
          signal,
          onPhaseStart: async (event) => {
            const update = buildStructuredOutlinePhaseUpdate(event);
            if (!update) {
              return;
            }
            await updateStatus(update);
          },
        }),
      });
      workspace = await persistStructuredOutlineVolumeSnapshot({
        taskId,
        novelId,
        workspace,
        itemKey: "beat_sheet",
        scope: "beat_sheet",
        volumeId: targetVolume.id,
        dependencies,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_list") {
      const targetVolume = workspace.volumes.find((volume) => volume.id === recoveryCursor.volumeId);
      if (!targetVolume) {
        throw new Error("自动导演恢复时缺少待拆章的目标卷。");
      }
      if (!recoveryCursor.beatKey) {
        throw new Error("自动导演恢复时缺少待生成章节的目标节奏段。");
      }
      const targetBeatKey = recoveryCursor.beatKey;
      workspace = await runDirectorTrackedStep({
        taskId,
        stage: "structured_outline",
        itemKey: "chapter_list",
        itemLabel: `正在生成第 ${targetVolume.sortOrder} 卷章节列表`,
        progress: DIRECTOR_PROGRESS.chapterList,
        volumeId: targetVolume.id,
        callbacks,
        run: async ({ updateStatus, signal }) => dependencies.volumeService.generateVolumes(novelId, {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          scope: "chapter_list",
          guidance: fastStartGuidance,
          targetVolumeId: targetVolume.id,
          generationMode: "single_beat",
          targetBeatKey,
          draftWorkspace: workspace,
          taskId,
          entrypoint: "auto_director",
          signal,
          persistIntermediateDocuments: true,
          onPhaseStart: async (event) => {
            const update = buildStructuredOutlinePhaseUpdate(event);
            if (!update) {
              return;
            }
            await updateStatus(update);
          },
          onIntermediateDocument: async (event) => {
            workspace = event.document;
          },
        }),
      });
      const preparedVolume = workspace.volumes.find((item) => item.id === targetVolume.id);
      const titleDiversityIssue = preparedVolume
        ? getChapterTitleDiversityIssue(preparedVolume.chapters.map((chapter) => chapter.title))
        : null;
      if (titleDiversityIssue) {
        throw new Error(titleDiversityIssue);
      }
      workspace = await persistStructuredOutlineVolumeSnapshot({
        taskId,
        novelId,
        workspace,
        itemKey: "chapter_list",
        scope: "chapter_list",
        volumeId: targetVolume.id,
        dependencies,
      });
      await dependencies.workflowService.markTaskRunning(taskId, {
        stage: "structured_outline",
        itemKey: "chapter_list",
        itemLabel: `第 ${targetVolume.sortOrder} 卷章节列表已生成`,
        progress: DIRECTOR_PROGRESS.chapterList,
        volumeId: targetVolume.id,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_detail_bundle") {
      const targetDetailMode = recoveryCursor.detailMode as StructuredOutlineDetailMode | null;
      if (
        !recoveryCursor.chapterId
        || !recoveryCursor.volumeId
        || !targetDetailMode
        || recoveryCursor.nextChapterIndex == null
      ) {
        throw new Error("自动导演恢复时缺少章节细化所需游标。");
      }
      const targetVolumeId = recoveryCursor.volumeId;
      const targetChapterId = recoveryCursor.chapterId;
      const targetChapterIndex = recoveryCursor.nextChapterIndex;
      workspace = await runDirectorTrackedStep({
        taskId,
        stage: "structured_outline",
        itemKey: "chapter_detail_bundle",
        itemLabel: buildChapterDetailBundleLabel(
          targetChapterIndex + 1,
          recoveryCursor.totalChapterCount,
          targetDetailMode,
        ),
        progress: buildChapterDetailBundleProgress(
          recoveryCursor.completedDetailSteps,
          recoveryCursor.totalDetailSteps,
        ),
        chapterId: targetChapterId,
        volumeId: targetVolumeId,
        callbacks,
        run: async ({ signal }) => dependencies.volumeService.generateVolumes(novelId, {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          scope: "chapter_detail",
          targetVolumeId,
          targetChapterId,
          detailMode: targetDetailMode,
          chapterTaskSheetQualityMode: "ai_copilot",
          draftWorkspace: workspace,
          taskId,
          entrypoint: "auto_director",
          signal,
        }),
      });
      workspace = await dependencies.volumeService.updateVolumesWithOptions(novelId, workspace, {
        volumeUpdateReason: "chapter_execution_contract_refined",
        syncPayoffLedger: false,
        memoryTelemetry: {
          taskId,
          stage: "structured_outline",
          itemKey: "chapter_detail_bundle",
          scope: "chapter_detail",
          entrypoint: "auto_director",
          volumeId: recoveryCursor.volumeId,
          chapterId: recoveryCursor.chapterId,
        },
      });
      await syncPreparedChapterExecutionContext({
        novelId,
        workspace,
        targetVolumeId,
        targetChapterId,
        dependencies,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_sync" || recoveryCursor.step === "completed") {
      break;
    }
  }

  const preparedVolumeIds = resolveStructuredOutlineRecoveryCursor({
    workspace,
    plan: detailPlan,
    allowPartialChapterListReady: false,
  }).preparedVolumeIds;
  const maxPreparedChapterOrder = Math.max(
    0,
    ...flattenPreparedOutlineChapters(workspace).map((chapter) => chapter.chapterOrder),
  );
  const targetChapterRange = resolveDirectorAutoExecutionPlanChapterRange(detailPlan);
  if (targetChapterRange && maxPreparedChapterOrder < targetChapterRange.endOrder) {
    throw new Error(
      `当前章节规划只覆盖到第 ${maxPreparedChapterOrder} 章，请补齐${buildChapterOrderRangeLabel(targetChapterRange.startOrder, targetChapterRange.endOrder)}的剧本。`,
    );
  }

  await callbacks.markDirectorTaskRunning(
    taskId,
    "structured_outline",
    "chapter_sync",
    "正在保存章节剧本",
    DIRECTOR_PROGRESS.chapterSync,
  );
  logMemoryUsage({
    event: "before_sync_write",
    component: "runDirectorStructuredOutlinePhase",
    taskId,
    novelId,
    stage: "structured_outline",
    itemKey: "chapter_sync",
    scope: "structured_outline",
    entrypoint: "auto_director",
    volumeCount: workspace.volumes.length,
    chapterCount: workspace.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: workspace.beatSheets.length,
  });
  const persistedOutlineWorkspace = await dependencies.volumeService.updateVolumesWithOptions(novelId, workspace, {
    volumeUpdateReason: "chapter_execution_contract_refined",
    syncPayoffLedger: false,
    memoryTelemetry: {
      taskId,
      stage: "structured_outline",
      itemKey: "chapter_sync",
      scope: "structured_outline",
      entrypoint: "auto_director",
    },
  });
  await dependencies.volumeService.syncVolumeChaptersWithOptions(novelId, {
    volumes: persistedOutlineWorkspace.volumes,
    // Structured outline sync refreshes execution contracts; generated prose stays protected.
    preserveContent: true,
    applyDeletes: false,
    executionContractChapterRange: targetChapterRange ?? undefined,
  }, {
    emitEvent: false,
    syncPayoffLedger: false,
  });
  const syncCursor = resolveStructuredOutlineRecoveryCursor({
    workspace: persistedOutlineWorkspace,
    plan: detailPlan,
    allowPartialChapterListReady: false,
  });
  const selectedChapters = syncCursor.selectedChapters;
  if (selectedChapters.length === 0) {
    throw new Error("自动导演未能准备出章节剧本。");
  }
  const selectedChapterOrders = selectedChapters.map((chapter) => chapter.chapterOrder).sort((left, right) => left - right);
  if (targetChapterRange) {
    const missingOrders = findMissingSelectedChapterOrders(selectedChapterOrders, targetChapterRange);
    if (missingOrders.length > 0) {
      throw new Error(
        `章节规划缺少第 ${missingOrders.slice(0, 5).join("、")} 章，请补齐${buildChapterOrderRangeLabel(targetChapterRange.startOrder, targetChapterRange.endOrder)}的剧本。`,
      );
    }
  }
  const autoExecutionScopeLabel = syncCursor.scopeLabel;

  await callbacks.markDirectorTaskRunning(
    taskId,
    "structured_outline",
    "chapter_detail_bundle",
    `${autoExecutionScopeLabel}剧本细化已完成，正在保存结果`,
    DIRECTOR_PROGRESS.chapterDetailDone,
    {
      chapterId: selectedChapters[0]?.id ?? null,
      volumeId: selectedChapters[0]?.volumeId ?? null,
    },
  );
  const persistedChapters = await dependencies.novelContextService.listChapters(novelId);
  if (persistedChapters.length === 0) {
    throw new Error("章节列表已生成，但章节剧本没有成功保存。");
  }
  const persistedChapterByOrder = new Map(persistedChapters.map((chapter) => [chapter.order, chapter] as const));
  const missingExecutionContextOrders = selectedChapterOrders.filter((order) => {
      const chapter = persistedChapterByOrder.get(order);
      return !chapter || !hasDirectorSyncedChapterExecutionContext(chapter);
    });
  if (missingExecutionContextOrders.length > 0) {
    throw new Error(
      `${autoExecutionScopeLabel}还有第 ${missingExecutionContextOrders.slice(0, 5).join("、")} 章缺少完整章节剧本。请先补齐任务单与场景卡。`,
    );
  }

  await dependencies.novelContextService.updateNovel(novelId, {
    projectStatus: "in_progress",
    storylineStatus: "in_progress",
    outlineStatus: "in_progress",
  });

  const autoExecutionState = buildDirectorAutoExecutionState({
    range: {
      startOrder: selectedChapterOrders[0] ?? 1,
      endOrder: selectedChapterOrders[selectedChapterOrders.length - 1] ?? selectedChapterOrders[0] ?? 1,
      totalChapterCount: targetChapterRange
        ? countDirectorAutoExecutionChapterRange(targetChapterRange)
        : selectedChapters.length,
      firstChapterId: selectedChapters[0]?.id ?? null,
    },
    chapters: persistedChapters.map((chapter) => ({
      id: chapter.id,
      order: chapter.order,
      content: chapter.content ?? null,
      conflictLevel: chapter.conflictLevel ?? null,
      revealLevel: chapter.revealLevel ?? null,
      targetWordCount: chapter.targetWordCount ?? null,
      mustAvoid: chapter.mustAvoid ?? null,
      taskSheet: chapter.taskSheet ?? null,
      sceneCards: chapter.sceneCards ?? null,
      generationState: chapter.generationState ?? null,
      chapterStatus: chapter.chapterStatus ?? null,
    })),
    plan: detailPlan,
    scopeLabel: autoExecutionScopeLabel,
    volumeTitle: detailPlan.mode === "volume" ? selectedChapters[0]?.volumeTitle ?? null : null,
    preparedVolumeIds,
    beatChapterListReady: syncCursor.beatChapterListReady,
    volumeChapterListComplete: syncCursor.volumeChapterListComplete,
  });

  const pausedSession = buildDirectorSessionState({
    runMode: request.runMode,
    phase: "structured_outline",
    isBackgroundRunning: false,
  });
  const chapterResumeTarget = buildNovelEditResumeTarget({
    novelId,
    taskId,
    stage: "structured",
    volumeId: selectedChapters[0]?.volumeId ?? firstVolume.id,
    chapterId: selectedChapters[0]?.id ?? null,
  });
  await dependencies.workflowService.recordCheckpoint(taskId, {
    stage: "structured_outline",
    checkpointType: "chapter_script_batch_ready",
    checkpointSummary: `《${request.candidate.workingTitle.trim() || request.title?.trim() || "当前项目"}》的${autoExecutionScopeLabel}章节剧本已准备，请逐章检查并验收后继续。`,
    itemLabel: `${autoExecutionScopeLabel}章节剧本待验收`,
    volumeId: selectedChapters[0]?.volumeId ?? firstVolume.id,
    chapterId: selectedChapters[0]?.id ?? null,
    progress: Math.min(0.99, (scriptBatch.endOrder - scriptBatchScope.startOrder + 1) / scriptBatch.totalChapterCount),
    seedPayload: callbacks.buildDirectorSeedPayload(batchRequest, novelId, {
      directorSession: pausedSession,
      resumeTarget: chapterResumeTarget,
      scriptBatch: { ...scriptBatch, status: "waiting_acceptance", artifactHash: hashScriptBatchArtifacts(persistedChapters, scriptBatch, persistedOutlineWorkspace) },
      scriptBatchScope,
      autoExecution: { ...autoExecutionState, enabled: false },
      startupPreparation: request.startupPreparation,
    }),
  });
  logMemoryUsage({
    event: "done",
    component: "runDirectorStructuredOutlinePhase",
    taskId,
    novelId,
    stage: "structured_outline",
    itemKey: "chapter_script_batch_ready",
    scope: autoExecutionScopeLabel,
    entrypoint: "auto_director",
    volumeCount: persistedOutlineWorkspace.volumes.length,
    chapterCount: persistedOutlineWorkspace.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: persistedOutlineWorkspace.beatSheets.length,
  });
}

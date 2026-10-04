import { createHash } from "node:crypto";
import { parseChapterScenePlan } from "@ai-novel/shared/types/chapterLengthControl";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { DIRECTOR_SCRIPT_BATCH_SIZE, type DirectorConfirmRequest, type DirectorScriptBatchState } from "@ai-novel/shared/types/novelDirector";
import { AppError } from "../../../../../middleware/errorHandler";

export interface ScriptBatchScope { startOrder: number; endOrder: number }
export interface ScriptBatchChapter {
  id: string; order: number; title?: string | null; expectation?: string | null;
  taskSheet?: string | null; sceneCards?: string | null;
  targetWordCount?: number | null; conflictLevel?: number | null;
  revealLevel?: number | null; mustAvoid?: string | null;
}

export function resolveScriptBatchScope(
  request: DirectorConfirmRequest,
  workspace: VolumePlanDocument,
  storedScope?: ScriptBatchScope | null,
): ScriptBatchScope {
  if (storedScope) return storedScope;
  const plan = request.autoExecutionPlan;
  if (plan?.mode === "chapter_range") {
    const startOrder = Math.max(1, plan.startOrder ?? 1);
    return { startOrder, endOrder: Math.max(startOrder, plan.endOrder ?? startOrder) };
  }
  if (plan?.mode === "volume") {
    const chapters = workspace.volumes.find((volume) => volume.sortOrder === (plan.volumeOrder ?? 1))?.chapters ?? [];
    if (chapters.length > 0) {
      const orders = chapters.map((chapter) => chapter.chapterOrder);
      return { startOrder: Math.min(...orders), endOrder: Math.max(...orders) };
    }
  }
  return { startOrder: 1, endOrder: Math.max(1, request.estimatedChapterCount ?? request.candidate.targetChapterCount ?? 80) };
}

export function prepareScriptBatch(scope: ScriptBatchScope, previous?: DirectorScriptBatchState | null): DirectorScriptBatchState {
  if (previous) return previous;
  return {
    startOrder: scope.startOrder,
    endOrder: Math.min(scope.endOrder, scope.startOrder + DIRECTOR_SCRIPT_BATCH_SIZE - 1),
    totalChapterCount: scope.endOrder - scope.startOrder + 1,
    scopeStartOrder: scope.startOrder,
    scopeEndOrder: scope.endOrder,
    acceptedThroughChapterOrder: scope.startOrder - 1,
    status: "preparing",
  };
}

export function advanceScriptBatch(batch: DirectorScriptBatchState, scope: ScriptBatchScope): DirectorScriptBatchState {
  const completed = batch.endOrder >= scope.endOrder;
  return {
    startOrder: completed ? batch.startOrder : batch.endOrder + 1,
    endOrder: completed ? batch.endOrder : Math.min(scope.endOrder, batch.endOrder + DIRECTOR_SCRIPT_BATCH_SIZE),
    totalChapterCount: batch.totalChapterCount,
    scopeStartOrder: scope.startOrder,
    scopeEndOrder: scope.endOrder,
    acceptedThroughChapterOrder: batch.endOrder,
    status: completed ? "all_accepted" : "preparing",
  };
}

/** Hash only reviewed script data, excluding manuscript content and volatile timestamps. */

export function hashScriptBatchArtifacts(chapters: ScriptBatchChapter[], batch: Pick<DirectorScriptBatchState, "startOrder" | "endOrder">, workspace: Pick<VolumePlanDocument, "volumes">): string {
  const selected = chapters.filter((chapter) => chapter.order >= batch.startOrder && chapter.order <= batch.endOrder).sort((a, b) => a.order - b.order);
  const outlines = workspace.volumes.flatMap((volume) => volume.chapters).filter((chapter) => chapter.chapterOrder >= batch.startOrder && chapter.chapterOrder <= batch.endOrder).sort((a, b) => a.chapterOrder - b.chapterOrder);
  for (let order = batch.startOrder; order <= batch.endOrder; order += 1) {
    const matching = selected.filter((chapter) => chapter.order === order);
    const outlineMatches = outlines.filter((chapter) => chapter.chapterOrder === order);
    if (matching.length !== 1 || !matching[0].taskSheet?.trim() || !parseChapterScenePlan(matching[0].sceneCards, { targetWordCount: matching[0].targetWordCount ?? 2500 })
      || outlineMatches.length !== 1 || !outlineMatches[0].summary?.trim()) {
      throw new AppError(`第 ${order} 章剧本不完整，请补齐任务单与场景卡后验收。`, 409);
    }
  }
  const artifacts = selected.map((chapter) => ({
    id: chapter.id, order: chapter.order, title: chapter.title ?? null, expectation: chapter.expectation ?? null,
    taskSheet: chapter.taskSheet, sceneCards: chapter.sceneCards,
    targetWordCount: chapter.targetWordCount ?? null, conflictLevel: chapter.conflictLevel ?? null,
    revealLevel: chapter.revealLevel ?? null, mustAvoid: chapter.mustAvoid ?? null,
  }));
  const outlineArtifacts = outlines.map((chapter) => ({
    id: chapter.id, chapterOrder: chapter.chapterOrder, title: chapter.title, summary: chapter.summary,
    purpose: chapter.purpose ?? null, exclusiveEvent: chapter.exclusiveEvent ?? null,
    endingState: chapter.endingState ?? null, nextChapterEntryState: chapter.nextChapterEntryState ?? null,
    taskSheet: chapter.taskSheet ?? null, sceneCards: chapter.sceneCards ?? null,
    conflictLevel: chapter.conflictLevel ?? null, revealLevel: chapter.revealLevel ?? null,
    targetWordCount: chapter.targetWordCount ?? null, mustAvoid: chapter.mustAvoid ?? null,
  }));
  return createHash("sha256").update(JSON.stringify({ artifacts, outlines: outlineArtifacts })).digest("hex");
}

export function assertScriptBatchMayPrepare(batch?: DirectorScriptBatchState | null): void {
  if (batch?.status === "waiting_acceptance") {
    throw new AppError("请先检查并验收本批章节剧本，再准备下一批。", 409);
  }
  if (batch?.status === "all_accepted") {
    throw new AppError("所选范围的章节剧本已全部验收。", 409);
  }
}

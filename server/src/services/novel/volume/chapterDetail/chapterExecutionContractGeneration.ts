import type {
  VolumeBeatSheet,
  VolumePlan,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";
import { assessChapterExecutionContractShape } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import type { ChapterTaskSheetQualityGateResult } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../../db/prisma";
import {
  ChapterScenePlanNormalizationError,
  normalizeChapterScenePlan,
  serializeChapterScenePlan,
} from "@ai-novel/shared/types/chapterLengthControl";
import { runStructuredPrompt } from "../../../../prompting/core/promptRunner";
import { volumeChapterExecutionContractPrompt } from "../../../../prompting/prompts/novel/volume/chapterDetail.prompts";
import { buildVolumeChapterDetailContextBlocks } from "../../../../prompting/prompts/novel/volume/contextBlocks";
import type { StoryMacroPlanService } from "../../storyMacro/StoryMacroPlanService";
import {
  ChapterTaskSheetQualityGateService,
  ChapterTaskSheetQualityGateError,
} from "../ChapterTaskSheetQualityGateService";
import type {
  VolumeGenerateOptions,
  VolumeGenerationNovel,
  VolumeWorkspace,
} from "../volumeModels";

type StoryMacroPlanResult = Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;

export function canAutomaticallyResolveContractConflict(
  result: ChapterTaskSheetQualityGateResult,
  options: Pick<VolumeGenerateOptions, "entrypoint" | "chapterTaskSheetQualityMode">,
): boolean {
  return (options.entrypoint === "auto_director" || options.chapterTaskSheetQualityMode === "full_book_autopilot")
    && result.recommendedHandling === "repair_contract";
}

export function shouldRetryChapterExecutionContract(error: unknown, attempt: number): boolean {
  if (attempt > 0) {
    return false;
  }
  if (error instanceof ChapterScenePlanNormalizationError) {
    return true;
  }
  return Boolean(
    error
    && typeof error === "object"
    && (error as { promptQualityFailureKind?: unknown }).promptQualityFailureKind === "post_validate_failed"
  );
}

export function canReuseChapterExecutionContract(input: {
  novelId: string;
  volumeId: string;
  chapter: VolumePlan["chapters"][number];
}): boolean {
  return assessChapterExecutionContractShape({
    novelId: input.novelId,
    volumeId: input.volumeId,
    chapterId: input.chapter.id,
    chapterOrder: input.chapter.chapterOrder,
    title: input.chapter.title,
    summary: input.chapter.summary,
    purpose: input.chapter.purpose,
    exclusiveEvent: input.chapter.exclusiveEvent,
    endingState: input.chapter.endingState,
    nextChapterEntryState: input.chapter.nextChapterEntryState,
    conflictLevel: input.chapter.conflictLevel,
    revealLevel: input.chapter.revealLevel,
    targetWordCount: input.chapter.targetWordCount,
    mustAvoid: input.chapter.mustAvoid,
    payoffRefs: input.chapter.payoffRefs,
    taskSheet: input.chapter.taskSheet,
    sceneCards: input.chapter.sceneCards,
  }).canEnterExecution;
}

export async function generateChapterTaskSheetDetail(params: {
  promptInput: {
    novel: VolumeGenerationNovel;
    workspace: VolumeWorkspace;
    storyMacroPlan: StoryMacroPlanResult;
    strategyPlan: VolumePlanDocument["strategyPlan"];
    targetVolume: VolumePlan;
    targetBeatSheet: VolumeBeatSheet | null;
    targetChapter: VolumePlan["chapters"][number];
    guidance?: string;
    detailMode: "task_sheet";
  };
  options: VolumeGenerateOptions;
}): Promise<{
  purpose: string;
  exclusiveEvent: string;
  endingState: string;
  nextChapterEntryState: string;
  conflictLevel: number;
  revealLevel: number;
  targetWordCount: number;
  mustAvoid: string;
  payoffRefs: string[];
  taskSheet: string;
  sceneCards: string;
}> {
  const existingChapter = params.promptInput.targetChapter;
  if (
    !params.promptInput.guidance?.trim()
    && canReuseChapterExecutionContract({
      novelId: params.promptInput.workspace.novelId,
      volumeId: params.promptInput.targetVolume.id,
      chapter: existingChapter,
    })
  ) {
    const scenePlan = normalizeChapterScenePlan(
      existingChapter.sceneCards,
      existingChapter.targetWordCount,
    );
    return {
      purpose: existingChapter.purpose?.trim() || existingChapter.summary.trim(),
      exclusiveEvent: existingChapter.exclusiveEvent?.trim() || existingChapter.summary.trim(),
      endingState: existingChapter.endingState?.trim() || "本章完成当前章节任务，并为下一章留下明确入口。",
      nextChapterEntryState: existingChapter.nextChapterEntryState?.trim() || existingChapter.endingState?.trim() || "下一章承接本章结果继续推进。",
      conflictLevel: existingChapter.conflictLevel ?? 3,
      revealLevel: existingChapter.revealLevel ?? 2,
      targetWordCount: existingChapter.targetWordCount ?? 2200,
      mustAvoid: existingChapter.mustAvoid?.trim() || "避免偏离本章任务单和卷节奏。",
      payoffRefs: existingChapter.payoffRefs,
      taskSheet: existingChapter.taskSheet?.trim() ?? "",
      sceneCards: serializeChapterScenePlan(scenePlan),
    };
  }

  let lastError: Error | null = null;
  let qualityFeedback: string | null = null;
  let repairDraft = params.promptInput.targetChapter;
  const automatic = params.options.entrypoint === "auto_director"
    || params.options.chapterTaskSheetQualityMode === "full_book_autopilot";
  const maxAttempts = automatic ? 3 : 2;
  const resolutions: string[] = [];
  const qualityGate = new ChapterTaskSheetQualityGateService();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const promptInput = qualityFeedback
        ? {
          ...params.promptInput,
          targetChapter: repairDraft,
          guidance: [
            params.promptInput.guidance?.trim(),
            "以已保存大纲主线、已有规则和已发生事实为先。自行选择最合理的局部方向，直接修改上一版合同，不等待人工选择；不要重写正文或总纲。",
            `上一版章节执行合同未通过质量门禁：${qualityFeedback}`,
          ].filter(Boolean).join("\n"),
        }
        : params.promptInput;
      const generated = await runStructuredPrompt({
        asset: volumeChapterExecutionContractPrompt,
        promptInput,
        contextBlocks: buildVolumeChapterDetailContextBlocks(promptInput),
        options: {
          provider: params.options.provider,
          model: params.options.model,
          temperature: params.options.temperature ?? 0.35,
          maxTokens: 3_200,
          taskId: params.options.taskId,
          entrypoint: params.options.entrypoint,
          novelId: promptInput.workspace.novelId,
          volumeId: promptInput.targetVolume.id,
          chapterId: promptInput.targetChapter.id,
          stage: "chapter_execution_contract",
          itemKey: "chapter_detail_bundle",
          scope: "chapter_detail",
          triggerReason: "chapter_detail_generation",
          signal: params.options.signal,
        },
      });
      const scenePlan = normalizeChapterScenePlan(
        {
          scenes: generated.output.sceneCards,
          readerExperience: generated.output.readerExperience,
        },
        generated.output.targetWordCount ?? promptInput.targetChapter.targetWordCount,
      );
      const candidate = {
        novelId: promptInput.workspace.novelId,
        volumeId: promptInput.targetVolume.id,
        chapterId: promptInput.targetChapter.id,
        chapterOrder: promptInput.targetChapter.chapterOrder,
        title: promptInput.targetChapter.title,
        summary: promptInput.targetChapter.summary,
        purpose: generated.output.purpose,
        exclusiveEvent: generated.output.exclusiveEvent,
        endingState: generated.output.endingState,
        nextChapterEntryState: generated.output.nextChapterEntryState,
        conflictLevel: generated.output.conflictLevel,
        revealLevel: generated.output.revealLevel,
        targetWordCount: generated.output.targetWordCount,
        mustAvoid: generated.output.mustAvoid,
        payoffRefs: generated.output.payoffRefs,
        taskSheet: generated.output.taskSheet,
        sceneCards: serializeChapterScenePlan(scenePlan),
      };
      const assessment = await qualityGate.evaluate(candidate, {
        mode: automatic ? "full_book_autopilot" : params.options.chapterTaskSheetQualityMode,
        provider: params.options.provider,
        model: params.options.model,
        taskId: params.options.taskId,
        entrypoint: params.options.entrypoint,
        signal: params.options.signal,
      });
      if (automatic && assessment.recommendedHandling === "replan_window") {
        throw new ChapterTaskSheetQualityGateError({ ...assessment, canEnterExecution: false });
      }
      const localConflict = canAutomaticallyResolveContractConflict(assessment, params.options);
      if (localConflict) {
        qualityFeedback = [assessment.summary, ...assessment.repairGuidance,
          ...assessment.issues.map((issue) => issue.repairHint)].filter(Boolean).join("；");
        resolutions.push(qualityFeedback);
        repairDraft = { ...repairDraft, ...generated.output, sceneCards: serializeChapterScenePlan(scenePlan) };
        if (attempt + 1 < maxAttempts) continue;
      }
      if (!assessment.canEnterExecution) throw new ChapterTaskSheetQualityGateError(assessment);
      if (resolutions.length && params.options.taskId) {
        await prisma.directorEvent.create({ data: {
          id: randomUUID(), taskId: params.options.taskId, novelId: candidate.novelId,
          type: "chapter_contract_auto_resolution", nodeKey: "volume_chapter_detail_bundle_generate",
          summary: localConflict ? "章节设定已自动调整，剩余衔接要求交给正文执行并继续。" : "AI 已按大纲主线修正章节设定与场景衔接，继续创作。",
          affectedScope: candidate.chapterId, severity: localConflict ? "warning" : "info",
          metadataJson: JSON.stringify({ chapterId: candidate.chapterId, attempts: attempt + 1,
            repairGuidance: resolutions, remainingGuidance: localConflict ? qualityFeedback : null }),
          occurredAt: new Date(),
        } });
      }
      return {
        purpose: generated.output.purpose.trim(),
        exclusiveEvent: generated.output.exclusiveEvent.trim(),
        endingState: generated.output.endingState.trim(),
        nextChapterEntryState: generated.output.nextChapterEntryState.trim(),
        conflictLevel: generated.output.conflictLevel,
        revealLevel: generated.output.revealLevel,
        targetWordCount: generated.output.targetWordCount,
        mustAvoid: generated.output.mustAvoid.trim(),
        payoffRefs: generated.output.payoffRefs,
        taskSheet: [generated.output.taskSheet.trim(),
          localConflict ? `本章衔接修正要求（优先遵守大纲与已有规则）：${qualityFeedback}` : "",
        ].filter(Boolean).join("\n"),
        sceneCards: serializeChapterScenePlan(scenePlan),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("章节执行合同生成失败。");
      if (!shouldRetryChapterExecutionContract(error, attempt)) {
        throw lastError;
      }
      qualityFeedback = lastError.message;
    }
  }

  throw lastError ?? new Error("章节执行合同生成失败。");
}

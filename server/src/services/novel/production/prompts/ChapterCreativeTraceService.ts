import type { BaseMessage } from "@langchain/core/messages";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { CHAPTER_EXECUTION_CONTRACT_REGENERATION_GUIDANCE } from "@ai-novel/shared/types/chapterCreative";
import type { PromptContextBlock, PromptAsset } from "../../../../prompting/core/promptTypes";
import { prepareResolvedPromptExecution } from "../../../../prompting/core/promptRunner";
import { resolvePromptContextBlocksForAsset } from "../../../../prompting/context/promptContextResolution";
import { createContextBlock } from "../../../../prompting/core/contextBudget";
import { buildChapterWriterContextBlocks, sanitizeWriterContextBlocks, resolveTargetWordRange } from "../../../../prompting/prompts/novel/chapterLayeredContext";
import { chapterWriterPrompt } from "../../../../prompting/prompts/novel/chapterWriter.prompts";
import {
  buildVolumeChapterDetailContextBlocks,
  buildVolumeBeatSheetContextBlocks,
} from "../../../../prompting/prompts/novel/volume/contextBlocks";
import { volumeBeatSheetPrompt } from "../../../../prompting/prompts/novel/volume/beatSheet.prompts";
import { volumeChapterExecutionContractPrompt } from "../../../../prompting/prompts/novel/volume/chapterDetail.prompts";
import {
  novelOutlinePrompt,
  novelStructuredOutlinePrompt,
} from "../../../../prompting/prompts/novel/coreGeneration.prompts";
import { prisma } from "../../../../db/prisma";
import type { WritingPlatformSnapshot } from "@ai-novel/shared/types/writingPlatform";
import { novelReferenceService } from "../../NovelReferenceService";
import { DEFAULT_ESTIMATED_CHAPTER_COUNT } from "../../novelCoreShared";
import { buildWorldContextBlockFromSlice } from "../../worldContext/WorldContextGateway";
import { NovelWorldSliceService } from "../../storyWorldSlice/NovelWorldSliceService";
import { plannerService } from "../../../planner/PlannerService";
import { GenerationContextAssembler } from "../../runtime/GenerationContextAssembler";
import { normalizeVolumeWorkspaceDocument } from "../../volume/volumeWorkspaceDocument";
import { mapRowToPlan } from "../../storyMacro/storyMacroPlanPersistence";
import type { VolumeGenerationNovel } from "../../volume/volumeModels";
import { allocateChapterBudgets, deriveChapterBudget } from "../../volume/volumeChapterBudgetAllocation";
import { resolveBeatSheetTargetChapterCount } from "../../volume/volumeBeatSheetGeneration";
import { buildDirectorCompletionProfile } from "@ai-novel/shared/types/directorCompletion";
import { buildStoryModePromptBlock, normalizeStoryModeOutput } from "../../../storyMode/storyModeProfile";

type PromptMessageView = { role: string; content: string };
type PromptPreviewView = {
  promptId: string;
  version: string;
  messages: PromptMessageView[];
  contextBlocks: Array<{ id: string; group: string; content: string }>;
};

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) return String((item as { text: unknown }).text ?? "");
      return JSON.stringify(item);
    }).filter(Boolean).join("\n");
  }
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function serializeMessages(messages: BaseMessage[]): PromptMessageView[] {
  return messages.map((message, index) => ({
    role: message.type === "system" ? "system" : message.type === "human" ? "user" : `message_${index + 1}`,
    content: textContent(message.content),
  }));
}

function toPromptPreview(
  asset: PromptAsset<unknown, unknown, unknown>,
  messages: BaseMessage[],
  contextBlocks: PromptContextBlock[],
): PromptPreviewView {
  return {
    promptId: asset.id,
    version: asset.version,
    messages: serializeMessages(messages),
    contextBlocks: contextBlocks.map(({ id, group, content }) => ({ id, group, content })),
  };
}

function formatJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function getPromptInputFromChapter(input: {
  title: string;
  order: number;
  chapterTitle: string;
  targetWordCount: number | null;
}) {
  const target = resolveTargetWordRange(input.targetWordCount);
  return {
    novelTitle: input.title,
    chapterOrder: input.order,
    chapterTitle: input.chapterTitle,
    mode: "draft" as const,
    targetWordCount: target.targetWordCount,
    minWordCount: target.minWordCount,
    maxWordCount: target.maxWordCount,
  };
}

async function loadWritingPlatformBlock(novelId: string): Promise<PromptContextBlock> {
  const novel = await prisma.novel.findUnique({
    where: { id: novelId },
    select: { writingPlatformSnapshotJson: true },
  });
  let content = "沿用通用中文商业网文写法，保持情节推进、人物主动、因果清晰和章节回报。";
  if (novel?.writingPlatformSnapshotJson) {
    try {
      const snapshot = JSON.parse(novel.writingPlatformSnapshotJson) as WritingPlatformSnapshot;
      content = `${snapshot.label}（配置版本 ${snapshot.profileVersion}）：${snapshot.guidance.drafting}`;
    } catch {
      // Legacy snapshots use the same default as chapter generation.
    }
  }
  return createContextBlock({ id: "writing_platform", group: "writing_platform", priority: 105, required: true, content });
}

function buildVolumeGenerationNovel(novel: {
  title: string;
  description: string | null;
  targetAudience: string | null;
  bookSellingPoint: string | null;
  competingFeel: string | null;
  first30ChapterPromise: string | null;
  commercialTagsJson: string | null;
  estimatedChapterCount: number | null;
  narrativePov: string | null;
  pacePreference: string | null;
  emotionIntensity: string | null;
  genre: { name: string } | null;
  characters: Array<{ name: string; role: string; currentGoal: string | null; currentState: string | null }>;
  primaryStoryMode: Parameters<typeof normalizeStoryModeOutput>[0] | null;
  secondaryStoryMode: Parameters<typeof normalizeStoryModeOutput>[0] | null;
}): VolumeGenerationNovel {
  return {
    ...buildNovelBasics(novel),
  };
}

function buildNovelBasics(novel: Parameters<typeof buildVolumeGenerationNovel>[0]) {
  return {
    title: novel.title,
    description: novel.description,
    targetAudience: novel.targetAudience,
    bookSellingPoint: novel.bookSellingPoint,
    competingFeel: novel.competingFeel,
    first30ChapterPromise: novel.first30ChapterPromise,
    commercialTagsJson: novel.commercialTagsJson,
    estimatedChapterCount: novel.estimatedChapterCount,
    narrativePov: novel.narrativePov,
    pacePreference: novel.pacePreference,
    emotionIntensity: novel.emotionIntensity,
    genre: novel.genre,
    characters: novel.characters,
    completionProfile: buildDirectorCompletionProfile(novel.estimatedChapterCount ?? 80),
    storyModePromptBlock: buildStoryModePromptBlock({
      primary: novel.primaryStoryMode ? normalizeStoryModeOutput(novel.primaryStoryMode) : null,
      secondary: novel.secondaryStoryMode ? normalizeStoryModeOutput(novel.secondaryStoryMode) : null,
    }),
  };
}

export class ChapterCreativeTraceService {
  private readonly assembler = new GenerationContextAssembler();
  private readonly worldSliceService = new NovelWorldSliceService();

  async get(novelId: string, chapterId: string) {
    const [novel, chapter, bible, macroRow, activeVolumeVersion, plan] = await Promise.all([
      prisma.novel.findUnique({
        where: { id: novelId },
        select: {
          id: true,
          title: true,
          description: true,
          outline: true,
          structuredOutline: true,
          targetAudience: true,
          bookSellingPoint: true,
          competingFeel: true,
          first30ChapterPromise: true,
          commercialTagsJson: true,
          estimatedChapterCount: true,
          narrativePov: true,
          pacePreference: true,
          emotionIntensity: true,
          genre: { select: { name: true } },
          primaryStoryMode: {
            select: { id: true, name: true, description: true, template: true, parentId: true, profileJson: true, createdAt: true, updatedAt: true },
          },
          secondaryStoryMode: {
            select: { id: true, name: true, description: true, template: true, parentId: true, profileJson: true, createdAt: true, updatedAt: true },
          },
          characters: {
            orderBy: { createdAt: "asc" },
            select: { name: true, role: true, personality: true, currentGoal: true, currentState: true },
          },
        },
      }),
      prisma.chapter.findFirst({
        where: { id: chapterId, novelId },
        select: {
          id: true,
          order: true,
          title: true,
          content: true,
          expectation: true,
          targetWordCount: true,
          conflictLevel: true,
          revealLevel: true,
          mustAvoid: true,
          hook: true,
          taskSheet: true,
          sceneCards: true,
        },
      }),
      prisma.novelBible.findUnique({ where: { novelId }, select: { coreSetting: true, forbiddenRules: true, mainPromise: true, worldRules: true, rawContent: true } }),
      prisma.storyMacroPlan.findUnique({ where: { novelId } }),
      prisma.volumePlanVersion.findFirst({ where: { novelId, status: "active" }, orderBy: { version: "desc" } }),
      plannerService.getChapterPlan(novelId, chapterId),
    ]);

    if (!novel || !chapter) throw new Error("小说或章节不存在。");

    const [worldSliceView, outlineReferenceContext, structuredOutlineReferenceContext] = await Promise.all([
      this.worldSliceService.getWorldSliceView(novelId).catch(() => null),
      novelReferenceService.buildReferenceForStage(novelId, "outline").catch(() => ""),
      novelReferenceService.buildReferenceForStage(novelId, "structured_outline").catch(() => ""),
    ]);
    const buildStoredWorldContext = (purpose: "outline" | "chapter") => worldSliceView?.slice
      ? buildWorldContextBlockFromSlice({
        slice: worldSliceView.slice,
        purpose,
        novelWorldId: worldSliceView.worldId ?? undefined,
      })
      : null;
    const worldContext = buildStoredWorldContext("chapter");
    const outlineWorldContext = buildStoredWorldContext("outline");
    const structuredOutlineWorldContext = outlineWorldContext;
    const macroPlan = macroRow ? mapRowToPlan(macroRow) : null;
    const volumeDocument = activeVolumeVersion
      ? normalizeVolumeWorkspaceDocument(novelId, activeVolumeVersion.contentJson, {
        source: "volume",
        activeVersionId: activeVolumeVersion.id,
      })
      : null;
    const targetVolume = volumeDocument?.volumes.find((volume) => volume.chapters.some((item) => item.chapterOrder === chapter.order)) ?? null;
    const targetVolumeChapter = targetVolume?.chapters.find((item) => item.chapterOrder === chapter.order) ?? null;
    const targetBeatSheet = targetVolume && volumeDocument
      ? volumeDocument.beatSheets.find((sheet) => sheet.volumeId === targetVolume.id) ?? null
      : null;

    const charactersText = novel.characters.length > 0
      ? novel.characters
        .map((character) => `- ${character.name}（${character.role}）${character.personality ? `：${character.personality.slice(0, 80)}` : ""}`)
        .join("\n")
      : "暂无";
    const currentOutlinePromptMessages = await prepareResolvedPromptExecution({
      asset: novelOutlinePrompt,
      promptInput: {
        title: novel.title,
        description: novel.description ?? "",
        charactersText,
        worldContext: outlineWorldContext?.promptBlock
          ?? "本书世界上下文：暂无。请根据小说基础信息推进，不要凭空新增复杂世界规则。",
        referenceContext: outlineReferenceContext.trim() || undefined,
      },
      options: {},
    });
    const structuredOutlinePromptMessages = await prepareResolvedPromptExecution({
      asset: novelStructuredOutlinePrompt,
      promptInput: {
        charactersText,
        worldContext: structuredOutlineWorldContext?.promptBlock
          ?? "本书世界上下文：暂无。请根据小说基础信息推进，不要凭空新增复杂世界规则。",
        outline: novel.outline ?? "",
        referenceContext: structuredOutlineReferenceContext.trim() || undefined,
        totalChapters: novel.estimatedChapterCount ?? DEFAULT_ESTIMATED_CHAPTER_COUNT,
      },
      options: {},
    });
    const outlinePrompt = toPromptPreview(
      novelOutlinePrompt as PromptAsset<unknown, unknown, unknown>,
      currentOutlinePromptMessages.messages,
      currentOutlinePromptMessages.context.blocks,
    );
    const structuredOutlinePrompt = toPromptPreview(
      novelStructuredOutlinePrompt as PromptAsset<unknown, unknown, unknown>,
      structuredOutlinePromptMessages.messages,
      structuredOutlinePromptMessages.context.blocks,
    );

    let executionContractPrompt: PromptPreviewView | null = null;
    let volumeScriptPrompt: PromptPreviewView | null = null;
    if (targetVolume && volumeDocument) {
      const volumeNovel = buildVolumeGenerationNovel(novel);
      const workspace = volumeDocument;
      const chapterBudget = deriveChapterBudget({ novel: volumeNovel, workspace, options: {} });
      const chapterBudgets = allocateChapterBudgets({
        volumeCount: Math.max(workspace.volumes.length, 1),
        chapterBudget,
        existingVolumes: workspace.volumes,
      });
      const targetIndex = workspace.volumes.findIndex((volume) => volume.id === targetVolume.id);
      const targetChapterCount = resolveBeatSheetTargetChapterCount({
        targetVolumeChapterCount: targetVolume.chapters.length,
        targetVolumeIndex: targetIndex,
        volumeCount: workspace.volumes.length,
        chapterBudget,
        chapterBudgets,
      });
      const beatSheetInput = {
        novel: volumeNovel,
        workspace,
        storyMacroPlan: macroPlan,
        strategyPlan: workspace.strategyPlan,
        targetVolume,
        targetChapterCount,
      };
      const messages = await prepareResolvedPromptExecution({
        asset: volumeBeatSheetPrompt,
        promptInput: beatSheetInput,
        contextBlocks: buildVolumeBeatSheetContextBlocks(beatSheetInput),
        options: { novelId, chapterId, volumeId: targetVolume.id, entrypoint: "chapter_pipeline", stage: "structured_outline", scope: "beat_sheet" },
      });
      volumeScriptPrompt = toPromptPreview(
        volumeBeatSheetPrompt as PromptAsset<unknown, unknown, unknown>,
        messages.messages,
        messages.context.blocks,
      );
    }
    if (targetVolume && targetVolumeChapter && volumeDocument) {
      const volumePromptInput = {
        novel: buildVolumeGenerationNovel(novel),
        workspace: volumeDocument as VolumePlanDocument,
        storyMacroPlan: macroPlan,
        strategyPlan: volumeDocument.strategyPlan,
        targetVolume,
        targetBeatSheet,
        targetChapter: targetVolumeChapter,
        detailMode: "task_sheet" as const,
        guidance: CHAPTER_EXECUTION_CONTRACT_REGENERATION_GUIDANCE,
      };
      const messages = await prepareResolvedPromptExecution({
        asset: volumeChapterExecutionContractPrompt,
        promptInput: volumePromptInput,
        contextBlocks: buildVolumeChapterDetailContextBlocks(volumePromptInput),
        options: { novelId, chapterId, volumeId: targetVolume.id, entrypoint: "chapter_pipeline", stage: "chapter_execution_contract", scope: "chapter_detail" },
      });
      executionContractPrompt = toPromptPreview(
        volumeChapterExecutionContractPrompt as PromptAsset<unknown, unknown, unknown>,
        messages.messages,
        messages.context.blocks,
      );
    }

    const assembled = await this.assembler.assemble(novelId, chapterId, {}, { worldContextBlock: worldContext });
    const writeContext = assembled.contextPackage.chapterWriteContext;
    let writerPrompt: PromptPreviewView | null = null;
    if (writeContext) {
      const fallbackBlocks = sanitizeWriterContextBlocks([
        await loadWritingPlatformBlock(novelId),
        ...buildChapterWriterContextBlocks(writeContext),
      ]).allowedBlocks;
      const resolvedContext = await resolvePromptContextBlocksForAsset({
        asset: chapterWriterPrompt,
        executionContext: {
          entrypoint: "chapter_pipeline",
          novelId,
          chapterId,
          metadata: {
            chapterWriteContext: writeContext,
            chapterBlockMode: "full",
            ragContext: assembled.contextPackage.ragContext,
          },
        },
        fallbackBlocks,
      });
      const prepared = await prepareResolvedPromptExecution({
        asset: chapterWriterPrompt,
        promptInput: getPromptInputFromChapter({
          title: novel.title,
          order: chapter.order,
          chapterTitle: chapter.title,
          targetWordCount: writeContext.chapterMission.targetWordCount ?? null,
        }),
        contextBlocks: resolvedContext.blocks,
        options: { novelId, chapterId, entrypoint: "chapter_pipeline" },
      });
      writerPrompt = toPromptPreview(chapterWriterPrompt as PromptAsset<unknown, unknown, unknown>, prepared.messages, prepared.context.blocks);
    }

    const planText = plan
      ? [
        `标题：${plan.title}`,
        `本章目标：${plan.objective}`,
        plan.hookTarget ? `章末钩子：${plan.hookTarget}` : "",
        plan.mustAdvanceJson ? `必须推进：${formatJson(plan.mustAdvanceJson)}` : "",
        plan.mustPreserveJson ? `必须保留：${formatJson(plan.mustPreserveJson)}` : "",
        plan.revealsJson ? `关键信息：${formatJson(plan.revealsJson)}` : "",
        plan.riskNotesJson ? `风险提醒：${formatJson(plan.riskNotesJson)}` : "",
        ...plan.scenes.map((scene: {
          sortOrder: number;
          title: string;
          objective: string | null;
          conflict: string | null;
          reveal: string | null;
          emotionBeat: string | null;
        }) => `${scene.sortOrder}. ${scene.title}\n目标：${scene.objective ?? "无"}\n冲突：${scene.conflict ?? "无"}\n变化：${scene.reveal ?? "无"}\n情绪：${scene.emotionBeat ?? "无"}`),
      ].filter(Boolean).join("\n\n")
      : "暂无本章分纲。";

    const volumeText = targetVolume && targetVolumeChapter
      ? [
        `第 ${targetVolume.sortOrder} 卷：${targetVolume.title}`,
        `卷梗概：${targetVolume.summary ?? "暂无"}`,
        `本卷承诺：${targetVolume.mainPromise ?? "暂无"}`,
        `升级方式：${targetVolume.escalationMode ?? "暂无"}`,
        targetBeatSheet?.beats.length
          ? `卷内节拍：\n${targetBeatSheet.beats.map((beat, index) => `${index + 1}. ${beat.title || beat.label}：${beat.summary}`).join("\n")}`
          : "",
        `第 ${chapter.order} 章安排：${targetVolumeChapter.title}`,
        `本章梗概：${targetVolumeChapter.summary}`,
        targetVolumeChapter.purpose ? `本章目的：${targetVolumeChapter.purpose}` : "",
      ].filter(Boolean).join("\n")
      : "暂无可用的卷规划。";

    const outlineText = [
      novel.outline?.trim() ? `全书大纲：\n${novel.outline.trim()}` : "全书大纲：暂无。",
      novel.structuredOutline?.trim() ? `结构化大纲：\n${novel.structuredOutline.trim()}` : "",
      worldSliceView?.hasWorld
        ? (worldSliceView.isStale ? "世界规则切片状态：已过期；实际生成前会刷新。" : "世界规则切片状态：已同步。")
        : "世界规则切片状态：暂无已保存切片。",
      bible ? `世界观手册：\n${[bible.coreSetting, bible.mainPromise, bible.worldRules, bible.forbiddenRules, bible.rawContent].filter(Boolean).join("\n")}` : "世界观手册：暂无。",
      worldContext?.promptBlock ? `当前章节世界规则：\n${worldContext.promptBlock}` : "",
      macroRow ? `宏观故事架构：\n${[macroRow.storyInput, macroRow.expansionJson, macroRow.decompositionJson, macroRow.constraintEngineJson].filter(Boolean).map((item) => formatJson(item)).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");

    return {
      chapter: { id: chapter.id, order: chapter.order, title: chapter.title },
      stages: [
        { key: "outline_world", title: "全书大纲与世界观", text: outlineText },
        { key: "volume_script", title: "卷剧本与节奏", text: volumeText },
        { key: "chapter_outline", title: "当前章节分纲", text: planText },
        { key: "chapter_script", title: "正文小剧本", text: [chapter.taskSheet?.trim() ? `任务单：\n${chapter.taskSheet.trim()}` : "暂无本章任务单。", chapter.sceneCards?.trim() ? `场景拆解：\n${formatJson(chapter.sceneCards)}` : "暂无本章场景拆解。"].join("\n\n") },
      ],
      prompts: {
        outline: outlinePrompt,
        structuredOutline: structuredOutlinePrompt,
        volumeScript: volumeScriptPrompt,
        executionContract: executionContractPrompt,
        writer: writerPrompt,
      },
    };
  }
}

export const chapterCreativeTraceService = new ChapterCreativeTraceService();

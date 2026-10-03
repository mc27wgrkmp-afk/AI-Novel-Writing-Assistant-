import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../db/prisma";
import { withSqliteRetry } from "../../../../db/sqliteRetry";
import {
  mergeChapterPatchForGenerationStateBump,
  type OperationalChapterStatus,
  type PipelineGenerationState,
} from "../../chapterLifecycleState";
import { assertChapterContentNotEmpty } from "../chapterEmptyContentError";
import { assertChapterModelOutput } from "../chapterModelOutputGuard";

export class ChapterContentPersistenceError extends Error {
  constructor(
    readonly chapterId: string,
    message: string,
  ) {
    super(message);
    this.name = "ChapterContentPersistenceError";
  }
}

export class ChapterLifecycleService {
  /** Atomically replaces a claimed regeneration draft without overwriting a concurrent edit. */
  async saveRegeneratedContent(input: {
    novelId: string;
    chapterId: string;
    content: string;
    expectedContent: string | null;
  }): Promise<void> {
    const content = assertChapterModelOutput(input.content, {
      novelId: input.novelId,
      chapterId: input.chapterId,
      source: "chapter_regeneration_save",
    });
    try {
      const result = await withSqliteRetry(
        () => prisma.chapter.updateMany({
          where: {
            id: input.chapterId,
            novelId: input.novelId,
            chapterStatus: "generating",
            content: input.expectedContent,
          },
          data: {
            content,
            generationState: "drafted",
            chapterStatus: "pending_review",
            qualityScore: null,
            continuityScore: null,
            characterScore: null,
            pacingScore: null,
            riskFlags: null,
            repairHistory: null,
          },
        }),
        { label: "chapterLifecycle.saveRegeneratedContent" },
      );
      if (result.count !== 1) {
        throw new Error("章节正文或生成状态已变化，请保留当前正文后重试。");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ChapterContentPersistenceError(input.chapterId, `重新生成正文保存失败：${detail}`);
    }
  }

  async saveWorkingContent(input: {
    novelId: string;
    chapterId: string;
    content: string;
    generationState: "drafted" | "repaired";
  }): Promise<string> {
    const content = assertChapterContentNotEmpty(input.content, {
      novelId: input.novelId,
      chapterId: input.chapterId,
      source: "chapter_lifecycle_save",
    });
    try {
      await withSqliteRetry(
        () => prisma.chapter.update({
          where: { id: input.chapterId },
          data: {
            content,
            generationState: input.generationState,
            chapterStatus: "generating",
          },
        }),
        { label: "chapterLifecycle.saveWorkingContent" },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ChapterContentPersistenceError(input.chapterId, `正文保存失败：${detail}`);
    }
    return content;
  }

  async markChapterStatus(chapterId: string, chapterStatus: OperationalChapterStatus): Promise<void> {
    await withSqliteRetry(
      () => prisma.chapter.update({
        where: { id: chapterId },
        data: { chapterStatus },
      }),
      { label: "chapterLifecycle.markChapterStatus" },
    );
  }

  async markGenerationState(chapterId: string, generationState: PipelineGenerationState): Promise<void> {
    await withSqliteRetry(
      () => prisma.chapter.update({
        where: { id: chapterId },
        data: mergeChapterPatchForGenerationStateBump({}, generationState),
      }),
      { label: "chapterLifecycle.markGenerationState" },
    );
  }

  async applyQualityAssessmentState(input: {
    chapterId: string;
    data: Pick<Prisma.ChapterUpdateInput, "riskFlags" | "repairHistory" | "chapterStatus" | "generationState">;
  }): Promise<void> {
    await withSqliteRetry(
      () => prisma.chapter.update({
        where: { id: input.chapterId },
        data: input.data,
      }),
      { label: "chapterLifecycle.applyQualityAssessmentState" },
    );
  }
}

export const chapterLifecycleService = new ChapterLifecycleService();

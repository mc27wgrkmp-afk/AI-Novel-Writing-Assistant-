import { assertAiProseGenerationAllowed } from "../authoring";
import type { BaseMessageChunk } from "@langchain/core/messages";
import { prisma } from "../../../../db/prisma";
import { AppError } from "../../../../middleware/errorHandler";
import { plannerService } from "../../../planner/PlannerService";
import { ChapterWritingGraph } from "../../chapterWritingGraph";
import { NovelCoreSnapshotService } from "../../novelCoreSnapshotService";
import { GenerationContextAssembler } from "../../runtime/GenerationContextAssembler";
import { ChapterRuntimeReadinessService } from "../../runtime/ChapterRuntimeReadinessService";
import { batchContextCache } from "../../runtime/BatchContextCache";
import { chapterLifecycleService } from "../../runtime/lifecycle";
import { assertChapterModelOutput } from "../../runtime/chapterModelOutputGuard";
import type { ChapterRuntimeRequestInput } from "../../runtime/chapterRuntimeSchema";

type Assembled = Awaited<ReturnType<GenerationContextAssembler["assemble"]>>;
type Writer = Pick<ChapterWritingGraph, "createChapterStream">;
type ChapterBefore = { chapterStatus: string | null; order: number; content: string | null };

export interface ChapterRegenerationDeps {
  claim: (novelId: string, chapterId: string) => Promise<ChapterBefore>;
  release: (novelId: string, chapterId: string, previous: ChapterBefore) => Promise<void>;
  backup: (novelId: string, chapterId: string, order: number, expectedContent: string | null) => Promise<unknown>;
  assemble: GenerationContextAssembler["assemble"];
  assertReady: ChapterRuntimeReadinessService["assertReady"];
  writer: Writer;
  save: (novelId: string, chapterId: string, content: string, expectedContent: string | null) => Promise<void>;
}

function createDefaultDeps(): ChapterRegenerationDeps {
  const assembler = new GenerationContextAssembler();
  const readiness = new ChapterRuntimeReadinessService();
  const snapshot = new NovelCoreSnapshotService();
  return {
    claim: async (novelId, chapterId) => prisma.$transaction(async (tx) => {
      const chapter = await tx.chapter.findFirst({ where: { id: chapterId, novelId } });
      if (!chapter) throw new AppError("章节不存在。", 404);
      const [director, chapterRun] = await Promise.all([
        tx.novelWorkflowTask.findFirst({ where: { novelId, lane: "auto_director", status: { in: ["queued", "running"] } }, select: { id: true } }),
        tx.agentRun.findFirst({ where: { novelId, chapterId, status: { in: ["queued", "running"] } }, select: { id: true } }),
      ]);
      if (director || chapterRun || chapter.chapterStatus === "generating") {
        throw new AppError("本章或全书正在生成，请等待任务结束后再重新生成。", 409);
      }
      const claimed = await tx.chapter.updateMany({
        where: { id: chapterId, novelId, chapterStatus: chapter.chapterStatus },
        data: { chapterStatus: "generating" },
      });
      if (claimed.count !== 1) throw new AppError("本章正在生成，请稍后再试。", 409);
      return { chapterStatus: chapter.chapterStatus, order: chapter.order, content: chapter.content };
    }),
    release: async (novelId, chapterId, previous) => {
      await prisma.chapter.updateMany({
        where: { id: chapterId, novelId, chapterStatus: "generating", content: previous.content },
        data: { chapterStatus: previous.chapterStatus as "pending_review" | null },
      });
    },
    backup: async (novelId, chapterId, order, expectedContent) => {
      const saved = await snapshot.createNovelSnapshot(novelId, "manual", `第 ${order} 章重新生成前`);
      const data = JSON.parse(saved.snapshotData) as { chapters?: Array<{ id: string; content: string | null }> };
      const oldDraft = data.chapters?.find((chapter) => chapter.id === chapterId);
      if (!saved.id || !oldDraft || oldDraft.content !== expectedContent) {
        throw new AppError("旧稿快照校验失败，已保留正文，请刷新后重试。", 409);
      }
      return saved;
    },
    assemble: async (novelId, chapterId, request) => {
      // Regeneration is a read boundary: never rebuild a saved outline or script.
      const plan = await plannerService.getChapterPlan(novelId, chapterId);
      if (!plan || plan.scenes.length === 0) {
        throw new AppError("请先保存本章细纲和章节剧本，再重新生成正文。", 400);
      }
      batchContextCache.invalidate(novelId);
      return assembler.assemble(novelId, chapterId, request);
    },
    assertReady: (context) => readiness.assertReady(context),
    writer: new ChapterWritingGraph({
      enforceOpeningDiversity: async (_novelId, _order, _title, content) => ({ content, rewritten: false, maxSimilarity: 0 }),
      // The regenerated draft is committed only after the writer fully completes.
      saveDraftAndArtifacts: async () => {},
      logInfo: (message, meta) => console.info(`[chapter-regeneration] ${message}`, meta ?? ""),
      logWarn: (message, meta) => console.warn(`[chapter-regeneration] ${message}`, meta ?? ""),
    }),
    save: (novelId, chapterId, content, expectedContent) => chapterLifecycleService.saveRegeneratedContent({ novelId, chapterId, content, expectedContent }),
  };
}

/** Rewrites prose from saved creative assets; review and story-state commit remain explicit. */
export class ChapterRegenerationService {
  private readonly deps: ChapterRegenerationDeps;

  constructor(deps?: ChapterRegenerationDeps) {
    this.deps = deps ?? createDefaultDeps();
  }

  async createStream(novelId: string, chapterId: string, options: ChapterRuntimeRequestInput = {}) {
    assertAiProseGenerationAllowed();
    const previous = await this.deps.claim(novelId, chapterId);
    let committed = false;
    let released = false;
    const release = async () => {
      if (committed || released) return;
      released = true;
      await this.deps.release(novelId, chapterId, previous);
    };
    try {
      // Model selection/style are allowed; workflow policy must never trigger planning.
      const request: ChapterRuntimeRequestInput = {
        provider: options.provider, model: options.model, temperature: options.temperature,
        taskStyleProfileId: options.taskStyleProfileId,
      };
      const assembled: Assembled = await this.deps.assemble(novelId, chapterId, request);
      this.deps.assertReady(assembled.contextPackage);
      if (assembled.contextPackage.pendingReviewProposalCount > 0) {
        throw new AppError("请先处理本章待确认的故事状态，再重新生成正文。", 409);
      }
      await this.deps.backup(novelId, chapterId, previous.order, previous.content);
      const writer = await this.deps.writer.createChapterStream({
        novelId, novelTitle: assembled.novel.title,
        chapter: { ...assembled.chapter, content: null },
        contextPackage: { ...assembled.contextPackage, chapter: { ...assembled.contextPackage.chapter, content: null } },
        options: { ...request, deferArtifactBackgroundSync: true },
      });
      let streamCompleted = false;
      return {
        stream: (async function* (): AsyncIterable<BaseMessageChunk> {
          try {
            yield* writer.stream;
            streamCompleted = true;
          } finally {
            if (!streamCompleted) await release();
          }
        })(),
        onDone: async (fullContent: string) => {
          try {
            if (!streamCompleted) throw new AppError("正文生成连接中断，原正文已保留。", 409);
            const normalized = await writer.onDone(fullContent);
            const content = assertChapterModelOutput(normalized?.finalContent ?? fullContent, {
              novelId, chapterId, source: "chapter_regeneration",
            });
            await this.deps.save(novelId, chapterId, content, previous.content);
            committed = true;
            return { fullContent: content };
          } catch (error) {
            await release();
            throw error;
          }
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
}

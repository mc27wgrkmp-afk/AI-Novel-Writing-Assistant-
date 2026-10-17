import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { agentRuntime } from "../../../../agents";
import { validate } from "../../../../middleware/validate";
import type { NovelApplicationServices } from "../../../../services/novel/application/NovelApplicationContracts";
import { chapterCreativeTraceService } from "../../../../services/novel/production/prompts/ChapterCreativeTraceService";
import {
  chapterCreativeRevisionService,
  CHAPTER_CREATIVE_REVISION_SCOPES,
} from "../../../../services/novel/production/revisions/ChapterCreativeRevisionService";

const chapterRevisionCreateSchema = z.object({
  scope: z.enum(CHAPTER_CREATIVE_REVISION_SCOPES),
  label: z.string().trim().max(120).optional(),
});

const chapterRevisionRestoreSchema = z.object({
  id: z.string().trim().min(1),
  chapterId: z.string().trim().min(1),
  revisionId: z.string().trim().min(1),
});

interface RegisterNovelChapterRoutesInput {
  router: Router;
  novelService: Pick<NovelApplicationServices,
    | "listChapters"
    | "createChapter"
    | "updateChapter"
    | "deleteChapter"
    | "ensureChapterExecutionContract"
  >;
  idParamsSchema: z.ZodType<{ id: string }>;
  chapterParamsSchema: z.ZodType<{ id: string; chapterId: string }>;
  chapterSchema: z.ZodTypeAny;
  updateChapterSchema: z.ZodTypeAny;
  chapterExecutionContractSchema: z.ZodTypeAny;
}

export function registerNovelChapterRoutes(input: RegisterNovelChapterRoutesInput): void {
  const {
    router,
    novelService,
    idParamsSchema,
    chapterParamsSchema,
    chapterSchema,
    updateChapterSchema,
    chapterExecutionContractSchema,
  } = input;

  router.get("/:id/chapters", validate({ params: idParamsSchema }), async (req, res, next) => {
    try {
      const { id } = req.params as z.infer<typeof idParamsSchema>;
      const data = await novelService.listChapters(id);
      res.status(200).json({
        success: true,
        data,
        message: "Chapters loaded.",
      } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:id/chapters",
    validate({ params: idParamsSchema, body: chapterSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const data = await novelService.createChapter(id, req.body as any);
        res.status(201).json({
          success: true,
          data,
          message: "Chapter created.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/:id/chapters/:chapterId",
    validate({ params: chapterParamsSchema, body: updateChapterSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.updateChapter(
          id,
          chapterId,
          req.body as any,
        );
        res.status(200).json({
          success: true,
          data,
          message: "Chapter updated.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:id/chapters/:chapterId", validate({ params: chapterParamsSchema }), async (req, res, next) => {
    try {
      const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
      await novelService.deleteChapter(id, chapterId);
      res.status(200).json({
        success: true,
        message: "Chapter deleted.",
      } satisfies ApiResponse<null>);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/:id/chapters/:chapterId/traces",
    validate({ params: chapterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await agentRuntime.listRuns({ novelId: id, chapterId, limit: 20 });
        res.status(200).json({
          success: true,
          data,
          message: "Chapter traces loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/chapters/:chapterId/creative-trace",
    validate({ params: chapterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await chapterCreativeTraceService.get(id, chapterId);
        res.status(200).json({ success: true, data, message: "Chapter creative trace loaded." } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/chapters/:chapterId/revisions",
    validate({ params: chapterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await chapterCreativeRevisionService.list(id, chapterId);
        res.status(200).json({ success: true, data, message: "Chapter revisions loaded." } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/revisions",
    validate({ params: chapterParamsSchema, body: chapterRevisionCreateSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const body = req.body as z.infer<typeof chapterRevisionCreateSchema>;
        const data = await chapterCreativeRevisionService.create({
          novelId: id,
          chapterId,
          scope: body.scope,
          label: body.label,
        });
        res.status(201).json({ success: true, data, message: "Chapter revision saved." } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/revisions/:revisionId/restore",
    validate({ params: chapterRevisionRestoreSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId, revisionId } = req.params as z.infer<typeof chapterRevisionRestoreSchema>;
        const data = await chapterCreativeRevisionService.restore({ novelId: id, chapterId, revisionId });
        await novelService.updateChapter(id, chapterId, data.chapter as any);
        res.status(200).json({ success: true, data, message: "Chapter revision restored." } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/execution-contract",
    validate({ params: chapterParamsSchema, body: chapterExecutionContractSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.ensureChapterExecutionContract(id, chapterId, req.body as any);
        res.status(200).json({
          success: true,
          data,
          message: "Chapter execution contract generated.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );
}

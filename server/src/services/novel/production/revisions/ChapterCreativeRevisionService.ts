import type { Prisma } from "@prisma/client";
import type { StoryPlanRole } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../../db/prisma";

export const CHAPTER_CREATIVE_REVISION_SCOPES = ["chapter_plan", "execution_contract", "prose"] as const;
export type ChapterCreativeRevisionScope = typeof CHAPTER_CREATIVE_REVISION_SCOPES[number];

const REVISION_LABEL_PREFIX = "chapter-creative-revision:v1:";
const REVISION_RETENTION_COUNT = 40;

interface ChapterRevisionPayload {
  schemaVersion: 1;
  chapterId: string;
  scope: ChapterCreativeRevisionScope;
  chapter: Record<string, unknown>;
  plan?: null | {
    id: string;
    novelId: string;
    chapterId: string | null;
    parentId: string | null;
    sourceStateSnapshotId: string | null;
    level: string;
    planRole: string | null;
    phaseLabel: string | null;
    title: string;
    objective: string;
    participantsJson: string | null;
    revealsJson: string | null;
    riskNotesJson: string | null;
    mustAdvanceJson: string | null;
    mustPreserveJson: string | null;
    sourceIssueIdsJson: string | null;
    replannedFromPlanId: string | null;
    hookTarget: string | null;
    status: string;
    externalRef: string | null;
    rawPlanJson: string | null;
    scenes: Array<{
      sortOrder: number;
      title: string;
      objective: string | null;
      conflict: string | null;
      reveal: string | null;
      emotionBeat: string | null;
    }>;
  };
}

function scopeLabel(chapterId: string, scope: ChapterCreativeRevisionScope, label: string): string {
  return `${REVISION_LABEL_PREFIX}${chapterId}:${scope}:${label}`;
}

function scopeLabelPrefix(chapterId: string, scope: ChapterCreativeRevisionScope): string {
  return `${REVISION_LABEL_PREFIX}${chapterId}:${scope}:`;
}

function parseRevisionPayload(snapshotData: string): ChapterRevisionPayload | null {
  try {
    const value = JSON.parse(snapshotData) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<ChapterRevisionPayload>;
    if (record.schemaVersion !== 1 || !record.chapterId || !CHAPTER_CREATIVE_REVISION_SCOPES.includes(record.scope as ChapterCreativeRevisionScope)) {
      return null;
    }
    return record as ChapterRevisionPayload;
  } catch {
    return null;
  }
}

function hasPreviousAsset(input: {
  scope: ChapterCreativeRevisionScope;
  chapter: {
    content: string | null;
    expectation: string | null;
    taskSheet: string | null;
    sceneCards: string | null;
  };
  plan: unknown;
}): boolean {
  if (input.scope === "prose") return Boolean(input.chapter.content?.trim());
  if (input.scope === "chapter_plan") return Boolean(input.plan || input.chapter.expectation?.trim());
  return Boolean(input.chapter.expectation?.trim() || input.chapter.taskSheet?.trim() || input.chapter.sceneCards?.trim());
}

export class ChapterCreativeRevisionService {
  async create(input: {
    novelId: string;
    chapterId: string;
    scope: ChapterCreativeRevisionScope;
    label?: string;
  }) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, novelId: input.novelId },
      select: {
        id: true,
        title: true,
        order: true,
        content: true,
        expectation: true,
        targetWordCount: true,
        conflictLevel: true,
        revealLevel: true,
        mustAvoid: true,
        taskSheet: true,
        sceneCards: true,
        hook: true,
        chapterStatus: true,
        generationState: true,
        qualityScore: true,
        continuityScore: true,
        characterScore: true,
        pacingScore: true,
        riskFlags: true,
        repairHistory: true,
      },
    });
    if (!chapter) throw new Error("章节不存在。");

    const plan = input.scope === "chapter_plan"
      ? await prisma.storyPlan.findFirst({
        where: { novelId: input.novelId, chapterId: input.chapterId, level: "chapter", status: { not: "stale" } },
        include: { scenes: { orderBy: { sortOrder: "asc" } } },
        orderBy: { updatedAt: "desc" },
      })
      : null;
    if (!hasPreviousAsset({ scope: input.scope, chapter, plan })) return null;

    const planSnapshot: ChapterRevisionPayload["plan"] = plan ? {
      id: plan.id,
      novelId: plan.novelId,
      chapterId: plan.chapterId,
      parentId: plan.parentId,
      sourceStateSnapshotId: plan.sourceStateSnapshotId,
      level: plan.level,
      planRole: plan.planRole,
      phaseLabel: plan.phaseLabel,
      title: plan.title,
      objective: plan.objective,
      participantsJson: plan.participantsJson,
      revealsJson: plan.revealsJson,
      riskNotesJson: plan.riskNotesJson,
      mustAdvanceJson: plan.mustAdvanceJson,
      mustPreserveJson: plan.mustPreserveJson,
      sourceIssueIdsJson: plan.sourceIssueIdsJson,
      replannedFromPlanId: plan.replannedFromPlanId,
      hookTarget: plan.hookTarget,
      status: plan.status,
      externalRef: plan.externalRef,
      rawPlanJson: plan.rawPlanJson,
      scenes: plan.scenes.map((scene) => ({
        sortOrder: scene.sortOrder,
        title: scene.title,
        objective: scene.objective,
        conflict: scene.conflict,
        reveal: scene.reveal,
        emotionBeat: scene.emotionBeat,
      })),
    } : null;

    const labelPrefix = scopeLabelPrefix(input.chapterId, input.scope);
    const label = scopeLabel(input.chapterId, input.scope, input.label?.trim() || `第${chapter.order}章生成前版本`);
    const saved = await prisma.novelSnapshot.create({
      data: {
        novelId: input.novelId,
        label,
        triggerType: "manual",
        snapshotData: JSON.stringify({
          schemaVersion: 1,
          chapterId: input.chapterId,
          scope: input.scope,
          chapter,
          ...(input.scope === "chapter_plan" ? { plan: planSnapshot } : {}),
        } satisfies ChapterRevisionPayload),
      },
    });
    try {
      const retainedSnapshots = await prisma.novelSnapshot.findMany({
        where: { novelId: input.novelId, label: { startsWith: labelPrefix } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: REVISION_RETENTION_COUNT,
        select: { id: true },
      });
      if (retainedSnapshots.length > 0) {
        await prisma.novelSnapshot.deleteMany({
          where: { novelId: input.novelId, id: { in: retainedSnapshots.map((snapshot) => snapshot.id) } },
        });
      }
    } catch (error) {
      console.warn("[chapter.revision] Revision retention cleanup skipped.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        scope: input.scope,
        error,
      });
    }
    return {
      id: saved.id,
      scope: input.scope,
      label: input.label?.trim() || `第${chapter.order}章生成前版本`,
      createdAt: saved.createdAt.toISOString(),
    };
  }

  async list(novelId: string, chapterId: string) {
    const snapshots = await prisma.novelSnapshot.findMany({
      where: {
        novelId,
        OR: CHAPTER_CREATIVE_REVISION_SCOPES.map((scope) => ({
          label: { startsWith: scopeLabelPrefix(chapterId, scope) },
        })),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: REVISION_RETENTION_COUNT * CHAPTER_CREATIVE_REVISION_SCOPES.length,
      select: { id: true, label: true, snapshotData: true, createdAt: true },
    });
    return snapshots.flatMap((snapshot) => {
      const payload = parseRevisionPayload(snapshot.snapshotData);
      if (!payload || payload.chapterId !== chapterId) return [];
      return [{
        id: snapshot.id,
        scope: payload.scope,
        label: snapshot.label?.slice(scopeLabelPrefix(chapterId, payload.scope).length) || `第${payload.chapter.order}章保存版本`,
        createdAt: snapshot.createdAt.toISOString(),
      }];
    });
  }

  async restore(input: { novelId: string; chapterId: string; revisionId: string }): Promise<{
    id: string;
    scope: ChapterCreativeRevisionScope;
    chapter: Record<string, unknown>;
  }> {
    const snapshot = await prisma.novelSnapshot.findFirst({
      where: { id: input.revisionId, novelId: input.novelId, label: { startsWith: REVISION_LABEL_PREFIX } },
      select: { id: true, label: true, snapshotData: true },
    });
    const payload = snapshot ? parseRevisionPayload(snapshot.snapshotData) : null;
    if (!snapshot || !payload || payload.chapterId !== input.chapterId) throw new Error("找不到这条章节版本记录。");

    await this.create({
      novelId: input.novelId,
      chapterId: input.chapterId,
      scope: payload.scope,
      label: "回滚前自动保留版本",
    });

    await prisma.$transaction(async (tx) => {
      if (payload.scope === "prose") {
        await tx.chapter.update({
          where: { id: input.chapterId },
          data: {
            content: String(payload.chapter.content ?? ""),
            chapterStatus: payload.chapter.chapterStatus as Prisma.ChapterUpdateInput["chapterStatus"],
            generationState: payload.chapter.generationState as Prisma.ChapterUpdateInput["generationState"],
            qualityScore: payload.chapter.qualityScore as number | null,
            continuityScore: payload.chapter.continuityScore as number | null,
            characterScore: payload.chapter.characterScore as number | null,
            pacingScore: payload.chapter.pacingScore as number | null,
            riskFlags: payload.chapter.riskFlags as string | null,
            repairHistory: payload.chapter.repairHistory as string | null,
          },
        });
        return;
      }

      if (payload.scope === "execution_contract") {
        await tx.chapter.update({
          where: { id: input.chapterId },
          data: {
            expectation: payload.chapter.expectation as string | null,
            targetWordCount: payload.chapter.targetWordCount as number | null,
            conflictLevel: payload.chapter.conflictLevel as number | null,
            revealLevel: payload.chapter.revealLevel as number | null,
            mustAvoid: payload.chapter.mustAvoid as string | null,
            taskSheet: payload.chapter.taskSheet as string | null,
            sceneCards: payload.chapter.sceneCards as string | null,
            hook: payload.chapter.hook as string | null,
          },
        });
        return;
      }

      const savedPlan = payload.plan ?? null;
      await tx.storyPlan.updateMany({
        where: { novelId: input.novelId, chapterId: input.chapterId, level: "chapter", ...(savedPlan ? { id: { not: savedPlan.id } } : {}) },
        data: { status: "stale" },
      });
      if (savedPlan) {
        const planData = {
          chapterId: input.chapterId,
          parentId: savedPlan.parentId,
          sourceStateSnapshotId: savedPlan.sourceStateSnapshotId,
          level: "chapter" as const,
          planRole: savedPlan.planRole as StoryPlanRole | null,
          phaseLabel: savedPlan.phaseLabel,
          title: savedPlan.title,
          objective: savedPlan.objective,
          participantsJson: savedPlan.participantsJson,
          revealsJson: savedPlan.revealsJson,
          riskNotesJson: savedPlan.riskNotesJson,
          mustAdvanceJson: savedPlan.mustAdvanceJson,
          mustPreserveJson: savedPlan.mustPreserveJson,
          sourceIssueIdsJson: savedPlan.sourceIssueIdsJson,
          replannedFromPlanId: savedPlan.replannedFromPlanId,
          hookTarget: savedPlan.hookTarget,
          status: savedPlan.status,
          externalRef: savedPlan.externalRef,
          rawPlanJson: savedPlan.rawPlanJson,
        };
        const existing = await tx.storyPlan.findUnique({ where: { id: savedPlan.id }, select: { id: true } });
        if (existing) {
          await tx.storyPlan.update({ where: { id: savedPlan.id }, data: planData });
        } else {
          await tx.storyPlan.create({ data: { id: savedPlan.id, novelId: input.novelId, ...planData } });
        }
        await tx.chapterPlanScene.deleteMany({ where: { planId: savedPlan.id } });
        if (savedPlan.scenes.length > 0) {
          await tx.chapterPlanScene.createMany({
            data: savedPlan.scenes.map((scene) => ({ planId: savedPlan.id, ...scene })),
          });
        }
      }
      await tx.chapter.update({
        where: { id: input.chapterId },
        data: {
          expectation: payload.chapter.expectation as string | null,
          targetWordCount: payload.chapter.targetWordCount as number | null,
          conflictLevel: payload.chapter.conflictLevel as number | null,
          revealLevel: payload.chapter.revealLevel as number | null,
          mustAvoid: payload.chapter.mustAvoid as string | null,
          taskSheet: payload.chapter.taskSheet as string | null,
          sceneCards: payload.chapter.sceneCards as string | null,
          hook: payload.chapter.hook as string | null,
        },
      });
    });

    const restoredChapter: Record<string, unknown> = payload.scope === "prose"
      ? {
        content: String(payload.chapter.content ?? ""),
        chapterStatus: payload.chapter.chapterStatus,
        qualityScore: payload.chapter.qualityScore,
        continuityScore: payload.chapter.continuityScore,
        characterScore: payload.chapter.characterScore,
        pacingScore: payload.chapter.pacingScore,
        riskFlags: payload.chapter.riskFlags,
        repairHistory: payload.chapter.repairHistory,
      }
      : {
        expectation: payload.chapter.expectation,
        targetWordCount: payload.chapter.targetWordCount,
        conflictLevel: payload.chapter.conflictLevel,
        revealLevel: payload.chapter.revealLevel,
        mustAvoid: payload.chapter.mustAvoid,
        taskSheet: payload.chapter.taskSheet,
        sceneCards: payload.chapter.sceneCards,
        hook: payload.chapter.hook,
      };
    return { id: snapshot.id, scope: payload.scope, chapter: restoredChapter };
  }
}

export const chapterCreativeRevisionService = new ChapterCreativeRevisionService();

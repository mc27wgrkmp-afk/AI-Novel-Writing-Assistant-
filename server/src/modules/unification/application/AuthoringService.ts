import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { hash, parse, POLICY_PREFIX } from "./ImportService";
import type { AuthoringPolicy } from "../domain/types";

export const REVIEW_PREFIX = "unification.review.v1:";
export const APPROVAL_PREFIX = "unification.approval.v1:";
export interface Fact { type: "fact" | "testimony" | "inference" | "rule" | "plan"; text: string; evidence: string; }
export interface Review { id: string; novelId: string; chapterId: string; bodyHash: string; contextHash: string; summary: string; facts: Fact[]; dimensions: Record<string, string>; decision: "pass" | "revise"; blocking: string[]; createdAt: string; meta?: unknown; }

export class AuthoringService {
  async policy(novelId: string): Promise<AuthoringPolicy> {
    const row = await prisma.appSetting.findUnique({ where: { key: POLICY_PREFIX + novelId } });
    return row ? parse<AuthoringPolicy>(row.value) : { mode: "manual", version: 0 };
  }

  async novel(novelId: string) {
    const novel = await prisma.novel.findUnique({ where: { id: novelId }, select: { id: true, title: true } });
    if (!novel) throw new AppError("作品不存在。", 404);
    const chapters = await prisma.chapter.findMany({ where: { novelId }, orderBy: { order: "asc" }, select: { id: true, title: true, order: true, content: true } });
    return { novel, policy: await this.policy(novelId), chapters: chapters.map(c => ({ ...c, content: c.content ?? "", bodyHash: hash(c.content ?? "") })) };
  }

  async setPolicy(novelId: string, mode: AuthoringPolicy["mode"], expectedVersion: number) {
    return prisma.$transaction(async tx => {
      if (!await tx.novel.findUnique({ where: { id: novelId }, select: { id: true } })) throw new AppError("作品不存在。", 404);
      const key = POLICY_PREFIX + novelId;
      const row = await tx.appSetting.findUnique({ where: { key } });
      const current = row ? parse<AuthoringPolicy>(row.value) : { mode: "manual" as const, version: 0 };
      if (current.version !== expectedVersion) throw new AppError("作品模式已变化，请刷新后重试。", 409);
      const policy = { mode, version: current.version + 1 };
      await tx.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(policy) }, update: { value: JSON.stringify(policy) } });
      return policy;
    });
  }

  async context(novelId: string, chapterId: string, db: typeof prisma | Prisma.TransactionClient = prisma) {
    const [novel, chapters, bible, snapshots, facts, characters, contract, world, volumes, storylines] = await Promise.all([
      db.novel.findUnique({ where: { id: novelId }, select: { title: true, description: true, outline: true, structuredOutline: true, styleTone: true, targetWordCount: true, storyWorldSliceJson: true, storyWorldSliceOverridesJson: true, world: true } }),
      db.chapter.findMany({ where: { novelId }, orderBy: { order: "asc" }, select: { id: true, order: true, title: true, content: true, taskSheet: true, sceneCards: true } }),
      db.novelBible.findUnique({ where: { novelId } }),
      db.novelSnapshot.findMany({ where: { novelId, triggerType: "unified_final" }, orderBy: { createdAt: "asc" }, select: { id: true, snapshotData: true } }),
      db.novelFactEntry.findMany({ where: { novelId, category: { not: "superseded" } }, orderBy: [{ chapterOrder: "asc" }, { id: "asc" }] }),
      db.character.findMany({ where: { novelId }, orderBy: { id: "asc" } }),
      db.bookContract.findUnique({ where: { novelId } }),
      db.novelWorld.findUnique({ where: { novelId } }),
      db.volumePlan.findMany({ where: { novelId }, include: { chapters: { orderBy: { chapterOrder: "asc" } } }, orderBy: { sortOrder: "asc" } }),
      db.storylineVersion.findMany({ where: { novelId, status: "active" }, orderBy: { version: "asc" } }),
    ]);
    if (!novel || !chapters.some(c => c.id === chapterId)) throw new AppError("章节不存在。", 404);
    // Current chapter body is independently hashed; other bodies and all context are bound here.
    const currentOrder = chapters.find(c => c.id === chapterId)!.order;
    const activeRows = await db.appSetting.findMany({ where: { key: { in: chapters.map(c => "unification.active-approval.v1:" + c.id) } } });
    const activeIds = new Set(activeRows.map(r => r.value));
    const context = { novel, bible, characters, contract, world, volumes, storylines,
      chapters: chapters.map(c => ({ ...c, content: c.id === chapterId ? "[当前正文另附]" : c.order < currentOrder ? c.content : "[后续正文不进入本章上下文]" })),
      approved: snapshots.filter(s => {
        const data = parse<{ id: string; chapterId: string; chapterOrder?: number }>(s.snapshotData);
        return activeIds.has(data.id) && data.chapterId !== chapterId && (data.chapterOrder ?? Infinity) < currentOrder;
      }),
      facts: facts.filter(f => f.chapterOrder < currentOrder),
    };
    return { context, contextHash: hash(JSON.stringify(context)) };
  }

  async chapter(novelId: string, chapterId: string) {
    const c = await prisma.chapter.findFirst({ where: { id: chapterId, novelId } });
    if (!c) throw new AppError("章节不存在。", 404);
    const [{ contextHash }, snapshots, reviewRows, approvalRows] = await Promise.all([
      this.context(novelId, chapterId),
      prisma.novelSnapshot.findMany({ where: { novelId, triggerType: { in: ["unified_import", "unified_draft", "unified_ai", "unified_conflict"] } }, orderBy: { createdAt: "desc" } }),
      prisma.appSetting.findMany({ where: { key: { startsWith: `${REVIEW_PREFIX}${chapterId}:` } }, orderBy: { createdAt: "desc" } }),
      prisma.appSetting.findMany({ where: { key: { startsWith: `${APPROVAL_PREFIX}${chapterId}:` } }, orderBy: { createdAt: "desc" } }),
    ]);
    const content = c.content ?? "", bodyHash = hash(content);
    const versions = snapshots.map(s => ({ row: s, body: parse<{ chapterId: string; content: string; bodyHash: string; source: string }>(s.snapshotData) }))
      .filter(s => s.body.chapterId === chapterId).map(s => ({ id: s.row.id, label: s.row.label ?? "历史稿", content: s.body.content, bodyHash: s.body.bodyHash, source: s.body.source, createdAt: s.row.createdAt.toISOString() }));
    const reviews = reviewRows.map(r => parse<Review>(r.value)).map(r => ({ ...r, current: r.bodyHash === bodyHash && r.contextHash === contextHash }));
    const activeApproval = await prisma.appSetting.findUnique({ where: { key: "unification.active-approval.v1:" + chapterId } });
    const approvals = approvalRows.map(r => parse<{ id: string; bodyHash: string; contextHash: string; summary: string; facts: Fact[]; createdAt: string }>(r.value)).map(a => ({ ...a, current: activeApproval?.value === a.id && a.bodyHash === bodyHash && a.contextHash === contextHash }));
    return { chapter: { id: c.id, title: c.title, content, bodyHash }, versions, reviews, approvals, contextHash };
  }

  async save(novelId: string, chapterId: string, content: string, expectedHash: string, source = "manual", policyVersion?: number) {
    return prisma.$transaction(async tx => {
      const c = await tx.chapter.findFirst({ where: { id: chapterId, novelId } });
      if (!c) throw new AppError("章节不存在。", 404);
      const policyRow = await tx.appSetting.findUnique({ where: { key: POLICY_PREFIX + novelId } });
      const policy = policyRow ? parse<AuthoringPolicy>(policyRow.value) : { mode: "manual", version: 0 };
      const stale = hash(c.content ?? "") !== expectedHash || (source === "ai" && (policy.mode !== "ai" || policy.version !== policyVersion));
      if (stale && source !== "ai") throw new AppError("正文已被修改，请刷新后对比，当前编辑尚未覆盖原稿。", 409);
      if (c.content) await tx.novelSnapshot.create({ data: { novelId, triggerType: "unified_draft", label: "保存前版本", snapshotData: JSON.stringify({ schema: 1, chapterId, content: c.content, bodyHash: hash(c.content), source: "previous" }) } });
      const saved = await tx.novelSnapshot.create({ data: { novelId, triggerType: stale ? "unified_conflict" : source === "ai" ? "unified_ai" : "unified_draft", label: stale ? "待对比的 AI 草稿" : source === "ai" ? "AI 起草" : "手写保存", snapshotData: JSON.stringify({ schema: 1, chapterId, content, bodyHash: hash(content), parentHash: expectedHash, source, policyVersion }) } });
      if (!stale) {
        const updated = await tx.chapter.updateMany({ where: { id: chapterId, content: c.content }, data: { content, generationState: "drafted", chapterStatus: "pending_review" } });
        if (updated.count !== 1) throw new AppError("正文已被并发修改，请刷新。", 409);
      }
      return { id: c.id, title: c.title, content: stale ? c.content ?? "" : content, bodyHash: stale ? hash(c.content ?? "") : hash(content), branchVersionId: stale ? saved.id : undefined, conflict: stale };
    });
  }

  async storeReview(review: Review) {
    const state = await this.chapter(review.novelId, review.chapterId);
    if (state.chapter.bodyHash !== review.bodyHash || state.contextHash !== review.contextHash) throw new AppError("正文或设定在审读期间发生变化，请重新审读。", 409);
    await prisma.appSetting.create({ data: { key: `${REVIEW_PREFIX}${review.chapterId}:${review.id}`, value: JSON.stringify(review) } });
    return { ...review, current: true };
  }

  async approve(novelId: string, chapterId: string, expectedHash: string, reviewId: string) {
    const state = await this.chapter(novelId, chapterId);
    const review = state.reviews.find(r => r.id === reviewId);
    if (state.chapter.bodyHash !== expectedHash || !review?.current || review.decision !== "pass" || review.blocking.length) throw new AppError("需要当前正文及上下文的通过审读，才能批准定稿。", 409);
    const id = randomUUID(), createdAt = new Date().toISOString();
    const approval = { id, novelId, chapterId, bodyHash: expectedHash, contextHash: state.contextHash,
      reviewId, summary: review.summary, facts: review.facts, summaryHash: hash(review.summary), factsHash: hash(JSON.stringify(review.facts)), createdAt };
    return prisma.$transaction(async tx => {
      const c = await tx.chapter.findFirst({ where: { id: chapterId, novelId } });
      const live = await this.context(novelId, chapterId, tx);
      if (live.contextHash !== state.contextHash) throw new AppError("设定或前文已变化，请重新审读。", 409);
      if (!c || hash(c.content ?? "") !== expectedHash) throw new AppError("正文已变化。", 409);
      const previous = await tx.appSetting.findMany({ where: { key: { startsWith: `${APPROVAL_PREFIX}${chapterId}:` } } });
      const same = previous.map(p => parse<typeof approval>(p.value)).find(p => p.reviewId === reviewId && p.bodyHash === expectedHash && p.contextHash === state.contextHash && p.summaryHash === approval.summaryHash && p.factsHash === approval.factsHash);
      const active = await tx.appSetting.findUnique({ where: { key: "unification.active-approval.v1:" + chapterId } });
      if (same && active?.value === same.id) return { ...same, current: true };
      await tx.novelSnapshot.create({ data: { novelId, triggerType: "unified_final", label: `作者批准：${c.title}`, snapshotData: JSON.stringify({ ...approval, chapterOrder: c.order, content: c.content }) } });
      // Preserve superseded ledger rows as history, but exclude them from active context.
      await tx.novelFactEntry.updateMany({ where: { novelId, chapterOrder: c.order, source: { startsWith: "author:" }, category: { not: "superseded" } }, data: { category: "superseded" } });
      await tx.appSetting.upsert({ where: { key: "unification.active-approval.v1:" + chapterId }, create: { key: "unification.active-approval.v1:" + chapterId, value: id }, update: { value: id } });
      // Approval itself is excluded from the context fingerprint; later chapters/edits invalidate it.
      for (const f of review.facts.filter(f => f.type === "fact" || f.type === "rule")) await tx.novelFactEntry.create({ data: { novelId, chapterOrder: c.order, text: f.text, category: "completed", source: `author:${id}` } });
      await tx.appSetting.create({ data: { key: `${APPROVAL_PREFIX}${chapterId}:${id}`, value: JSON.stringify(approval) } });
      // Keep production-state semantics separate: our approval record is the authority.
      return { ...approval, current: true };
    });
  }
}
export const authoringService = new AuthoringService();

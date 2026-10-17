import { randomUUID } from "node:crypto";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import { unifiedResearchPrompt } from "../../../prompting/prompts/unified/research.prompts";
import { ARTIFACT_PREFIX, hash, importService, parse } from "./ImportService";
import { exclusively } from "./ModelService";

const SEGMENTS: Record<string, [number, number]> = { "0-3000": [0,3000], "3000-10000": [3000,10000], "10000-30000": [10000,30000], "30000-50000": [30000,50000], "50000-100000": [50000,100000] };
export function extractRange(content: string, start: number, end: number): { text: string; total: number } {
  let total = 0, text = "";
  for (const c of content) {
    const counted = /[\p{L}\p{N}]/u.test(c);
    if (total >= start && total < end) text += c;
    if (counted) total++;
  }
  if (total <= start) throw new AppError("该参考作品尚无这个字数区间的正文。", 422);
  return { text, total };
}

export async function runResearch(importId: string, body: { kind: "opening" | "pattern" | "scene"; segment?: string; relatedImportIds?: string[]; patternId?: string }) {
  return exclusively(`research:${importId}`, async () => {
    const entries = await importService.entries();
    const main = entries.find(e => e.id === importId && e.kind === "reference" && e.documentId);
    if (!main) throw new AppError("请选择已导入的参考作品。", 404);
    const sources: { id: string; title: string; text: string }[] = [];
    const sourceVersions: { documentId: string; versionId: string; contentHash: string }[] = [];
    let scope = "";
    if (body.kind === "scene") {
      const row = await prisma.appSetting.findUnique({ where: { key: `${ARTIFACT_PREFIX}${importId}:${body.patternId ?? ""}` } });
      const pattern = row ? parse<{ kind: string; approved: boolean; content: string; sourceVersions?: typeof sourceVersions }>(row.value) : null;
      if (!pattern || pattern.kind !== "pattern" || !pattern.approved) throw new AppError("请先由作者批准有跨书证据的 Pattern。", 409);
      for (const v of pattern.sourceVersions ?? []) {
        const doc = await prisma.knowledgeDocument.findUnique({ where: { id: v.documentId }, include: { activeVersion: true } });
        if (doc?.activeVersionId !== v.versionId || doc.activeVersion?.contentHash !== v.contentHash) throw new AppError("Pattern 的原文版本已变化，请重新研究并批准。", 409);
      }
      sources.push({ id: body.patternId!, title: "作者已批准的跨书模式", text: pattern.content });
      scope = "基于已批准 Pattern 的通用场景结构卡";
    } else {
      const ids = [...new Set([importId, ...(body.relatedImportIds ?? [])])];
      if (body.kind === "pattern" && ids.length < 2) throw new AppError("跨书 Pattern 至少需要两部不同参考作品。", 400);
      const range = body.kind === "opening" ? SEGMENTS[body.segment ?? "0-3000"] : [0,10000];
      if (!range) throw new AppError("开篇区间不支持。", 400);
      for (const id of body.kind === "opening" ? [importId] : ids) {
        const entry = entries.find(e => e.id === id && e.kind === "reference");
        if (!entry?.documentId) throw new AppError("研究来源必须是不同的参考作品。", 400);
        const doc = await prisma.knowledgeDocument.findUnique({ where: { id: entry.documentId }, include: { activeVersion: { include: { chapters: { orderBy: { chapterIndex: "asc" } } } } } });
        if (!doc?.activeVersion) throw new AppError("参考原文版本不存在。", 404);
        const version = doc.activeVersion;
        // Imported source chapter headings are presentation, excluded from WFL character intervals.
        const raw = version.chapters.length ? version.chapters.map(c => version.content.slice(c.startOffset,c.endOffset).replace(/^# [^\n]*\n\n/, "")).join("") : version.content;
        const chosen = extractRange(raw, range[0], range[1]);
        sources.push({ id, title: entry.title, text: chosen.text });
        sourceVersions.push({ documentId: doc.id, versionId: version.id, contentHash: version.contentHash });
      }
      if (new Set(sourceVersions.map(v => v.documentId)).size !== sources.length) throw new AppError("不能把同一本参考作品重复计为跨书证据。", 400);
      scope = body.kind === "opening" ? `开篇正文字符区间 ${body.segment ?? "0-3000"}（Unicode字母与数字计数）` : "所选参考作品各前10000正文字符的对照研究；不代表整书结论";
    }
    if (sources.reduce((n,s) => n+s.text.length,0) > 180000) throw new AppError("本次研究范围过大，请减少参考作品数量。", 400);
    const result = await runStructuredPrompt({ asset: unifiedResearchPrompt, promptInput: { kind: body.kind, scope, sources }, options: { entrypoint: "unified_research", stage: body.kind, timeoutMs: 600000 } });
    const id = randomUUID();
    const artifact = { id, importId, title: `${body.kind === "opening" ? "开篇研究" : body.kind === "pattern" ? "跨书 Pattern" : "SceneCard"} · ${scope}`,
      kind: body.kind, approved: false, content: JSON.stringify(result.output,null,2), sourceVersions, scope,
      evidenceSourceIds: [...new Set(result.output.findings.flatMap(f => f.evidence.map(e => e.sourceId)))],
      contentHash: hash(JSON.stringify(result.output)), createdAt: new Date().toISOString(), modelMeta: result.meta };
    await prisma.appSetting.create({ data: { key: `${ARTIFACT_PREFIX}${importId}:${id}`, value: JSON.stringify(artifact) } });
    return artifact;
  });
}

export async function approvePattern(importId: string, artifactId: string) {
  const key = `${ARTIFACT_PREFIX}${importId}:${artifactId}`;
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const artifact = row ? parse<{ id: string; kind: string; content: string; evidenceSourceIds: string[]; sourceVersions: { documentId: string; versionId: string; contentHash: string }[]; approved?: boolean; approvedAt?: string }>(row.value) : null;
  if (!artifact || artifact.kind !== "pattern" || (artifact.evidenceSourceIds ?? []).length < 2) throw new AppError("只有至少两部参考作品支持的 Pattern 才能批准。", 409);
  for (const v of artifact.sourceVersions) {
    const doc = await prisma.knowledgeDocument.findUnique({ where: { id: v.documentId }, include: { activeVersion: true } });
    if (doc?.activeVersionId !== v.versionId || doc.activeVersion?.contentHash !== v.contentHash) throw new AppError("来源版本已变化，请重新研究。", 409);
  }
  artifact.approved = true; artifact.approvedAt = new Date().toISOString();
  await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify(artifact) } });
  return artifact;
}

import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { scanSources } from "../infrastructure/sourceScanner";
import type { ImportEntry, SourceBundle } from "../domain/types";

export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const ENTRY_PREFIX = "unification.import.v1:";
export const ARTIFACT_PREFIX = "unification.artifact.v1:";
export const POLICY_PREFIX = "unification.policy.v1:";
export const parse = <T>(text: string): T => JSON.parse(text) as T;

/** Import into canonical Novel/Chapter and KnowledgeDocument, preserving source artifacts. */
export class ImportService {
  constructor(private readonly scanner: () => Promise<SourceBundle> = scanSources) {}

  async entries(): Promise<ImportEntry[]> {
    return (await prisma.appSetting.findMany({ where: { key: { startsWith: ENTRY_PREFIX } }, orderBy: { createdAt: "desc" } }))
      .map(r => parse<ImportEntry>(r.value));
  }

  async overview() {
    const [bundle, imports, novels] = await Promise.all([this.scanner(), this.entries(), prisma.novel.findMany({ select: { id: true, title: true }, orderBy: { updatedAt: "desc" } })]);
    return {
      sources: bundle.books.map(b => {
        const existing = imports.find(e => e.sourceKey === b.key);
        return { key: b.key, source: b.source, kind: b.kind, title: b.title, hash: b.hash,
          chapterCount: b.chapters.length, draftCount: b.chapters.reduce((n, c) => n + c.drafts.length, 0),
          artifactCount: b.artifacts.length, latestHan: b.chapters.reduce((n, c) => n + (c.drafts.at(-1)?.han ?? 0), 0),
          imported: Boolean(existing), changed: Boolean(existing && existing.sourceHash !== b.hash) };
      }), imports, novels, warnings: bundle.warnings,
    };
  }

  async importBook(sourceKey: string, expectedHash: string): Promise<ImportEntry> {
    const bundle = await this.scanner();
    const source = bundle.books.find(b => b.key === sourceKey);
    if (!source) throw new AppError("来源不存在，请刷新导入预览。", 404);
    if (source.hash !== expectedHash) throw new AppError("来源已变化，请刷新预览后再导入。", 409);
    const entryKey = ENTRY_PREFIX + hash(sourceKey);
    return prisma.$transaction(async tx => {
      const previous = await tx.appSetting.findUnique({ where: { key: entryKey } });
      if (previous) {
        const entry = parse<ImportEntry>(previous.value);
        if (entry.sourceHash !== source.hash) throw new AppError("这份来源已有导入版本。请先保留当前作品，核对来源变化后另行处理冲突。", 409);
        return entry;
      }
      const id = randomUUID();
      const entry: ImportEntry = { id, sourceKey, sourceHash: source.hash, source: source.source, kind: source.kind,
        title: source.title, chapterCount: source.chapters.length,
        draftCount: source.chapters.reduce((n, c) => n + c.drafts.length, 0), artifactCount: source.artifacts.length,
        createdAt: new Date().toISOString() };
      // Unique source key is the transaction's reservation; a competing import rolls back.
      await tx.appSetting.create({ data: { key: entryKey, value: JSON.stringify(entry) } });
      if (source.kind === "novel") {
        const novel = await tx.novel.create({ data: { title: source.title, description: "由本地书仓导入，历史资料可在统一书房查看。", writingMode: "original", status: "draft" } });
        entry.novelId = novel.id;
        await tx.appSetting.create({ data: { key: POLICY_PREFIX + novel.id, value: JSON.stringify({ mode: "manual", version: 1 }) } });
        for (let i = 0; i < source.chapters.length; i++) {
          const c = source.chapters[i];
          const chapter = await tx.chapter.create({ data: { novelId: novel.id, order: i + 1, title: c.title,
            content: c.content, generationState: c.content ? "drafted" : "planned", chapterStatus: c.content ? "pending_review" : "unplanned" } });
          for (const d of c.drafts) {
            await tx.novelSnapshot.create({ data: { novelId: novel.id, triggerType: "unified_import",
              label: `unified:v1:第${c.volume}卷-第${c.order}章-稿${d.version}`,
              snapshotData: JSON.stringify({ schema: 1, type: "draft", chapterId: chapter.id, source: "import", importId: id,
                sourceChapterKey: c.key, sourceVolume: c.volume, sourceOrder: c.order, sourceKey: d.key,
                sourceHash: d.hash, bodyHash: d.bodyHash, raw: d.raw, candidateFacts: d.candidateFacts, content: d.content, version: d.version }) } });
          }
        }
        const designs = source.artifacts.filter(a => ["design", "contract", "outline", "world", "memory", "ledger"].includes(a.kind) || /^(作品契约|世界书|大纲|账本|本书记忆)\//.test(a.path));
        await tx.novelBible.create({ data: { novelId: novel.id, rawContent: designs.map(a => `## ${a.path}\n\n${a.content}`).join("\n\n") } });
      } else {
        let content = "";
        const sections = source.chapters.map((c, i) => {
          const section = `# ${c.title}\n\n${c.content}\n\n`;
          const startOffset = content.length; content += section;
          return { chapterIndex: i + 1, title: c.title, startOffset, endOffset: content.length,
            charCount: Array.from(c.content).length, summary: JSON.stringify({ sourceChapterKey: c.key, sourceOrder: c.order }), splitter: "unified-import:v1" };
        });
        const document = await tx.knowledgeDocument.create({ data: { title: source.title, fileName: `${source.title}.md`, activeVersionNumber: 1 } });
        const version = await tx.knowledgeDocumentVersion.create({ data: { documentId: document.id, versionNumber: 1, content, contentHash: hash(content), charCount: Array.from(content).length } });
        await tx.knowledgeDocument.update({ where: { id: document.id }, data: { activeVersionId: version.id } });
        for (let i = 0; i < sections.length; i += 150) await tx.documentChapter.createMany({ data: sections.slice(i, i + 150).map(c => ({ ...c, documentVersionId: version.id })) });
        entry.documentId = document.id;
      }
      for (let i = 0; i < source.artifacts.length; i++) {
        const a = source.artifacts[i];
        await tx.appSetting.create({ data: { key: `${ARTIFACT_PREFIX}${id}:${i}`,
          value: JSON.stringify({ id: String(i), importId: id, title: a.path, kind: a.kind, content: a.content, sourceHash: a.hash }) } });
      }
      await tx.appSetting.create({ data: { key: `${ARTIFACT_PREFIX}${id}:metadata`, value: JSON.stringify({ id: "metadata", importId: id, title: "来源与身份映射", kind: "metadata", content: JSON.stringify({ key: source.key, hash: source.hash, metadata: source.metadata, chapterKeys: source.chapters.map(c => ({ key: c.key, volume: c.volume, order: c.order, title: c.title })) }, null, 2) }) } });
      await tx.appSetting.update({ where: { key: entryKey }, data: { value: JSON.stringify(entry) } });
      return entry;
    }, { timeout: 120_000, maxWait: 15_000 });
  }

  async artifacts(importId: string) {
    return (await prisma.appSetting.findMany({ where: { key: { startsWith: `${ARTIFACT_PREFIX}${importId}:` } }, orderBy: { key: "asc" } }))
      .map(r => { const a = parse<{ id: string; title: string; kind: string; approved?: boolean }>(r.value); return { id: a.id, title: a.title, kind: a.kind, approved: a.approved }; });
  }

  async artifact(importId: string, id: string) {
    const row = await prisma.appSetting.findUnique({ where: { key: `${ARTIFACT_PREFIX}${importId}:${id}` } });
    if (!row) throw new AppError("资料不存在。", 404);
    return JSON.parse(row.value) as { title: string; kind: string; content: string };
  }
}
export const importService = new ImportService();

import { randomUUID } from "node:crypto";
import os from "node:os";
import type { FactoryBook, FactorySetup } from "@ai-novel/shared/types/factory";
import { prisma } from "../../../../db/prisma";
import { currentChapter, FactoryError } from "../domain/factoryPolicy";

export interface FactoryRepository {
  create(setup: FactorySetup): Promise<FactoryBook>;
  list(): Promise<FactoryBook[]>;
  read(id: string): Promise<FactoryBook>;
  mutate(id: string, apply: (book: FactoryBook) => void, owner?: string): Promise<FactoryBook>;
  claim(id: string, owner: string): Promise<void>;
  heartbeat(id: string, owner: string): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
}

export const factoryProcessOwner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
const leaseDurationMs = 5 * 60 * 1000;

function ownerAlive(owner: string | null): boolean {
  if (!owner) return false;
  const parts = owner.split(":");
  if (parts[0] !== os.hostname()) return true;
  const pid = Number(parts[1]);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class PrismaFactoryRepository implements FactoryRepository {
  async create(setup: FactorySetup): Promise<FactoryBook> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const book: FactoryBook = {
      ...setup, id, novelId: id, revision: 0, stateVersion: 0,
      currentState: { ...setup.initialState }, chapters: [], nextHandoff: null,
      batchRemaining: 0, createdAt: now, updatedAt: now,
    };
    await prisma.$transaction([
      prisma.novel.create({ data: { id: book.novelId, title: setup.title, description: "章节生产实验；正文与连续性记录请从章节生产页查看。", defaultChapterLength: setup.targetWords } }),
      prisma.factoryBook.create({ data: { id: book.id, title: book.title, payloadJson: JSON.stringify(book) } }),
    ]);
    return book;
  }

  async list(): Promise<FactoryBook[]> {
    const rows = await prisma.factoryBook.findMany({ orderBy: { updatedAt: "desc" } });
    return Promise.all(rows.map((row) => this.read(row.id)));
  }

  async read(id: string): Promise<FactoryBook> {
    const row = await prisma.factoryBook.findUnique({ where: { id } });
    if (!row) throw new FactoryError("生产项目不存在。", 404);
    const book = JSON.parse(row.payloadJson) as FactoryBook;
    book.revision = row.revision;
    const chapter = currentChapter(book);
    book.executionActive = Boolean(row.leaseOwner && row.leaseUntil && row.leaseUntil.getTime() > Date.now() && ownerAlive(row.leaseOwner));
    const interrupted = chapter && ["running", "queued"].includes(chapter.status) && !row.leaseOwner;
    if (interrupted || (row.leaseOwner && (!ownerAlive(row.leaseOwner) || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now()))) {
      if (chapter && ["running", "queued"].includes(chapter.status)) {
        chapter.status = "paused";
        chapter.error = "上次运行中断，已保存的正文和状态可继续使用。点击恢复。";
      }
      book.revision += 1;
      delete book.executionActive;
      book.updatedAt = new Date().toISOString();
      const changed = await prisma.factoryBook.updateMany({
        where: { id, revision: row.revision, leaseOwner: row.leaseOwner },
        data: { payloadJson: JSON.stringify(book), revision: book.revision, leaseOwner: null, leaseUntil: null },
      });
      if (!changed.count) return this.read(id);
    }
    return book;
  }

  async mutate(id: string, apply: (book: FactoryBook) => void, owner?: string): Promise<FactoryBook> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await prisma.factoryBook.findUnique({ where: { id } });
      if (!row) throw new FactoryError("生产项目不存在。", 404);
      if (owner && (row.leaseOwner !== owner || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now())) {
        throw new FactoryError("本次运行已失去执行权，请刷新项目后恢复。", 409);
      }
      const book = JSON.parse(row.payloadJson) as FactoryBook;
      delete book.executionActive;
      apply(book);
      book.revision = row.revision + 1;
      book.updatedAt = new Date().toISOString();
      const chapter = currentChapter(book);
      if (chapter) chapter.updatedAt = book.updatedAt;
      const result = await prisma.factoryBook.updateMany({
        where: { id, revision: row.revision, ...(owner ? { leaseOwner: owner } : {}) },
        data: { payloadJson: JSON.stringify(book), revision: book.revision },
      });
      if (result.count === 1) {
        book.executionActive = Boolean(row.leaseOwner && row.leaseUntil && row.leaseUntil.getTime() > Date.now() && ownerAlive(row.leaseOwner));
        return book;
      }
    }
    throw new FactoryError("项目正在更新，请稍后重试。", 409);
  }

  async claim(id: string, owner: string): Promise<void> {
    await this.read(id); // Converts a dead local process's unfinished run into a durable pause.
    const result = await prisma.factoryBook.updateMany({
      where: { id, OR: [{ leaseOwner: null }, { leaseUntil: { lte: new Date() } }] },
      data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + leaseDurationMs) },
    });
    if (!result.count) throw new FactoryError("本章仍在执行或保存当前步骤，请稍后恢复。", 409);
  }

  async heartbeat(id: string, owner: string): Promise<boolean> {
    const result = await prisma.factoryBook.updateMany({
      where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() } },
      data: { leaseUntil: new Date(Date.now() + leaseDurationMs) },
    });
    return result.count === 1;
  }

  async release(id: string, owner: string): Promise<void> {
    await prisma.factoryBook.updateMany({ where: { id, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } });
  }
}

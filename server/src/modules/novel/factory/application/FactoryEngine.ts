import type {
  FactoryBook, FactoryChapter, FactoryGoal, FactoryModel, FactoryPatch, FactoryPhase,
  FactoryReview, FactoryScript, FactorySetup, FactoryUsage,
} from "@ai-novel/shared/types/factory";
import type { FactoryRepository } from "../infrastructure/FactoryRepository";
import { applyLocalPatches, commitChapter, currentChapter, currentText, FactoryError, reviewBlockers } from "../domain/factoryPolicy";

export interface FactoryPromptContext {
  novelId?: string;
  setup: FactorySetup;
  state: Record<string, string>;
  previousSummary: string;
  order: number;
  goal: FactoryGoal;
  script?: FactoryScript;
  content?: string;
  review?: FactoryReview;
}
export interface FactoryModelResult<T> { output: T; usage: Omit<FactoryUsage, "phase"> }
export interface FactoryModels {
  plan(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<FactoryScript>>;
  write(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<string>>;
  review(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<FactoryReview>>;
  patch(input: FactoryPromptContext, model: FactoryModel): Promise<FactoryModelResult<FactoryPatch>>;
  compile(input: FactoryPromptContext): string;
}

function promptContext(book: FactoryBook, chapter: FactoryChapter, next = false): FactoryPromptContext {
  const order = chapter.order + (next ? 1 : 0);
  const previous = next ? chapter : book.chapters.find((c) => c.order === order - 1);
  const setup: FactorySetup = {
    title: book.title, constitution: book.constitution, lockedFacts: book.lockedFacts,
    negativeCanon: book.negativeCanon, style: book.style, initialState: book.initialState,
    goals: book.goals, targetWords: book.targetWords, planner: book.planner, writer: book.writer,
  };
  return {
    novelId: book.novelId, setup, state: next ? book.currentState : chapter.inputState,
    previousSummary: previous?.summary ?? "首章，尚无上一章。",
    order, goal: book.goals[order - 1],
    ...(!next && chapter.script ? { script: chapter.script } : {}),
    ...(!next && currentText(chapter) ? { content: currentText(chapter) } : {}),
    ...(!next && chapter.reviews.length ? { review: chapter.reviews.at(-1) } : {}),
  };
}

function newChapter(book: FactoryBook): FactoryChapter {
  const order = book.chapters.length + 1;
  const handoff = book.nextHandoff?.order === order && book.nextHandoff.stateVersion === book.stateVersion ? book.nextHandoff : null;
  const now = new Date().toISOString();
  return {
    order, status: "queued", phase: handoff ? "draft" : "plan",
    inputStateVersion: book.stateVersion, inputState: { ...book.currentState },
    script: handoff?.script ?? null, prompt: handoff?.prompt ?? null,
    versions: [], reviews: [], repairAttempts: 0, repairInFlight: false,
    committed: false, summary: null, changes: [], error: null, usage: [],
    startedAt: now, updatedAt: now,
  };
}

/** One saved stage at a time. Pause requests survive responses already in flight. */
export class FactoryEngine {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly repository: FactoryRepository, private readonly models: FactoryModels, private readonly owner: string) {}

  async start(id: string, count = 1): Promise<FactoryBook> {
    await this.repository.claim(id, this.owner);
    try {
      const book = await this.repository.mutate(id, (draft) => {
        const chapter = currentChapter(draft);
        if (chapter && chapter.status !== "completed") throw new FactoryError("当前章尚未完成，请先恢复或修改当前章。", 409);
        if (draft.chapters.length >= draft.goals.length) throw new FactoryError("已完成所有已导入章节目标。", 409);
        draft.batchRemaining = Math.min(count, draft.goals.length - draft.chapters.length);
        draft.chapters.push(newChapter(draft));
        draft.nextHandoff = null;
      }, this.owner);
      this.schedule(id);
      return book;
    } catch (error) { await this.repository.release(id, this.owner); throw error; }
  }

  async pause(id: string): Promise<FactoryBook> {
    return this.repository.mutate(id, (book) => {
      const chapter = currentChapter(book);
      if (!chapter || !["running", "queued"].includes(chapter.status)) throw new FactoryError("没有正在执行的章节。", 409);
      chapter.status = "paused";
      chapter.error = "已请求暂停。当前步骤返回后保存结果，再停止后续调用。";
    });
  }

  async resume(id: string): Promise<FactoryBook> {
    await this.repository.claim(id, this.owner);
    try {
      const book = await this.repository.mutate(id, (draft) => {
        const chapter = currentChapter(draft);
        if (!chapter || chapter.status === "completed") throw new FactoryError("没有需要恢复的章节。", 409);
        if (chapter.status === "blocked") throw new FactoryError("请先根据审核意见修改未定稿正文，再恢复审核。", 409);
        if (chapter.phase === "repair" && chapter.repairAttempts >= 2 && !chapter.repairInFlight) throw new FactoryError("已用完两轮自动修复，请先修改正文，再恢复审核。", 409);
        if (chapter.repairInFlight) {
          // A crashed/failed repair already consumed a reservation. Never reset its budget.
          chapter.repairInFlight = false;
          chapter.phase = "review";
        }
        chapter.status = "queued";
        chapter.error = null;
        draft.batchRemaining = Math.max(1, draft.batchRemaining);
      }, this.owner);
      this.schedule(id);
      return book;
    } catch (error) { await this.repository.release(id, this.owner); throw error; }
  }

  async editDraft(id: string, text: string): Promise<FactoryBook> {
    await this.repository.claim(id, this.owner);
    try {
      return await this.repository.mutate(id, (book) => {
        const chapter = currentChapter(book);
        if (!chapter || chapter.committed || !["paused", "blocked", "failed"].includes(chapter.status)) {
          throw new FactoryError("只能修改暂停或失败的未定稿正文。", 409);
        }
        if (!chapter.script) throw new FactoryError("章节小剧本尚未完成，请先恢复规划。", 409);
        chapter.versions.push({ kind: "manual", text, createdAt: new Date().toISOString() });
        chapter.phase = "review";
        chapter.status = "paused";
        chapter.repairInFlight = false;
        chapter.error = "修改稿已保存，恢复后会重新审核。";
      }, this.owner);
    } finally { await this.repository.release(id, this.owner); }
  }

  private schedule(id: string): void {
    const pending = this.run(id);
    this.running.set(id, pending);
    void pending.finally(() => this.running.delete(id));
  }

  /** Exposed for CLI acceptance and graceful shutdown; never an alternate production path. */
  async waitForIdle(id: string): Promise<void> { await this.running.get(id); }

  private async run(id: string): Promise<void> {
    let ownershipLost = false;
    const heartbeat = setInterval(() => {
      void this.repository.heartbeat(id, this.owner).then((ok) => { if (!ok) ownershipLost = true; }).catch(() => { ownershipLost = true; });
    }, 15000);
    heartbeat.unref();
    try {
      while (!ownershipLost) {
        const book = await this.repository.read(id);
        const chapter = currentChapter(book);
        if (!chapter || !["running", "queued"].includes(chapter.status)) break;
        const activated = await this.repository.mutate(id, (draft) => {
          const c = currentChapter(draft)!;
          if (c.status === "queued") c.status = "running";
        }, this.owner);
        if (currentChapter(activated)?.status !== "running") break;
        await this.step(id, book, chapter);
      }
    } catch (error) {
      if (!ownershipLost) {
        await this.repository.mutate(id, (book) => {
          const chapter = currentChapter(book);
          if (!chapter || chapter.status === "completed" || chapter.status === "paused") return;
          chapter.status = "failed";
          chapter.error = error instanceof FactoryError ? error.message : "模型调用或结果保存未完成。请检查模型连接，然后从当前步骤恢复。";
        }, this.owner).catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeat);
      await this.repository.release(id, this.owner).catch(() => undefined);
    }
  }

  private async call<T>(id: string, phase: FactoryPhase, model: FactoryModel, invoke: () => Promise<FactoryModelResult<T>>): Promise<FactoryModelResult<T>> {
    const started = Date.now();
    try { return await invoke(); }
    catch (error) {
      await this.repository.mutate(id, (book) => {
        currentChapter(book)!.usage.push({ phase, ...model, elapsedMs: Date.now() - started, inputTokens: null, outputTokens: null, source: "unavailable" });
      }, this.owner);
      throw error;
    }
  }

  private async step(id: string, book: FactoryBook, chapter: FactoryChapter): Promise<void> {
    const input = promptContext(book, chapter);
    const phase = chapter.phase;
    if (phase === "plan") {
      const result = await this.call(id, phase, book.planner, () => this.models.plan(input, book.planner));
      const script = { ...result.output, mustDo: [...new Set([...input.goal.mustDo, ...result.output.mustDo])], mustNot: [...new Set([...input.goal.mustNot, ...result.output.mustNot])], hook: input.goal.hook };
      const prompt = this.models.compile({ ...input, script });
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!; c.script = script; c.prompt = prompt; c.phase = "draft"; c.usage.push({ phase, ...result.usage });
      }, this.owner);
    } else if (phase === "draft") {
      const result = await this.call(id, phase, book.writer, () => this.models.write(input, book.writer));
      if (!result.output.trim()) throw new FactoryError("正文模型返回空内容，请检查连接后重试。", 422);
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        c.versions.push({ kind: "draft", text: result.output, createdAt: new Date().toISOString() });
        c.phase = "review"; c.usage.push({ phase, ...result.usage });
      }, this.owner);
    } else if (phase === "review") {
      const result = await this.call(id, phase, book.planner, () => this.models.review(input, book.planner));
      const blockers = reviewBlockers(book, chapter, result.output);
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        c.reviews.push(result.output); c.usage.push({ phase, ...result.usage });
        c.error = blockers.length ? blockers.join("\n") : null;
        c.phase = blockers.length ? "repair" : "commit";
        if (blockers.length && c.repairAttempts >= 2 && c.status !== "paused") c.status = "blocked";
      }, this.owner);
    } else if (phase === "repair") {
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        if (c.status === "paused") throw new FactoryError("已暂停。", 409);
        if (c.repairAttempts >= 2) throw new FactoryError("已用完两轮自动修复，请修改正文后重新审核。", 409);
        c.repairAttempts += 1; c.repairInFlight = true;
      }, this.owner);
      const result = await this.call(id, phase, book.writer, () => this.models.patch(input, book.writer));
      await this.repository.mutate(id, (draft) => { currentChapter(draft)!.usage.push({ phase, ...result.usage }); }, this.owner);
      const text = applyLocalPatches(currentText(chapter), result.output);
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        c.versions.push({ kind: "repair", text, createdAt: new Date().toISOString() });
        c.repairInFlight = false; c.phase = "review";
      }, this.owner);
    } else if (phase === "commit") {
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        if (c.status === "paused") return;
        commitChapter(draft, c);
      }, this.owner);
    } else if (phase === "handoff") {
      let nextHandoff: FactoryBook["nextHandoff"] = null;
      let usage: FactoryUsage | null = null;
      if (chapter.order < book.goals.length) {
        const nextInput = promptContext(book, chapter, true);
        const result = await this.call(id, phase, book.planner, () => this.models.plan(nextInput, book.planner));
        const script = { ...result.output, mustDo: [...new Set([...nextInput.goal.mustDo, ...result.output.mustDo])], mustNot: [...new Set([...nextInput.goal.mustNot, ...result.output.mustNot])], hook: nextInput.goal.hook };
        nextHandoff = { order: chapter.order + 1, stateVersion: book.stateVersion, script, prompt: this.models.compile({ ...nextInput, script }) };
        usage = { phase, ...result.usage };
      }
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        draft.nextHandoff = nextHandoff;
        if (usage) c.usage.push(usage);
        c.phase = "done";
      }, this.owner);
    } else if (phase === "done") {
      await this.repository.mutate(id, (draft) => {
        const c = currentChapter(draft)!;
        if (c.status === "paused") return;
        if (!c.committed) throw new FactoryError("本章尚未提交故事状态，不能进入下一章。", 409);
        c.status = "completed"; c.error = null;
        draft.batchRemaining = Math.max(0, draft.batchRemaining - 1);
        if (draft.batchRemaining > 0 && draft.chapters.length < draft.goals.length) {
          draft.chapters.push(newChapter(draft)); draft.nextHandoff = null;
        }
      }, this.owner);
    }
  }
}

import type { FactoryBook, FactoryChapter, FactoryPatch, FactoryReview } from "@ai-novel/shared/types/factory";

export class FactoryError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

export function currentChapter(book: FactoryBook): FactoryChapter | undefined {
  return book.chapters.at(-1);
}

export function currentText(chapter: FactoryChapter): string {
  return chapter.versions.at(-1)?.text ?? "";
}

export function applyLocalPatches(content: string, result: FactoryPatch): string {
  if (!result.patches.length) throw new FactoryError("修复模型没有返回可应用的局部修改。", 422);
  // Locate against the same original version, before applying any changes.
  const spans = result.patches.map((patch) => {
    const start = content.indexOf(patch.original);
    if (!patch.original.trim() || start < 0 || content.indexOf(patch.original, start + 1) >= 0) {
      throw new FactoryError("修复位置缺失或不唯一，原稿已保留。", 422);
    }
    if (patch.original.length > content.length * 0.6) {
      throw new FactoryError("修复范围过大，需要人工调整小剧本或正文。", 422);
    }
    return { start, end: start + patch.original.length, replacement: patch.replacement };
  }).sort((a, b) => a.start - b.start);
  if (spans.some((span, i) => i > 0 && span.start < spans[i - 1].end)) {
    throw new FactoryError("局部修改位置相互重叠，原稿已保留。", 422);
  }
  if (spans.reduce((sum, span) => sum + span.end - span.start, 0) > content.length * 0.6) {
    throw new FactoryError("累计修复范围过大，需要人工调整正文。", 422);
  }
  let output = content;
  for (const span of spans.reverse()) output = output.slice(0, span.start) + span.replacement + output.slice(span.end);
  if (!output.trim()) throw new FactoryError("修复结果为空，原稿已保留。", 422);
  return output;
}

/** Validation of structured judgments; semantic judgments remain the reviewer's job. */
export function reviewBlockers(book: FactoryBook, chapter: FactoryChapter, review: FactoryReview): string[] {
  const blockers = review.issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.description);
  const labels = { script: "剧情目标", canon: "锁定设定", continuity: "连续性", character: "人物行为", information: "信息边界", expansion: "新增设定", hook: "结尾钩子" };
  for (const [key, passed] of Object.entries(review.checks)) {
    if (!passed) blockers.push(`${labels[key as keyof typeof labels]}检查未通过。`);
  }
  const text = currentText(chapter);
  for (const issue of review.issues) {
    if (issue.evidence && !text.includes(issue.evidence)) blockers.push("审核引用的原文证据不存在。请重新审核。");
  }
  const keys = new Set<string>();
  for (const change of review.changes) {
    if (keys.has(change.key)) blockers.push(`同一状态被重复修改：${change.key}`);
    keys.add(change.key);
    if (change.kind === "new_canon") blockers.push(`新增重大设定需要人工处理：${change.key}`);
    if (book.lockedFacts.some((fact) => fact.id === change.key) || change.key.startsWith("canon.")) {
      blockers.push(`状态变化试图修改锁定设定：${change.key}`);
    }
    if (!change.evidence.trim() || !text.includes(change.evidence)) blockers.push(`状态变化没有有效原文依据：${change.key}`);
    if ((chapter.inputState[change.key] ?? null) !== change.before) blockers.push(`状态变化的起始值不匹配：${change.key}`);
  }
  const words = Array.from(text).filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  if (words < book.targetWords * 0.7 || words > book.targetWords * 1.5) {
    blockers.push(`正文字符数 ${words} 明显偏离目标 ${book.targetWords}，需要调整篇幅。`);
  }
  return [...new Set(blockers)];
}

export function commitChapter(book: FactoryBook, chapter: FactoryChapter): void {
  if (chapter.committed) return;
  if (chapter.inputStateVersion !== book.stateVersion) throw new FactoryError("故事状态版本已变化，请重新检查本章。", 409);
  const review = chapter.reviews.at(-1);
  if (!review || reviewBlockers(book, chapter, review).length) throw new FactoryError("本章仍有未通过的审核，不能提交状态。", 422);
  const next = { ...book.currentState };
  for (const change of review.changes) {
    if ((next[change.key] ?? null) !== change.before) throw new FactoryError("故事状态与本章起始值不一致。", 409);
    Object.defineProperty(next, change.key, { value: change.after, enumerable: true, writable: true, configurable: true });
  }
  // The repository saves this entire book atomically, with a revision compare-and-swap.
  book.currentState = next;
  book.stateVersion += 1;
  chapter.summary = review.summary;
  chapter.changes = review.changes;
  chapter.committed = true;
  chapter.phase = "handoff";
}

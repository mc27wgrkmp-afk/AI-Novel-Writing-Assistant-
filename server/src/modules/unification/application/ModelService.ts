import { randomUUID } from "node:crypto";
import { AppError } from "../../../middleware/errorHandler";
import { runStructuredPrompt, runTextPrompt } from "../../../prompting/core/promptRunner";
import { unifiedReviewPrompt } from "../../../prompting/prompts/unified/review.prompts";
import { chapterWriterPrompt } from "../../../prompting/prompts/novel/chapterWriter.prompts";
import { authoringService } from "./AuthoringService";
import type { PromptContextBlock } from "../../../prompting/core/promptTypes";

const running = new Set<string>();
export async function exclusively<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (running.has(key)) throw new AppError("当前章节已有任务正在执行，请等待完成。", 409);
  running.add(key);
  try { return await work(); } finally { running.delete(key); }
}
function guardSize(context: unknown) {
  if (JSON.stringify(context).length > 180000) throw new AppError("当前上下文过大，请先在作品中整理近期章节和材料范围。", 400);
}

export async function generateDraft(novelId: string, chapterId: string, expectedHash: string, policyVersion: number) {
  return exclusively(chapterId, async () => {
    const [policy, state, pack] = await Promise.all([authoringService.policy(novelId), authoringService.chapter(novelId, chapterId), authoringService.context(novelId, chapterId)]);
    if (policy.mode !== "ai" || policy.version !== policyVersion) throw new AppError("请先为本作品启用 AI 起草。", 409);
    if (state.chapter.bodyHash !== expectedHash) throw new AppError("正文已变化，请刷新后再起草。", 409);
    guardSize(pack.context);
    const novel = await authoringService.novel(novelId);
    const chapter = novel.chapters.find(c => c.id === chapterId)!;
    const groups = ["writing_platform", "book_contract", "chapter_mission", "reader_experience", "character_hard_facts", "obligation_contract", "style_contract", "volume_window", "participant_subset", "local_state"];
    const source = JSON.stringify(pack.context);
    const blocks: PromptContextBlock[] = groups.map((group, i) => ({ id: `unified:${group}`, group, priority: 100-i, required: true,
      estimatedTokens: i === 1 ? Math.ceil(source.length / 2) : 150,
      content: i === 1 ? source : i === 2 ? JSON.stringify({ title: chapter.title, order: chapter.order, currentDraft: chapter.content, instruction: "根据已提供的本章细纲和作品契约起草完整章节。已有正文可形成新稿；不把候选事实和工作流说明写入正文。不得改变正式设计或代替作者批准。" }) : "以 book_contract 中的原始资料及本章任务为准。无明确依据时保留信息边界，不发明隐藏规则、资源或已经兑现的计划。" }));
    const result = await runTextPrompt({ asset: chapterWriterPrompt,
      promptInput: { novelTitle: novel.novel.title, chapterTitle: chapter.title, chapterOrder: chapter.order, mode: "draft" },
      contextBlocks: blocks, options: { novelId, chapterId, entrypoint: "unified_authoring", stage: "draft", timeoutMs: 600000 } });
    if (!result.output.trim()) throw new AppError("模型未返回正文，原稿已保留。", 502);
    return authoringService.save(novelId, chapterId, result.output.trim(), expectedHash, "ai", policyVersion);
  });
}

export async function reviewChapter(novelId: string, chapterId: string, expectedHash: string) {
  return exclusively(chapterId, async () => {
    const [state, pack] = await Promise.all([authoringService.chapter(novelId, chapterId), authoringService.context(novelId, chapterId)]);
    if (!state.chapter.content.trim()) throw new AppError("章节尚无正文。", 400);
    if (state.chapter.bodyHash !== expectedHash) throw new AppError("正文已变化，请刷新后审读。", 409);
    guardSize(pack.context);
    const han = Array.from(state.chapter.content).filter(c => /\p{Script=Han}/u.test(c)).length;
    const result = await runStructuredPrompt({ asset: unifiedReviewPrompt,
      promptInput: { title: state.chapter.title, content: state.chapter.content, han, context: pack.context },
      options: { novelId, chapterId, entrypoint: "unified_review", stage: "eight_dimension_review", timeoutMs: 600000 } });
    return authoringService.storeReview({ ...result.output, id: randomUUID(), novelId, chapterId, bodyHash: expectedHash, contextHash: pack.contextHash, createdAt: new Date().toISOString(), meta: result.meta });
  });
}

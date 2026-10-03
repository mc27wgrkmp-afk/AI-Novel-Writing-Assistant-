import { AppError } from "../../../../middleware/errorHandler";

export const MANUAL_PROSE_HANDOFF_MESSAGE = "AI 负责大纲与章节剧本；请在章节编辑器中自行撰写正文。已有正文可以继续编辑和保存。";

/** Product capability boundary, also enforced for legacy jobs and direct callers. */
export function assertAiProseGenerationAllowed(): void {
  throw new AppError(MANUAL_PROSE_HANDOFF_MESSAGE, 409);
}

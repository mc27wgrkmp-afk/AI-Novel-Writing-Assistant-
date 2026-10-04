import type { ReactNode } from "react";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import ChapterScriptBatchReview from "../../autoDirector/ChapterScriptBatchReview";
import { normalizeNovelWorkspaceTab } from "../../novelWorkspaceNavigation";

interface ChapterScriptBatchWorkbenchProps {
  novelId: string;
  activeTab: string;
  task?: UnifiedTaskDetail | null;
  children: ReactNode;
}

/**
 * Batch acceptance belongs to the structured planning source page.
 * Keep the other workbenches available so authors can rework an individual script.
 */
export default function ChapterScriptBatchWorkbench({ novelId, activeTab, task, children }: ChapterScriptBatchWorkbenchProps) {
  const showReview = normalizeNovelWorkspaceTab(activeTab) === "structured"
    && task?.checkpointType === "chapter_script_batch_ready"
    && task.resumeTarget?.novelId === novelId;
  return (
    <div className="space-y-6">
      {showReview && task ? <ChapterScriptBatchReview key={task.id} task={task} novelId={novelId} /> : null}
      {children}
    </div>
  );
}

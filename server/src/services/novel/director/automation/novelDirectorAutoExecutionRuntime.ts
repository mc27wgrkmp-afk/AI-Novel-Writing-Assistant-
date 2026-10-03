import type { DirectorAutoExecutionState, DirectorConfirmRequest } from "@ai-novel/shared/types/novelDirector";
import type { AutoExecutionResumeStage } from "./novelDirectorAutoExecutionCheckpointRuntime";
import { prepareRequestedAutoExecution as prepareRequestedAutoExecutionState } from "./novelDirectorAutoExecutionRuntimePreparation";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "./novelDirectorAutoExecutionRuntimePorts";

/** Compatibility entry point for saved commands; director owns planning, not prose. */
export class NovelDirectorAutoExecutionRuntime {
  constructor(private readonly deps: NovelDirectorAutoExecutionRuntimeDeps) {}

  async prepareRequestedAutoExecution(input: Parameters<typeof prepareRequestedAutoExecutionState>[1]) {
    return prepareRequestedAutoExecutionState(this.deps, input);
  }

  async runFromReady(input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    existingPipelineJobId?: string | null;
    existingState?: DirectorAutoExecutionState | null;
    resumeCheckpointType?: "chapter_batch_ready" | "replan_required" | null;
    resumeStage?: AutoExecutionResumeStage;
    previousFailureMessage?: string | null;
    allowSkipReviewBlockedChapter?: boolean;
    approveAutoExecutionScope?: boolean;
    skipCurrentQualityRepair?: boolean;
    resumePendingManualRecovery?: boolean;
  }): Promise<void> {
    throw new Error("AI 自动规划止于大纲与章节剧本。请在创作工作台查看剧本并撰写正文。");
  }
}

export function schedulePendingReviewAutoPromotionIfEnabled(
  deps: Pick<
    NovelDirectorAutoExecutionRuntimeDeps,
    "isPendingReviewAutoPromotionEnabled" | "autoPromotePendingReviewProposals"
  >,
  input: {
    novelId: string;
    taskId: string;
  },
): void {
  if (!deps.isPendingReviewAutoPromotionEnabled || !deps.autoPromotePendingReviewProposals) {
    return;
  }
  void Promise.resolve(deps.isPendingReviewAutoPromotionEnabled())
    .then((enabled) => {
      if (!enabled) {
        return undefined;
      }
      return deps.autoPromotePendingReviewProposals?.(input);
    })
    .catch(() => null);
}


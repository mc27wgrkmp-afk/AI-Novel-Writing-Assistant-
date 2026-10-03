export interface DirectorConflictRecoveryOption {
  id: string;
  title: string;
  summary: string;
  changes: string[];
  preserves: string[];
  tradeoff: string;
  instruction: string;
  repair: {
    kind: "chapter_contract" | "workflow_step" | "retry";
    chapterId: string | null;
    stepId: string | null;
  };
}

export interface DirectorConflictRecoveryPlan {
  id: string;
  taskId: string;
  summary: string;
  outlinePriority: string;
  conflicts: Array<{ left: string; right: string; explanation: string }>;
  options: DirectorConflictRecoveryOption[];
  recommendedOptionId: string;
  createdAt: string;
}

export interface DirectorConflictRecoveryRecord {
  plan: DirectorConflictRecoveryPlan;
  contentFingerprint: string;
  failureFingerprint: string;
  selectedOptionId?: string;
  appliedAt?: string;
}

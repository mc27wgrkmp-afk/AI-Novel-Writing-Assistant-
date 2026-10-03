/** The deliberately small, versioned chapter experiment contract. */
export interface FactoryModel { provider: string; model: string }
export interface FactoryGoal {
  title: string;
  goal: string;
  mustDo: string[];
  mustNot: string[];
  hook: string;
}
export interface FactorySetup {
  title: string;
  constitution: string;
  lockedFacts: { id: string; text: string }[];
  negativeCanon: string[];
  style: string;
  initialState: Record<string, string>;
  goals: FactoryGoal[];
  targetWords: number;
  planner: FactoryModel;
  writer: FactoryModel;
}
export interface FactoryScript {
  title: string;
  scenes: string[];
  mustDo: string[];
  mustNot: string[];
  hook: string;
}
export interface FactoryIssue {
  code: string;
  severity: "blocking" | "warning";
  description: string;
  evidence: string;
  repairInstruction: string;
}
export interface FactoryChange {
  key: string;
  before: string | null;
  after: string;
  evidence: string;
  kind: "operational" | "new_canon";
}
export interface FactoryReview {
  checks: {
    script: boolean; canon: boolean; continuity: boolean; character: boolean;
    information: boolean; expansion: boolean; hook: boolean;
  };
  issues: FactoryIssue[];
  summary: string;
  changes: FactoryChange[];
}
export interface FactoryPatch { patches: { original: string; replacement: string }[] }
export type FactoryPhase = "plan" | "draft" | "review" | "repair" | "commit" | "handoff" | "done";
export type FactoryStatus = "queued" | "running" | "paused" | "blocked" | "failed" | "completed";
export interface FactoryUsage {
  phase: FactoryPhase;
  provider: string;
  model: string;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  source: "provider" | "unavailable";
}
export interface FactoryChapter {
  order: number;
  status: FactoryStatus;
  phase: FactoryPhase;
  inputStateVersion: number;
  inputState: Record<string, string>;
  script: FactoryScript | null;
  prompt: string | null;
  versions: { kind: "draft" | "repair" | "manual"; text: string; createdAt: string }[];
  reviews: FactoryReview[];
  repairAttempts: number;
  repairInFlight: boolean;
  committed: boolean;
  summary: string | null;
  changes: FactoryChange[];
  error: string | null;
  usage: FactoryUsage[];
  startedAt: string;
  updatedAt: string;
}
export interface FactoryHandoff {
  order: number;
  stateVersion: number;
  script: FactoryScript;
  prompt: string;
}
export interface FactoryBook extends FactorySetup {
  id: string;
  novelId: string;
  revision: number;
  stateVersion: number;
  currentState: Record<string, string>;
  chapters: FactoryChapter[];
  nextHandoff: FactoryHandoff | null;
  batchRemaining: number;
  /** Read-time projection, never part of the saved story state. */
  executionActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

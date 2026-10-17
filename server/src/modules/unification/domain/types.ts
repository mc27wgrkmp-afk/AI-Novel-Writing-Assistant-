export interface SourceDraft { key: string; version: number; raw: string; content: string; candidateFacts: string; hash: string; bodyHash: string; han: number; }
export interface SourceChapter { key: string; volume: number; order: number; title: string; content: string; drafts: SourceDraft[]; }
export interface SourceArtifact { path: string; kind: string; content: string; hash: string; }
export interface SourceBook {
  key: string; source: "scriptor" | "webfictionlab"; kind: "novel" | "reference";
  title: string; hash: string; chapters: SourceChapter[]; artifacts: SourceArtifact[];
  metadata: Record<string, unknown>;
}
export interface SourceBundle { schema: number; books: SourceBook[]; warnings: string[]; }
export interface ImportEntry {
  id: string; sourceKey: string; sourceHash: string; source: string; kind: string; title: string;
  novelId?: string; documentId?: string; chapterCount: number; draftCount: number; artifactCount: number;
  createdAt: string;
}
export interface AuthoringPolicy { mode: "manual" | "ai"; version: number; }
export const REVIEW_DIMENSIONS = ["structure", "character", "pacing", "world", "theme", "foreshadowing", "style", "text"] as const;

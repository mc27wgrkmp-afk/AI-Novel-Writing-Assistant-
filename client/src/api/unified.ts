import type { ApiResponse } from "@ai-novel/shared/types/api";
import { apiClient } from "./client";

export interface UnifiedSource {
  key: string;
  source: string;
  kind: "novel" | "reference";
  title: string;
  hash: string;
  chapterCount: number;
  draftCount: number;
  artifactCount: number;
  latestHan: number;
  imported: boolean;
  changed: boolean;
}

export interface UnifiedImport {
  id: string;
  sourceKey: string;
  sourceHash: string;
  source: string;
  kind: string;
  title: string;
  novelId?: string;
  documentId?: string;
  chapterCount: number;
  draftCount: number;
  artifactCount: number;
  createdAt: string;
}

export interface UnifiedOverview {
  sources: UnifiedSource[];
  imports: UnifiedImport[];
  novels: { id: string; title: string }[];
}

export interface UnifiedArtifact {
  id: string;
  title: string;
  kind: string;
  approved?: boolean;
}

export interface UnifiedArtifactContent {
  title: string;
  content: string;
  kind: string;
  approved?: boolean;
}

export interface UnifiedResearchArtifact extends UnifiedArtifactContent {
  id: string;
  approved: boolean;
}

export interface UnifiedResearchRequest {
  kind: "opening" | "pattern" | "scene";
  segment?: "0-3000" | "3000-10000" | "10000-30000" | "30000-50000" | "50000-100000";
  relatedImportIds?: string[];
  patternId?: string;
}

export interface UnifiedPolicy {
  mode: "manual" | "ai";
  version: number;
}

export interface UnifiedChapter {
  id: string;
  title: string;
  content: string;
  bodyHash: string;
  conflict?: boolean;
  branchVersionId?: string;
}

export interface UnifiedNovel {
  novel: { id: string; title: string };
  policy: UnifiedPolicy;
  chapters: (UnifiedChapter & { order: number })[];
}

export interface UnifiedVersion {
  id: string;
  label: string;
  content: string;
  bodyHash: string;
  source: string;
  createdAt: string;
}

export interface UnifiedFact {
  type: "fact" | "testimony" | "inference" | "rule" | "plan";
  text: string;
  evidence: string;
}

export interface UnifiedReview {
  id: string;
  bodyHash: string;
  contextHash: string;
  summary: string;
  facts: UnifiedFact[];
  dimensions: Record<string, string>;
  blocking: string[];
  decision: "pass" | "revise";
  createdAt: string;
  current: boolean;
}

export interface UnifiedApproval {
  id: string;
  reviewId?: string;
  bodyHash: string;
  summary: string;
  facts: UnifiedFact[];
  createdAt: string;
  current: boolean;
}

export interface UnifiedChapterDetail {
  chapter: UnifiedChapter;
  versions: UnifiedVersion[];
  reviews: UnifiedReview[];
  approvals: UnifiedApproval[];
  contextHash: string;
}

function result<T>(response: ApiResponse<T>): T {
  if (!response.success || response.data === undefined) {
    throw new Error(response.error || response.message || "没有取得所需内容，请重试。");
  }
  return response.data;
}

const novelPath = (novelId: string) => `/unification/novels/${encodeURIComponent(novelId)}`;
const chapterPath = (novelId: string, chapterId: string) =>
  `${novelPath(novelId)}/chapters/${encodeURIComponent(chapterId)}`;

export async function getUnifiedOverview() {
  const { data } = await apiClient.get<ApiResponse<UnifiedOverview>>("/unification/overview");
  return result(data);
}

export async function importUnifiedSource(sourceKey: string, expectedHash: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedImport>>("/unification/import", {
    sourceKey,
    expectedHash,
  });
  return result(data);
}

export async function getUnifiedArtifacts(importId: string) {
  const { data } = await apiClient.get<ApiResponse<UnifiedArtifact[]>>(
    `/unification/imports/${encodeURIComponent(importId)}/artifacts`,
  );
  return result(data);
}

export async function getUnifiedArtifact(importId: string, artifactId: string) {
  const { data } = await apiClient.get<ApiResponse<UnifiedArtifactContent>>(
    `/unification/imports/${encodeURIComponent(importId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
  return result(data);
}

export async function getUnifiedNovel(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<UnifiedNovel>>(novelPath(novelId));
  return result(data);
}

export async function updateUnifiedPolicy(novelId: string, mode: UnifiedPolicy["mode"], expectedVersion: number) {
  const { data } = await apiClient.put<ApiResponse<UnifiedPolicy>>(`${novelPath(novelId)}/policy`, {
    mode,
    expectedVersion,
  });
  return result(data);
}

export async function getUnifiedChapter(novelId: string, chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<UnifiedChapterDetail>>(chapterPath(novelId, chapterId));
  return result(data);
}

export async function saveUnifiedDraft(novelId: string, chapterId: string, content: string, expectedHash: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedChapter>>(`${chapterPath(novelId, chapterId)}/draft`, {
    content,
    expectedHash,
  });
  return result(data);
}

export async function generateUnifiedDraft(
  novelId: string,
  chapterId: string,
  expectedHash: string,
  policyVersion: number,
) {
  const { data } = await apiClient.post<ApiResponse<UnifiedChapter>>(`${chapterPath(novelId, chapterId)}/generate`, {
    expectedHash,
    policyVersion,
  }, { timeout: 660_000 });
  return result(data);
}

export async function reviewUnifiedChapter(novelId: string, chapterId: string, expectedHash: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedReview>>(`${chapterPath(novelId, chapterId)}/review`, {
    expectedHash,
  }, { timeout: 660_000 });
  return result(data);
}

export async function approveUnifiedChapter(novelId: string, chapterId: string, expectedHash: string, reviewId: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedApproval>>(`${chapterPath(novelId, chapterId)}/approve`, {
    expectedHash,
    reviewId,
  });
  return result(data);
}

export async function runUnifiedResearch(importId: string, payload: UnifiedResearchRequest) {
  const { data } = await apiClient.post<ApiResponse<UnifiedResearchArtifact>>(
    `/unification/research/${encodeURIComponent(importId)}`,
    payload,
    { timeout: 660_000 },
  );
  return result(data);
}

export async function approveUnifiedPattern(importId: string, artifactId: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedResearchArtifact>>(
    `/unification/research/${encodeURIComponent(importId)}/${encodeURIComponent(artifactId)}/approve`,
    {},
  );
  return result(data);
}

import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  TimelineCheckReport,
  TimelineContextForChapter,
} from "@ai-novel/shared/types/timeline";
import type {
  ChapterEditorAiRevisionRequest,
  ChapterEditorAiRevisionResponse,
  Chapter,
  ChapterEditorWorkspaceResponse,
  ChapterEditorRewritePreviewRequest,
  ChapterEditorRewritePreviewResponse,
  ChapterStatus,
} from "@ai-novel/shared/types/novel";
import { apiClient } from "../client";

export async function getNovelChapters(id: string) {
  const { data } = await apiClient.get<ApiResponse<Chapter[]>>(`/novels/${id}/chapters`);
  return data;
}

export async function createNovelChapter(
  id: string,
  payload: {
    title: string;
    order: number;
    content?: string;
    expectation?: string;
    chapterStatus?: ChapterStatus;
    targetWordCount?: number;
    conflictLevel?: number;
    revealLevel?: number;
    mustAvoid?: string;
    taskSheet?: string;
    sceneCards?: string;
    repairHistory?: string;
    qualityScore?: number;
    continuityScore?: number;
    characterScore?: number;
    pacingScore?: number;
    riskFlags?: string;
  },
) {
  const { data } = await apiClient.post<ApiResponse<Chapter>>(`/novels/${id}/chapters`, payload);
  return data;
}

export async function updateNovelChapter(
  id: string,
  chapterId: string,
  payload: Partial<{
    title: string;
    order: number;
    content: string;
    expectation: string;
    chapterStatus: ChapterStatus;
    targetWordCount: number;
    conflictLevel: number;
    revealLevel: number;
    mustAvoid: string;
    taskSheet: string;
    sceneCards: string;
    repairHistory: string;
    qualityScore: number;
    continuityScore: number;
    characterScore: number;
    pacingScore: number;
    riskFlags: string;
  }>,
) {
  const { data } = await apiClient.put<ApiResponse<Chapter>>(`/novels/${id}/chapters/${chapterId}`, payload);
  return data;
}

export async function deleteNovelChapter(id: string, chapterId: string) {
  const { data } = await apiClient.delete<ApiResponse<null>>(`/novels/${id}/chapters/${chapterId}`);
  return data;
}

export async function getChapterTraces(novelId: string, chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<import("@ai-novel/shared/types/agent").AgentRun[]>>(
    `/novels/${novelId}/chapters/${chapterId}/traces`,
  );
  return data;
}

export async function getChapterTimeline(novelId: string, chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<{
    context: TimelineContextForChapter;
    latestReport: TimelineCheckReport | null;
  }>>(`/novels/${novelId}/chapters/${chapterId}/timeline`);
  return data;
}

export async function previewChapterRewrite(
  novelId: string,
  chapterId: string,
  payload: ChapterEditorRewritePreviewRequest,
) {
  const { data } = await apiClient.post<ApiResponse<ChapterEditorRewritePreviewResponse>>(
    `/novels/${novelId}/chapters/${chapterId}/editor/rewrite-preview`,
    payload,
  );
  return data;
}

export async function getChapterEditorWorkspace(novelId: string, chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<ChapterEditorWorkspaceResponse>>(
    `/novels/${novelId}/chapters/${chapterId}/editor/workspace`,
  );
  return data;
}

export async function previewChapterAiRevision(
  novelId: string,
  chapterId: string,
  payload: ChapterEditorAiRevisionRequest,
) {
  const { data } = await apiClient.post<ApiResponse<ChapterEditorAiRevisionResponse>>(
    `/novels/${novelId}/chapters/${chapterId}/editor/ai-revision-preview`,
    payload,
  );
  return data;
}

export async function generateChapterExecutionContract(
  novelId: string,
  chapterId: string,
  payload: Partial<{
    provider: import("@ai-novel/shared/types/llm").LLMProvider;
    model: string;
    temperature: number;
    guidance: string;
  }> = {},
) {
  const { data } = await apiClient.post<ApiResponse<Chapter>>(
    `/novels/${novelId}/chapters/${chapterId}/execution-contract`,
    payload,
  );
  return data;
}

export type ChapterCreativeRevisionScope = "chapter_plan" | "execution_contract" | "prose";

export interface ChapterCreativeTrace {
  chapter: { id: string; order: number; title: string };
  stages: Array<{ key: string; title: string; text: string }>;
  prompts: {
    outline: null | {
      promptId: string;
      version: string;
      messages: Array<{ role: string; content: string }>;
      contextBlocks: Array<{ id: string; group: string; content: string }>;
    };
    structuredOutline: null | {
      promptId: string;
      version: string;
      messages: Array<{ role: string; content: string }>;
      contextBlocks: Array<{ id: string; group: string; content: string }>;
    };
    volumeScript: null | {
      promptId: string;
      version: string;
      messages: Array<{ role: string; content: string }>;
      contextBlocks: Array<{ id: string; group: string; content: string }>;
    };
    executionContract: null | {
      promptId: string;
      version: string;
      messages: Array<{ role: string; content: string }>;
      contextBlocks: Array<{ id: string; group: string; content: string }>;
    };
    writer: null | {
      promptId: string;
      version: string;
      messages: Array<{ role: string; content: string }>;
      contextBlocks: Array<{ id: string; group: string; content: string }>;
    };
  };
}

export interface ChapterCreativeRevision {
  id: string;
  scope: ChapterCreativeRevisionScope;
  label: string;
  createdAt: string;
}

export async function getChapterCreativeTrace(novelId: string, chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<ChapterCreativeTrace>>(
    `/novels/${novelId}/chapters/${chapterId}/creative-trace`,
  );
  return data;
}

export async function listChapterCreativeRevisions(novelId: string, chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<ChapterCreativeRevision[]>>(
    `/novels/${novelId}/chapters/${chapterId}/revisions`,
  );
  return data;
}

export async function createChapterCreativeRevision(
  novelId: string,
  chapterId: string,
  payload: { scope: ChapterCreativeRevisionScope; label?: string },
) {
  const { data } = await apiClient.post<ApiResponse<ChapterCreativeRevision | null>>(
    `/novels/${novelId}/chapters/${chapterId}/revisions`,
    payload,
  );
  return data;
}

export async function restoreChapterCreativeRevision(
  novelId: string,
  chapterId: string,
  revisionId: string,
) {
  const { data } = await apiClient.post<ApiResponse<{
    id: string;
    scope: ChapterCreativeRevisionScope;
    chapter: Partial<import("@ai-novel/shared/types/novel").Chapter>;
  }>>(
    `/novels/${novelId}/chapters/${chapterId}/revisions/${revisionId}/restore`,
  );
  return data;
}

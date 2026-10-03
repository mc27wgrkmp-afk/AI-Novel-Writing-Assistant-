import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { DirectorConflictRecoveryPlan } from "@ai-novel/shared/types/directorConflictRecovery";
import { apiClient } from "@/api/client";

export async function loadConflictRecoveryPlan(taskId: string) {
  const { data } = await apiClient.get<ApiResponse<DirectorConflictRecoveryPlan | null>>(
    `/novels/director/tasks/${taskId}/conflict-recovery/plans`,
  );
  return data.data;
}

export async function generateConflictRecoveryPlan(taskId: string, userNote: string) {
  const { data } = await apiClient.post<ApiResponse<DirectorConflictRecoveryPlan>>(
    `/novels/director/tasks/${taskId}/conflict-recovery/plans`, { userNote },
  );
  if (!data.data) throw new Error("AI 没有返回可选方案，请重新分析。");
  return data.data;
}

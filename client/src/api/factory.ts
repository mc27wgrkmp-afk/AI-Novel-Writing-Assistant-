import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { FactoryBook, FactorySetup } from "@ai-novel/shared/types/factory";
import { apiClient } from "./client";

async function unwrap<T>(request: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  const { data } = await request;
  if (!data.success || data.data === undefined) throw new Error(data.error || data.message || "请求未返回结果");
  return data.data;
}
export const factoryApi = {
  list: () => unwrap(apiClient.get<ApiResponse<FactoryBook[]>>("/factory/books")),
  get: (id: string) => unwrap(apiClient.get<ApiResponse<FactoryBook>>(`/factory/books/${encodeURIComponent(id)}`)),
  create: (setup: FactorySetup) => unwrap(apiClient.post<ApiResponse<FactoryBook>>("/factory/books", setup)),
  start: (id: string, count: number) => unwrap(apiClient.post<ApiResponse<FactoryBook>>(`/factory/books/${encodeURIComponent(id)}/start`, { count })),
  pause: (id: string) => unwrap(apiClient.post<ApiResponse<FactoryBook>>(`/factory/books/${encodeURIComponent(id)}/pause`)),
  resume: (id: string) => unwrap(apiClient.post<ApiResponse<FactoryBook>>(`/factory/books/${encodeURIComponent(id)}/resume`)),
  useGeminiWeb: (id: string) => unwrap(apiClient.post<ApiResponse<FactoryBook>>(`/factory/books/${encodeURIComponent(id)}/gemini-web`)),
  draft: (id: string, text: string) => unwrap(apiClient.put<ApiResponse<FactoryBook>>(`/factory/books/${encodeURIComponent(id)}/draft`, { text })),
  export: async (id: string, format: "txt" | "json" | "md") => {
    const result = await apiClient.get<Blob>(`/factory/books/${encodeURIComponent(id)}/export`, { params: { format }, responseType: "blob" });
    const url = URL.createObjectURL(result.data);
    const link = document.createElement("a"); link.href = url; link.download = `章节生产-${id}.${format}`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

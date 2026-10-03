import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChapterEditorDiagnosticCard } from "@ai-novel/shared/types/novel";
import { reviewNovelChapter, updateNovelChapter } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useLLMStore } from "@/store/llmStore";
import ChapterIssueDetails from "../chapterInsights/ChapterIssueDetails";
import ChapterEditorSidebar from "./ChapterEditorSidebar";
import ChapterTextEditor from "./ChapterTextEditor";
import type { ChapterEditorShellProps } from "./chapterEditorTypes";
import { countEditorWords, getSaveStatusLabel, normalizeChapterContent } from "./chapterEditorUtils";

export default function ChapterEditorShell(props: ChapterEditorShellProps) {
  const { novelId, chapter, workspace, workspaceStatus, onBack, onOpenVersionHistory } = props;
  const llm = useLLMStore();
  const queryClient = useQueryClient();
  const normalizedChapterContent = useMemo(() => normalizeChapterContent(chapter?.content ?? ""), [chapter?.content]);
  const [contentDraft, setContentDraft] = useState(normalizedChapterContent);
  const [savedContent, setSavedContent] = useState(normalizedChapterContent);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [selectedDiagnosticId, setSelectedDiagnosticId] = useState<string | null>(null);
  useEffect(() => {
    setContentDraft(normalizedChapterContent);
    setSavedContent(normalizedChapterContent);
    setSaveStatus("idle");
    setSelectedDiagnosticId(null);
  }, [chapter?.id, normalizedChapterContent]);
  const isDirty = contentDraft !== savedContent;
  const wordCount = useMemo(() => countEditorWords(contentDraft), [contentDraft]);
  const selectedDiagnosticCard = workspace?.diagnosticCards.find((card) => card.id === selectedDiagnosticId);
  const invalidateChapterQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapters(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.simpleShelf(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.qualityReport(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterEditorWorkspace(novelId, chapter?.id ?? "none") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.snapshots(novelId) }),
      chapter?.id
        ? queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterPlan(novelId, chapter.id) })
        : Promise.resolve(),
      chapter?.id
        ? queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterAuditReports(novelId, chapter.id) })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.latestStateSnapshot(novelId) }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async (nextContent: string) => {
      if (!chapter) {
        throw new Error("当前未选中章节。");
      }
      return updateNovelChapter(novelId, chapter.id, { content: nextContent });
    },
    onMutate: () => {
      setSaveStatus("saving");
    },
    onSuccess: async (_response, nextContent) => {
      setSavedContent(nextContent);
      setSaveStatus("saved");
      await invalidateChapterQueries();
      toast.success("章节正文已保存。");
    },
    onError: (error) => {
      setSaveStatus("error");
      toast.error(error instanceof Error ? error.message : "章节保存失败。");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) {
        throw new Error("当前未选中章节。");
      }
      if (isDirty || saveMutation.isPending) {
        throw new Error("请先保存正文，再重新审校。");
      }
      return reviewNovelChapter(novelId, chapter.id, {
        provider: llm.provider,
        model: llm.model,
        temperature: 0.1,
        content: savedContent,
      });
    },
    onSuccess: async (response) => {
      await invalidateChapterQueries();
      const assessment = response.data?.qualityAssessment;
      toast.success(assessment?.recommendedAction === "continue"
        ? "重新审校通过，本章待优化项已关闭。"
        : "重新审校完成，AI 仍发现需要处理的内容。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "重新审校失败，请稍后重试。");
    },
  });

  if (!chapter) return <div className="p-10 text-center text-sm text-muted-foreground">请选择一个章节后开始编辑正文。</div>;
  const focusRange = selectedDiagnosticCard?.anchorRange;
  const safeFocusRange = focusRange && focusRange.from >= 0 && focusRange.to > focusRange.from && focusRange.to <= contentDraft.length
    ? focusRange : null;
  const handleFocusDiagnostic = (card: ChapterEditorDiagnosticCard) => setSelectedDiagnosticId((current) => current === card.id ? null : card.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/20 px-4 py-3">
        <p className="text-sm text-muted-foreground">参考章节分纲与剧本，由你完成正文。保存后可以让 AI 检查并提出建议。</p>
        <Button size="sm" variant="outline" disabled={isDirty || !savedContent.trim() || saveMutation.isPending || reviewMutation.isPending} onClick={() => reviewMutation.mutate()}>{reviewMutation.isPending ? "审校中…" : "审校已保存正文"}</Button>
      </div>
      <ChapterIssueDetails chapter={chapter} editing />
      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)_320px]">
        <ChapterEditorSidebar chapter={chapter} workspace={workspace} workspaceStatus={workspaceStatus} wordCount={wordCount} saveStatusLabel={getSaveStatusLabel(saveStatus, isDirty)} isDirty={isDirty} isSaving={saveMutation.isPending} selectedDiagnosticId={selectedDiagnosticId} onBack={onBack} onOpenVersionHistory={onOpenVersionHistory} onSave={() => saveMutation.mutate(contentDraft)} onFocusDiagnostic={handleFocusDiagnostic} />
        <div className="relative min-h-0 overflow-hidden">
          <ChapterTextEditor value={contentDraft} readOnly={saveMutation.isPending} onChange={(next) => { setContentDraft(next); setSaveStatus("idle"); }} onSelectionChange={() => {}} preview={null} focusRange={safeFocusRange} />
        </div>
        <aside className="min-h-0 space-y-5 overflow-y-auto rounded-2xl bg-muted/10 p-4">
          <section><h3 className="mb-2 text-sm font-medium">章节分纲</h3><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{chapter.expectation?.trim() || "先在章节工作台准备分纲，明确本章要发生的事件。"}</p></section>
          <section><h3 className="mb-2 text-sm font-medium">章节剧本</h3><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{chapter.taskSheet?.trim() || "先在章节工作台生成章节剧本，作为写作参考。"}</p></section>
          {chapter.sceneCards?.trim() ? <section><h3 className="mb-2 text-sm font-medium">场景拆解</h3><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{chapter.sceneCards}</p></section> : null}
        </aside>
      </div>
    </div>
  );
}

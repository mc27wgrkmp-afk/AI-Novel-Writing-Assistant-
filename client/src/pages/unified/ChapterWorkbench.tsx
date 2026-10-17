import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, GitCompareArrows, Loader2, Save, Sparkles } from "lucide-react";
import {
  approveUnifiedChapter, generateUnifiedDraft, getUnifiedChapter, reviewUnifiedChapter, saveUnifiedDraft,
  type UnifiedPolicy, type UnifiedReview,
} from "@/api/unified";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ContentReader, ErrorState, LoadingState, unifiedKeys } from "./presentation";
import ReviewPanel from "./ReviewPanel";
import VersionsPanel from "./VersionsPanel";

interface ChapterWorkbenchProps {
  novelId: string;
  chapterId: string;
  policy: UnifiedPolicy;
  policyBusy: boolean;
}

export default function ChapterWorkbench({ novelId, chapterId, policy, policyBusy }: ChapterWorkbenchProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"edit" | "versions" | "review">("edit");
  const [content, setContent] = useState("");
  const [baseHash, setBaseHash] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [checkedHash, setCheckedHash] = useState("");
  const [activeAction, setActiveAction] = useState<"save" | "generate" | "review" | "approve" | null>(null);
  const storageKey = `unification.unsaved.${novelId}.${chapterId}`;
  const chapterQuery = useQuery({
    queryKey: unifiedKeys.chapter(novelId, chapterId),
    queryFn: () => getUnifiedChapter(novelId, chapterId),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const detail = chapterQuery.data;
  const dirty = Boolean(initialized && detail && (content !== detail.chapter.content || baseHash !== detail.chapter.bodyHash));
  const conflict = Boolean(initialized && detail && baseHash !== detail.chapter.bodyHash);

  useEffect(() => {
    if (!detail || initialized) return;
    let cached: { content: string; baseHash: string } | undefined;
    try {
      const value: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null");
      if (value && typeof value === "object" && "content" in value && typeof value.content === "string" && "baseHash" in value && typeof value.baseHash === "string") cached = { content: value.content, baseHash: value.baseHash };
    } catch { /* The server copy remains available when browser storage is unavailable. */ }
    setContent(cached?.content ?? detail.chapter.content);
    setBaseHash(cached?.baseHash ?? detail.chapter.bodyHash);
    setInitialized(true);
  }, [detail, initialized, storageKey]);

  useEffect(() => {
    if (!initialized) return;
    try {
      if (dirty) window.sessionStorage.setItem(storageKey, JSON.stringify({ content, baseHash }));
      else window.sessionStorage.removeItem(storageKey);
    } catch { /* Saving to the book remains the explicit primary save action. */ }
  }, [content, baseHash, initialized, dirty, storageKey]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const refreshChapter = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: unifiedKeys.chapter(novelId, chapterId) }),
      queryClient.invalidateQueries({ queryKey: unifiedKeys.novel(novelId) }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: () => saveUnifiedDraft(novelId, chapterId, content, conflict ? checkedHash : baseHash),
    onSuccess: async (chapter) => {
      setContent(chapter.content);
      setBaseHash(chapter.bodyHash);
      setCheckedHash("");
      await refreshChapter();
      toast.success("新稿已保存，历史版本完整保留。");
    },
    onError: () => { void chapterQuery.refetch(); },
  });
  const generateMutation = useMutation({
    mutationFn: () => generateUnifiedDraft(novelId, chapterId, detail!.chapter.bodyHash, policy.version),
    onSuccess: async (chapter) => {
      setContent(chapter.content);
      setBaseHash(chapter.bodyHash);
      await refreshChapter();
      if (chapter.conflict) {
        setTab("versions");
        toast.info("AI 稿已另存为待对比版本，请对照最新正文后决定采用内容。");
      } else {
        toast.success("AI 草稿已保存为新版本，请阅读并审稿。");
      }
    },
    onError: () => { void chapterQuery.refetch(); },
  });
  const reviewMutation = useMutation({
    mutationFn: () => reviewUnifiedChapter(novelId, chapterId, detail!.chapter.bodyHash),
    onSuccess: async () => { await refreshChapter(); toast.success("审稿完成，请核对意见、摘要与事实材料。"); },
    onError: () => { void chapterQuery.refetch(); },
  });
  const approveMutation = useMutation({
    mutationFn: (review: UnifiedReview) => approveUnifiedChapter(novelId, chapterId, review.bodyHash, review.id),
    onSuccess: async () => { await refreshChapter(); toast.success("本章已按你的批准定稿。"); },
    onError: () => { void chapterQuery.refetch(); },
  });

  const busy = saveMutation.isPending || generateMutation.isPending || reviewMutation.isPending || approveMutation.isPending || policyBusy;
  const mutationError = activeAction === "save" ? saveMutation.error : activeAction === "generate" ? generateMutation.error : activeAction === "review" ? reviewMutation.error : activeAction === "approve" ? approveMutation.error : null;
  const hanCount = Array.from(content).filter((character) => /\p{Script=Han}/u.test(character)).length;
  if (chapterQuery.isLoading || (detail && !initialized)) return <LoadingState label="正在打开章节与保留版本…" />;
  if (chapterQuery.isError) return <ErrorState error={chapterQuery.error} retry={() => { void chapterQuery.refetch(); }} />;
  if (!detail) return null;

  return (
    <section className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold">{detail.chapter.title}</h3><div className="flex items-center gap-2"><Badge variant="secondary">{dirty ? "有未保存的修改" : "正文已保存"}</Badge><span className="text-xs tabular-nums text-muted-foreground">{hanCount.toLocaleString("zh-CN")} 汉字</span></div></div>
      <div className="flex flex-wrap gap-2 border-b border-border/60 pb-3" aria-label="章节工具">
        {([{ key: "edit", label: "正文编辑", icon: BookOpenText }, { key: "versions", label: `稿件版本 · ${detail.versions.length}`, icon: GitCompareArrows }, { key: "review", label: "审稿与定稿", icon: BookOpenText }] as const).map((item) => <Button key={item.key} size="sm" variant={tab === item.key ? "secondary" : "ghost"} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}><item.icon className="h-4 w-4" />{item.label}</Button>)}
      </div>
      {mutationError ? <ErrorState error={mutationError} /> : null}
      {tab === "edit" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-lg text-sm leading-6 text-muted-foreground">在这里修改正文，每次保存都保留一个新稿件版本。</p>
            <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy || dirty || policy.mode !== "ai"} title={policy.mode === "manual" ? "本作品使用手写模式，可在作品设置中开启 AI 起草" : dirty ? "请先保存当前修改" : undefined} onClick={() => { setActiveAction("generate"); generateMutation.mutate(); }}>{generateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{generateMutation.isPending ? "正在起草…" : "AI 起草新版本"}</Button><Button disabled={busy || !dirty || !content.trim() || (conflict && checkedHash !== detail.chapter.bodyHash)} onClick={() => { setActiveAction("save"); saveMutation.mutate(); }}>{saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存新稿</Button></div>
          </div>
          {conflict ? <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"><p className="text-sm font-medium">书房中有更新的正文，你的未保存修改已保留。</p><details className="text-sm"><summary className="cursor-pointer text-muted-foreground">对照书房中的最新正文</summary><div className="mt-3 max-h-72 overflow-y-auto rounded-lg bg-background/70 p-4"><ContentReader content={detail.chapter.content} /></div></details><label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" checked={checkedHash === detail.chapter.bodyHash} onChange={(event) => setCheckedHash(event.target.checked ? detail.chapter.bodyHash : "")} />我已对照最新正文，将编辑区内容保存为新版本</label></div> : null}
          <label className="sr-only" htmlFor={`chapter-body-${chapterId}`}>章节正文</label>
          <textarea id={`chapter-body-${chapterId}`} value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} spellCheck={false} className={cn("min-h-[520px] w-full resize-y rounded-xl border border-input bg-background px-5 py-5 text-base leading-8 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 sm:px-8 sm:py-6")} placeholder="从这里写下本章正文…" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs leading-6 text-muted-foreground"><span>{policy.mode === "manual" ? "手写模式 · AI 可协助审稿" : "AI 起草模式 · 新版本需由你审读确认"}</span><span>切换章节时，未保存文字会保留在当前浏览器会话。</span></div>
        </div>
      ) : tab === "versions" ? <VersionsPanel chapter={detail.chapter} versions={detail.versions} /> : <ReviewPanel detail={detail} dirty={dirty} busy={busy} reviewing={reviewMutation.isPending} approving={approveMutation.isPending} onReview={() => { setActiveAction("review"); reviewMutation.mutate(); }} onApprove={async (review) => { setActiveAction("approve"); await approveMutation.mutateAsync(review); }} />}
    </section>
  );
}

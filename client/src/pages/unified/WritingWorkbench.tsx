import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FilePenLine, Loader2, PenLine, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { getUnifiedNovel, updateUnifiedPolicy, type UnifiedPolicy, type UnifiedOverview } from "@/api/unified";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import ChapterWorkbench from "./ChapterWorkbench";
import { EmptyState, ErrorState, LoadingState, unifiedKeys } from "./presentation";

export default function WritingWorkbench({ novels, novelId, onSelectNovel, onOpenImport }: {
  novels: UnifiedOverview["novels"];
  novelId: string;
  onSelectNovel: (id: string) => void;
  onOpenImport: () => void;
}) {
  const queryClient = useQueryClient();
  const [chapterId, setChapterId] = useState("");
  const selectedId = novels.some((novel) => novel.id === novelId) ? novelId : novels[0]?.id ?? "";
  const novelQuery = useQuery({
    queryKey: unifiedKeys.novel(selectedId),
    queryFn: () => getUnifiedNovel(selectedId),
    enabled: Boolean(selectedId),
    refetchOnWindowFocus: false,
  });
  const workspace = novelQuery.data;
  const chapter = workspace?.chapters.find((item) => item.id === chapterId) ?? workspace?.chapters[0];

  useEffect(() => { setChapterId(""); }, [selectedId]);

  const policyMutation = useMutation({
    mutationFn: (mode: UnifiedPolicy["mode"]) => updateUnifiedPolicy(selectedId, mode, workspace!.policy.version),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: unifiedKeys.novel(selectedId) }); toast.success("作品写作方式已保存。"); },
    onError: () => { void novelQuery.refetch(); },
  });

  if (!novels.length) return <EmptyState title="选择一部作品开始写作" action={<Button variant="secondary" onClick={onOpenImport}>导入已有作品</Button>}>导入作者作品后，可在这里编辑正文、比较版本和审稿定稿。</EmptyState>;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-full space-y-2 sm:max-w-md"><label className="text-xs font-medium text-muted-foreground">当前作品</label><Select value={selectedId} onValueChange={onSelectNovel}><SelectTrigger aria-label="选择当前作品" className="shadow-none hover:shadow-none"><SelectValue /></SelectTrigger><SelectContent>{novels.map((novel) => <SelectItem key={novel.id} value={novel.id}>{novel.title}</SelectItem>)}</SelectContent></Select></div>
        <Button asChild variant="ghost" size="sm"><Link to={`/novels/${encodeURIComponent(selectedId)}/edit`}>查看创作规划<ArrowUpRight className="h-4 w-4" /></Link></Button>
      </div>
      {novelQuery.isLoading ? <LoadingState label="正在读取作品与章节…" /> : novelQuery.isError ? <ErrorState error={novelQuery.error} retry={() => { void novelQuery.refetch(); }} /> : workspace ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted/30 px-4 py-4 sm:px-5">
            <div><h2 className="text-sm font-semibold">这部作品的正文写法</h2><p className="mt-1 text-xs leading-6 text-muted-foreground">手写与 AI 起草共用稿件、审稿和作者定稿记录。</p></div>
            <div className="flex rounded-lg bg-background/70 p-1" aria-label="正文写作方式">{([{ mode: "manual", label: "我来手写", icon: PenLine }, { mode: "ai", label: "允许 AI 起草", icon: Sparkles }] as const).map((item) => <Button key={item.mode} variant="ghost" size="sm" aria-pressed={workspace.policy.mode === item.mode} disabled={policyMutation.isPending || workspace.policy.mode === item.mode} className={cn("disabled:opacity-100", workspace.policy.mode === item.mode ? "bg-primary/10 text-primary" : "text-muted-foreground")} onClick={() => policyMutation.mutate(item.mode)}>{policyMutation.isPending && policyMutation.variables === item.mode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <item.icon className="h-3.5 w-3.5" />}{item.label}</Button>)}</div>
          </div>
          {policyMutation.isError ? <ErrorState error={policyMutation.error} /> : null}
          {workspace.chapters.length ? (
            <div className="grid gap-7 xl:grid-cols-[200px_minmax(0,1fr)]">
              <aside className="min-w-0"><h3 className="mb-3 text-xs font-medium text-muted-foreground">章节 · {workspace.chapters.length}</h3><div className="flex gap-1 overflow-x-auto pb-2 xl:max-h-[650px] xl:flex-col xl:overflow-y-auto">{[...workspace.chapters].sort((a, b) => a.order - b.order).map((item) => <button key={item.id} type="button" onClick={() => setChapterId(item.id)} className={cn("flex shrink-0 items-start gap-2 rounded-lg px-3 py-3 text-left text-sm leading-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:shrink", chapter?.id === item.id ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted/50")}><FilePenLine className="mt-1 h-3.5 w-3.5 shrink-0" /><span className="break-words">{item.title}</span></button>)}</div></aside>
              {chapter ? <ChapterWorkbench key={`${selectedId}:${chapter.id}`} novelId={selectedId} chapterId={chapter.id} policy={workspace.policy} policyBusy={policyMutation.isPending} /> : null}
            </div>
          ) : <EmptyState title="作品还没有章节" action={<Button asChild variant="secondary"><Link to={`/novels/${encodeURIComponent(selectedId)}/edit`}>打开作品规划<ArrowUpRight className="h-4 w-4" /></Link></Button>}>先在作品规划中准备章节，再回来编辑和审稿。</EmptyState>}
        </>
      ) : null}
    </div>
  );
}

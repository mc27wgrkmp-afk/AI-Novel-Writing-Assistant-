import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, Loader2, RefreshCw } from "lucide-react";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import { parseChapterScenePlan } from "@ai-novel/shared/types/chapterLengthControl";
import { getNovelDetail } from "@/api/novel/core";
import { getNovelVolumeWorkspace } from "@/api/novel/volumes";
import { acceptNovelWorkflowScriptBatch, getNovelWorkflowScriptBatch } from "@/api/novelWorkflow";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

export default function ChapterScriptBatchReview({ task, novelId }: { task: UnifiedTaskDetail; novelId: string }) {
  const queryClient = useQueryClient();
  const batchQuery = useQuery({
    queryKey: ["novel-workflows", task.id, "script-batch"],
    queryFn: () => getNovelWorkflowScriptBatch(task.id),
  });
  const batch = batchQuery.data?.data;
  const novelQuery = useQuery({ queryKey: ["novels", novelId], queryFn: () => getNovelDetail(novelId) });
  const volumeQuery = useQuery({ queryKey: ["novels", novelId, "script-batch-volumes"], queryFn: () => getNovelVolumeWorkspace(novelId) });
  const refresh = async () => {
    await Promise.all([
      batchQuery.refetch(),
      novelQuery.refetch(),
      volumeQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail("novel_workflow", task.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.directorTaskSnapshot(task.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.directorRuntime(task.id) }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
    ]);
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!batch?.artifactHash) throw new Error("请刷新当前批次后再验收。");
      const result = await acceptNovelWorkflowScriptBatch(task.id, {
        startOrder: batch.startOrder, endOrder: batch.endOrder, artifactHash: batch.artifactHash,
      });
      if (!result.data) throw new Error("验收没有返回结果，请刷新后确认。");
      return result.data;
    },
    onSuccess: async (result) => {
      toast.success(result.completed ? "章节剧本已全部验收，可以根据剧本写作。" : "本批剧本已验收，AI 正在准备下一批。" );
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "验收失败，请重试。"),
  });
  if (!batch) return <div className="space-y-3"><p className="text-sm text-muted-foreground">{batchQuery.isError ? "批次信息加载失败，请重试。" : "正在读取本批剧本。"}</p><Button variant="outline" disabled={batchQuery.isFetching} onClick={() => void refresh()}>重新加载</Button></div>;
  const chapters = novelQuery.data?.data?.chapters ?? [];
  const plans = volumeQuery.data?.data?.volumes.flatMap((volume) => volume.chapters) ?? [];
  const orders = Array.from({ length: batch.endOrder - batch.startOrder + 1 }, (_, index) => batch.startOrder + index);
  const rows = orders.map((order) => {
    const chapter = chapters.find((item) => item.order === order);
    const plan = plans.find((item) => item.chapterOrder === order);
    const scenes = parseChapterScenePlan(chapter?.sceneCards, { targetWordCount: chapter?.targetWordCount ?? 2500 });
    return { order, chapter, plan, scenes };
  });
  const loading = batchQuery.isFetching || novelQuery.isFetching || volumeQuery.isFetching;
  const complete = rows.every(({ chapter, plan, scenes }) => Boolean(chapter?.taskSheet?.trim() && plan?.summary?.trim() && scenes?.scenes.length));
  const nextStart = batch.endOrder + 1;
  const scopeEnd = batch.scopeEndOrder;
  const nextEnd = Math.min(nextStart + 2, scopeEnd);
  return (
    <section className="mx-auto max-w-5xl space-y-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">验收第 {batch.startOrder}–{batch.endOrder} 章剧本</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">先阅读本批的章节大纲、任务单和场景安排。检查事件是否推进、人物与道具是否接得上，满意后再准备下一批。</p>
          {batch.status === "preparing" ? <p role="status" className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />AI 正在准备本批剧本，完成后可阅读并验收。</p> : null}
        </div>
        <Button variant="ghost" disabled={loading || mutation.isPending} onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" />刷新剧本</Button>
      </div>
      {novelQuery.isError || volumeQuery.isError ? <p role="alert" className="text-sm text-destructive">剧本加载失败，请刷新后重试。</p> : null}
      {rows.map(({ order, chapter, plan, scenes }) => (
        <article key={order} className="space-y-5 border-t border-border/60 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">第 {order} 章 · {chapter?.title ?? plan?.title ?? "剧本待准备"}</h2>
            {chapter ? <Button variant="outline" size="sm" asChild><Link to={`/novels/${novelId}/edit?stage=chapter&chapterId=${encodeURIComponent(chapter.id)}&directorTaskId=${encodeURIComponent(task.id)}`}>修改或重新生成本章剧本</Link></Button> : null}
          </div>
          <div><h3 className="text-sm font-semibold">章节大纲</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7">{plan?.summary?.trim() || "章节大纲尚未准备完成。"}</p></div>
          {plan ? <dl className="grid gap-3 text-sm sm:grid-cols-2">{[["本章目标", plan.purpose], ["核心事件", plan.exclusiveEvent], ["结束状态", plan.endingState], ["下一章起点", plan.nextChapterEntryState]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap leading-6">{value}</dd></div>)}</dl> : null}
          <div><h3 className="text-sm font-semibold">章节任务单</h3><div className="mt-2 whitespace-pre-wrap text-sm leading-7">{chapter?.taskSheet?.trim() || "任务单尚未准备完成。"}</div></div>
          <div className="space-y-3"><h3 className="text-sm font-semibold">场景剧本</h3>{scenes?.scenes.length ? scenes.scenes.map((scene, index) => <div key={scene.key} className="space-y-2 rounded-xl bg-muted/30 p-4"><h4 className="text-sm font-semibold">场景 {index + 1} · {scene.title}</h4><dl className="space-y-2 text-sm">{[["场景目标", scene.purpose], ["入场状态", scene.entryState], ["阻碍", scene.resistance], ["行动与推进", scene.mustAdvance.join("；")], ["转折", scene.turn], ["结果", scene.exitState], ["人物情绪变化", scene.emotionalShift], ["读者回报", scene.readerValue], ["应保留的信息", scene.mustPreserve.join("；")], ["本场边界", scene.forbiddenExpansion.join("；")]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap leading-6">{value}</dd></div>)}</dl></div>) : <p className="text-sm text-muted-foreground">场景剧本尚未准备完成。</p>}</div>
        </article>
      ))}
      <div className="space-y-3 border-t border-border/60 pt-6">
        {!complete ? <p className="text-sm text-muted-foreground">本批的章节大纲、任务单和场景剧本全部齐备后才能验收。</p> : null}
        <p className="text-sm text-muted-foreground">如需返工，先修改本批章节，再返回此页刷新并验收。</p>
        <Button disabled={!complete || !batch.artifactHash || loading || mutation.isPending || batch.status !== "waiting_acceptance"} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          {batch.endOrder >= scopeEnd ? "验收通过，完成章节剧本规划" : `验收通过，准备第 ${nextStart}–${nextEnd} 章`}
        </Button>
      </div>
    </section>
  );
}

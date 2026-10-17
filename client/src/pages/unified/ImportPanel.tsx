import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowRight, Check, FolderOpen, Loader2 } from "lucide-react";
import { importUnifiedSource, type UnifiedSource } from "@/api/unified";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, sourceName, unifiedKeys } from "./presentation";

interface ImportPanelProps {
  sources: UnifiedSource[];
  onOpenLibrary: () => void;
}

export default function ImportPanel({ sources, onOpenLibrary }: ImportPanelProps) {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");
  const selected = sources.find((source) => source.key === selectedKey) ?? sources.find((source) => !source.imported) ?? sources[0];
  const importMutation = useMutation({
    mutationFn: (source: UnifiedSource) => importUnifiedSource(source.key, source.hash),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: unifiedKeys.overview });
      toast.success("资料已加入书房，可在作品与研究中查看。");
    },
  });

  if (!sources.length) {
    return <EmptyState title="没有找到可导入的资料">将作品与研究资料放入连接的书房后，点击右上角“刷新书房”查看。</EmptyState>;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.6fr)]">
      <section className="min-w-0">
        <h2 className="text-lg font-semibold">选择一份资料</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">先核对内容与版本数量，再加入书房。</p>
        <div className="mt-5 space-y-2">
          {sources.map((source) => (
            <button key={source.key} type="button" onClick={() => setSelectedKey(source.key)} className={cn("flex w-full gap-3 rounded-xl p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected?.key === source.key ? "bg-primary/10 ring-1 ring-primary/25" : "bg-muted/25 hover:bg-muted/50")}>
              <FolderOpen className="mt-1 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium leading-6">{source.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{sourceName(source.source)} · {source.kind === "reference" ? "参考研究" : "作者作品"}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="secondary">{source.imported ? (source.changed ? "来源有更新" : "已导入") : "待导入"}</Badge>
                  <span className="text-xs leading-5 text-muted-foreground">{source.chapterCount} 章 · {source.draftCount} 个稿件版本</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {selected ? (
        <section className="min-w-0 rounded-2xl bg-muted/25 p-5 sm:p-8" aria-label="导入预览">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground"><span>导入预览</span><span>·</span><span>{sourceName(selected.source)}</span></div>
          <h2 className="mt-4 text-2xl font-semibold leading-snug tracking-tight">{selected.title}</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{selected.kind === "reference" ? "作为参考研究保存，供拆书、资料查阅与创作参考使用。" : "作为作者作品保存，进入章节写作、版本比较和审稿流程。"}</p>
          <dl className="my-8 grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-4">
            {[ ["章节", selected.chapterCount], ["稿件版本", selected.draftCount], ["资料文件", selected.artifactCount], ["最新稿汉字", selected.latestHan] ].map(([label, value]) => <div key={label}><dd className="text-2xl font-semibold tabular-nums">{Number(value).toLocaleString("zh-CN")}</dd><dt className="mt-1 text-xs text-muted-foreground">{label}</dt></div>)}
          </dl>
          <div className="space-y-3 border-t border-border/60 pt-6 text-sm leading-6">
            <p className="flex items-start gap-2"><Check className="mt-1 h-4 w-4 shrink-0 text-primary" /><span>保留原始资料、稿件版本与来源，便于追溯。</span></p>
            <p className="flex items-start gap-2"><Check className="mt-1 h-4 w-4 shrink-0 text-primary" /><span>候选事实单独保存，定稿须由作者确认正文、摘要与事实。</span></p>
          </div>
          {importMutation.isError ? <div className="mt-5"><ErrorState error={importMutation.error} /></div> : null}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {!selected.imported ? (
              <Button onClick={() => importMutation.mutate(selected)} disabled={importMutation.isPending}>
                {importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                将这份资料加入书房
              </Button>
            ) : <Badge variant="secondary" className="gap-1.5"><Check className="h-3.5 w-3.5" />这份资料已在书房中</Badge>}
            <Button variant="ghost" onClick={onOpenLibrary}>查看作品与研究<ArrowRight className="h-4 w-4" /></Button>
          </div>
          {selected.imported && selected.changed ? <p className="mt-4 text-sm leading-6 text-muted-foreground">来源有更新，已保留已导入版本；请先核对变更。</p> : null}
        </section>
      ) : null}
    </div>
  );
}

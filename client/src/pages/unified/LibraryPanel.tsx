import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookOpenText, FileText, Library, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { getUnifiedArtifact, getUnifiedArtifacts, type UnifiedImport, type UnifiedOverview } from "@/api/unified";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ContentReader, dateLabel, EmptyState, ErrorState, LoadingState, sourceName } from "./presentation";
import ResearchPanel, { PatternApproval } from "./ResearchPanel";
import ResearchReader from "./ResearchReader";

export default function LibraryPanel({ overview, onOpenNovel, onOpenImport }: {
  overview: UnifiedOverview;
  onOpenNovel: (id: string) => void;
  onOpenImport: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const [search, setSearch] = useState("");
  const selected = overview.imports.find((entry) => entry.id === selectedId) ?? overview.imports[0];
  const artifactsQuery = useQuery({
    queryKey: ["unification", "artifacts", selected?.id],
    queryFn: () => getUnifiedArtifacts(selected!.id),
    enabled: Boolean(selected),
  });
  const artifacts = artifactsQuery.data ?? [];
  const visibleArtifacts = artifacts.filter((artifact) => artifact.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selectedArtifact = artifacts.find((artifact) => artifact.id === artifactId) ?? visibleArtifacts[0];
  const sourceNames = Object.fromEntries([...overview.imports.map((entry) => [entry.id, entry.title]), ...artifacts.map((artifact) => [artifact.id, artifact.title])]);
  const artifactQuery = useQuery({
    queryKey: ["unification", "artifact", selected?.id, selectedArtifact?.id],
    queryFn: () => getUnifiedArtifact(selected!.id, selectedArtifact!.id),
    enabled: Boolean(selected && selectedArtifact),
  });

  const chooseImport = (entry: UnifiedImport) => {
    setSelectedId(entry.id);
    setArtifactId("");
    setSearch("");
  };

  return (
    <div className="space-y-10">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="text-lg font-semibold">我的作品</h2><p className="mt-1 text-sm text-muted-foreground">选择作品，继续写作或查看创作规划。</p></div>
          <Button asChild variant="ghost" size="sm"><Link to="/create">创作新作品<ArrowUpRight className="h-4 w-4" /></Link></Button>
        </div>
        {overview.novels.length ? <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{overview.novels.map((novel) => <button type="button" key={novel.id} onClick={() => onOpenNovel(novel.id)} className="group flex items-center gap-4 rounded-xl bg-muted/30 p-5 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><BookOpenText className="h-6 w-6 shrink-0 text-primary" /><span className="min-w-0 flex-1 break-words text-sm font-medium leading-6">{novel.title}</span><ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></button>)}</div> : <div className="mt-5"><EmptyState title="书房里还没有作者作品" action={<Button variant="secondary" onClick={onOpenImport}>导入已有作品</Button>}>可以导入书房中的作品，也可以从一个创意开始。</EmptyState></div>}
      </section>

      <section>
        <h2 className="text-lg font-semibold">来源资料与研究</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">作者作品与参考研究分开收纳。选择资料后可阅读原文。</p>
        {!overview.imports.length ? <div className="mt-5"><EmptyState title="还没有导入资料" action={<Button variant="secondary" onClick={onOpenImport}>查看待导入资料</Button>} /></div> : (
          <div className="mt-5 grid gap-6 lg:grid-cols-[250px_minmax(0,1fr)]">
            <div className="space-y-6">
              {([ ["novel", "作者作品"], ["reference", "参考研究"] ] as const).map(([kind, label]) => {
                const entries = overview.imports.filter((entry) => entry.kind === kind);
                return <div key={kind}><h3 className="mb-2 px-2 text-xs font-medium text-muted-foreground">{label} · {entries.length}</h3>{entries.length ? <div className="space-y-1">{entries.map((entry) => <button key={entry.id} type="button" onClick={() => chooseImport(entry)} className={cn("w-full rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected?.id === entry.id ? "bg-primary/10 text-primary" : "hover:bg-muted/50")}><p className="break-words text-sm font-medium leading-6">{entry.title}</p><p className="mt-1 text-xs text-muted-foreground">{sourceName(entry.source)} · {dateLabel(entry.createdAt)}</p></button>)}</div> : <p className="px-2 text-xs leading-6 text-muted-foreground">暂无{label}</p>}</div>;
              })}
            </div>
            <div className="min-w-0 rounded-xl bg-muted/20 p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0"><div className="mb-2 flex items-center gap-2"><Library className="h-4 w-4 text-primary" /><Badge variant="secondary">{selected?.kind === "reference" ? "参考研究" : "作者作品"}</Badge></div><h3 className="break-words font-semibold">{selected?.title}</h3><p className="mt-1 text-xs text-muted-foreground">{selected?.draftCount} 个稿件版本 · {selected?.artifactCount} 份资料</p></div>
                {selected?.novelId ? <Button size="sm" variant="secondary" onClick={() => onOpenNovel(selected.novelId!)}>继续写作<ArrowUpRight className="h-4 w-4" /></Button> : selected?.documentId ? <Button asChild size="sm" variant="secondary"><Link to="/knowledge">打开知识库<ArrowUpRight className="h-4 w-4" /></Link></Button> : null}
              </div>
              {selected?.kind === "reference" ? <ResearchPanel key={selected.id} entry={selected} references={overview.imports.filter((entry) => entry.kind === "reference")} artifacts={artifacts} onOpenArtifact={setArtifactId} /> : null}
              <div className="relative mt-5"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="查找资料文件" aria-label="查找资料文件" className="pl-9" /></div>
              {artifactsQuery.isLoading ? <LoadingState /> : artifactsQuery.isError ? <div className="mt-5"><ErrorState error={artifactsQuery.error} retry={() => { void artifactsQuery.refetch(); }} /></div> : !artifacts.length ? <div className="mt-5"><EmptyState title="没有附加资料文件">章节正文与稿件版本请从“继续写作”查看。</EmptyState></div> : (
                <div className="mt-5 space-y-5">
                  <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto" aria-label="资料文件">
                    {visibleArtifacts.length ? visibleArtifacts.map((artifact) => <Button key={artifact.id} size="sm" variant={selectedArtifact?.id === artifact.id ? "secondary" : "ghost"} className="h-auto max-w-full justify-start whitespace-normal py-2 text-left text-xs" onClick={() => setArtifactId(artifact.id)}><FileText className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{artifact.title}</span></Button>) : <p className="py-3 text-sm text-muted-foreground">没有找到匹配的资料。</p>}
                  </div>
                  {artifactQuery.isLoading ? <LoadingState label="正在读取资料原文…" /> : artifactQuery.isError ? <ErrorState error={artifactQuery.error} retry={() => { void artifactQuery.refetch(); }} /> : artifactQuery.data ? <article className="min-w-0 border-t border-border/60 pt-5"><h4 className="mb-4 break-words text-sm font-semibold">{artifactQuery.data.title}</h4>{["opening", "pattern", "scene"].includes(artifactQuery.data.kind) ? <ResearchReader content={artifactQuery.data.content} sourceNames={sourceNames} /> : <ContentReader content={artifactQuery.data.content} />}{artifactQuery.data.kind === "pattern" && selected && selectedArtifact ? <PatternApproval key={selectedArtifact.id} importId={selected.id} artifactId={selectedArtifact.id} approved={artifactQuery.data.approved === true} /> : null}</article> : null}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

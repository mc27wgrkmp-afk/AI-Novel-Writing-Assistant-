import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CheckCircle2, Loader2, ScanSearch } from "lucide-react";
import { Link } from "react-router-dom";
import { approveUnifiedPattern, runUnifiedResearch, type UnifiedArtifact, type UnifiedImport, type UnifiedResearchRequest } from "@/api/unified";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ErrorState } from "./presentation";

export default function ResearchPanel({ entry, references, artifacts, onOpenArtifact }: {
  entry: UnifiedImport;
  references: UnifiedImport[];
  artifacts: UnifiedArtifact[];
  onOpenArtifact: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<UnifiedResearchRequest["kind"]>("opening");
  const [segment, setSegment] = useState<NonNullable<UnifiedResearchRequest["segment"]>>("0-3000");
  const [relatedIds, setRelatedIds] = useState<string[]>([]);
  const [patternId, setPatternId] = useState("");
  const approvedPatterns = artifacts.filter((artifact) => artifact.kind === "pattern" && artifact.approved === true);
  const selectedPatternId = approvedPatterns.some((artifact) => artifact.id === patternId) ? patternId : approvedPatterns[0]?.id;
  const availableReferences = references.filter((reference) => reference.id !== entry.id && reference.chapterCount > 0);
  const validRelatedIds = relatedIds.filter((id) => availableReferences.some((reference) => reference.id === id));
  const researchMutation = useMutation({
    mutationFn: () => runUnifiedResearch(entry.id, {
      kind,
      ...(kind === "opening" ? { segment } : {}),
      ...(kind === "pattern" ? { relatedImportIds: validRelatedIds } : {}),
      ...(kind === "scene" ? { patternId: selectedPatternId } : {}),
    }),
    onSuccess: async (artifact) => {
      await queryClient.invalidateQueries({ queryKey: ["unification", "artifacts", entry.id] });
      onOpenArtifact(artifact.id);
      toast.success("研究结果已保存，可阅读依据与结论。");
    },
  });
  const cannotRun = researchMutation.isPending || (kind === "pattern" && !validRelatedIds.length) || (kind === "scene" && !selectedPatternId);

  if (entry.chapterCount === 0) return <p className="mt-5 text-sm text-muted-foreground">这是历史运行与来源资料集合，可在上方查阅原记录。</p>;

  return (
    <div className="mt-5 space-y-4 border-t border-border/60 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="flex items-center gap-2 text-sm font-semibold"><ScanSearch className="h-4 w-4 text-primary" />研究这本参考书</h4><div className="flex gap-2"><Button asChild variant="ghost" size="sm"><Link to={entry.documentId ? `/book-analysis?documentId=${encodeURIComponent(entry.documentId)}` : "/book-analysis"}>整书拆解<ArrowUpRight className="h-3.5 w-3.5" /></Link></Button><Button asChild variant="ghost" size="sm"><Link to="/knowledge">知识库<ArrowUpRight className="h-3.5 w-3.5" /></Link></Button></div></div>
      <div className="flex flex-wrap gap-1">{([{ key: "opening", label: "开篇研究" }, { key: "pattern", label: "跨书模式" }, { key: "scene", label: "场景卡" }] as const).map((item) => <Button key={item.key} variant={kind === item.key ? "secondary" : "ghost"} size="sm" disabled={researchMutation.isPending} onClick={() => setKind(item.key)}>{item.label}</Button>)}</div>
      {kind === "opening" ? <div className="space-y-2"><p className="text-xs leading-6 text-muted-foreground">选择开篇区间，查看人物出场、冲突、节奏与悬念的正文依据。</p><Select value={segment} onValueChange={(value) => setSegment(value as typeof segment)} disabled={researchMutation.isPending}><SelectTrigger aria-label="选择开篇研究区间" className="max-w-xs shadow-none hover:shadow-none"><SelectValue /></SelectTrigger><SelectContent>{[{ value: "0-3000", label: "开篇 0—3,000 字" }, { value: "3000-10000", label: "3,000—10,000 字" }, { value: "10000-30000", label: "10,000—30,000 字" }, { value: "30000-50000", label: "30,000—50,000 字" }, { value: "50000-100000", label: "50,000—100,000 字" }].map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div> : kind === "pattern" ? <div className="space-y-3"><p className="text-xs leading-6 text-muted-foreground">以《{entry.title}》为起点，至少再选一本参考书，比较可复用的叙事模式与引用依据。</p>{availableReferences.length ? <div className="grid max-h-40 gap-2 overflow-y-auto sm:grid-cols-2">{availableReferences.map((reference) => <label key={reference.id} className={cn("flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-sm leading-6", validRelatedIds.includes(reference.id) ? "bg-primary/10" : "bg-background/50")}><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]" checked={validRelatedIds.includes(reference.id)} disabled={researchMutation.isPending} onChange={(event) => setRelatedIds((current) => event.target.checked ? [...current, reference.id] : current.filter((id) => id !== reference.id))} /><span className="break-words">{reference.title}</span></label>)}</div> : <p className="text-sm text-muted-foreground">请先导入另一本参考书，再进行跨书研究。</p>}</div> : <div className="space-y-2"><p className="text-xs leading-6 text-muted-foreground">选择已由你核对批准的跨书模式，生成带研究依据的场景卡。</p>{approvedPatterns.length ? <Select value={selectedPatternId} onValueChange={setPatternId} disabled={researchMutation.isPending}><SelectTrigger aria-label="选择已批准的跨书模式" className="shadow-none hover:shadow-none"><SelectValue /></SelectTrigger><SelectContent>{approvedPatterns.map((artifact) => <SelectItem key={artifact.id} value={artifact.id}>{artifact.title}</SelectItem>)}</SelectContent></Select> : <p className="text-sm text-muted-foreground">先完成跨书模式研究，阅读并批准引用依据后，再生成场景卡。</p>}</div>}
      <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" size="sm" disabled={cannotRun} onClick={() => researchMutation.mutate()}>{researchMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}{researchMutation.isPending ? "正在研究…" : kind === "opening" ? "研究选定区间" : kind === "pattern" ? "比较所选参考书" : "生成场景卡"}</Button><p className="text-xs leading-6 text-muted-foreground">研究会使用模型额度，结果保存为参考材料。</p></div>
      {researchMutation.isError ? <ErrorState error={researchMutation.error} /> : null}
    </div>
  );
}

export function PatternApproval({ importId, artifactId, approved }: { importId: string; artifactId: string; approved: boolean }) {
  const queryClient = useQueryClient();
  const approvalMutation = useMutation({
    mutationFn: () => approveUnifiedPattern(importId, artifactId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["unification", "artifacts", importId] }),
        queryClient.invalidateQueries({ queryKey: ["unification", "artifact", importId, artifactId] }),
      ]);
      toast.success("跨书模式已按你的确认批准，可用于生成场景卡。");
    },
  });
  return <div className="mt-6 space-y-3 border-t border-border/60 pt-5">{approved ? <p className="flex items-center gap-2 text-sm font-medium text-primary"><CheckCircle2 className="h-4 w-4" />这份跨书模式已由你批准</p> : <><p className="text-sm leading-6 text-muted-foreground">核对结论与至少两本参考书的有效引用后，批准这份模式研究。</p><Button variant="secondary" disabled={approvalMutation.isPending} onClick={() => approvalMutation.mutate()}>{approvalMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}我已核对引用，批准这份模式研究</Button></>}{approvalMutation.isError ? <ErrorState error={approvalMutation.error} /> : null}</div>;
}

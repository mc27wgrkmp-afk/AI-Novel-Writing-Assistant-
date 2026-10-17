import { useState } from "react";
import { GitCompareArrows } from "lucide-react";
import type { UnifiedChapter, UnifiedVersion } from "@/api/unified";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { dateLabel, EmptyState, sourceName } from "./presentation";

export default function VersionsPanel({ chapter, versions }: { chapter: UnifiedChapter; versions: UnifiedVersion[] }) {
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("current");
  const fallbackLeft = versions.find((version) => version.bodyHash !== chapter.bodyHash) ?? versions[0];
  const selectedLeftId = leftId === "current" || versions.some((version) => version.id === leftId) ? leftId : fallbackLeft?.id ?? "current";
  const findVersion = (id: string) => id === "current" ? chapter : versions.find((version) => version.id === id) ?? chapter;
  const left = findVersion(selectedLeftId);
  const right = findVersion(rightId);
  const leftLines = left.content.split("\n");
  const rightLines = right.content.split("\n");
  const lineCount = Math.max(leftLines.length, rightLines.length);
  const differenceCount = Array.from({ length: lineCount }, (_, index) => leftLines[index] !== rightLines[index]).filter(Boolean).length;

  if (!versions.length) return <EmptyState title="还没有历史稿件">保存草稿后，可以在这里比较各个版本。</EmptyState>;

  const picker = (label: string, value: string, onChange: (value: string) => void) => (
    <div className="min-w-0 flex-1 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="shadow-none hover:shadow-none"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="current">当前正文</SelectItem>{versions.map((version) => <SelectItem key={version.id} value={version.id}>{version.label} · {dateLabel(version.createdAt)}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );

  return (
    <section className="space-y-5">
      <div><h3 className="flex items-center gap-2 font-semibold"><GitCompareArrows className="h-4 w-4 text-primary" />稿件版本比较</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">所有保留版本均可阅读。选择版本只切换阅读内容，修改正文请回到编辑区保存新稿。</p></div>
      <div className="flex flex-col gap-4 sm:flex-row">{picker("左侧版本", selectedLeftId, setLeftId)}{picker("右侧版本", rightId, setRightId)}</div>
      <p className="text-xs text-muted-foreground">{differenceCount ? `${differenceCount} 行内容不同，变化行以底色标出。` : "两个版本内容相同。"}</p>
      <div className="max-h-[620px] overflow-auto rounded-lg bg-muted/20">
        <div className="min-w-[560px] divide-y divide-border/30 text-sm leading-7">
          {Array.from({ length: lineCount }, (_, index) => {
            const changed = leftLines[index] !== rightLines[index];
            return <div key={index} className="grid grid-cols-2"><div className={cn("grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2 px-3 py-1.5", changed && "bg-destructive/5")}><span className="select-none text-right font-mono text-[10px] text-muted-foreground/70">{leftLines[index] === undefined ? "" : index + 1}</span><p className="whitespace-pre-wrap break-words">{leftLines[index] ?? ""}</p></div><div className={cn("grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2 border-l border-border/50 px-3 py-1.5", changed && "bg-primary/10")}><span className="select-none text-right font-mono text-[10px] text-muted-foreground/70">{rightLines[index] === undefined ? "" : index + 1}</span><p className="whitespace-pre-wrap break-words">{rightLines[index] ?? ""}</p></div></div>;
          })}
        </div>
      </div>
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">查看保留版本清单（{versions.length}）</summary><ul className="mt-3 divide-y divide-border/50">{versions.map((version) => <li key={version.id} className="flex flex-wrap justify-between gap-2 py-3 text-xs"><span className="font-medium">{version.label}</span><span className="text-muted-foreground">{sourceName(version.source)} · {dateLabel(version.createdAt)}</span></li>)}</ul></details>
    </section>
  );
}

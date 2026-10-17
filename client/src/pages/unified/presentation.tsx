import type { ReactNode } from "react";
import { AlertCircle, BookOpen, Loader2 } from "lucide-react";
import MarkdownViewer from "@/components/common/MarkdownViewer";
import { Button } from "@/components/ui/button";
import type { UnifiedFact } from "@/api/unified";

export const unifiedKeys = {
  overview: ["unification", "overview"] as const,
  novel: (id: string) => ["unification", "novel", id] as const,
  chapter: (novelId: string, chapterId: string) => ["unification", "chapter", novelId, chapterId] as const,
};

export function sourceName(source: string) {
  return ({ scriptor: "Scriptor 书房", webfictionlab: "WebFictionLab", biz: "Biz Novel Studio", manual: "手写稿", ai: "AI 草稿", previous: "保存前正文", import: "原始稿" } as Record<string, string>)[source] ?? source;
}

export function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未记录" : new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function LoadingState({ label = "正在读取内容…" }: { label?: string }) {
  return <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />{label}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-destructive" role="alert">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{error instanceof Error ? error.message : "内容读取失败，请重试。"}</span>
      {retry ? <Button variant="outline" size="sm" onClick={retry}>重试</Button> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center rounded-xl bg-muted/30 px-6 py-8 text-center">
      <BookOpen className="mb-3 h-6 w-6 text-muted-foreground/60" />
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ContentReader({ content }: { content: string }) {
  let json: unknown;
  try { json = JSON.parse(content); } catch { /* Markdown is rendered below. */ }
  if (json !== undefined) {
    return <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/35 p-4 text-xs leading-6">{JSON.stringify(json, null, 2)}</pre>;
  }
  return <div className="text-sm leading-7 [&_h1]:mb-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_ul]:list-disc [&_ul]:pl-5"><MarkdownViewer content={content || "暂无正文。"} /></div>;
}

const factNames: Record<UnifiedFact["type"], string> = {
  fact: "既成事实",
  testimony: "人物证言",
  inference: "推测",
  rule: "规则",
  plan: "未兑现计划",
};

export function FactsReader({ facts }: { facts: UnifiedFact[] }) {
  if (!facts.length) return <p className="text-sm text-muted-foreground">本章没有待确认的事实材料。</p>;
  return (
    <ul className="divide-y divide-border/50">
      {facts.map((fact, index) => (
        <li key={index} className="py-3 first:pt-0">
          <div className="mb-1 text-xs font-medium text-primary">{factNames[fact.type] ?? fact.type}</div>
          <p className="whitespace-pre-wrap text-sm leading-6">{fact.text}</p>
          {fact.evidence ? <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">正文依据：{fact.evidence}</p> : null}
        </li>
      ))}
    </ul>
  );
}

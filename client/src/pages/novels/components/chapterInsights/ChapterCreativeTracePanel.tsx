import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Chapter } from "@ai-novel/shared/types/novel";
import {
  getChapterCreativeTrace,
  listChapterCreativeRevisions,
  restoreChapterCreativeRevision,
  type ChapterCreativeRevision,
  type ChapterCreativeRevisionScope,
} from "@/api/novel/chapters";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";

interface ChapterCreativeTracePanelProps {
  novelId: string;
  chapter: Chapter;
  active: boolean;
  onRegeneratePlan: () => void;
  onRegenerateScript: () => void;
  onRegenerateProse: () => void;
  isRegeneratingPlan: boolean;
  isRegeneratingScript: boolean;
  isRegeneratingProse: boolean;
}

const SCOPE_LABELS: Record<ChapterCreativeRevisionScope, string> = {
  chapter_plan: "分纲",
  execution_contract: "小剧本",
  prose: "正文",
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function groupRevisions(revisions: ChapterCreativeRevision[], scope: ChapterCreativeRevisionScope) {
  return revisions.filter((revision) => revision.scope === scope);
}

function PromptMessages(props: {
  title: string;
  prompt: { promptId: string; version: string; messages: Array<{ role: string; content: string }> } | null;
}) {
  if (!props.prompt) {
    return <p className="mt-2 text-xs leading-6 text-muted-foreground">当前缺少这一步所需的上游规划资料，补齐分纲和小剧本后可查看完整提示词。</p>;
  }
  return (
    <details className="mt-3 rounded-xl bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-foreground">查看{props.title}完整提示词</summary>
      <div className="mt-3 space-y-3">
        <div className="text-[11px] text-muted-foreground">{props.prompt.promptId} · {props.prompt.version}</div>
        {props.prompt.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className="border-t border-border/50 pt-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {message.role === "system" ? "系统指令" : message.role === "user" ? "本次输入" : message.role}
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground">{message.content}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function RevisionList(props: {
  scope: ChapterCreativeRevisionScope;
  revisions: ChapterCreativeRevision[];
  restoringId?: string;
  busy: boolean;
  onRestore: (revisionId: string) => void;
}) {
  if (props.revisions.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border/50 pt-3">
      <div className="text-xs font-medium text-muted-foreground">可恢复版本</div>
      <div className="mt-2 space-y-1">
        {props.revisions.map((revision) => (
          <div key={revision.id} className="flex items-center justify-between gap-2 py-1.5">
            <div className="min-w-0">
              <div className="truncate text-xs text-foreground">{revision.label || `${SCOPE_LABELS[props.scope]}版本`}</div>
              <div className="text-[11px] text-muted-foreground">{formatTime(revision.createdAt)}</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              disabled={props.busy}
              onClick={() => props.onRestore(revision.id)}
            >
              {props.restoringId === revision.id ? "恢复中…" : "恢复此版"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ChapterCreativeTracePanel(props: ChapterCreativeTracePanelProps) {
  const queryClient = useQueryClient();
  const [actionMessage, setActionMessage] = useState("");
  const previousGenerationState = useRef({
    plan: props.isRegeneratingPlan,
    script: props.isRegeneratingScript,
    prose: props.isRegeneratingProse,
  });
  const traceQuery = useQuery({
    queryKey: queryKeys.novels.chapterCreativeTrace(props.novelId, props.chapter.id),
    queryFn: () => getChapterCreativeTrace(props.novelId, props.chapter.id),
    enabled: props.active && Boolean(props.novelId && props.chapter.id),
    staleTime: 20_000,
  });
  const revisionsQuery = useQuery({
    queryKey: queryKeys.novels.chapterCreativeRevisions(props.novelId, props.chapter.id),
    queryFn: () => listChapterCreativeRevisions(props.novelId, props.chapter.id),
    enabled: props.active && Boolean(props.novelId && props.chapter.id),
    staleTime: 5_000,
  });
  const restoreMutation = useMutation({
    mutationFn: (revisionId: string) => restoreChapterCreativeRevision(props.novelId, props.chapter.id, revisionId),
    onSuccess: async (response) => {
      setActionMessage(`已恢复${SCOPE_LABELS[response.data?.scope ?? "prose"]}版本。`);
      if (response.data?.scope === "prose" && typeof response.data.chapter.content === "string") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(props.novelId) });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(props.novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapters(props.novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterPlan(props.novelId, props.chapter.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterCreativeTrace(props.novelId, props.chapter.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterCreativeRevisions(props.novelId, props.chapter.id) }),
      ]);
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : "恢复章节版本失败。"),
  });

  useEffect(() => {
    const previous = previousGenerationState.current;
    const finishedGeneration = (previous.plan && !props.isRegeneratingPlan)
      || (previous.script && !props.isRegeneratingScript)
      || (previous.prose && !props.isRegeneratingProse);
    previousGenerationState.current = {
      plan: props.isRegeneratingPlan,
      script: props.isRegeneratingScript,
      prose: props.isRegeneratingProse,
    };
    if (finishedGeneration) {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterCreativeTrace(props.novelId, props.chapter.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterCreativeRevisions(props.novelId, props.chapter.id) }),
      ]);
    }
  }, [
    props.chapter.id,
    props.isRegeneratingPlan,
    props.isRegeneratingScript,
    props.isRegeneratingProse,
    props.novelId,
    queryClient,
  ]);

  const trace = traceQuery.data?.data;
  const revisions = revisionsQuery.data?.data ?? [];
  const stageMap = useMemo(() => new Map((trace?.stages ?? []).map((stage) => [stage.key, stage])), [trace?.stages]);
  const planRevisions = groupRevisions(revisions, "chapter_plan");
  const scriptRevisions = groupRevisions(revisions, "execution_contract");
  const proseRevisions = groupRevisions(revisions, "prose");

  if (traceQuery.isLoading) {
    return <div className="p-3 text-sm text-muted-foreground">正在整理第 {props.chapter.order} 章的创作链路和提示词…</div>;
  }
  if (traceQuery.isError) {
    return <div className="rounded-xl bg-amber-50/70 p-3 text-sm leading-6 text-amber-900">创作链路暂时无法读取。重新加载后可继续查看。</div>;
  }

  const stage = (key: string) => stageMap.get(key)?.text || "暂无已保存内容。";
  const restoringId = restoreMutation.variables;
  const revisionsBusy = restoreMutation.isPending
    || props.isRegeneratingPlan
    || props.isRegeneratingScript
    || props.isRegeneratingProse;
  return (
    <div className="space-y-4 pb-3">
      <div className="rounded-2xl bg-muted/20 p-4">
        <div className="text-sm font-semibold text-foreground">第 {props.chapter.order} 章创作链路</div>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">
          依次核对全书方向、卷内安排、本章分纲和正文小剧本；展开可查看当前资料组装出的完整提示词。
        </p>
      </div>

      <section className="rounded-2xl bg-background px-4 py-3">
        <div className="text-sm font-medium">1. 全书大纲与世界观</div>
        <p className="mt-1 text-xs text-muted-foreground">影响后续各章的主线方向、设定规则和故事边界。</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-primary">查看当前资料</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{stage("outline_world")}</pre>
        </details>
        <PromptMessages title="全书发展走向生成的" prompt={trace?.prompts.outline ?? null} />
        <PromptMessages title="逐章大纲生成的" prompt={trace?.prompts.structuredOutline ?? null} />
      </section>

      <section className="rounded-2xl bg-background px-4 py-3">
        <div className="text-sm font-medium">2. 卷剧本与节奏</div>
        <p className="mt-1 text-xs text-muted-foreground">当前章节所在卷的承诺、节拍和本章位置。</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-primary">查看当前卷安排</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{stage("volume_script")}</pre>
        </details>
        <PromptMessages title="当前卷节奏板生成的" prompt={trace?.prompts.volumeScript ?? null} />
      </section>

      <section className="rounded-2xl bg-background px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium">3. 当前章节分纲</div>
            <p className="mt-1 text-xs text-muted-foreground">确定本章目标、场景顺序和关键变化。</p>
          </div>
          <Button size="sm" variant="outline" onClick={props.onRegeneratePlan} disabled={props.isRegeneratingPlan}>
            {props.isRegeneratingPlan ? "生成中…" : "重新生成分纲"}
          </Button>
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-primary">查看当前分纲</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{stage("chapter_outline")}</pre>
        </details>
        <RevisionList scope="chapter_plan" revisions={planRevisions} restoringId={restoringId} busy={revisionsBusy} onRestore={(id) => restoreMutation.mutate(id)} />
      </section>

      <section className="rounded-2xl bg-background px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium">4. 正文小剧本</div>
            <p className="mt-1 text-xs text-muted-foreground">任务单与场景拆解会约束正文的动作、冲突和收尾。</p>
          </div>
          <Button size="sm" variant="outline" onClick={props.onRegenerateScript} disabled={props.isRegeneratingScript}>
            {props.isRegeneratingScript ? "生成中…" : "重新生成"}
          </Button>
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-primary">查看当前小剧本</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{stage("chapter_script")}</pre>
        </details>
        <PromptMessages title="生成正文小剧本的" prompt={trace?.prompts.executionContract ?? null} />
        <RevisionList scope="execution_contract" revisions={scriptRevisions} restoringId={restoringId} busy={revisionsBusy} onRestore={(id) => restoreMutation.mutate(id)} />
      </section>

      <section className="rounded-2xl bg-background px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium">5. 正文历史与写作参考</div>
            <p className="mt-1 text-xs text-muted-foreground">核对写作参考与已保存的正文版本，再由你完成正文。</p>
          </div>

        </div>
        <PromptMessages title="正文生成" prompt={trace?.prompts.writer ?? null} />
        <RevisionList scope="prose" revisions={proseRevisions} restoringId={restoringId} busy={revisionsBusy} onRestore={(id) => restoreMutation.mutate(id)} />
      </section>

      {actionMessage ? <div className="rounded-xl bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">{actionMessage}</div> : null}
      {revisionsQuery.isError ? <div className="text-xs text-muted-foreground">版本记录暂时无法读取。</div> : null}
    </div>
  );
}

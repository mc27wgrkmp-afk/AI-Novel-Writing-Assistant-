import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Chapter } from "@ai-novel/shared/types/novel";
import { readChapterQualityDebtDetails } from "@ai-novel/shared/types/chapterQualityLoop";
import { getChapterAuditReports } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";

const auditLabels: Record<string, string> = {
  continuity: "连续性", character: "人物", plot: "情节", mode_fit: "写法匹配",
};

/** Read-only saved evidence; opening details never starts an AI call. */
export default function ChapterIssueDetails({ chapter, editing = false, disabled = false }: {
  chapter: Chapter;
  editing?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const debt = readChapterQualityDebtDetails(chapter.riskFlags);
  const hasWarning = Boolean(debt || chapter.chapterStatus === "needs_repair");
  const reportsQuery = useQuery({
    queryKey: queryKeys.novels.chapterAuditReports(chapter.novelId, chapter.id),
    queryFn: () => getChapterAuditReports(chapter.novelId, chapter.id),
    enabled: open,
  });
  const reports = reportsQuery.data?.data ?? [];
  return (
    <section className={hasWarning ? "rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" : "py-2 text-sm"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {hasWarning ? <p className="font-medium">本章有待处理的问题</p> : null}
          {debt ? <p className="mt-1 leading-6">{debt.reason}</p> : hasWarning ? <p className="mt-1">请查看问题记录，修改正文并保存后重新审校。</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "收起问题详情" : "查看问题详情"}
          </Button>
          {!editing && !disabled ? <Button asChild size="sm"><Link to={`/novels/${chapter.novelId}/chapters/${chapter.id}`}>修改本章</Link></Button> : null}
        </div>
      </div>
      {open ? <div className="mt-4 max-h-72 space-y-4 overflow-y-auto">
        <p className="text-xs text-muted-foreground">以下为已保存的审校记录。记录可能早于当前正文，请结合正文检查；修改后需重新审校。</p>
        {debt?.issueCodes.length ? <ul className="space-y-1 break-words">{debt.issueCodes.map((code) => <li key={code}>{code}</li>)}</ul> : null}
        {reportsQuery.isLoading ? <p>正在加载问题记录…</p> : null}
        {reportsQuery.isError ? <div><p>问题记录加载失败。</p><Button type="button" size="sm" variant="outline" onClick={() => void reportsQuery.refetch()}>重新加载记录</Button></div> : null}
        {!reportsQuery.isLoading && !reportsQuery.isError && !reports.length ? <p>尚未保存详细审校报告。可以先修改正文，保存后再审校。</p> : null}
        {reports.map((report) => <div key={report.id} className="space-y-2 border-t border-border/60 pt-3">
          <p className="font-medium">{auditLabels[report.auditType] ?? "章节"}审校 · {new Date(report.createdAt).toLocaleString("zh-CN")}</p>
          {report.summary ? <p>{report.summary}</p> : null}
          {!report.issues.length ? <p className="text-muted-foreground">这份报告未保存具体问题条目，不代表当前正文已通过审校。</p> : null}
          {report.issues.map((issue) => <div key={issue.id} className="space-y-1 whitespace-pre-wrap bg-muted/30 p-3">
            <p className="font-medium">{issue.description}</p>
            {issue.evidence ? <p>正文依据：{issue.evidence}</p> : null}
            {issue.fixSuggestion ? <p>修改建议：{issue.fixSuggestion}</p> : null}
            <p className="text-xs text-muted-foreground">{issue.status === "resolved" ? "已处理" : "待核对"}</p>
          </div>)}
        </div>)}
      </div> : null}
    </section>
  );
}

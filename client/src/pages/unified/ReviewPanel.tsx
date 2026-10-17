import { useState } from "react";
import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";
import type { UnifiedChapterDetail, UnifiedReview } from "@/api/unified";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ContentReader, dateLabel, EmptyState, FactsReader } from "./presentation";

const dimensionNames: Record<string, string> = {
  structure: "结构", character: "人物", pacing: "节奏", world: "世界观",
  theme: "主题情绪", foreshadowing: "伏笔悬念", style: "文笔文风", text: "文本规范",
};

interface ReviewPanelProps {
  detail: UnifiedChapterDetail;
  dirty: boolean;
  busy: boolean;
  reviewing: boolean;
  approving: boolean;
  onReview: () => void;
  onApprove: (review: UnifiedReview) => Promise<void>;
}

export default function ReviewPanel({ detail, dirty, busy, reviewing, approving, onReview, onApprove }: ReviewPanelProps) {
  const [reviewId, setReviewId] = useState("");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const currentReview = detail.reviews.find((review) => review.current && review.bodyHash === detail.chapter.bodyHash && review.contextHash === detail.contextHash);
  const review = detail.reviews.find((item) => item.id === reviewId) ?? currentReview ?? detail.reviews[0];
  const currentApproval = detail.approvals.find((approval) => approval.current && approval.bodyHash === detail.chapter.bodyHash);
  const mayApprove = Boolean(currentReview?.decision === "pass" && !currentReview.blocking.length && !dirty && !busy && (!currentApproval || currentApproval.reviewId !== currentReview?.id));

  return (
    <section className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h3 className="flex items-center gap-2 font-semibold"><ClipboardCheck className="h-4 w-4 text-primary" />八维审稿与作者定稿</h3><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">AI 审读当前正文与创作资料，提出修改意见。作者核对正文、摘要和分类事实后批准定稿。</p></div>
        <Button variant="secondary" onClick={() => { setReviewId(""); onReview(); }} disabled={dirty || busy || !detail.chapter.content.trim()}>{reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}{reviewing ? "正在审读…" : "审读当前正文"}</Button>
      </div>
      {dirty ? <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">请先保存编辑区的修改，再审读或批准当前正文。</p> : null}
      <p className="text-xs leading-6 text-muted-foreground">审读会使用模型额度，请先在系统设置中完成模型连接。</p>

      {currentApproval ? <div className="flex items-center gap-3 rounded-xl bg-primary/10 p-4"><CheckCircle2 className="h-5 w-5 text-primary" /><div><p className="text-sm font-semibold">当前正文已由作者批准定稿</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(currentApproval.createdAt)} · 修改正文后需重新审稿与确认。</p></div></div> : null}

      {!review ? <EmptyState title="本章还没有审稿记录">保存正文后，点击“审读当前正文”获取八个维度的意见。</EmptyState> : (
        <div className="space-y-6 rounded-xl bg-muted/25 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2"><Badge variant={review.decision === "pass" ? "secondary" : "outline"}>{review.decision === "pass" ? "审稿通过" : "需要修改"}</Badge><Badge variant="secondary">{review.current && review.bodyHash === detail.chapter.bodyHash && review.contextHash === detail.contextHash ? "适用于当前正文与资料" : "历史审稿"}</Badge></div>
            {detail.reviews.length > 1 ? <Select value={review.id} onValueChange={setReviewId}><SelectTrigger aria-label="选择审稿记录" className="w-full shadow-none hover:shadow-none sm:w-56"><SelectValue /></SelectTrigger><SelectContent>{detail.reviews.map((item) => <SelectItem key={item.id} value={item.id}>{dateLabel(item.createdAt)} · {item.current ? "当前" : "历史"}</SelectItem>)}</SelectContent></Select> : <span className="text-xs text-muted-foreground">{dateLabel(review.createdAt)}</span>}
          </div>
          {!review.current || review.bodyHash !== detail.chapter.bodyHash || review.contextHash !== detail.contextHash ? <p className="text-sm leading-6 text-muted-foreground">正文或创作资料有变化，请重新审读后再定稿。</p> : null}
          {review.blocking?.length ? <div className="rounded-lg bg-destructive/10 p-4"><h4 className="mb-2 text-sm font-semibold text-destructive">定稿前需处理</h4><ul className="list-disc space-y-2 pl-4 text-sm leading-6">{review.blocking.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
          <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">{Object.entries(review.dimensions).map(([key, value]) => <div key={key}><h4 className="mb-1 text-sm font-semibold">{dimensionNames[key] ?? key}</h4><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{value}</p></div>)}</div>
          <div className="border-t border-border/60 pt-5"><h4 className="mb-3 text-sm font-semibold">章节摘要</h4><ContentReader content={review.summary} /></div>
          <div className="border-t border-border/60 pt-5"><h4 className="mb-4 text-sm font-semibold">事实与待确认材料</h4><FactsReader facts={review.facts} /></div>
        </div>
      )}

      {(!currentApproval || currentApproval.reviewId !== currentReview?.id) && currentReview?.decision === "pass" ? <div className="flex flex-wrap items-center justify-between gap-4"><p className="max-w-xl text-sm leading-6 text-muted-foreground">确认摘要与分类材料准确后，核对本次定稿。既成事实与规则可作为后续章节依据。</p><Button disabled={!mayApprove} onClick={() => setApprovalOpen(true)}>核对定稿材料</Button></div> : null}

      {detail.approvals.length ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">作者定稿记录（{detail.approvals.length}）</summary><div className="mt-4 space-y-4">{detail.approvals.map((approval) => <div key={approval.id} className="rounded-lg bg-muted/25 p-4"><p className="mb-4 text-xs font-medium">{dateLabel(approval.createdAt)} · {approval.current ? "当前正文" : "历史正文"}</p><ContentReader content={approval.summary} /><div className="mt-5"><FactsReader facts={approval.facts} /></div></div>)}</div></details> : null}

      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <AppDialogContent title="核对本章定稿材料" description="请阅读当前正文、章节摘要与分类事实，再由你批准本次定稿。" className="max-w-4xl" footer={<><Button variant="ghost" onClick={() => setApprovalOpen(false)} disabled={approving}>返回审稿</Button><Button disabled={!mayApprove} className="h-auto whitespace-normal py-2" onClick={async () => { if (!currentReview || !mayApprove) return; try { await onApprove(currentReview); setApprovalOpen(false); } catch { /* The action error remains visible in the chapter workbench. */ } }}>{approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}批准当前正文、摘要与事实并定稿</Button></>}>
          <div className="space-y-7 py-2"><section><h3 className="mb-3 text-sm font-semibold">当前正文 · {detail.chapter.title}</h3><ContentReader content={detail.chapter.content} /></section><section className="border-t border-border/60 pt-5"><h3 className="mb-3 text-sm font-semibold">章节摘要</h3><ContentReader content={currentReview?.summary ?? ""} /></section><section className="border-t border-border/60 pt-5"><h3 className="mb-4 text-sm font-semibold">事实与分类材料</h3><FactsReader facts={currentReview?.facts ?? []} /></section></div>
        </AppDialogContent>
      </Dialog>
    </section>
  );
}

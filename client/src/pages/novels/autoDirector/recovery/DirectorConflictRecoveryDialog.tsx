import { useId } from "react";
import type { DirectorConflictRecoveryPlan } from "@ai-novel/shared/types/directorConflictRecovery";
import { Button } from "@/components/ui/button";
import { Dialog, AppDialogContent } from "@/components/ui/dialog";

export interface DirectorConflictRecoveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: () => void;
  plan: DirectorConflictRecoveryPlan | null;
  selectedOptionId: string;
  onSelectOption: (id: string) => void;
  userNote: string;
  onUserNoteChange: (value: string) => void;
  analyzing: boolean;
  applying: boolean;
  error: string | null;
  onGenerate: () => void;
  onConfirm: () => void;
}

export function DirectorConflictRecoveryDialog(props: DirectorConflictRecoveryDialogProps) {
  const radioName = useId();
  const busy = props.analyzing || props.applying;
  const selected = props.plan?.options.find((option) => option.id === props.selectedOptionId);
  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!props.applying) props.onOpenChange(open); }}>
      <AppDialogContent
        title="先看清冲突，再选择修改方案"
        description="以已保存的大纲主线为先。AI 提出 2–3 个方案，由你决定如何处理。"
        footer={<>
          <Button type="button" variant="outline" disabled={busy} onClick={() => props.onOpenChange(false)}>暂不修改</Button>
          <Button type="button" disabled={busy || !selected || Boolean(props.error)} onClick={props.onConfirm}>
            {props.applying ? "正在提交…" : selected?.repair.kind === "retry" ? "按所选方案重试" : "按所选方案修改"}
          </Button>
        </>}
      >
        <div className="space-y-5">
          {props.analyzing ? <div role="status" className="py-4 text-sm text-muted-foreground">AI 正在对照大纲和章节资料，整理冲突及可选方案…</div> : null}
          {props.error ? <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{props.error}</div> : null}
          {props.plan ? <>
            <section className="space-y-2">
              <h3 className="font-medium">到底哪里有冲突</h3>
              <p className="text-sm leading-6">{props.plan.summary}</p>
              {props.plan.conflicts.map((conflict, index) => (
                <div key={index} className="space-y-1 bg-muted/30 p-3 text-sm leading-6">
                  <p>一处写的是：{conflict.left}</p>
                  <p>另一处写的是：{conflict.right}</p>
                  <p className="text-muted-foreground">冲突在于：{conflict.explanation}</p>
                </div>
              ))}
            </section>
            <section className="space-y-1">
              <h3 className="font-medium">优先保留的大纲主线</h3>
              <p className="text-sm leading-6 text-muted-foreground">{props.plan.outlinePriority}</p>
            </section>
            <fieldset className="space-y-3" disabled={busy}>
              <legend className="mb-2 font-medium">选择一个处理方案</legend>
              {props.plan.options.map((option, index) => (
                <label key={option.id} className={`block cursor-pointer space-y-2 rounded-lg p-4 ${props.selectedOptionId === option.id ? "bg-primary/5 ring-1 ring-primary" : "bg-muted/30"}`}>
                  <div className="flex items-center gap-2">
                    <input type="radio" name={radioName} checked={props.selectedOptionId === option.id} onChange={() => props.onSelectOption(option.id)} />
                    <span className="font-medium">方案 {index + 1}：{option.title}</span>
                    {props.plan?.recommendedOptionId === option.id ? <span className="text-xs text-primary">推荐</span> : null}
                  </div>
                  <p className="text-sm leading-6">{option.summary}</p>
                  <div className="space-y-1 text-sm leading-6">
                    <p className="font-medium">会修改</p>
                    {option.changes.map((change, i) => <p key={i}>· {change}</p>)}
                    <p className="pt-1 font-medium">会保留</p>
                    {option.preserves.map((preserve, i) => <p key={i}>· {preserve}</p>)}
                    <p className="pt-1 text-muted-foreground">代价或影响：{option.tradeoff}</p>
                  </div>
                </label>
              ))}
            </fieldset>
          </> : null}
          <section className="space-y-2 border-t pt-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium">补充你的偏好（可选）</span>
              <textarea value={props.userNote} onChange={(event) => props.onUserNoteChange(event.target.value)} maxLength={2000}
                disabled={busy} className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
                placeholder="例如：容量上限一定保留，优先调整转移场景；不要改变主角的决定。" />
            </label>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onGenerate}>
              {props.analyzing ? "分析中…" : props.plan ? "按补充意见重新给方案" : "重新分析并给方案"}
            </Button>
          </section>
        </div>
      </AppDialogContent>
    </Dialog>
  );
}

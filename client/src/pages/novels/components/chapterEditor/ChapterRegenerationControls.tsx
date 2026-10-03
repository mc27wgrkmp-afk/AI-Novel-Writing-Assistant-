import { useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import type { Chapter } from "@ai-novel/shared/types/novel";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useSSE } from "@/hooks/useSSE";
import { countEditorWords } from "./chapterEditorUtils";
import { useLLMStore } from "@/store/llmStore";

interface Props {
  novelId: string;
  chapter: Chapter;
  isDirty: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onCompleted: () => Promise<void>;
}

export default function ChapterRegenerationControls(props: Props) {
  const llm = useLLMStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const completedRef = useRef(false);
  const startingRef = useRef(false);
  const refreshRef = useRef<Promise<void> | null>(null);
  const stream = useSSE({
    onDone: async () => {
      completedRef.current = true;
      refreshRef.current = props.onCompleted().then(() => {
        toast.success("本章正文已重新生成，请重新审校；旧稿可在版本历史中查看。");
      }).catch(() => {
        toast.error("正文已生成，但页面刷新失败。请刷新页面查看保存结果。");
      });
      await refreshRef.current;
    },
  });

  const start = async () => {
    if (startingRef.current || props.disabled || props.isDirty) return;
    startingRef.current = true;
    completedRef.current = false;
    refreshRef.current = null;
    setOpen(false);
    setIncomplete(false);
    setBusy(true);
    props.onBusyChange(true);
    try {
      await stream.start(`/novels/${props.novelId}/chapters/${props.chapter.id}/regenerate`, {
        provider: llm.provider,
        model: llm.model,
        temperature: llm.temperature,
      });
      await refreshRef.current;
      if (!completedRef.current) {
        setIncomplete(true);
        stream.abort();
      }
    } finally {
      startingRef.current = false;
      setBusy(false);
      props.onBusyChange(false);
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm text-muted-foreground">
          按已保存的创作设定与章节规划，从头重写本章。
          {props.isDirty ? <div className="mt-1 text-amber-700">请先保存正文修改，再重新生成。</div> : null}
          {busy ? (
            <div className="mt-1" role="status">
              {stream.latestRun?.message || (stream.content
                ? `已收到 ${countEditorWords(stream.content)} 字，正在完成本章写作与保存。`
                : "正在准备创作资料、等待模型并生成正文。模型会按设定的请求间隔排队。")}
            </div>
          ) : null}
          {!busy && (stream.error || incomplete) ? (
            <div className="mt-1 text-destructive" role="alert">
              {stream.error || "未收到生成完成确认，请刷新页面检查章节状态后再操作。"}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={props.disabled || props.isDirty || busy}
          onClick={() => setOpen(true)}
          className="shrink-0"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
          {busy ? "正在重新生成…" : "重新生成正文"}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <AppDialogContent
          title={`重新生成第 ${props.chapter.order} 章正文`}
          description="生成前会保存旧稿快照。新稿完成并保存后替换本章正文，生成失败时保留旧稿。"
          footer={(
            <>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>返回</Button>
              <Button type="button" disabled={props.disabled || props.isDirty || busy} onClick={() => void start()}>
                按已有资料重新生成
              </Button>
            </>
          )}
        >
          <p className="text-sm leading-7 text-muted-foreground">
            AI 将使用已保存的总纲、世界观、人物设定、基本原则、细纲与章节剧本，结合前文衔接和本章目标，重新撰写这一章。
          </p>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            生成后请点击「重新审校确认」检查新稿。旧稿可从版本历史中回看；模型请求会遵守已设置的等待间隔。
          </p>
        </AppDialogContent>
      </Dialog>
    </>
  );
}

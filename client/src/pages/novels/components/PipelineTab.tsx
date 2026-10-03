import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Chapter, NovelBible, PipelineJob, PlotBeat, QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import AiButton from "@/components/common/AiButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import StreamOutput from "@/components/common/StreamOutput";
import SelectControl from "@/components/common/SelectControl";

interface PipelineTabProps {
  novelId: string;
  worldInjectionSummary: string | null;
  hasCharacters: boolean;
  directorTakeoverEntry?: ReactNode;
  onGoToCharacterTab: () => void;
  pipelineForm: {
    startOrder: number;
    endOrder: number;
    maxRetries: number;
    runMode: "fast" | "polish";
    autoReview: boolean;
    autoRepair: boolean;
    skipCompleted: boolean;
    qualityThreshold: number;
    repairMode: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
  };
  onPipelineFormChange: (
    field: "startOrder" | "endOrder" | "maxRetries" | "runMode" | "autoReview" | "autoRepair" | "skipCompleted" | "qualityThreshold" | "repairMode",
    value: number | boolean | string,
  ) => void;
  maxOrder: number;
  onGenerateBible: () => void;
  onAbortBible: () => void;
  isBibleStreaming: boolean;
  bibleStreamContent: string;
  onGenerateBeats: () => void;
  onAbortBeats: () => void;
  isBeatsStreaming: boolean;
  beatsStreamContent: string;
  onRunPipeline: (patch?: Partial<PipelineTabProps["pipelineForm"]>) => void;
  isRunningPipeline: boolean;
  pipelineMessage: string;
  pipelineJob?: PipelineJob;
  chapters: Chapter[];
  selectedChapterId: string;
  onSelectedChapterChange: (chapterId: string) => void;
  onReviewChapter: () => void;
  isReviewing: boolean;
  onRepairChapter: () => void;
  isRepairing: boolean;
  onGenerateHook: () => void;
  isGeneratingHook: boolean;
  reviewResult: {
    score: QualityScore;
    issues: ReviewIssue[];
  } | null;
  repairBeforeContent: string;
  repairAfterContent: string;
  repairStreamContent: string;
  isRepairStreaming: boolean;
  onAbortRepair: () => void;
  qualitySummary?: QualityScore;
  chapterReports: Array<{
    chapterId?: string | null;
    coherence: number;
    repetition: number;
    pacing: number;
    voice: number;
    engagement: number;
    overall: number;
    issues?: string | null;
  }>;
  bible?: NovelBible | null;
  plotBeats: PlotBeat[];
}


export default function PipelineTab(props: PipelineTabProps) {
  const selectedChapter = props.chapters.find((chapter) => chapter.id === props.selectedChapterId);
  const exportReport = () => {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), pipelineJob: props.pipelineJob, qualitySummary: props.qualitySummary, chapterReports: props.chapterReports }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quality-report-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-5">
      <Card className="border-0 bg-muted/15 shadow-none">
        <CardHeader><CardTitle>正文审校与手动修改</CardTitle><p className="text-sm leading-6 text-muted-foreground">AI 负责大纲和剧本。正文由你写作，审校结果帮助你发现问题并自行修改。</p></CardHeader>
        <CardContent className="space-y-4">
          <SelectControl className="w-full rounded-md border bg-background p-2 text-sm" value={props.selectedChapterId} onChange={(event) => props.onSelectedChapterChange(event.target.value)}>
            <option value="">选择章节</option>
            {props.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.order} 章 · {chapter.title}</option>)}
          </SelectControl>
          <div className="flex flex-wrap gap-2">
            <AiButton onClick={props.onReviewChapter} disabled={props.isReviewing || !selectedChapter?.content?.trim()}>{props.isReviewing ? "审校中…" : "审校已保存正文"}</AiButton>
            {selectedChapter ? <Button asChild><Link to={`/novels/${props.novelId}/chapters/${selectedChapter.id}`}>打开正文编辑器</Link></Button> : null}
            <Button variant="outline" onClick={exportReport}>导出质量报告</Button>
          </div>
          {props.reviewResult ? <div className="space-y-3 text-sm"><p>综合评分：{props.reviewResult.score.overall}</p><pre className="whitespace-pre-wrap text-xs leading-6">{JSON.stringify(props.reviewResult.issues, null, 2)}</pre></div> : null}
        </CardContent>
      </Card>
      {props.pipelineMessage ? <p className="text-sm text-muted-foreground">{props.pipelineMessage}</p> : null}
      {props.isRepairStreaming ? <StreamOutput content={props.repairStreamContent} isStreaming onAbort={props.onAbortRepair} /> : null}
      <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">历史任务与质量记录</summary>
        <div className="mt-4 space-y-4 text-sm">
          {props.pipelineJob ? <div className="space-y-1 rounded-xl bg-muted/15 p-4"><p>任务：{props.pipelineJob.id}</p><p>状态：{props.pipelineJob.status}</p><p>阶段：{props.pipelineJob.currentStage || "—"}</p><p>完成：{props.pipelineJob.completedCount}/{props.pipelineJob.totalCount}</p>{props.pipelineJob.error ? <p className="text-destructive">{props.pipelineJob.error}</p> : null}</div> : <p className="text-muted-foreground">暂无历史流水线任务。</p>}
          {props.qualitySummary ? <p>全书综合评分：{props.qualitySummary.overall}</p> : null}
          {props.chapterReports.map((report, index) => <div key={`${report.chapterId ?? "novel"}-${index}`} className="border-t py-3"><p>{props.chapters.find((chapter) => chapter.id === report.chapterId)?.title ?? report.chapterId ?? "全书"} · 综合评分 {report.overall}</p>{report.issues ? <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{report.issues}</p> : null}</div>)}
          {props.bible ? <section><h3 className="mb-2 font-medium">已保存的作品圣经</h3><p className="whitespace-pre-wrap leading-7 text-muted-foreground">{[props.bible.mainPromise, props.bible.coreSetting, props.bible.worldRules].filter(Boolean).join("\n\n")}</p></section> : null}
          {props.plotBeats.length ? <section><h3 className="mb-2 font-medium">已保存的剧情拍点</h3>{props.plotBeats.map((beat) => <p key={beat.id}>第 {beat.chapterOrder ?? "—"} 章 · {beat.title}</p>)}</section> : null}
        </div>
      </details>
    </div>
  );
}

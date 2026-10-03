import type { SSEFrame } from "@ai-novel/shared/types/api";
import type { ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import type { AuditReport, Chapter, StoryStateSnapshot } from "@ai-novel/shared/types/novel";
import { Link } from "react-router-dom";
import AiButton from "@/components/common/AiButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { chapterHasPreparationAssets, chapterStatusLabel, PrimaryActionButton, type PrimaryAction, type ChapterExecutionBackgroundActivity, resolveDisplayedChapterStatus } from "./chapterExecution.shared";

interface ChapterExecutionActionPanelProps {
  novelId: string;
  selectedChapter: Chapter | undefined;
  hasCharacters: boolean;
  strategy: {
    runMode: "fast" | "polish";
    wordSize: "short" | "medium" | "long";
    conflictLevel: number;
    pace: "slow" | "balanced" | "fast";
    aiFreedom: "low" | "medium" | "high";
  };
  onStrategyChange: (
    field: "runMode" | "wordSize" | "conflictLevel" | "pace" | "aiFreedom",
    value: string | number,
  ) => void;
  onApplyStrategy: () => void;
  isApplyingStrategy: boolean;
  onGenerateSelectedChapter: () => void;
  onRewriteChapter: () => void;
  onExpandChapter: () => void;
  onCompressChapter: () => void;
  onSummarizeChapter: () => void;
  onGenerateTaskSheet: () => void;
  onGenerateSceneCards: () => void;
  onGenerateChapterPlan: () => void;
  onReplanChapter: () => void;
  onRunFullAudit: () => void;
  onCheckContinuity: () => void;
  onCheckCharacterConsistency: () => void;
  onCheckPacing: () => void;
  onAutoRepair: () => void;
  onStrengthenConflict: () => void;
  onEnhanceEmotion: () => void;
  onUnifyStyle: () => void;
  onAddDialogue: () => void;
  onAddDescription: () => void;
  isGeneratingTaskSheet: boolean;
  isGeneratingSceneCards: boolean;
  isSummarizingChapter: boolean;
  reviewActionKind?: "full_audit" | "continuity" | "character_consistency" | "pacing" | null;
  repairActionKind?: "autoRepair" | "expand" | "compress" | "strengthenConflict" | "enhanceEmotion" | "unifyStyle" | "addDialogue" | "addDescription" | null;
  generationActionKind?: "rewrite" | null;
  isReviewingChapter: boolean;
  isRepairingChapter: boolean;
  isGeneratingChapterPlan: boolean;
  isReplanningChapter: boolean;
  isRunningFullAudit: boolean;
  isStreaming: boolean;
  streamingChapterId?: string | null;
  repairStreamingChapterId?: string | null;
  chapterAuditReports: AuditReport[];
  chapterRuntimePackage?: ChapterRuntimePackage | null;
  latestStateSnapshot?: StoryStateSnapshot | null;
  chapterStateSnapshot?: StoryStateSnapshot | null;
  backgroundSyncActivities?: ChapterExecutionBackgroundActivity[];
  chapterRunStatus?: Extract<SSEFrame, { type: "run_status" }> | null;
  repairRunStatus?: Extract<SSEFrame, { type: "run_status" }> | null;
}


export function resolveChapterWritingAction(props: Pick<ChapterExecutionActionPanelProps,
  "novelId" | "selectedChapter" | "isGeneratingChapterPlan" | "isGeneratingTaskSheet" | "isGeneratingSceneCards" | "onGenerateChapterPlan" | "onGenerateTaskSheet"
>): PrimaryAction {
  const chapter = props.selectedChapter;
  if (!chapter) return { label: "请先选择章节", reason: "选择章节后，先准备分纲与剧本，再进入正文编辑器。", disabled: true, variant: "default" };
  if (chapter.content?.trim()) return { label: "打开章节编辑器", reason: "结合章节剧本和审校建议，由你修改并保存正文。", href: `/novels/${props.novelId}/chapters/${chapter.id}`, variant: "default" };
  if (!chapterHasPreparationAssets(chapter)) return {
    label: props.isGeneratingChapterPlan ? "正在生成章节分纲…" : "生成章节分纲",
    reason: "先明确本章目标、事件过程和结果，再准备章节剧本。",
    onClick: props.onGenerateChapterPlan, disabled: props.isGeneratingChapterPlan, ai: true, variant: "default",
  };
  if (!chapter.taskSheet?.trim() || !chapter.sceneCards?.trim()) return {
    label: props.isGeneratingTaskSheet || props.isGeneratingSceneCards ? "正在准备章节剧本…" : "准备章节剧本",
    reason: "让 AI 拆清场景、行动、阻碍和结果，作为你写正文的依据。",
    onClick: props.onGenerateTaskSheet, disabled: props.isGeneratingTaskSheet || props.isGeneratingSceneCards, ai: true, variant: "default",
  };
  return { label: "开始手写正文", reason: "分纲与章节剧本已备齐，打开编辑器完成正文并保存。", href: `/novels/${props.novelId}/chapters/${chapter.id}`, variant: "default" };
}

export default function ChapterExecutionActionPanel(props: ChapterExecutionActionPanelProps) {
  const { selectedChapter: chapter } = props;
  const action = resolveChapterWritingAction(props);
  const hasContent = Boolean(chapter?.content?.trim());
  const preparing = props.isGeneratingTaskSheet || props.isGeneratingSceneCards;
  return (
    <Card className="self-start border-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">分纲与剧本助手</CardTitle>
        <p className="text-sm leading-6 text-muted-foreground">AI 帮你规划故事和拆解场景；正文由你在编辑器中写作。</p>
        {chapter ? <Badge variant="secondary">{chapterStatusLabel(resolveDisplayedChapterStatus(chapter))}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-2xl bg-primary/5 p-4">
          <p className="mb-3 text-sm leading-6">{action.reason}</p>
          <PrimaryActionButton action={action} className="w-full" />
          {chapter && !action.href ? <Button asChild variant="outline" className="mt-2 w-full"><Link to={`/novels/${props.novelId}/chapters/${chapter.id}`}>打开正文编辑器</Link></Button> : null}
        </div>
        <div className="grid gap-2">
          <AiButton variant="outline" onClick={props.onGenerateChapterPlan} disabled={!chapter || props.isGeneratingChapterPlan}>{props.isGeneratingChapterPlan ? "生成分纲中…" : "生成章节分纲"}</AiButton>
          <AiButton variant="outline" onClick={props.onGenerateTaskSheet} disabled={!chapter || preparing}>{preparing ? "准备剧本中…" : "生成章节剧本"}</AiButton>
          <AiButton variant="outline" onClick={props.onGenerateSceneCards} disabled={!chapter || preparing}>拆解场景</AiButton>
          <AiButton variant="outline" onClick={props.onReplanChapter} disabled={!chapter || props.isReplanningChapter}>{props.isReplanningChapter ? "调整计划中…" : "调整后续章节计划"}</AiButton>
        </div>
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">正文检查与建议</summary>
          <p className="my-3 text-xs leading-6 text-muted-foreground">保存你写的正文后，查看审校结果，再自行修改。</p>
          <div className="grid gap-2">
            <AiButton variant="outline" onClick={props.onRunFullAudit} disabled={!hasContent || props.isReviewingChapter}>{props.isRunningFullAudit ? "审校中…" : "运行完整审校"}</AiButton>
            <AiButton variant="outline" onClick={props.onCheckContinuity} disabled={!hasContent || props.isReviewingChapter}>检查连续性</AiButton>
            <AiButton variant="outline" onClick={props.onCheckCharacterConsistency} disabled={!hasContent || props.isReviewingChapter}>检查人设一致性</AiButton>
            <AiButton variant="outline" onClick={props.onCheckPacing} disabled={!hasContent || props.isReviewingChapter}>检查节奏</AiButton>
            <AiButton variant="outline" onClick={props.onSummarizeChapter} disabled={!hasContent || props.isSummarizingChapter}>生成正文摘要</AiButton>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

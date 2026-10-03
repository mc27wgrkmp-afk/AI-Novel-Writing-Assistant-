import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import type { DirectorConflictRecoveryPlan } from "@ai-novel/shared/types/directorConflictRecovery";
import { retryNovelWorkflow } from "@/api/novelWorkflow";
import { toast } from "@/components/ui/toast";
import { generateConflictRecoveryPlan, loadConflictRecoveryPlan } from "./api";
import type { DirectorConflictRecoveryDialogProps } from "./DirectorConflictRecoveryDialog";

export function useDirectorConflictRecovery(input: {
  task: UnifiedTaskDetail | null;
  onAccepted: (taskId: string) => Promise<void>;
}): DirectorConflictRecoveryDialogProps {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<DirectorConflictRecoveryPlan | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [userNote, setUserNote] = useState("");
  const taskId = input.task?.id ?? "";
  const activeTaskId = useRef(taskId);
  activeTaskId.current = taskId;
  useEffect(() => {
    setOpen(false); setPlan(null); setSelectedOptionId(""); setUserNote("");
  }, [taskId]);
  const analyze = useMutation({
    mutationFn: async (request: { taskId: string; userNote: string; reuse: boolean }) => {
      if (!request.taskId) throw new Error("没有找到当前任务。");
      const saved = request.reuse ? await loadConflictRecoveryPlan(request.taskId) : null;
      return saved ?? generateConflictRecoveryPlan(request.taskId, request.userNote);
    },
    onSuccess: (result, request) => {
      if (activeTaskId.current !== request.taskId) return;
      setPlan(result); setSelectedOptionId("");
    },
  });
  const apply = useMutation({
    mutationFn: async (selection: { taskId: string; planId: string; optionId: string }) => (
      retryNovelWorkflow(selection.taskId, { conflictRecoverySelection: { planId: selection.planId, optionId: selection.optionId } })
    ),
    onSuccess: async (response, selection) => {
      if (activeTaskId.current !== selection.taskId) return;
      setOpen(false); setPlan(null); setSelectedOptionId("");
      await input.onAccepted(response.data?.taskId ?? selection.taskId);
      toast.success("已开始按你选择的方案处理。修改完成后，请检查结果再继续。");
    },
  });
  const generate = (reuse: boolean) => {
    if (analyze.isPending || apply.isPending) return;
    setSelectedOptionId("");
    apply.reset();
    analyze.mutate({ taskId, userNote: userNote.trim(), reuse });
  };
  return {
    open, onOpenChange: setOpen,
    onOpen: () => { setOpen(true); generate(true); },
    plan, selectedOptionId, onSelectOption: setSelectedOptionId,
    userNote, onUserNoteChange: setUserNote,
    analyzing: analyze.isPending, applying: apply.isPending,
    error: (analyze.error ?? apply.error)?.message ?? null,
    onGenerate: () => generate(false),
    onConfirm: () => {
      if (plan && selectedOptionId && !analyze.isPending && !apply.isPending) {
        apply.mutate({ taskId, planId: plan.id, optionId: selectedOptionId });
      }
    },
  };
}

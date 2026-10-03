import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Check, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { selectNovelProductionExperience } from "@/api/novelWorkflow";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { queryKeys } from "@/api/queryKeys";

interface NovelProductionExperienceHandoffProps {
  taskId: string;
  novelId: string;
  novelTitle?: string;
  planningCompleted?: boolean;
}

export default function NovelProductionExperienceHandoff({
  taskId,
  novelId,
  novelTitle,
  planningCompleted = false,
}: NovelProductionExperienceHandoffProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await selectNovelProductionExperience(taskId, "professional");
      if (!response.data) {
        throw new Error("打开写作工作台失败，请重试。");
      }
      return response.data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["novels", novelId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.firstNovel }),
      ]);
      navigate(`/novels/${novelId}/edit`, { replace: true });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "打开写作工作台失败，请重试。"),
  });

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-3 py-6 sm:px-4 lg:px-0">
      <div className="rounded-3xl bg-muted/35 px-6 py-7 sm:px-8 sm:py-9">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <BookOpen className="h-4 w-4" />
          大纲与章节剧本准备完成
        </div>
        <h1 className="mt-4 max-w-3xl text-2xl font-semibold tracking-tight sm:text-3xl">
          根据《{novelTitle?.trim() || "这本小说"}》的剧本开始写作
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          AI 已完成故事方向、人物和卷章规划。你可以在工作台检查章节剧本，调整事件安排，再写成正文。
        </p>
      </div>
      <div className="px-6 sm:px-8">
        <ul className="space-y-3 text-sm text-foreground">
          {["查看大纲和人物资料", "检查每章的目标、阻碍、行动和结果", "根据章节剧本编写与保存正文"].map((item) => (
            <li key={item} className="flex items-center gap-2.5">
              <Check className="h-4 w-4 shrink-0 text-primary" />
              {item}
            </li>
          ))}
        </ul>
        <Button
          type="button"
          className="mt-6 gap-3"
          disabled={mutation.isPending}
          onClick={() => planningCompleted
            ? navigate(`/novels/${novelId}/edit`, { replace: true })
            : mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookOpen className="h-4 w-4" />}
          打开剧本与写作工作台
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}

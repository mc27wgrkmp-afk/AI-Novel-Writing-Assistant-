import type {
  NovelProductionExperience,
  NovelProductionExperienceSelectionResponse,
} from "@ai-novel/shared/types/novelWorkflow";
import { prisma } from "../../../../db/prisma";
import { AppError } from "../../../../middleware/errorHandler";
import { parseSeedPayload } from "../../workflow/novelWorkflow.shared";
import {
  applyDirectorRunModeContract,
  type DirectorWorkflowSeedPayload,
} from "../runtime/novelDirectorHelpers";
import { DirectorCommandService } from "./DirectorCommandService";

export function parseSelectedExperience(seed: DirectorWorkflowSeedPayload): NovelProductionExperience | null {
  return seed.productionExperience === "simple" || seed.productionExperience === "professional"
    ? seed.productionExperience
    : null;
}

export function buildProductionExperienceSeed(
  seed: DirectorWorkflowSeedPayload,
  experience: NovelProductionExperience,
): DirectorWorkflowSeedPayload {
  const directorInput = seed.directorInput;
  if (!directorInput) {
    throw new AppError("自动导演任务缺少继续生产所需的上下文。", 409);
  }
  const nextInput = applyDirectorRunModeContract({
    ...directorInput,
    runMode: "auto_to_ready" as const,
  });
  return {
    ...seed,
    productionExperience: experience,
    runMode: nextInput.runMode,
    autoExecutionPlan: nextInput.autoExecutionPlan,
    autoApproval: nextInput.autoApproval,
    directorInput: nextInput,
  };
}

export class DirectorProductionExperienceService {
  constructor(private readonly commandService = new DirectorCommandService()) {}

  async select(
    taskId: string,
    experience: NovelProductionExperience,
  ): Promise<NovelProductionExperienceSelectionResponse> {
    const task = await prisma.novelWorkflowTask.findUnique({ where: { id: taskId } });
    if (!task || task.lane !== "auto_director") {
      throw new AppError("自动导演任务不存在。", 404);
    }
    if (!task.novelId) {
      throw new AppError("自动导演任务还没有绑定小说项目。", 409);
    }

    const seed = parseSeedPayload<DirectorWorkflowSeedPayload>(task.seedPayloadJson) ?? {};
    if (task.checkpointType !== "workflow_completed"
      && task.checkpointType !== "production_experience_required"
      && task.checkpointType !== "chapter_batch_ready") {
      throw new AppError("请先完成大纲与章节剧本，再选择创作界面。", 409);
    }
    const nextSeed = buildProductionExperienceSeed(seed, experience);
    await prisma.$transaction([
      prisma.novelWorkflowTask.update({
        where: { id: task.id },
        data: { seedPayloadJson: JSON.stringify(nextSeed) },
      }),
      prisma.novel.update({
        where: { id: task.novelId },
        data: { creationExperience: experience },
      }),
    ]);
    return {
      experience,
      workflowTaskId: task.id,
      novelId: task.novelId,
      targetRoute: experience === "simple" ? `/novels/${task.novelId}/simple` : `/novels/${task.novelId}/edit`,
      backgroundStarted: false,
    };
  }
}

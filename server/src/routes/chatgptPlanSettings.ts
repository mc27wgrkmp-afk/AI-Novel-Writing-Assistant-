import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { setProviderSecretCache } from "../llm/factory";
import { authMiddleware } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { getLLMSelectionSettings } from "../services/settings/LLMSelectionSettingsService";
import { secretStore } from "../services/settings/secretStore";
import { getRagEmbeddingSettings } from "../services/settings/RagSettingsService";
import { getRagRuntimeSettings } from "../services/settings/RagRuntimeSettingsService";
import { chatGPTPlanService, getChatGPTPlanAvailability } from "../platform/llm/chatgptPlan/ChatGPTPlanService";

const router = Router();
const signInBodySchema = z.object({ reconsent: z.boolean().optional() }).default({});

router.use(authMiddleware);

router.get("/status", async (_req, res, next) => {
  try {
    const availability = getChatGPTPlanAvailability();
    const session = availability.available
      ? await chatGPTPlanService.getSession()
      : { status: "disconnected" as const, sharing: false };
    const data = {
      available: availability.available,
      message: availability.message,
      session,
      usageUrl: "https://chatgpt.com/settings/usage",
    };
    res.status(200).json({ success: true, data, message: "ChatGPT 方案连接状态已加载。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/sign-in", async (req, res, next) => {
  try {
    const body = signInBodySchema.parse(req.body ?? {});
    const result = await chatGPTPlanService.signIn(body.reconsent ?? false);
    const data = {
      available: true,
      session: result.session,
      models: result.models,
      modelError: result.modelError,
      usageUrl: "https://chatgpt.com/settings/usage",
    };
    res.status(200).json({ success: true, data, message: "ChatGPT 连接流程已完成。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/models", async (_req, res, next) => {
  try {
    const availability = getChatGPTPlanAvailability();
    if (!availability.available) throw new AppError(availability.message ?? "ChatGPT 方案连接不可用。", 503);
    const session = await chatGPTPlanService.getSession();
    if (session.status !== "connected") throw new AppError("请先连接 ChatGPT 账号。", 401);
    if (!session.sharing) throw new AppError("请在授权页面允许本应用使用 ChatGPT 方案额度。", 403);
    const data = await chatGPTPlanService.refreshModels();
    res.status(200).json({ success: true, data, message: "可用模型列表已更新。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/disconnect", async (_req, res, next) => {
  try {
    const provider = "chatgpt_plus";
    const [routeInUse, selection, ragSettings, ragRuntimeSettings] = await Promise.all([
      prisma.modelRouteConfig.findFirst({ where: { provider }, select: { taskType: true } }),
      getLLMSelectionSettings(),
      getRagEmbeddingSettings(),
      getRagRuntimeSettings(),
    ]);
    if (routeInUse) throw new AppError(`任务路由 ${routeInUse.taskType} 正在使用 ChatGPT，请先为该任务选择其他模型。`, 400);
    if (selection?.provider === provider) throw new AppError("顶部默认模型正在使用 ChatGPT，请先切换默认模型。", 400);
    if (ragRuntimeSettings.enabled && ragSettings.embeddingProvider === provider) {
      throw new AppError("知识库正在使用 ChatGPT，请先为知识库选择其他向量服务。", 400);
    }

    const disconnectResult = await chatGPTPlanService.disconnect();
    const existing = await secretStore.getProvider(provider);
    if (existing) await secretStore.updateProvider(provider, { isActive: false });
    setProviderSecretCache(provider, null);
    const data = {
      ...(await chatGPTPlanService.getSession()),
      remoteRevocationConfirmed: disconnectResult.remoteRevocationConfirmed,
    };
    res.status(200).json({
      success: true,
      data,
      message: disconnectResult.remoteRevocationConfirmed
        ? "ChatGPT 已从本应用断开。"
        : "本机登录凭据已移除；远程撤销未能确认，如需撤销授权，请前往 ChatGPT 设置中的已连接应用。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

export default router;

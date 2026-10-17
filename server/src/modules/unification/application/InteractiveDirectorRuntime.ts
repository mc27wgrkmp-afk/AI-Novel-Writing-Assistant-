import { prisma } from "../../../db/prisma";
import { DirectorWorker } from "../../../workers/directorWorker";
import { ENTRY_PREFIX } from "./ImportService";

const BASELINE_KEY = "unification.director-baseline.v1";

/** Run explicit work created in this installation without reviving imported jobs. */
export async function startInteractiveDirectorRuntime(): Promise<{ stop: () => Promise<void> }> {
  let baseline = await prisma.appSetting.findUnique({ where: { key: BASELINE_KEY } });
  if (!baseline) {
    const firstImport = await prisma.appSetting.findFirst({ where: { key: { startsWith: ENTRY_PREFIX } }, orderBy: { createdAt: "asc" } });
    const value = (firstImport?.createdAt ?? new Date()).toISOString();
    baseline = await prisma.appSetting.upsert({ where: { key: BASELINE_KEY }, create: { key: BASELINE_KEY, value }, update: {} });
  }
  const taskCreatedAfter = new Date(baseline.value);
  if (!Number.isFinite(taskCreatedAfter.getTime())) throw new Error("统一书房任务基准时间无效，请检查本地设置。");
  const worker = new DirectorWorker({ taskCreatedAfter, executionSlots: 2, pollMs: 1000 });
  void worker.start().catch(error => console.error("[unified.director] worker stopped", error));
  return { stop: async () => worker.stop() };
}

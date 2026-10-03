import { Router, type Response } from "express";
import { z } from "zod";
import { FactoryEngine } from "../application/FactoryEngine";
import { currentText, FactoryError } from "../domain/factoryPolicy";
import { factorySetupSchema } from "../domain/factorySchemas";
import { factoryProcessOwner, PrismaFactoryRepository } from "../infrastructure/FactoryRepository";
import { FactoryPromptModels } from "../infrastructure/FactoryPromptModels";

const repository = new PrismaFactoryRepository();
export const factoryEngine = new FactoryEngine(repository, new FactoryPromptModels(), factoryProcessOwner);
const router = Router();
const idSchema = z.string().uuid();
const bodyStart = z.object({ count: z.number().int().min(1).max(3).default(1) }).strict();
const bodyDraft = z.object({ text: z.string().min(1).max(100000).refine((s) => Boolean(s.trim()), "正文不能为空") }).strict();

function failure(error: unknown, res: Response): void {
  if (error instanceof z.ZodError) { res.status(422).json({ success: false, error: error.issues.map((issue) => `${issue.path.join(".")}：${issue.message}`).join("；") }); return; }
  if (error instanceof FactoryError) { res.status(error.status).json({ success: false, error: error.message }); return; }
  res.status(500).json({ success: false, error: "项目读取或保存失败，请检查本地服务和数据库。" });
}

router.get("/books", async (_req, res) => {
  try { res.json({ success: true, data: await repository.list() }); } catch (error) { failure(error, res); }
});
router.post("/books", async (req, res) => {
  try { res.status(201).json({ success: true, data: await repository.create(factorySetupSchema.parse(req.body)) }); } catch (error) { failure(error, res); }
});
router.get("/books/:id", async (req, res) => {
  try { res.json({ success: true, data: await repository.read(idSchema.parse(req.params.id)) }); } catch (error) { failure(error, res); }
});
router.post("/books/:id/start", async (req, res) => {
  try { res.status(202).json({ success: true, data: await factoryEngine.start(idSchema.parse(req.params.id), bodyStart.parse(req.body ?? {}).count) }); } catch (error) { failure(error, res); }
});
router.post("/books/:id/pause", async (req, res) => {
  try { res.json({ success: true, data: await factoryEngine.pause(idSchema.parse(req.params.id)) }); } catch (error) { failure(error, res); }
});
router.post("/books/:id/resume", async (req, res) => {
  try { res.status(202).json({ success: true, data: await factoryEngine.resume(idSchema.parse(req.params.id)) }); } catch (error) { failure(error, res); }
});
router.put("/books/:id/draft", async (req, res) => {
  try { res.json({ success: true, data: await factoryEngine.editDraft(idSchema.parse(req.params.id), bodyDraft.parse(req.body).text) }); } catch (error) { failure(error, res); }
});
router.get("/books/:id/export", async (req, res) => {
  try {
    const book = await repository.read(idSchema.parse(req.params.id));
    const format = z.enum(["txt", "json"]).default("txt").parse(req.query.format);
    res.setHeader("Content-Disposition", `attachment; filename="factory-${book.id}.${format}"`);
    if (format === "json") res.type("application/json").send(JSON.stringify(book, null, 2));
    else res.type("text/plain; charset=utf-8").send(book.chapters.filter((chapter) => chapter.committed).map((chapter) =>
      `第${chapter.order}章 ${chapter.script?.title ?? book.goals[chapter.order - 1].title}\n\n${currentText(chapter)}`).join("\n\n"));
  } catch (error) { failure(error, res); }
});

export default router;

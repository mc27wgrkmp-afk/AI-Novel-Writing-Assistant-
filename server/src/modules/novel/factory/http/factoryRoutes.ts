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
router.post("/books/:id/gemini-web", async (req, res) => {
  try { res.json({ success: true, data: await factoryEngine.useGeminiWeb(idSchema.parse(req.params.id)) }); } catch (error) { failure(error, res); }
});
router.put("/books/:id/draft", async (req, res) => {
  try { res.json({ success: true, data: await factoryEngine.editDraft(idSchema.parse(req.params.id), bodyDraft.parse(req.body).text) }); } catch (error) { failure(error, res); }
});
router.get("/books/:id/export", async (req, res) => {
  try {
    const book = await repository.read(idSchema.parse(req.params.id));
    const format = z.enum(["txt", "json", "md"]).default("txt").parse(req.query.format);
    res.setHeader("Content-Disposition", `attachment; filename="factory-${book.id}.${format}"`);
    if (format === "json") res.type("application/json").send(JSON.stringify(book, null, 2));
    else if (format === "md") res.type("text/markdown; charset=utf-8").send([
      `# ${book.title} · Gemini 网页版写作包`,
      "复制对应章节的完整指令到 Gemini 网页版。生成正文后粘贴回章节生产页，审核并保存后再写下一章。后续章节指令以审核后的故事状态为准。",
      "## 章节大纲（未来规划，尚未发生）\n" + book.goals.map((goal, i) => `### 第 ${i + 1} 章 ${goal.title}\n${goal.goal}\n必须发生：${goal.mustDo.join("；")}\n禁止发生：${goal.mustNot.join("；")}\n结尾钩子：${goal.hook}`).join("\n\n"),
      ...book.chapters.filter(c => c.prompt).map(c => `## 第 ${c.order} 章写作指令\n\n${c.prompt}`),
      ...(book.nextHandoff ? [`## 第 ${book.nextHandoff.order} 章写作指令\n\n${book.nextHandoff.prompt}`] : []),
    ].join("\n\n"));
    else res.type("text/plain; charset=utf-8").send(book.chapters.filter((chapter) => chapter.committed).map((chapter) =>
      `第${chapter.order}章 ${chapter.script?.title ?? book.goals[chapter.order - 1].title}\n\n${currentText(chapter)}`).join("\n\n"));
  } catch (error) { failure(error, res); }
});

export default router;

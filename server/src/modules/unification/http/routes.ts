import { Router } from "express";
import { z } from "zod";
import { importService } from "../application/ImportService";
import { authoringService } from "../application/AuthoringService";
import { generateDraft, reviewChapter } from "../application/ModelService";
import { runResearch, approvePattern } from "../application/ResearchService";
import { AppError } from "../../../middleware/errorHandler";

const router = Router();
const id = z.string().min(1).max(180);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
router.use((req, _res, next) => {
  const address = req.socket.remoteAddress;
  const origin = req.headers.origin;
  if (!address || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)
    || (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    next(new AppError("本地书仓仅允许本机访问。", 403)); return;
  }
  next();
});
router.get("/overview", async (_req, res, next) => { try { res.json({ success: true, data: await importService.overview() }); } catch (e) { next(e); } });
router.post("/import", async (req, res, next) => { try {
  const body = z.object({ sourceKey: z.string().min(1).max(600), expectedHash: hash }).parse(req.body);
  res.json({ success: true, data: await importService.importBook(body.sourceKey, body.expectedHash) });
} catch (e) { next(e); } });
router.get("/imports/:id/artifacts", async (req, res, next) => { try { res.json({ success: true, data: await importService.artifacts(id.parse(req.params.id)) }); } catch (e) { next(e); } });
router.get("/imports/:id/artifacts/:artifactId", async (req, res, next) => { try { res.json({ success: true, data: await importService.artifact(id.parse(req.params.id), id.parse(req.params.artifactId)) }); } catch (e) { next(e); } });
router.get("/novels/:id", async (req, res, next) => { try { res.json({ success: true, data: await authoringService.novel(id.parse(req.params.id)) }); } catch (e) { next(e); } });
router.put("/novels/:id/policy", async (req, res, next) => { try {
  const body = z.object({ mode: z.enum(["manual", "ai"]), expectedVersion: z.number().int().nonnegative() }).parse(req.body);
  res.json({ success: true, data: await authoringService.setPolicy(id.parse(req.params.id), body.mode, body.expectedVersion) });
} catch (e) { next(e); } });
router.get("/novels/:id/chapters/:chapterId", async (req, res, next) => { try { res.json({ success: true, data: await authoringService.chapter(id.parse(req.params.id), id.parse(req.params.chapterId)) }); } catch (e) { next(e); } });
router.post("/novels/:id/chapters/:chapterId/draft", async (req, res, next) => { try {
  const body = z.object({ content: z.string().max(500000), expectedHash: hash }).parse(req.body);
  res.json({ success: true, data: await authoringService.save(id.parse(req.params.id), id.parse(req.params.chapterId), body.content, body.expectedHash) });
} catch (e) { next(e); } });
router.post("/novels/:id/chapters/:chapterId/generate", async (req, res, next) => { try {
  const body = z.object({ expectedHash: hash, policyVersion: z.number().int().nonnegative() }).parse(req.body);
  res.json({ success: true, data: await generateDraft(id.parse(req.params.id), id.parse(req.params.chapterId), body.expectedHash, body.policyVersion) });
} catch (e) { next(e); } });
router.post("/novels/:id/chapters/:chapterId/review", async (req, res, next) => { try {
  const body = z.object({ expectedHash: hash }).parse(req.body);
  res.json({ success: true, data: await reviewChapter(id.parse(req.params.id), id.parse(req.params.chapterId), body.expectedHash) });
} catch (e) { next(e); } });
router.post("/novels/:id/chapters/:chapterId/approve", async (req, res, next) => { try {
  const body = z.object({ expectedHash: hash, reviewId: id }).parse(req.body);
  res.json({ success: true, data: await authoringService.approve(id.parse(req.params.id), id.parse(req.params.chapterId), body.expectedHash, body.reviewId) });
} catch (e) { next(e); } });
router.post("/research/:id", async (req, res, next) => { try {
  const body = z.object({ kind: z.enum(["opening","pattern","scene"]), segment: z.string().optional(), relatedImportIds: z.array(id).max(8).optional(), patternId: id.optional() }).parse(req.body);
  res.json({ success: true, data: await runResearch(id.parse(req.params.id), body) });
} catch (e) { next(e); } });
router.post("/research/:id/:artifactId/approve", async (req, res, next) => { try {
  res.json({ success: true, data: await approvePattern(id.parse(req.params.id), id.parse(req.params.artifactId)) });
} catch (e) { next(e); } });
export default router;

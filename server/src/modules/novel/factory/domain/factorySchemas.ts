import { z } from "zod";

const text = z.string().trim().min(1);
const stateKey = text.max(120).refine((s) => !["__proto__", "constructor", "prototype"].includes(s), "状态名称不可用");
export const factoryStateSchema = z.record(stateKey, text.max(2000)).refine((state) => Object.keys(state).length <= 200, "状态最多 200 项");
export const factoryModelSchema = z.object({ provider: text.max(100), model: text.max(150) }).strict();
export const factorySetupSchema = z.object({
  title: text.max(100),
  constitution: text.max(12000),
  lockedFacts: z.array(z.object({ id: stateKey, text: text.max(1000) }).strict()).min(1).max(40),
  negativeCanon: z.array(text.max(1000)).max(30),
  style: text.max(3000),
  initialState: factoryStateSchema,
  goals: z.array(z.object({
    title: text.max(100), goal: text.max(2000),
    mustDo: z.array(text.max(600)).min(1).max(15),
    mustNot: z.array(text.max(600)).max(15), hook: text.max(600),
  }).strict()).min(1).max(10),
  targetWords: z.number().int().min(300).max(6000),
  planner: factoryModelSchema,
  writer: factoryModelSchema.default({ provider: "gemini_web", model: "Gemini 网页版" }),
  writerMode: z.enum(["api", "gemini_web"]).default("api"),
}).strict().superRefine((setup, ctx) => {
  if (setup.writerMode === "api" && setup.writer.provider === "gemini_web") ctx.addIssue({ code: "custom", message: "接口写作需要选择正文模型", path: ["writer"] });
  const ids = setup.lockedFacts.map((f) => f.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "锁定设定标识不能重复", path: ["lockedFacts"] });
  if (Object.keys(setup.initialState).some((key) => ids.includes(key) || key.startsWith("canon."))) {
    ctx.addIssue({ code: "custom", message: "初始状态不能覆盖锁定设定", path: ["initialState"] });
  }
});

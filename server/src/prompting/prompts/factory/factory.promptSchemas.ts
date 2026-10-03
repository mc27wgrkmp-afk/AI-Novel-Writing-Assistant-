import { z } from "zod";

const shortText = z.string().trim().min(1).max(2000);
export const factoryScriptSchema = z.object({
  title: z.string().trim().min(1).max(200),
  scenes: z.array(shortText).min(1).max(12),
  mustDo: z.array(shortText).max(30),
  mustNot: z.array(shortText).max(30),
  hook: shortText,
}).strict();
export const factoryReviewSchema = z.object({
  checks: z.object({
    script: z.boolean(), canon: z.boolean(), continuity: z.boolean(), character: z.boolean(),
    information: z.boolean(), expansion: z.boolean(), hook: z.boolean(),
  }).strict(),
  issues: z.array(z.object({
    code: z.string().trim().min(1).max(100),
    severity: z.enum(["blocking", "warning"]),
    description: shortText,
    evidence: z.string().min(1).max(3000),
    repairInstruction: shortText,
  }).strict()).max(30),
  summary: z.string().trim().min(1).max(4000),
  changes: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    before: z.string().max(2000).nullable(),
    after: shortText,
    evidence: z.string().min(1).max(3000),
    kind: z.enum(["operational", "new_canon"]),
  }).strict()).max(40),
}).strict();
export const factoryPatchSchema = z.object({
  patches: z.array(z.object({
    original: z.string().min(1).max(6000),
    replacement: z.string().max(6000),
  }).strict()).min(1).max(8),
}).strict();

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SourceBundle } from "../domain/types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const draft = z.object({
  key: z.string().min(1),
  version: z.number().int().positive(),
  raw: z.string(),
  content: z.string(),
  candidateFacts: z.string(),
  hash,
  bodyHash: hash,
  han: z.number().int().nonnegative(),
}).strict();
const chapter = z.object({
  key: z.string().min(1),
  volume: z.number().int().positive(),
  order: z.number().int().positive(),
  title: z.string(),
  content: z.string(),
  drafts: z.array(draft),
}).strict();
const artifact = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
  content: z.string(),
  hash,
}).strict();
const bundle = z.object({
  schema: z.literal(1),
  books: z.array(z.object({
    key: z.string().min(1),
    source: z.enum(["scriptor", "webfictionlab"]),
    kind: z.enum(["novel", "reference"]),
    title: z.string(),
    hash,
    chapters: z.array(chapter),
    artifacts: z.array(artifact),
    metadata: z.record(z.string(), z.unknown()),
  }).strict()),
  warnings: z.array(z.string()),
}).strict();

function scannerPath(): string {
  const candidates = [
    path.resolve(__dirname, "source_scan.py"),
    // tsc emits the facade into dist; the local app retains its source tree.
    path.resolve(__dirname, "../../../../src/modules/unification/infrastructure/source_scan.py"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("找不到本地书仓扫描器，请检查应用安装文件。");
  return found;
}

/** Source locations are local environment configuration, never HTTP arguments. */
export async function scanSources(): Promise<SourceBundle> {
  const executable = scannerPath();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("python3", [executable], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 128 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    }, (error, output) => {
      if (error) {
        // execFile errors can retain stdout (complete novel manuscripts).
        // Do not put the original error or output in logs or HTTP diagnostics.
        reject(new Error("只读扫描未完成，请检查 Python 3、来源路径或文件大小。"));
      } else {
        resolve(output);
      }
    });
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error("书仓扫描结果不是有效 JSON，请检查应用安装文件。");
  }
  const result = bundle.safeParse(decoded);
  if (!result.success) throw new Error("书仓扫描结果格式不兼容，请检查应用安装文件。");
  return result.data;
}

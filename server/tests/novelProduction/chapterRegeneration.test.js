const test = require("node:test");
const assert = require("node:assert/strict");
// These tests exercise injected orchestration only, without opening a database
// or initializing any model adapters.
const fakeClass = class {};
const mockedModules = {
  "../../dist/db/prisma.js": { prisma: {} },
  "../../dist/services/planner/PlannerService.js": { plannerService: {} },
  "../../dist/services/novel/chapterWritingGraph.js": { ChapterWritingGraph: fakeClass },
  "../../dist/services/novel/novelCoreSnapshotService.js": { NovelCoreSnapshotService: fakeClass },
  "../../dist/services/novel/runtime/GenerationContextAssembler.js": { GenerationContextAssembler: fakeClass },
  "../../dist/services/novel/runtime/ChapterRuntimeReadinessService.js": { ChapterRuntimeReadinessService: fakeClass },
  "../../dist/services/novel/runtime/BatchContextCache.js": { batchContextCache: {} },
  "../../dist/services/novel/runtime/lifecycle/index.js": { chapterLifecycleService: {} },
};
for (const [path, exports] of Object.entries(mockedModules)) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { ChapterRegenerationService } = require("../../dist/services/novel/production/regeneration/ChapterRegenerationService.js");

function fixture(overrides = {}) {
  const calls = [];
  let original = "原正文";
  const contextPackage = { chapter: { content: original }, pendingReviewProposalCount: 0 };
  const deps = {
    claim: async () => { calls.push("claim"); return { chapterStatus: "needs_repair", order: 2, content: original }; },
    release: async () => { calls.push("release"); },
    backup: async () => { calls.push("backup"); },
    assemble: async (_novelId, _chapterId, request) => { calls.push(["assemble", request]); return { novel: { title: "小说" }, chapter: { id: "chapter-2", content: original }, contextPackage }; },
    assertReady: () => calls.push("ready"),
    writer: { createChapterStream: async (input) => { calls.push(["writer", input]); return { stream: (async function* () { yield { content: "新正文" }; })(), onDone: async () => ({ finalContent: "新正文" }) }; } },
    save: async (_novelId, _chapterId, content) => { calls.push("save"); original = content; },
    ...overrides,
  };
  return { service: new ChapterRegenerationService(deps), calls, contextPackage, original: () => original };
}

async function drain(stream) { for await (const _chunk of stream) {} }

test("regeneration backs up before writer, discards old prose, and saves only completed draft", async () => {
  const f = fixture();
  const result = await f.service.createStream("novel", "chapter-2", { provider: "gemini", previousChaptersSummary: ["untrusted override"], controlPolicy: { advanceMode: "full_book_autopilot" } });
  assert.equal(f.original(), "原正文");
  const writerCall = f.calls.find(c => Array.isArray(c) && c[0] === "writer")[1];
  assert.equal(writerCall.chapter.content, null);
  assert.equal(writerCall.contextPackage.chapter.content, null);
  assert.equal(writerCall.options.controlPolicy, undefined);
  assert.equal(writerCall.options.previousChaptersSummary, undefined);
  assert.ok(f.calls.indexOf("backup") < f.calls.indexOf(f.calls.find(c => Array.isArray(c) && c[0] === "writer")));
  await drain(result.stream);
  assert.equal(f.original(), "原正文");
  assert.deepEqual(await result.onDone("新正文"), { fullContent: "新正文" });
  assert.equal(f.original(), "新正文");
  assert.ok(!f.calls.includes("release"));
});

test("backup failure prevents any writer call and releases chapter", async () => {
  const f = fixture({ backup: async () => { throw new Error("backup failed"); } });
  await assert.rejects(f.service.createStream("n", "c"), /backup failed/);
  assert.equal(f.original(), "原正文");
  assert.ok(f.calls.includes("release"));
  assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === "writer"));
});

test("upstream stream failure keeps old text and releases chapter", async () => {
  const f = fixture({ writer: { createChapterStream: async () => ({ stream: (async function* () { yield { content: "partial" }; throw new Error("upstream failed"); })(), onDone: async () => { throw new Error("should not finish"); } }) } });
  const result = await f.service.createStream("n", "c");
  await assert.rejects(drain(result.stream), /upstream failed/);
  assert.equal(f.original(), "原正文");
  assert.ok(f.calls.includes("release"));
});

test("empty writer completion never replaces old manuscript", async () => {
  const f = fixture({ writer: { createChapterStream: async () => ({ stream: (async function* () { yield { content: " " }; })(), onDone: async () => ({ finalContent: " " }) }) } });
  const result = await f.service.createStream("n", "c");
  await drain(result.stream);
  await assert.rejects(result.onDone(" "));
  assert.equal(f.original(), "原正文");
  assert.ok(f.calls.includes("release"));
});

test("closed stream cannot commit a partial manuscript", async () => {
  const f = fixture();
  const result = await f.service.createStream("n", "c");
  for await (const _chunk of result.stream) break;
  await assert.rejects(result.onDone("partial"), /连接中断/);
  assert.equal(f.calls.filter(c => c === "release").length, 1);
  assert.equal(f.original(), "原正文");
});

test("unresolved story state requires review before regeneration", async () => {
  const f = fixture();
  f.contextPackage.pendingReviewProposalCount = 1;
  await assert.rejects(f.service.createStream("n", "c"), /故事状态/);
  assert.ok(!f.calls.includes("backup"));
  assert.ok(f.calls.includes("release"));
});

test("conflicting production claim never reaches assembly or backup", async () => {
  const f = fixture({ claim: async () => { throw new Error("busy"); } });
  await assert.rejects(f.service.createStream("n", "c"), /busy/);
  assert.deepEqual(f.calls, []);
});


test("persistence failure keeps original draft and releases claim", async () => {
  const f = fixture({ save: async (_novelId, _chapterId, _content, expectedContent) => { assert.equal(expectedContent, "原正文"); throw new Error("save failed"); } });
  const result = await f.service.createStream("n", "c");
  await drain(result.stream);
  await assert.rejects(result.onDone("新正文"), /save failed/);
  assert.equal(f.original(), "原正文");
  assert.equal(f.calls.filter(c => c === "release").length, 1);
});


test("assistant refusal is never saved as regenerated chapter prose", async () => {
  const f = fixture({ writer: { createChapterStream: async () => ({ stream: (async function* () { yield { content: "由于程序代码的局限，我没法办到。" }; })(), onDone: async () => ({ finalContent: "由于程序代码的局限，我没法办到。" }) }) } });
  const result = await f.service.createStream("n", "c");
  await drain(result.stream);
  await assert.rejects(result.onDone("refusal"), error => error.code === "CHAPTER_MODEL_REFUSAL");
  assert.equal(f.original(), "原正文");
  assert.ok(!f.calls.includes("save"));
  assert.equal(f.calls.filter(c => c === "release").length, 1);
});

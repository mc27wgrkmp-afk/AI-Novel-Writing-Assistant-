const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Every test uses an independently created database, never the author's manuscripts.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-factory-test-"));
process.env.DATABASE_URL = `file:${path.join(tempRoot, "acceptance.sqlite3")}`;
process.env.NODE_ENV = "test";
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = tempRoot;
const { prisma } = require("../dist/db/prisma");
const { FactoryEngine } = require("../dist/modules/novel/factory/application/FactoryEngine");
const { PrismaFactoryRepository } = require("../dist/modules/novel/factory/infrastructure/FactoryRepository");
const { applyLocalPatches, commitChapter } = require("../dist/modules/novel/factory/domain/factoryPolicy");
const { factorySetupSchema } = require("../dist/modules/novel/factory/domain/factorySchemas");
const { ensureRuntimeDatabaseReady } = require("../dist/db/runtimeMigrations");
test.before(async () => { await ensureRuntimeDatabaseReady(); });
test.after(async () => { await prisma.$disconnect(); });

const setup = () => ({
  title: "闭环测试样本", constitution: "主角依靠知识行动，无法获得系统。",
  lockedFacts: [{ id: "canon.no_system", text: "陆沉永远不能获得系统。" }],
  negativeCanon: ["禁止属性点与系统奖励"], style: "以行动和对话推进。",
  initialState: { location: "卧室", injury: "无" }, targetWords: 500,
  goals: [1, 2, 3].map(order => ({ title: `第${order}章`, goal: "向安全区前进", mustDo: ["走到城门"], mustNot: ["获得系统"], hook: "有人敲门" })),
  planner: { provider: "test-reviewer", model: "fixture" }, writer: { provider: "test-writer", model: "fixture" },
});
const text = "陆沉走到城门。" + "他沿着石阶向前走去，留意墙上的旧痕。".repeat(32) + "有人敲门。";
const allPassed = () => ({ script: true, canon: true, continuity: true, character: true, information: true, expansion: true, hook: true });
function output(value) { return { output: value, usage: { provider: "fixture", model: "fixture", elapsedMs: 1, inputTokens: null, outputTokens: null, source: "unavailable" } }; }
function models(overrides = {}) {
  const calls = { plan: [], write: [], review: [], patch: [] };
  return {
    calls,
    async plan(input) { calls.plan.push(structuredClone(input)); return output({ title: input.goal.title, scenes: ["离开原地", "走到城门"], mustDo: input.goal.mustDo, mustNot: input.goal.mustNot, hook: input.goal.hook }); },
    async write(input) { calls.write.push(structuredClone(input)); return output(text); },
    async review(input) { calls.review.push(structuredClone(input)); return output({ checks: allPassed(), issues: [], summary: "陆沉到达城门，听到敲门声。", changes: [{ key: "location", before: input.state.location, after: `城门${input.order}`, evidence: "陆沉走到城门。", kind: "operational" }] }); },
    async patch(input) { calls.patch.push(structuredClone(input)); return output({ patches: [{ original: "有人敲门。", replacement: "门外响起两下敲门声。" }] }); },
    compile(input) { return JSON.stringify({ state: input.state, summary: input.previousSummary, script: input.script }); },
    ...overrides,
  };
}
function engine(repository = new PrismaFactoryRepository(), gateway = models()) {
  return { repository, gateway, service: new FactoryEngine(repository, gateway, `${os.hostname()}:${process.pid}:${randomUUID()}`) };
}

test("one chapter commits prose and state together, and hands committed state to chapter two", async () => {
  const { repository, gateway, service } = engine();
  const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  const result = await repository.read(book.id);
  assert.equal(result.chapters[0].status, "completed");
  assert.equal(result.chapters[0].committed, true);
  assert.equal(result.stateVersion, 1);
  assert.equal(result.currentState.location, "城门1");
  assert.equal(result.nextHandoff.order, 2);
  assert.match(result.nextHandoff.prompt, /城门1/);
  assert.equal(gateway.calls.plan.length, 2);
  assert.equal(gateway.calls.plan[1].previousSummary, result.chapters[0].summary);
});

test("three sequential chapters inherit actual state without re-planning prebuilt handoffs", async () => {
  const { repository, gateway, service } = engine();
  const book = await repository.create(setup());
  await service.start(book.id, 3); await service.waitForIdle(book.id);
  const result = await repository.read(book.id);
  assert.equal(result.chapters.length, 3);
  assert.ok(result.chapters.every(c => c.status === "completed" && c.committed));
  assert.equal(result.stateVersion, 3);
  assert.deepEqual(gateway.calls.write.map(c => c.state.location), ["卧室", "城门1", "城门2"]);
  assert.equal(gateway.calls.plan.length, 3);
  assert.equal(result.nextHandoff, null);
});

test("an injected forbidden system reward is repaired locally before any state commit", async () => {
  const gateway = models();
  gateway.write = async () => output(text + "陆沉获得了系统奖励的十点力量。");
  const validReview = gateway.review.bind(gateway);
  gateway.review = async input => input.content.includes("系统奖励") ? output({ checks: { ...allPassed(), canon: false, expansion: false },
    issues: [{ code: "canon", severity: "blocking", description: "无系统设定被破坏", evidence: "陆沉获得了系统奖励的十点力量。", repairInstruction: "删除系统奖励" }], summary: "有冲突", changes: [] }) : validReview(input);
  gateway.patch = async () => output({ patches: [{ original: "陆沉获得了系统奖励的十点力量。", replacement: "" }] });
  const { repository, service } = engine(undefined, gateway);
  const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  const result = await repository.read(book.id);
  assert.equal(result.chapters[0].repairAttempts, 1);
  assert.equal(result.chapters[0].versions[1].text, text);
  assert.equal(result.stateVersion, 1);
  assert.equal(result.chapters[0].reviews.length, 2);
});

test("two failed repairs stop production; manual revision re-audits without resetting budget", async () => {
  const gateway = models(); let manualFixed = false;
  const validReview = gateway.review.bind(gateway);
  gateway.review = async input => manualFixed ? validReview(input) : output({ checks: { ...allPassed(), hook: false },
    issues: [{ code: "hook", severity: "blocking", description: "未完成钩子", evidence: "有人敲门。", repairInstruction: "补充敲门" }], summary: "未通过", changes: [] });
  gateway.patch = async () => output({ patches: [{ original: "陆沉走到城门。", replacement: "陆沉走到城门。" }] });
  const { repository, service } = engine(undefined, gateway);
  const book = await repository.create(setup());
  await service.start(book.id, 3); await service.waitForIdle(book.id);
  let result = await repository.read(book.id);
  assert.equal(result.chapters.length, 1);
  assert.equal(result.chapters[0].status, "blocked");
  assert.equal(result.chapters[0].repairAttempts, 2);
  assert.equal(result.stateVersion, 0);
  await assert.rejects(service.resume(book.id), /先.*修改/);
  await service.editDraft(book.id, text);
  manualFixed = true;
  await service.resume(book.id); await service.waitForIdle(book.id);
  result = await repository.read(book.id);
  assert.equal(result.chapters[0].repairAttempts, 2);
  assert.ok(result.chapters.every(c => c.status === "completed"));
  await assert.rejects(service.editDraft(book.id, text), /未定稿/);
});

test("pause during generation saves the response and resume does not generate prose again", async () => {
  let deliver; let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const gateway = models(); let writes = 0;
  gateway.write = async () => { writes += 1; notify(); return new Promise(resolve => { deliver = () => resolve(output(text)); }); };
  const { repository, service } = engine(undefined, gateway);
  const book = await repository.create(setup());
  await service.start(book.id); await started;
  await service.pause(book.id); deliver(); await service.waitForIdle(book.id);
  let result = await repository.read(book.id);
  assert.equal(result.chapters[0].status, "paused");
  assert.equal(result.chapters[0].phase, "review");
  assert.equal(result.chapters[0].versions.length, 1);
  await service.resume(book.id); await service.waitForIdle(book.id);
  result = await repository.read(book.id);
  assert.equal(writes, 1);
  assert.equal(result.chapters[0].status, "completed");
});

test("failure before commit leaves state untouched; retry only commits once", async () => {
  class InterruptedRepository extends PrismaFactoryRepository {
    broken = false;
    async mutate(id, apply, owner) {
      return super.mutate(id, book => {
        const before = book.stateVersion; apply(book);
        if (!this.broken && book.stateVersion > before) { this.broken = true; throw new Error("simulated commit interruption"); }
      }, owner);
    }
  }
  const { repository, gateway, service } = engine(new InterruptedRepository());
  const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  let result = await repository.read(book.id);
  assert.equal(result.currentState.location, "卧室");
  assert.equal(result.stateVersion, 0);
  assert.equal(result.chapters[0].committed, false);
  assert.equal(result.chapters[0].phase, "commit");
  await service.resume(book.id); await service.waitForIdle(book.id);
  result = await repository.read(book.id);
  assert.equal(result.stateVersion, 1);
  assert.equal(gateway.calls.write.length, 1);
  assert.equal(gateway.calls.review.length, 1);
});

test("failure after commit recovers handoff without duplicating state or re-generating prose", async () => {
  const gateway = models(); const plan = gateway.plan.bind(gateway); let failed = false;
  gateway.plan = async input => { if (input.order === 2 && !failed) { failed = true; throw new Error("simulated network failure"); } return plan(input); };
  const { repository, service } = engine(undefined, gateway);
  const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  let result = await repository.read(book.id);
  assert.equal(result.stateVersion, 1);
  assert.equal(result.chapters[0].phase, "handoff");
  assert.equal(result.chapters[0].status, "failed");
  await service.resume(book.id); await service.waitForIdle(book.id);
  result = await repository.read(book.id);
  assert.equal(result.stateVersion, 1);
  assert.equal(gateway.calls.write.length, 1);
  assert.equal(result.nextHandoff.order, 2);
});

test("repair network failures consume durable reservations across resume", async () => {
  const gateway = models(); let patches = 0;
  gateway.review = async () => output({ checks: { ...allPassed(), hook: false }, issues: [{ code: "hook", severity: "blocking", description: "钩子不完整", evidence: "有人敲门。", repairInstruction: "修复" }], summary: "失败", changes: [] });
  gateway.patch = async () => { patches += 1; throw new Error("network interruption"); };
  const { repository, service } = engine(undefined, gateway);
  const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  for (let i = 0; i < 2; i++) { await service.resume(book.id); await service.waitForIdle(book.id); }
  const result = await repository.read(book.id);
  assert.equal(patches, 2);
  assert.equal(result.chapters[0].repairAttempts, 2);
  assert.equal(result.chapters[0].status, "blocked");
  assert.equal(result.stateVersion, 0);
});

test("a second execution cannot claim the same book while a model is in flight", async () => {
  let deliver; let notify; const entered = new Promise(resolve => { notify = resolve; });
  const gateway = models(); const plan = gateway.plan.bind(gateway);
  gateway.plan = async input => { if (input.order === 1) { notify(); await new Promise(resolve => { deliver = resolve; }); } return plan(input); };
  const first = engine(undefined, gateway); const second = engine(first.repository);
  const book = await first.repository.create(setup());
  await first.service.start(book.id); await entered;
  await assert.rejects(second.service.start(book.id), /仍在执行/);
  deliver(); await first.service.waitForIdle(book.id);
  assert.equal((await first.repository.read(book.id)).stateVersion, 1);
});

test("a dead local worker is projected as paused and can be resumed immediately", async () => {
  const { repository, service } = engine(); const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  await repository.mutate(book.id, saved => { saved.chapters[0].status = "running"; saved.chapters[0].phase = "done"; });
  await prisma.factoryBook.update({ where: { id: book.id }, data: { leaseOwner: `${os.hostname()}:99999999:dead`, leaseUntil: new Date(Date.now() + 300000) } });
  const recovered = await repository.read(book.id);
  assert.equal(recovered.chapters[0].status, "paused");
  assert.equal(recovered.executionActive, undefined);
  await service.resume(book.id); await service.waitForIdle(book.id);
  assert.equal((await repository.read(book.id)).stateVersion, 1);
});

test("unapproved canon, fabricated evidence and wrong before-state cannot be committed", async () => {
  const { repository, service } = engine(); const book = await repository.create(setup());
  await service.start(book.id); await service.waitForIdle(book.id);
  const baseline = await repository.read(book.id);
  for (const change of [
    { key: "canon.no_system", before: null, after: "获得系统", kind: "operational", evidence: "陆沉走到城门。" },
    { key: "ability", before: null, after: "因果重构", kind: "new_canon", evidence: "陆沉走到城门。" },
    { key: "location", before: "卧室", after: "城门", kind: "operational", evidence: "伪造的原文" },
    { key: "location", before: "错误地点", after: "城门", kind: "operational", evidence: "陆沉走到城门。" },
  ]) {
    const copy = structuredClone(baseline); copy.stateVersion = 0; copy.currentState = { ...copy.initialState };
    copy.chapters[0].committed = false; copy.chapters[0].reviews[0].changes = [change];
    assert.throws(() => commitChapter(copy, copy.chapters[0]), /未通过/);
    assert.equal(copy.stateVersion, 0);
  }
});

test("patch anchors reject ambiguity and overlaps, and preserve untouched prose", () => {
  assert.equal(applyLocalPatches("甲乙丙丁", { patches: [{ original: "乙", replacement: "戊" }] }), "甲戊丙丁");
  assert.throws(() => applyLocalPatches("甲乙甲乙", { patches: [{ original: "甲乙", replacement: "丙" }] }), /不唯一/);
  assert.throws(() => applyLocalPatches("甲乙丙丁戊己", { patches: [{ original: "甲乙", replacement: "丙" }, { original: "乙丙", replacement: "丁" }] }), /重叠/);
});

test("invalid setup and locked-state collisions are rejected before creating a project", () => {
  const invalid = setup(); invalid.initialState["canon.no_system"] = "获得系统";
  assert.equal(factorySetupSchema.safeParse(invalid).success, false);
  invalid.initialState = { location: "卧室" }; invalid.targetWords = 0;
  assert.equal(factorySetupSchema.safeParse(invalid).success, false);
});


test("aggregate local patches cannot rewrite most of a chapter", () => {
  assert.throws(() => applyLocalPatches("甲乙丙丁戊己庚辛壬癸", { patches: [
    { original: "甲乙丙丁", replacement: "一" },
    { original: "戊己庚", replacement: "二" },
  ] }), /累计修复范围过大/);
});

test("ownerless interrupted work is recovered as paused", async () => {
  const { repository } = engine(); const book = await repository.create(setup());
  await repository.mutate(book.id, saved => {
    saved.chapters.push({ id: randomUUID(), order: 1, status: "running", phase: "plan" });
  });
  const recovered = await repository.read(book.id);
  assert.equal(recovered.chapters[0].status, "paused");
  assert.ok(!recovered.executionActive);
});


test("connectivity preserves the OpenAI failure instead of the fallback 404", async () => {
  const http = require("node:http");
  const { llmConnectivityService } = require("../dist/llm/connectivity");
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("chat/completions")) {
      res.end(JSON.stringify({ id: "probe", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await llmConnectivityService.testConnection({ provider: "custom_probe", model: "fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1`, authMode: "none", probeMode: "both" });
    assert.equal(result.plain.ok, false);
    assert.match(result.plain.error, /空正文/);
    assert.equal(result.structured.ok, false);
    assert.equal(result.structured.requestProtocol, "openai_compatible");
    assert.doesNotMatch(result.structured.error, /Anthropic request failed/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

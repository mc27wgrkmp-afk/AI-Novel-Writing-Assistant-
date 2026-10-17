// Synthetic review records only. These tests use a fresh temporary database,
// never invoke a model, and never open the original writing database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-contract-test-'));
process.env.DATABASE_URL = 'file:' + path.join(temporary, 'test.db');
process.env.NODE_ENV = 'test';
process.env.AI_NOVEL_RUNTIME = 'desktop';
process.env.AI_NOVEL_BACKGROUND_SERVICES = 'false';
const { prisma } = require('../dist/db/prisma');
const { ensureRuntimeDatabaseReady } = require('../dist/db/runtimeMigrations');
const { AuthoringService } = require('../dist/modules/unification/application/AuthoringService');
const writer = new AuthoringService();

test.before(async () => { await ensureRuntimeDatabaseReady(); });
test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function fixture() {
  const novel = await prisma.novel.create({ data: { title: '纯合成契约测试-' + randomUUID() } });
  await prisma.novelBible.create({ data: { novelId: novel.id, rawContent: '合成测试契约，非真实审稿资料。' } });
  const first = await prisma.chapter.create({ data: { novelId: novel.id, order: 1, title: '第一章', content: '灯是红色。' } });
  const second = await prisma.chapter.create({ data: { novelId: novel.id, order: 2, title: '第二章', content: '他走进门。' } });
  return { novel, first, second };
}

async function addReview(novelId, chapterId, summary, facts = []) {
  const state = await writer.chapter(novelId, chapterId);
  const review = {
    id: randomUUID(), novelId, chapterId, bodyHash: state.chapter.bodyHash,
    contextHash: state.contextHash, decision: 'pass', blocking: [], summary, facts,
    dimensions: Object.fromEntries(['structure', 'character', 'pacing', 'world', 'theme', 'foreshadowing', 'style', 'text'].map(key => [key, '合成测试记录，不代表实际语义审读。'])),
    createdAt: new Date().toISOString(),
  };
  await writer.storeReview(review);
  return review;
}

test('editing a canonical character invalidates the prior review', async () => {
  const { novel, first } = await fixture();
  const character = await prisma.character.create({ data: { novelId: novel.id, name: '测试甲', role: '主角', prohibitionsJson: '["不能识字"]' } });
  const review = await addReview(novel.id, first.id, '合成摘要');
  await prisma.character.update({ where: { id: character.id }, data: { prohibitionsJson: '["不能看见红色"]' } });
  const state = await writer.chapter(novel.id, first.id);
  assert.equal(state.reviews.find(row => row.id === review.id).current, false,
    '人物的正式硬限制变化后，不能批准旧上下文的审读');
});

test('editing the canonical book contract invalidates the prior review', async () => {
  const { novel, first } = await fixture();
  await prisma.bookContract.create({ data: {
    novelId: novel.id, readingPromise: '合成承诺', protagonistFantasy: '合成主角目标',
    coreSellingPoint: '合成卖点', chapter3Payoff: '三章', chapter10Payoff: '十章', chapter30Payoff: '三十章',
    escalationLadder: '合成升级线', relationshipMainline: '合成关系线', absoluteRedLinesJson: '["禁止复活"]',
  } });
  const review = await addReview(novel.id, first.id, '合成摘要');
  await prisma.bookContract.update({ where: { novelId: novel.id }, data: { absoluteRedLinesJson: '["禁止穿越"]' } });
  const state = await writer.chapter(novel.id, first.id);
  assert.equal(state.reviews.find(row => row.id === review.id).current, false,
    '正式契约变化后，不能批准旧上下文的审读');
});

test('approving a new review binds its corrected summary and facts even when body is unchanged', async () => {
  const { novel, first } = await fixture();
  const initial = await addReview(novel.id, first.id, '旧摘要', [{ type: 'fact', text: '测试断言', evidence: '灯是红色' }]);
  await writer.approve(novel.id, first.id, initial.bodyHash, initial.id);
  const corrected = await addReview(novel.id, first.id, '已纠正摘要', [{ type: 'testimony', text: '测试断言', evidence: '灯是红色' }]);
  const approval = await writer.approve(novel.id, first.id, corrected.bodyHash, corrected.id);
  assert.equal(approval.reviewId, corrected.id, '作者批准的应是所选审读，而非旧审读');
  assert.equal(approval.summary, '已纠正摘要');
  assert.equal(approval.facts[0].type, 'testimony');
  assert.equal((await writer.approve(novel.id, first.id, corrected.bodyHash, corrected.id)).id, approval.id,
    '重复批准同一审读仍应幂等');
});

test('a superseded approval is preserved as history but its obsolete facts are excluded from later context', async () => {
  const { novel, first, second } = await fixture();
  const oldFact = { type: 'fact', text: '灯是红色', evidence: '灯是红色' };
  const initial = await addReview(novel.id, first.id, '红灯摘要', [oldFact]);
  const firstApproval = await writer.approve(novel.id, first.id, initial.bodyHash, initial.id);
  await writer.save(novel.id, first.id, '灯是蓝色。', initial.bodyHash);
  const corrected = await addReview(novel.id, first.id, '蓝灯摘要', [{ type: 'fact', text: '灯是蓝色', evidence: '灯是蓝色' }]);
  await writer.approve(novel.id, first.id, corrected.bodyHash, corrected.id);
  const pack = await writer.context(novel.id, second.id);
  assert.equal(pack.context.facts.some(row => row.text === oldFact.text), false,
    '后续写作的有效账本不能同时保留被新定稿推翻的旧事实');
  assert.equal(pack.context.facts.some(row => row.text === '灯是蓝色'), true);
  const previous = await prisma.novelSnapshot.findMany({ where: { novelId: novel.id, triggerType: 'unified_final' } });
  assert.equal(previous.some(row => JSON.parse(row.snapshotData).id === firstApproval.id), true,
    '历史批准证据应保留，不能为了清理有效上下文而删掉');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-writing-test-'));
process.env.DATABASE_URL = 'file:' + path.join(temporary, 'test.db');
process.env.NODE_ENV = 'test';
process.env.AI_NOVEL_RUNTIME = 'desktop';
process.env.AI_NOVEL_BACKGROUND_SERVICES = 'false';
const { prisma } = require('../dist/db/prisma');
const { ensureRuntimeDatabaseReady } = require('../dist/db/runtimeMigrations');
const { ImportService, hash } = require('../dist/modules/unification/application/ImportService');
const { AuthoringService } = require('../dist/modules/unification/application/AuthoringService');
const { generateDraft } = require('../dist/modules/unification/application/ModelService');

const drafts = Array.from({ length: 7 }, (_, i) => ({ key: `draft-${i+1}`, version: i+1,
  content: `# 夜班\n\n第${i+1}稿正文。`, raw: `第${i+1}稿正文。\n## 草稿候选事实\n候选`,
  candidateFacts: '候选', hash: hash('source-'+i), bodyHash: hash(`# 夜班\n\n第${i+1}稿正文。`), han: 6 }));
let bundle = { schema: 1, warnings: [], books: [{ key: 'scriptor:test', source: 'scriptor', kind: 'novel', title: '合成测试书', hash: hash('book-1'), metadata: { originalId: 'test' },
  chapters: [{ key: 'v1c1', volume: 1, order: 1, title: '夜班', content: drafts.at(-1).content, drafts }, { key: 'v2c1', volume: 2, order: 1, title: '新卷', content: '', drafts: [] }],
  artifacts: [{ path: '作品契约/契约.md', kind: 'contract', content: '目标2000汉字', hash: hash('contract') }] }] };
const importer = new ImportService(async () => bundle);
const writer = new AuthoringService();
let imported, chapterId;

test.before(async () => { await ensureRuntimeDatabaseReady(); });
test.after(async () => { await prisma.$disconnect(); fs.rmSync(temporary, { recursive: true, force: true }); });

test('import preserves seven drafts and volume identities without approving anything', async () => {
  imported = await importer.importBook('scriptor:test', hash('book-1'));
  const state = await writer.novel(imported.novelId);
  assert.equal(state.chapters.length, 2);
  assert.deepEqual(state.chapters.map(c => c.order), [1,2]);
  chapterId = state.chapters[0].id;
  const chapter = await writer.chapter(imported.novelId, chapterId);
  assert.equal(chapter.versions.length, 7);
  assert.equal(chapter.chapter.content, drafts.at(-1).content);
  assert.equal(chapter.chapter.content.includes('候选'), false);
  assert.equal(chapter.reviews.length, 0);
  assert.equal(chapter.approvals.length, 0);
  assert.equal((await writer.policy(imported.novelId)).mode, 'manual');
});

test('identical import is idempotent and changed source is rejected', async () => {
  assert.equal((await importer.importBook('scriptor:test', hash('book-1'))).id, imported.id);
  assert.equal(await prisma.novel.count(), 1);
  await assert.rejects(importer.importBook('scriptor:test', hash('other')), /来源已变化/);
  const original = bundle.books[0].hash;
  bundle.books[0].hash = hash('book-2');
  await assert.rejects(importer.importBook('scriptor:test', hash('book-2')), /已有导入版本/);
  bundle.books[0].hash = original;
});

test('reference chapters become a knowledge document, not an authored novel', async () => {
  bundle.books.push({ key: 'webfictionlab:r', source: 'webfictionlab', kind: 'reference', title: '参考书', hash: hash('reference'), metadata: { id: 'reference-uuid' },
    chapters: [{ key: 'reference-chapter', volume:1, order:1, title:'参考第一章', content:'参考😀文字', drafts:[] }],
    artifacts: [{ path:'opening-uuid.json', kind:'opening', content:'{"original_id":"opening-uuid"}', hash:hash('opening') }] });
  const entry = await importer.importBook('webfictionlab:r', hash('reference'));
  assert.ok(entry.documentId); assert.equal(entry.novelId, undefined);
  assert.equal(await prisma.novel.count(), 1);
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: entry.documentId }, include: { activeVersion: { include: { chapters: true } } } });
  const c = doc.activeVersion.chapters[0];
  assert.equal(doc.activeVersion.content.slice(c.startOffset,c.endOffset).includes('参考😀文字'), true);
  assert.ok((await importer.artifacts(entry.id)).some(a=>a.title==='opening-uuid.json'));
});

test('manual mode blocks model generation before a model is called; policies use versions', async () => {
  const state = await writer.chapter(imported.novelId, chapterId);
  await assert.rejects(generateDraft(imported.novelId, chapterId, state.chapter.bodyHash, 1), /启用 AI 起草/);
  const p = await writer.setPolicy(imported.novelId, 'ai', 1);
  assert.equal(p.version,2);
  await assert.rejects(writer.setPolicy(imported.novelId, 'manual', 1), /模式已变化/);
  await writer.setPolicy(imported.novelId,'manual',2);
});

test('concurrent edits are rejected and an AI result is retained as a branch', async () => {
  const old = await writer.chapter(imported.novelId,chapterId);
  const saved = await writer.save(imported.novelId,chapterId,'作者新稿。',old.chapter.bodyHash);
  await assert.rejects(writer.save(imported.novelId,chapterId,'过期编辑。',old.chapter.bodyHash), /正文已被修改/);
  const branch = await writer.save(imported.novelId,chapterId,'迟到的AI稿。',old.chapter.bodyHash,'ai',1);
  assert.equal(branch.conflict,true); assert.ok(branch.branchVersionId);
  assert.equal((await writer.chapter(imported.novelId,chapterId)).chapter.content,saved.content);
});

test('approval binds review, body and context, is idempotent, and publishes only facts/rules', async () => {
  let state = await writer.chapter(imported.novelId,chapterId);
  await assert.rejects(writer.approve(imported.novelId,chapterId,state.chapter.bodyHash,'missing'), /通过审读/);
  const review = { id:'test-review', novelId:imported.novelId, chapterId, bodyHash:state.chapter.bodyHash, contextHash:state.contextHash,
    decision:'pass',blocking:[],summary:'作者写了新稿。',facts:[{type:'fact',text:'已发生',evidence:'作者新稿'},{type:'testimony',text:'人物说法',evidence:'作者新稿'}],
    dimensions:Object.fromEntries(['structure','character','pacing','world','theme','foreshadowing','style','text'].map(k=>[k,'合成测试证据，不是真实审稿'])),createdAt:new Date().toISOString() };
  await writer.storeReview(review);
  const approval = await writer.approve(imported.novelId,chapterId,state.chapter.bodyHash,review.id);
  assert.equal((await writer.chapter(imported.novelId,chapterId)).approvals[0].current,true);
  assert.equal((await writer.approve(imported.novelId,chapterId,state.chapter.bodyHash,review.id)).id,approval.id);
  assert.equal(await prisma.novelFactEntry.count({where:{novelId:imported.novelId}}),1);
  await prisma.novelBible.update({where:{novelId:imported.novelId},data:{rawContent:'契约发生变化'}});
  state = await writer.chapter(imported.novelId,chapterId);
  assert.equal(state.reviews[0].current,false);
  assert.equal(state.approvals[0].current,false);
  await assert.rejects(writer.approve(imported.novelId,chapterId,state.chapter.bodyHash,review.id), /通过审读/);
});

test('interactive worker leases fresh tasks while leaving imported and manually paused tasks untouched', async () => {
  const { DirectorTaskQueue } = require('../dist/workers/DirectorTaskQueue');
  const cutoff = new Date('2026-10-17T00:00:00Z');
  const old = await prisma.novelWorkflowTask.create({ data: { title:'旧导入任务', lane:'auto_director', status:'running', createdAt:new Date('2026-10-01T00:00:00Z') } });
  const fresh = await prisma.novelWorkflowTask.create({ data: { title:'用户新建任务', lane:'auto_director', status:'running', createdAt:new Date('2026-10-17T01:00:00Z') } });
  const paused = await prisma.novelWorkflowTask.create({ data: { title:'作者暂停任务', lane:'auto_director', status:'running', pendingManualRecovery:true, createdAt:new Date('2026-10-17T02:00:00Z') } });
  for (const task of [old,fresh,paused]) await prisma.directorRunCommand.create({ data: { taskId:task.id, commandType:'generate_candidates', idempotencyKey:task.id, runAfter:new Date('2026-10-01T00:00:00Z') } });
  const queue = new DirectorTaskQueue({ taskCreatedAfter:cutoff, executionSlots:1, workerId:'synthetic-worker' });
  const leased = await queue.leaseNext('slot');
  assert.equal(leased.command.taskId,fresh.id);
  assert.equal((await prisma.directorRunCommand.findFirst({where:{taskId:old.id}})).status,'queued');
  assert.equal((await prisma.directorRunCommand.findFirst({where:{taskId:paused.id}})).status,'queued');
  assert.equal((await prisma.novelWorkflowTask.findUnique({where:{id:paused.id}})).pendingManualRecovery,true);
  assert.equal(await queue.leaseNext('slot2'),null);
});

test('interactive stale scan does not requeue pre-merge jobs', async () => {
  const { DirectorCommandService } = require('../dist/services/novel/director/commands/DirectorCommandService');
  const task = await prisma.novelWorkflowTask.create({ data:{title:'合成旧租约',lane:'auto_director',status:'running',createdAt:new Date('2026-10-01T00:00:00Z')} });
  const command = await prisma.directorRunCommand.create({data:{taskId:task.id,commandType:'generate_candidates',idempotencyKey:task.id,status:'running',leaseExpiresAt:new Date('2026-10-02T00:00:00Z')}});
  const count = await new DirectorCommandService().recoverStaleLeases(new Date(),{taskCreatedAfter:new Date('2026-10-17T00:00:00Z')});
  assert.equal(count,0);
  assert.equal((await prisma.directorRunCommand.findUnique({where:{id:command.id}})).status,'running');
});

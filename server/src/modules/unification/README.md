# 本地创作书房

统一入口为 `/unified`，API 为 `/api/unification`。此模块把本地 Scriptor 文件和 WebFictionLab 研究库导入现有 Biz 作品/知识文档体系，不启动旧平台服务。

## 归属

- `domain/types.ts`：来源快照与作品策略合同。
- `infrastructure/source_scan.py`：只读文件与 SQLite 扫描，不调用源平台运行时；`sourceScanner.ts` 提供经校验的 Node 入口。
- `application/ImportService.ts`：导入预览、身份映射、事务写入及重复导入校验。
- `application/AuthoringService.ts`：正文版本、作品策略、审读与作者批准。
- `application/ModelService.ts`：显式单章起草与八维审读，复用 Prompt Runner 和模型路由，不调用旧自动导演回灌。
- `application/ResearchService.ts`：按字符区间研究开篇、多书证据模式与批准后场景卡。
- `http/routes.ts`：本机请求与输入校验。

## 数据与恢复

创作作品使用 `Novel/Chapter`；参考资料使用 `KnowledgeDocument/KnowledgeDocumentVersion/DocumentChapter`。来源原记录、UUID、源路径、原哈希、候选事实及旧审核以工件保留，不伪装成新批准。每个源的导入映射由 AppSetting 中 `unification.import.v1:` 记录，事务内预留唯一键；相同内容重导入返回原批次，已变化来源拒绝覆盖。

创作稿件使用既有 NovelSnapshot。`unified_import/unified_draft/unified_ai/unified_conflict/unified_final` 是独立 triggerType，标签不属于普通章节最近40版裁剪前缀，也不属于自动快照清理集合。源原稿与批准稿作为保护版本保留。整本普通快照列表会排除这些专用工件，防止被当成整书恢复包。

策略保存于 `unification.policy.v1:{novelId}`，不重用原创/续写 `writingMode`。默认手写；启用 AI 不恢复旧任务。当前只在统一书房的显式单章入口执行 AI 起草，原自动导演和批量正文的全局禁止继续保留，避免绕过作者批准路径。

审读和批准分别保存。批准绑定正文、上下文、所选审读、摘要和事实哈希。当前生效批准由 `unification.active-approval.v1:{chapterId}` 指向；重复批准同一审读幂等。新批准保留原 receipt 和历史快照，把旧的模块事实标为 `superseded`，新事实入账与批准同事务。正式事实消费者排除 superseded；人物证言、推测与计划不发布为正式事实。

上下文包含作品契约、Bible、正式人物、书级世界与来源世界、卷章计划、有效故事线、前文、当前以前的有效批准和账本。当前正文单独绑定哈希，后章草稿不反向污染前章审读。改设定、前文或当前正文后，旧审读与批准显示过期。

模型运行中正文或作品策略变化，生成结果另存冲突草稿，不覆盖当前正文。手动保存采用正文哈希比较。任何生成结果先进入草稿，不自动批准、不触发事实回灌。

## 研究

开篇采用 WebFictionLab 的 Unicode 字母/数字字符计数，区别于小说汉字数。所选范围不足时给出具体错误。跨书模式每条引用必须逐字匹配所选来源，至少两部独立参考书；模式经作者批准且来源版本未变，才可生成通用场景卡。整书研究复用主平台拆书入口，不把有限开篇样本称为全书结论。

## 配置与测试

来源路径只来自环境变量 `UNIFICATION_SCRIPTOR_LIBRARY`、`UNIFICATION_WFL_DATABASE`，不接受浏览器传来的任意文件路径。所有 API 限制本机调用，私有正文不进入错误日志。模型任务只在点击后发出；导入和测试不会调用模型。

执行服务器构建后，可用官方 Node 运行 `node --test tests/unification.test.js tests/unification_contract.test.js`（server目录）；Python 扫描测试为 `python3 -m unittest discover -s server/tests -p unification_scan_test.py`。测试均用合成内容和临时数据库。启动器的 `AI_NOVEL_BACKGROUND_SERVICES=false` 停止全量历史后台恢复，同时启动仅领取本次整合之后新建任务的导演执行器。安装基准时间持久化；新用户任务正常执行，旧任务与作者暂停任务保持原状态。模型配置与手动任务继续可用。

书仓原文件的 GPL-3.0-only 上游归属保留于原来源包；本模块使用显式格式适配，不把旧 DSH 的审核、Git 记录转换为 Codex 或本平台批准。

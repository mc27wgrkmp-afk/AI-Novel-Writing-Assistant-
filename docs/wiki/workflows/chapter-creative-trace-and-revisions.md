# 章节创作链路、提示词与版本恢复

## 背景

章节编辑需要让作者判断当前正文依据了哪些上游内容：全书方向与世界设定、卷内节奏、本章分纲、正文小剧本和正文写作提示词。只展示最终正文或分散的任务单，无法定位问题来自哪一层，也让重生成后的结果难以比较和恢复。

## 决策

创作链路面板读取现有规划资产，并从 PromptAsset 与当前上下文组装提示词预览。章节分纲、小剧本和正文各自拥有独立版本记录与恢复动作。恢复只作用于选定阶段，并沿用章节更新入口同步派生资产。

## 当前规则

- 展示顺序固定为：全书发展走向与逐章大纲、当前卷节奏板、本章分纲、正文小剧本、正文写作提示词。
- 提示词预览使用注册的 PromptAsset 与当前已保存资料组装；小剧本、卷节奏板和正文预览同时展示 prompt id、版本、角色消息和上下文块。
- 打开提示词面板是只读操作，不应触发 LLM 生成或保存世界切片。世界切片过期时预览现存切片并标明待刷新状态。
- 一次性传给某次生成调用、但未持久化的临时要求无法从旧正文反推。提示词预览应说明它基于当前资料，不能冒充历史请求的逐字记录。
- 重生成前按 `chapter_plan`、`execution_contract` 或 `prose` 保存当前资产。分纲和小剧本重生成要传入明确 guidance，确保跳过就地复用。
- 版本保存在现有 `NovelSnapshot` 中，以版本前缀和负载中的章节 ID、作用域识别；不为章节编辑再引入平行版本表。
- 回滚某阶段前先自动保存当前版本，便于撤销回滚。正文恢复还要走 `updateChapter`，以同步章节索引、卷工作区和其他既有副作用。
- 分纲恢复要恢复 StoryPlan、场景和对应章节目标字段；小剧本恢复任务单、场景卡及执行参数；正文恢复正文和原章节状态。其他阶段资产不应被覆盖。
- 创作链路与版本列表按当前章节惰性加载。重新生成或恢复后必须刷新链路和版本查询。

## 示例

- 推荐：作者重新生成小剧本前保存合同版本；恢复时先保存当前合同，再还原任务单和场景卡。
- 不推荐：仅清空正文后重写，导致旧稿无法恢复；或直接用 Prisma 恢复正文，却不刷新章节索引。

## 失败模式

- 已改资料但预览仍显示旧提示词：检查创作链路查询是否在对应生成结束后失效。
- 点击重生成却保留旧任务单或场景卡：检查请求是否带 guidance，以及合同服务是否复用了旧资产。
- 恢复后正文与搜索或卷工作区不一致：确认恢复入口调用章节 `updateChapter` 并等待其同步完成。
- 旧项目缺少卷规划或分纲：对应提示词显示不可用状态，不能伪造上游资产。

## 相关模块

- `server/src/services/novel/production/prompts/ChapterCreativeTraceService.ts`
- `server/src/services/novel/production/revisions/ChapterCreativeRevisionService.ts`
- `server/src/modules/novel/production/http/novelChapterRoutes.ts`
- `client/src/pages/novels/components/chapterInsights/ChapterCreativeTracePanel.tsx`
- `client/src/pages/novels/hooks/useChapterExecutionActions.ts`

## 来源文档

- 来源文档标题：`章节生产链路`，[`chapter-production-chain.md`](./chapter-production-chain.md)

# 冲突分析与选案修复

`DirectorConflictRecoveryService` 属于自动导演的人工恢复边界。小说源页面提供入口；运行记录仅负责查看状态和返回源页面。

分析读取任务失败证据、保存的大纲、宏观规划、书级约定、卷路线和当前章附近资料。注册的结构化提示词输出日常语言的冲突解释、主线优先级、2–3 个修改方案及推荐项。分析只把方案存入任务 seed，不改小说内容、不恢复生产。接口故障必须按实际故障说明，不能虚构剧情矛盾。

用户提交保存的 planId/optionId。入队前和执行前均校验小说指纹；入队前还校验失败指纹与人工恢复状态。旧方案、未知选项、重复应用和期间修改的内容均拒绝执行。方案执行仍使用既有导演命令 Worker；模型不能直接批准自身方案。

创作修复先保存小说快照。当前支持单章任务单/场景卡刷新，以及故事宏观规划、书级约定自身失败时的步骤完善。单章修复显式要求刷新合同，不复用冲突合同；不改现有正文。所有创作修复完成后进入 `step_review_required`，用户检查后显式继续。接口重试复用既有重试路径，不触碰小说内容。

前端状态与弹窗由 `client/src/pages/novels/autoDirector/recovery/` 所有；协议在 `shared/types/directorConflictRecovery.ts`；提示词在 `server/src/prompting/prompts/director/conflictRecovery.prompts.ts`。复用的步骤、合同生成器仍负责质量门槛、保存和后续事实同步。

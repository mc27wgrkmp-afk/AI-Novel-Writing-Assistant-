# ChatGPT 方案模型接入边界

## 背景

本地创作工作台需要能使用用户已有的 ChatGPT 方案模型，同时避免把浏览器 Cookie、ChatGPT 网页内部请求或登录令牌伪装成 API Key。模型仍要进入项目现有的统一 LLM 路由，才能被默认模型、任务级路由和章节生产共同选择。

## 决策

- 账号连接使用 OpenAI 官方 Sign in with ChatGPT DevKit，并走明确的 OAuth / 方案额度授权流程。不得读取浏览器 Cookie、注入网页会话或调用 ChatGPT 网页内部接口。
- 官方 DevKit 仅作为可选、本机运行依赖，由启动脚本按固定 Git 提交准备；不同步进仓库，也不嵌入发布构件。使用前应重新核对官方版本与许可。
- OAuth 凭据由 DevKit 加密存于应用数据目录；加密主密钥单独存于 macOS 钥匙串。凭据不能进入普通厂商 API Key 表、日志、诊断响应或前端状态。
- 只有本机回环服务可调用临时 Chat Completions 兼容桥。桥接层把纯文本对话转换为官方 SDK 的 Responses 调用，并启用 `store:false`；外部地址、其他消息角色和工具调用均不得通过此桥。
- ChatGPT 方案能力限定为文本生成。图像生成、Embedding、工具调用、温度、最大输出 token 和 OpenAI 兼容扩展字段不属于该连接合同；知识库向量必须使用独立 Embedding 服务。
- 账号断开时先移除此机凭据并清空模型缓存。若 OpenAI 端撤销授权未获确认，仍完成本机断开并提示用户从 ChatGPT 设置检查授权。
- 官方 DevKit 当前为非商业许可。任何商业场景或分发前必须先确认取得适用授权；不得将这个可选连接描述为商业使用已获许可。

## 当前运行合同

1. 设置页发起官方登录，用户在系统浏览器完成账号登录和额度授权。
2. 服务端按账号实际返回的模型目录填充模型候选；未连接或未授予方案额度时，厂商不满足可运行条件。
3. 统一 LLM 工厂通过回环地址和进程随机密钥访问本地桥。该密钥只存在于服务端进程内，不复用账号访问令牌。
4. 桥接层保留 user / assistant 历史，并把 system / developer 内容合并到 Responses `instructions`；成功必须等 SDK 收到完整 Responses 完成事件。
5. 结构化输出使用 Prompt JSON 合同，不能通过工具调用或本地桥伪造 `response_format` 能力。

## 失败边界

- OAuth 组件不可用、Node.js 版本过低或非 macOS 时，只禁用此提供方，不影响其他模型。
- 账号未授权额度时不列出可用模型，也不向 Responses API 发送生成请求。
- 请求中的模型不属于当前账号目录时，以模型不可用错误结束。
- 网络在完整 Responses 结束事件前中断时，不能向统一 LLM 客户端返回成功终止帧；上游错误须保留为失败。
- 官方 SDK 反馈本机凭据已清理但远程撤销失败时，UI 应明确区分本机断开与远程授权状态。

## 相关模块

- `server/src/platform/llm/chatgptPlan/`
- `server/src/routes/chatgptPlanSettings.ts`
- `server/src/llm/factory.ts`
- `client/src/pages/settings/components/ChatGPTPlanConnection.tsx`
- `scripts/setup-chatgpt-sdk.cjs`

## 来源

- [OpenAI Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)
- [Sign in with ChatGPT 预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

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

1. 快速配置弹窗与模型设置页共用账号连接组件，用户在系统浏览器完成账号登录和额度授权。快速配置首屏直接显示此入口，避免被仅展示推荐厂商的列表隐藏。
2. 服务端按账号实际返回的模型目录填充模型候选，并单独标识用户指定的手动配置型号；未连接或未授予方案额度时，厂商不满足可运行条件。型号权限以实际推理结果为准。
3. 统一 LLM 工厂通过回环地址和进程随机密钥访问本地桥。该密钥只存在于服务端进程内，不复用账号访问令牌。
4. 桥接层保留 user / assistant 历史，并把 system / developer 内容合并到 Responses `instructions`；成功必须等 SDK 收到完整 Responses 完成事件。
5. 结构化输出使用 Prompt JSON 合同，不能通过工具调用或本地桥伪造 `response_format` 能力。
6. 登录与设为创作模型是两个动作。快速配置通过普通文本与结构化探测后，才保存默认模型并配置所有核心任务路由；单纯登录不替换正在使用的创作模型。就绪检查必须包含方案提供方，并依据真实授权状态判断，不能仅依据普通厂商表中的配置。
7. 快速配置不接受方案提供方的 API Key 或用户指定网关地址；只使用服务端生成的回环桥地址，型号必须在上游目录或明确的手动配置范围内，并通过实际请求检测。
8. SDK 网络请求优先使用环境变量中的 HTTP/HTTPS 代理；未配置时，macOS 读取系统 HTTP/HTTPS 代理。Node 原生 `fetch` 不自动采用 macOS 系统代理，因此浏览器能登录不代表 SDK 可以读取 OAuth discovery。代理通过异步调用上下文限定于 SDK 对 `auth.openai.com` 和 `api.openai.com` 的请求，其他厂商及回环桥保持各自的连接方式。系统代理变更后需重启后端。

## 失败边界

- OAuth 组件不可用、Node.js 版本过低或非 macOS 时，只禁用此提供方，不影响其他模型。
- 账号未授权额度时不列出可用模型，也不向 Responses API 发送生成请求。
- 请求中的模型不属于当前账号目录时，以模型不可用错误结束。
- 网络在完整 Responses 结束事件前中断时，不能向统一 LLM 客户端返回成功终止帧；上游错误须保留为失败。
- 官方 SDK 反馈本机凭据已清理但远程撤销失败时，UI 应明确区分本机断开与远程授权状态。
- SDK 的通用“policy or permission restriction”提示只是未识别 HTTP 403 的安全摘要，不能据此确定地区或账号权限问题。先检查账号是否实际连接，以及失败阶段；OAuth discovery 返回 403 HTML 时，登录尚未开始。应比较 Node 的实际网络路径与浏览器使用的现有代理，不得把网络拒绝归因于额度用尽。
- 模型桥保留 SDK 返回的状态码、错误码、参数和请求 ID；流已打开时，在 SSE 错误事件内携带上游状态。诊断不能输出授权头、令牌、加密凭据或小说正文。

## 本地开发服务更新

本地启动器使用 `ts-node-dev --exit-child`。Node 子进程必须随监控进程退出；否则旧后端可能继续占用端口，使更新后的服务启动失败，而页面健康探测仍命中旧服务。排查功能更新未生效时，应核对监听端口的进程与当前启动日志，不能只检查 HTTP 200。

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
## 模型目录与思考强度的边界

- 上游目录与实际推理权限可能不同步：目录缺少某型号不能单独证明它不可调用。排查时可对用户明确指定的型号发一次最小文本请求，并等到 `response.completed`；不能用另一型号成功替代该型号验证。
- 用户指定的 `gpt-6.1-sol`、`gpt-6-luna` 作为手动配置选项加入列表，使用 `manuallyAdded` 区分上游目录。手动配置不是账号权限声明；实际推理由官方服务校验，权限错误如实返回，不自动切换模型或付费 API。
- ChatGPT 请求支持 `low / medium / high / xhigh / max`。Sol 默认 `medium`，Luna 默认 `max`；设置页切换型号时保存对应默认值。同一厂商的任务路由选择另一型号时使用该型号默认值，避免把 Sol 的中等强度套到 Luna；请求显式指定强度时优先使用请求值。
- 本地桥接校验 `reasoning_effort`，服务层传给 SDK 请求上下文。SDK 文本 helper 未暴露该参数时，适配层只在当前 SDK 调用的 `POST https://api.openai.com/v1/responses` 加入 `reasoning: { effort }`，保留 SDK 的凭据处理、流解析、`store: false` 和 `stream: true`。上下文必须隔离并发强度，不能影响其他厂商或本地请求。
- 思考强度控制推理预算，不保证返回或展示内部思考内容。

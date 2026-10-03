import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

const execFileAsync = promisify(execFile);
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
const requestContext = new AsyncLocalStorage<{ dispatcher?: Dispatcher; reasoningEffort?: ReasoningEffort }>();
let networkSetup: Promise<Dispatcher | undefined> | undefined;

function proxyAddress(settings: Map<string, string>, prefix: string): string | undefined {
  if (settings.get(`${prefix}Enable`) !== "1") return undefined;
  const host = settings.get(`${prefix}Proxy`);
  const port = Number(settings.get(`${prefix}Port`));
  if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("系统代理地址无效，请检查 macOS 网络代理设置。");
  }
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

async function configureNetwork(): Promise<Dispatcher | undefined> {
  let httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
  let httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const allProxy = process.env.all_proxy || process.env.ALL_PROXY;
  httpProxy ||= allProxy;
  httpsProxy ||= allProxy || httpProxy;

  if (!httpProxy && !httpsProxy && process.platform === "darwin") {
    const { stdout } = await execFileAsync("scutil", ["--proxy"], { timeout: 2_000 });
    const settings = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
      if (match) settings.set(match[1]!, match[2]!);
    }
    httpProxy = proxyAddress(settings, "HTTP");
    httpsProxy = proxyAddress(settings, "HTTPS");
  }
  for (const address of [httpProxy, httpsProxy].filter(Boolean)) {
    const url = new URL(address!);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("ChatGPT 连接需要 HTTP 或 HTTPS 代理，请检查代理配置。");
    }
  }

  const dispatcher = httpProxy || httpsProxy ? new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: process.env.no_proxy || process.env.NO_PROXY,
  }) : undefined;
  const nativeFetch = globalThis.fetch;
  // The DevKit does not accept a fetch hook. Async context keeps this dispatcher
  // scoped to SDK calls; other providers and loopback requests retain their fetch.
  globalThis.fetch = (input, init) => {
    const context = requestContext.getStore();
    if (!context) return nativeFetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol === "https:"
      && ["auth.openai.com", "api.openai.com"].includes(url.hostname)) {
      let requestInit = init;
      // The DevKit text helper omits reasoning options. Add the supported public
      // Responses field at the SDK boundary without editing vendored SDK files.
      if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses"
        && init?.method === "POST" && typeof init.body === "string" && context.reasoningEffort) {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        requestInit = { ...init, body: JSON.stringify({ ...body, reasoning: { effort: context.reasoningEffort } }) };
      }
      return context.dispatcher
        ? nativeFetch(input, { ...requestInit, dispatcher: context.dispatcher } as RequestInit & { dispatcher: Dispatcher })
        : nativeFetch(input, requestInit);
    }
    return nativeFetch(input, init);
  };
  return dispatcher;
}

export async function withChatGPTNetwork<T>(operation: () => Promise<T>, reasoningEffort?: ReasoningEffort): Promise<T> {
  networkSetup ??= configureNetwork().catch((error: unknown) => {
    networkSetup = undefined;
    throw error;
  });
  const dispatcher = await networkSetup;
  return requestContext.run({ dispatcher, reasoningEffort }, operation);
}

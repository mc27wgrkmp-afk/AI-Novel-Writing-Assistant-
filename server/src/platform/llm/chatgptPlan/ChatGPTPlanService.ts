import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAppDataRoot, resolveWorkspaceRoot } from "../../../runtime/appPaths";
import { macOSCredentialEncryption } from "./macOSCredentialEncryption";
import { withChatGPTNetwork } from "./chatGPTNetwork";

export interface ChatGPTPlanSession {
  status: "disconnected" | "connecting" | "connected" | "reauth_required";
  sharing: boolean;
  profileId?: string;
  profileLabel?: string;
  identity?: { name?: string; email?: string };
  error?: { code: string; message: string; retryable: boolean };
}

export interface ChatGPTPlanModel {
  slug: string;
  displayName: string;
  manuallyAdded?: boolean;
}

interface ChatGPTPlanClient {
  signIn(options?: { reconsent?: boolean }): Promise<ChatGPTPlanSession>;
  getSession(): Promise<ChatGPTPlanSession>;
  listModels(options?: { signal?: AbortSignal }): Promise<ChatGPTPlanModel[]>;
  disconnect(): Promise<void>;
  streamResponse(options: {
    model: string;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
    input: Array<{ role: "user" | "assistant"; content: string }>;
    instructions?: string;
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
  }): Promise<{ text: string }>;
}

interface ChatGPTPlanSdk {
  createChatGPT(config: {
    appName: string;
    appId: string;
    redirectPort: number;
    storageDir: string;
    sendHostId: boolean;
    credentialEncryption: typeof macOSCredentialEncryption;
    openBrowser: (url: string) => Promise<void>;
  }): ChatGPTPlanClient;
}

interface ChatGPTPlanAvailability {
  available: boolean;
  message: string | null;
}

const MIN_NODE_VERSION = [22, 12, 0] as const;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const bridgeApiKey = randomBytes(32).toString("hex");
let clientPromise: Promise<ChatGPTPlanClient> | undefined;
let availableModels: ChatGPTPlanModel[] = [];
let availableModelsFetchedAt = 0;

// Explicit user-selected models can remain callable while the upstream catalog lags.
// These are configuration choices, not a claim of entitlement; inference still
// passes through the official SDK and reports upstream permission errors.
function addConfiguredModels(models: ChatGPTPlanModel[]): ChatGPTPlanModel[] {
  const configured = [
    { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", manuallyAdded: true },
    { slug: "gpt-6-luna", displayName: "GPT-6 Luna", manuallyAdded: true },
  ];
  return [...configured.filter((item) => !models.some((model) => model.slug === item.slug)), ...models];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function compareNodeVersion(): boolean {
  const current = process.versions.node.split(".").map((part) => Number(part));
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if ((current[index] ?? 0) > MIN_NODE_VERSION[index]!) return true;
    if ((current[index] ?? 0) < MIN_NODE_VERSION[index]!) return false;
  }
  return true;
}

function sdkEntryPath(): string {
  const configured = process.env.AI_NOVEL_SIWC_SDK_ENTRY?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(resolveWorkspaceRoot(), ".local", "siwc-devkit", "packages", "local", "dist", "index.js");
}

export function getChatGPTPlanAvailability(): ChatGPTPlanAvailability {
  if (process.platform !== "darwin") {
    return { available: false, message: "ChatGPT 方案连接目前需要 macOS 钥匙串。" };
  }
  if (!compareNodeVersion()) {
    return { available: false, message: "ChatGPT 方案连接需要 Node.js 22.12 或更新版本。" };
  }
  if (!existsSync(sdkEntryPath())) {
    return { available: false, message: "尚未安装官方 ChatGPT 登录组件。请重启本地工作台完成准备。" };
  }
  return { available: true, message: null };
}

function openAuthorizationPage(value: string): Promise<void> {
  const url = new URL(value);
  if (url.origin !== "https://auth.openai.com") {
    return Promise.reject(new Error("Unexpected ChatGPT authorization destination."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("open", [url.href], { shell: false, stdio: "ignore" });
    child.once("error", () => reject(new Error("无法打开系统浏览器，请检查默认浏览器设置后重试。")));
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error("无法打开系统浏览器，请检查默认浏览器设置后重试。")));
  });
}

async function loadSdk(entry: string): Promise<ChatGPTPlanSdk> {
  // The official DevKit is an optional ESM runtime; this server compiles to CommonJS.
  const dynamicImport = new Function("moduleUrl", "return import(moduleUrl)") as (moduleUrl: string) => Promise<unknown>;
  const loaded = await dynamicImport(pathToFileURL(entry).href) as Partial<ChatGPTPlanSdk>;
  if (typeof loaded.createChatGPT !== "function") {
    throw new Error("The installed ChatGPT login component is not compatible with this app.");
  }
  return loaded as ChatGPTPlanSdk;
}

async function getClient(): Promise<ChatGPTPlanClient> {
  const availability = getChatGPTPlanAvailability();
  if (!availability.available) throw new Error(availability.message ?? "ChatGPT sign-in is unavailable.");
  if (!clientPromise) {
    clientPromise = loadSdk(sdkEntryPath()).then((sdk) => {
      const client = sdk.createChatGPT({
        appName: "AI Novel Writing Assistant",
        appId: "ai-novel-writing-assistant",
        redirectPort: 0,
        storageDir: path.join(resolveAppDataRoot(), "chatgpt-plan"),
        sendHostId: true,
        credentialEncryption: macOSCredentialEncryption,
        openBrowser: openAuthorizationPage,
      });
      return {
        signIn: (options) => withChatGPTNetwork(() => client.signIn(options)),
        getSession: () => withChatGPTNetwork(() => client.getSession()),
        listModels: (options) => withChatGPTNetwork(() => client.listModels(options)),
        disconnect: () => withChatGPTNetwork(() => client.disconnect()),
        streamResponse: (options) => withChatGPTNetwork(() => client.streamResponse(options), options.reasoningEffort),
      } satisfies ChatGPTPlanClient;
    }).catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

export const chatGPTPlanService = {
  getBridgeApiKey(): string {
    return bridgeApiKey;
  },

  async getSession(): Promise<ChatGPTPlanSession> {
    if (!getChatGPTPlanAvailability().available) return { status: "disconnected", sharing: false };
    return getClient().then((client) => client.getSession());
  },

  async signIn(reconsent = false): Promise<{ session: ChatGPTPlanSession; models: ChatGPTPlanModel[]; modelError: string | null }> {
    availableModels = [];
    availableModelsFetchedAt = 0;
    const client = await getClient();
    const session = await client.signIn({ reconsent });
    if (session.status !== "connected" || !session.sharing) {
      availableModels = [];
      availableModelsFetchedAt = 0;
      return { session, models: [], modelError: null };
    }
    try {
      availableModels = addConfiguredModels(await client.listModels());
      availableModelsFetchedAt = Date.now();
      return { session, models: availableModels, modelError: null };
    } catch (error) {
      return {
        session,
        models: [],
        modelError: error instanceof Error ? error.message : "暂时无法读取可用模型。",
      };
    }
  },

  async listModels(): Promise<ChatGPTPlanModel[]> {
    if (availableModels.length > 0 && Date.now() - availableModelsFetchedAt < MODEL_CACHE_TTL_MS) {
      return availableModels.map((model) => ({ ...model }));
    }
    const client = await getClient();
    availableModels = addConfiguredModels(await client.listModels());
    availableModelsFetchedAt = Date.now();
    return availableModels.map((model) => ({ ...model }));
  },

  async refreshModels(): Promise<ChatGPTPlanModel[]> {
    const client = await getClient();
    availableModels = addConfiguredModels(await client.listModels());
    availableModelsFetchedAt = Date.now();
    return availableModels.map((model) => ({ ...model }));
  },

  getCachedModels(): ChatGPTPlanModel[] {
    return availableModels.map((model) => ({ ...model }));
  },

  async disconnect(): Promise<{ remoteRevocationConfirmed: boolean }> {
    const client = await getClient();
    availableModels = [];
    availableModelsFetchedAt = 0;
    try {
      await client.disconnect();
      return { remoteRevocationConfirmed: true };
    } catch (error) {
      // The official SDK removes local credentials before reporting this case.
      // Finish local cleanup while preserving the useful remote-revocation warning.
      if (errorCode(error) === "revocation_failed") return { remoteRevocationConfirmed: false };
      throw error;
    }
  },

  async streamResponse(options: Parameters<ChatGPTPlanClient["streamResponse"]>[0]): Promise<{ text: string }> {
    const client = await getClient();
    return client.streamResponse(options);
  },
};

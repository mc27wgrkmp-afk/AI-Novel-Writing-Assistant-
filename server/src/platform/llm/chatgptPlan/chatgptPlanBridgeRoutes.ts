import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  chatGPTPlanService,
  getChatGPTPlanAvailability,
  type ChatGPTPlanModel,
} from "./ChatGPTPlanService";

const router = Router();

const chatCompletionSchema = z.object({
  model: z.string().trim().min(1).max(240),
  messages: z.array(z.object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.string(),
  })).min(1).max(200),
  stream: z.boolean().optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
}).passthrough();

type ErrorRecord = Record<string, unknown>;

interface UpstreamErrorDetails {
  message: string;
  status?: number;
  type?: string;
  code?: string;
  param?: string;
  requestId?: string;
}

const UPSTREAM_STATUS_BY_CODE = new Map<string, number>([
  ["subscription_sharing_user_not_eligible", 403],
  ["subscription_sharing_usage_limit_exceeded", 429],
  ["subscription_sharing_usage_unavailable", 503],
  ["subscription_sharing_unsupported_capability", 400],
  ["subscription_sharing_route_not_supported", 403],
  ["subscription_sharing_invalid_user", 401],
  ["chatpass_v2_scope_not_authorized", 403],
  ["chatpass_v2_invalid_authorization_context", 403],
  ["subscription_sharing_user_unavailable", 503],
]);

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as ErrorRecord
    : undefined;
}

function readErrorString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() && value.length <= 512) {
      return value.trim();
    }
  }
  return undefined;
}

function readHttpStatus(...values: unknown[]): number | undefined {
  for (const value of values) {
    const status = typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value)
        ? Number(value)
        : Number.NaN;
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return undefined;
}

function readResponseHeader(headers: unknown, name: string): string | undefined {
  const headerRecord = asRecord(headers);
  if (!headerRecord) return undefined;
  const get = headerRecord.get;
  if (typeof get === "function") {
    try {
      return readErrorString(get.call(headers, name));
    } catch {
      return undefined;
    }
  }
  const key = Object.keys(headerRecord).find((candidate) => candidate.toLowerCase() === name);
  return key ? readErrorString(headerRecord[key]) : undefined;
}

function getUpstreamErrorDetails(error: unknown, fallbackMessage: string): UpstreamErrorDetails {
  const top = asRecord(error) ?? {};
  const cause = asRecord(top.cause) ?? {};
  const response = asRecord(top.response) ?? {};
  const body = asRecord(response.data) ?? asRecord(response.body) ?? asRecord(top.data) ?? {};
  const bodyError = asRecord(body.error) ?? asRecord(top.error) ?? {};
  const headers = response.headers ?? top.headers;
  const message = readErrorString(
    error instanceof Error ? error.message : undefined,
    bodyError.message,
    body.detail,
    body.message,
    top.message,
    cause.message,
  ) ?? fallbackMessage;
  const isPolicyRestriction = message.toLowerCase().includes("policy or permission restriction prevented this request");
  const code = readErrorString(bodyError.code, body.code, top.errorCode, top.error_code, top.code, cause.code)
    ?? (isPolicyRestriction ? "policy_or_permission_restriction" : undefined);
  const status = readHttpStatus(
    top.status,
    top.statusCode,
    top.status_code,
    response.status,
    body.status,
    cause.status,
  ) ?? (code ? UPSTREAM_STATUS_BY_CODE.get(code) : undefined)
    ?? (isPolicyRestriction ? 403 : undefined);

  return {
    message,
    status,
    type: readErrorString(bodyError.type, body.type, top.type, cause.type),
    code,
    param: readErrorString(bodyError.param, body.param, top.param),
    requestId: readErrorString(
      body.request_id,
      body.requestId,
      bodyError.request_id,
      bodyError.requestId,
      top.request_id,
      top.requestId,
      top.requestID,
      cause.request_id,
      cause.requestId,
      readResponseHeader(headers, "x-request-id"),
    ),
  };
}

function upstreamErrorBody(
  details: UpstreamErrorDetails,
  fallbackCode: string,
  includeStatus = false,
): Record<string, unknown> {
  return {
    error: {
      message: details.message,
      type: details.type ?? "upstream_error",
      code: details.code ?? fallbackCode,
      ...(details.param ? { param: details.param } : {}),
    },
    ...(details.requestId ? { request_id: details.requestId } : {}),
    ...(includeStatus && details.status ? { upstream_status: details.status } : {}),
  };
}

function writeUpstreamError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
  fallbackCode: string,
): void {
  const details = getUpstreamErrorDetails(error, fallbackMessage);
  if (details.requestId) res.setHeader("x-request-id", details.requestId);
  res.status(details.status ?? 502).json(upstreamErrorBody(details, fallbackCode));
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.toLowerCase().replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function writeOpenAIError(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({
    error: {
      message,
      type: status === 401 ? "authentication_error" : "invalid_request_error",
      code,
    },
  });
}

function authorizeInternalRequest(req: Request, res: Response): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    writeOpenAIError(res, 403, "This model bridge accepts requests from this device only.", "local_only");
    return false;
  }
  const authorization = req.header("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided || provided !== chatGPTPlanService.getBridgeApiKey()) {
    writeOpenAIError(res, 401, "The local model bridge rejected this request.", "invalid_local_credential");
    return false;
  }
  return true;
}

async function requirePlanSharing(res: Response): Promise<boolean> {
  const availability = getChatGPTPlanAvailability();
  if (!availability.available) {
    writeOpenAIError(res, 503, availability.message ?? "ChatGPT plan access is unavailable.", "chatgpt_plan_unavailable");
    return false;
  }
  try {
    const session = await chatGPTPlanService.getSession();
    if (session.status !== "connected") {
      writeOpenAIError(res, 401, "Connect a ChatGPT account in this app before using this model.", "sign_in_required");
      return false;
    }
    if (!session.sharing) {
      writeOpenAIError(res, 403, "Allow ChatGPT plan usage in the account authorization screen before using this model.", "plan_sharing_not_enabled");
      return false;
    }
    return true;
  } catch (error) {
    writeOpenAIError(
      res,
      401,
      error instanceof Error ? error.message : "ChatGPT sign-in is required.",
      "sign_in_required",
    );
    return false;
  }
}

async function getModels(forceRefresh = false): Promise<ChatGPTPlanModel[]> {
  return forceRefresh ? chatGPTPlanService.refreshModels() : chatGPTPlanService.listModels();
}

router.get("/v1/models", async (req, res) => {
  if (!authorizeInternalRequest(req, res) || !(await requirePlanSharing(res))) return;
  try {
    const models = await getModels();
    res.status(200).json({
      object: "list",
      data: models.map((model) => ({
        id: model.slug,
        object: "model",
        created: 0,
        owned_by: "openai",
        name: model.displayName,
      })),
    });
  } catch (error) {
    writeUpstreamError(res, error, "Could not load ChatGPT models.", "model_list_failed");
  }
});

router.post("/v1/chat/completions", async (req, res) => {
  if (!authorizeInternalRequest(req, res) || !(await requirePlanSharing(res))) return;
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    writeOpenAIError(res, 400, "The local ChatGPT bridge accepts text messages and a model name.", "invalid_request");
    return;
  }
  const request = parsed.data;
  const messages = request.messages;
  if ((Array.isArray(request.tools) && request.tools.length > 0) || request.tool_choice != null) {
    writeOpenAIError(res, 400, "ChatGPT plan access currently supports text-only chat without tools.", "unsupported_tool_call");
    return;
  }
  let models: ChatGPTPlanModel[];
  try {
    models = await getModels();
  } catch (error) {
    writeUpstreamError(res, error, "Could not load ChatGPT models.", "model_list_failed");
    return;
  }
  if (!models.some((model) => model.slug === request.model)) {
    writeOpenAIError(res, 404, "Choose a model available to the connected ChatGPT account.", "model_not_found");
    return;
  }
  const input: Array<{ role: "user" | "assistant"; content: string }> = [];
  const instructions: string[] = [];
  let totalCharacters = 0;
  for (const message of messages) {
    totalCharacters += message.content.length;
    if (totalCharacters > 4_000_000) {
      writeOpenAIError(res, 413, "This request is too large for the local ChatGPT bridge.", "request_too_large");
      return;
    }
    if (message.role === "system" || message.role === "developer") instructions.push(message.content);
    else if (message.role === "user" || message.role === "assistant") {
      input.push({ role: message.role, content: message.content });
    }
  }
  if (!input.length) {
    writeOpenAIError(res, 400, "Add a user or assistant message before sending this request.", "empty_input");
    return;
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  if (request.stream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    try {
      await chatGPTPlanService.streamResponse({
        model: request.model,
        reasoningEffort: request.reasoning_effort,
        input,
        ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}),
        signal: controller.signal,
        onDelta: (delta) => {
          res.write(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`);
        },
      });
      res.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`);
      res.end();
    } catch (error) {
      if (!res.writableEnded && !controller.signal.aborted) {
        const details = getUpstreamErrorDetails(error, "The ChatGPT response stream failed.");
        if (details.requestId && !res.headersSent) res.setHeader("x-request-id", details.requestId);
        res.write(`event: error\ndata: ${JSON.stringify(upstreamErrorBody(details, "chatgpt_response_failed", true))}\n\n`);
        res.end();
      }
    }
    return;
  }

  try {
    const result = await chatGPTPlanService.streamResponse({
      model: request.model,
      reasoningEffort: request.reasoning_effort,
      input,
      ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}),
      signal: controller.signal,
    });
    res.status(200).json({
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    });
  } catch (error) {
    writeUpstreamError(res, error, "The ChatGPT response failed.", "chatgpt_response_failed");
  }
});

export default router;

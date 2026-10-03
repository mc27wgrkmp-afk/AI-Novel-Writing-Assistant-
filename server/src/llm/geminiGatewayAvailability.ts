/** Deterministic guard for explicit gateway errors; does not infer user intent. */
export function getGeminiGatewayBlockMessage(error: unknown): string | null {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (/Gemini paused:/iu.test(message)) {
    return "Gemini 本地网关已暂停。该网关的所有模型共用登录会话，切换 Gemini 型号无法解除暂停。请先恢复网关会话，或选择其他厂商。";
  }
  if (/Gateway cooling down after upstream failure/iu.test(message)) {
    return "Gemini 本地网关正在冷却。请等待冷却结束后再检测；切换 Gemini 型号仍会使用同一个网关。";
  }
  if (/Gemini upstream rejected request: BardErrorInfo/iu.test(message)) {
    return "Gemini 上游拒绝了请求，网关已暂停。请检查网页登录与上游限制，恢复会话后再检测；也可以选择其他厂商。";
  }
  return null;
}

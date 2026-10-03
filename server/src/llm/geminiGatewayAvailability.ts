/** Deterministic guard for explicit gateway errors; does not infer user intent. */
export function getGeminiGatewayBlockMessage(error: unknown): string | null {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (/Gemini paused:/iu.test(message)) {
    return "Gemini 本地网关返回了旧版暂停状态。请重启网关以切换为冷却恢复；所有 Gemini 型号共用网关。";
  }
  if (/Gateway cooling down after upstream failure/iu.test(message)) {
    return "Gemini 本地网关正在冷却。请等待冷却结束后再检测；切换 Gemini 型号仍会使用同一个网关。";
  }
  if (/Gemini upstream rejected request: BardErrorInfo/iu.test(message)) {
    return "Gemini 上游拒绝了请求，网关进入冷却。冷却结束后可以重新检测；若仍被拒绝，请检查网页登录或额度。";
  }
  return null;
}

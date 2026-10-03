/** Keep actionable service errors when a stream is rejected before SSE starts. */
export async function readStreamError(response: Response): Promise<string> {
  const fallback = `请求失败，状态码 ${response.status}`;
  try {
    const payload = await response.json() as {
      message?: unknown;
      error?: unknown;
    };
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
    if (payload.error && typeof payload.error === "object" && "message" in payload.error
      && typeof payload.error.message === "string" && payload.error.message.trim()) {
      return payload.error.message;
    }
  } catch {
    // A proxy can return an HTML error instead of the service's JSON response.
  }
  return fallback;
}

import type { AiError } from "../../core/errors/ai-error.js";
import { parseRetryAfter, providerError } from "../../core/errors/provider-errors.js";

/** The most of an error body ai-core reads: enough for its JSON, never a whole stream. */
const ERROR_BODY_BYTES = 64 * 1024;

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  try {
    while (size < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return body;
}

/**
 * Builds the error for a response that isn't a success, from the shape the
 * OpenAI specification and Kimi document: `{ error: { message, type, code } }`.
 * It reads at most 64 KB, keeps the error's type and code, never its message,
 * which can repeat the prompt (ADR 0004), and the `x-request-id` and
 * `retry-after` headers. The status decides the code (ADR 0007).
 *
 * @internal
 */
export async function chatCompletionsHttpError(response: Response): Promise<AiError> {
  let type: string | undefined;
  try {
    const body = JSON.parse(await readCapped(response)) as {
      error?: { type?: unknown; code?: unknown };
    };
    const raw = body.error?.code ?? body.error?.type;
    type = typeof raw === "string" ? raw : undefined;
  } catch {
    // Not JSON, or cut off: the status alone decides.
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  return providerError({
    status: response.status,
    ...(type === undefined ? {} : { providerType: type }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

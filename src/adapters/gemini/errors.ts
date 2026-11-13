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
 * Builds the error for a response that isn't a success. Google names its
 * errors by status, such as `429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE`.
 * The HTTP status decides the code (ADR 0007); the error's status name is
 * kept when the body has one, never its message (ADR 0004).
 *
 * @internal
 */
export async function geminiHttpError(response: Response): Promise<AiError> {
  let status: string | undefined;
  try {
    const body = JSON.parse(await readCapped(response)) as { error?: { status?: unknown } };
    status = typeof body.error?.status === "string" ? body.error.status : undefined;
  } catch {
    // Not JSON, or cut off: the HTTP status alone decides.
  }
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  return providerError({
    status: response.status,
    ...(status === undefined ? {} : { providerType: status }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

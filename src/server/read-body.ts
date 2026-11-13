import { AiError, isAiError } from "../core/errors/ai-error.js";
import type { RequestPolicy } from "../core/limits/ai-limits.js";
import type { AiLimitWarning } from "../core/stream/call-guard.js";

function unreadable(message: string): AiError {
  return new AiError("INVALID_REQUEST", message, { details: { retryable: false } });
}

/**
 * Reads a request's body as UTF-8 text within the `requestBytes` limit
 * (ADR 0003, ADR 0005): `content-length` first, then the bytes as they
 * arrive, so an over-limit body is never read whole. The body itself never
 * appears in an error.
 *
 * @throws An `AiError`: `REQUEST_TOO_LARGE` over the limit, and
 *   `INVALID_REQUEST` for a body that can't be read or isn't UTF-8.
 * @internal
 */
export async function readBody(
  request: Request,
  policy: RequestPolicy,
  onWarning: ((warning: AiLimitWarning) => void) | undefined,
): Promise<string> {
  let warned = false;
  const measure = (bytes: number): void => {
    if (policy.check("requestBytes", bytes) === "warning" && !warned) {
      warned = true;
      onWarning?.({
        limit: "requestBytes",
        actual: bytes,
        maximum: policy.limits.requestBytes.maximum,
      });
    }
  };

  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    measure(Number(declared.trim()));
  }
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      measure(total);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    // The read failure's own error isn't kept: it could quote the body.
    throw isAiError(error) ? error : unreadable("The request body couldn't be read.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unreadable("The request body isn't valid UTF-8.");
  }
}

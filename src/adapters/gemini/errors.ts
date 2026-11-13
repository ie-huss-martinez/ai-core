import type { AiError } from "../../core/errors/ai-error.js";
import { parseRetryAfter, providerError } from "../../core/errors/provider-errors.js";
import { readCapped } from "../shared/read-capped.js";

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

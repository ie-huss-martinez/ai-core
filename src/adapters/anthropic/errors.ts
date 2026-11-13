import type { AiError, AiErrorCode } from "../../core/errors/ai-error.js";
import {
  classifyStatus,
  parseRetryAfter,
  providerError,
} from "../../core/errors/provider-errors.js";
import { readCapped } from "../shared/read-capped.js";

/**
 * Anthropic's error types and the HTTP status each stands for, from its
 * errors documentation: they also arrive as `error` events mid-stream, where
 * there's no status (ADR 0007).
 */
const STATUS_OF_TYPE: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/**
 * The code and retryability for one of Anthropic's error types, as for its
 * HTTP status. An unknown type is `PROVIDER_ERROR` and not retryable.
 *
 * @internal
 */
export function errorTypeFailure(type: string): readonly [AiErrorCode, boolean] {
  const status = STATUS_OF_TYPE[type];
  return status === undefined ? ["PROVIDER_ERROR", false] : classifyStatus(status);
}

/**
 * Builds the error for a response that isn't a success. It reads at most
 * 64 KB of the body, keeps the error's type, its spend-cap code and its
 * request ID, and never its message, which can repeat the prompt (ADR 0004).
 * A spend-cap 429 is `SPEND_LIMIT_REACHED`, which retrying can't fix until
 * access resumes (ADR 0007).
 *
 * @internal
 */
export async function httpError(response: Response): Promise<AiError> {
  let type: string | undefined;
  let errorCode: string | undefined;
  let bodyRequestId: string | undefined;
  try {
    const body = JSON.parse(await readCapped(response)) as {
      error?: { type?: unknown; details?: { error_code?: unknown } };
      request_id?: unknown;
    };
    type = typeof body.error?.type === "string" ? body.error.type : undefined;
    errorCode =
      typeof body.error?.details?.error_code === "string"
        ? body.error.details.error_code
        : undefined;
    bodyRequestId = typeof body.request_id === "string" ? body.request_id : undefined;
  } catch {
    // Not JSON, or cut off: the status alone decides.
  }
  const requestId = response.headers.get("request-id") ?? bodyRequestId;
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  const spendCap = response.status === 429 && errorCode === "enforced_spend_limit_reached";
  return providerError(
    {
      status: response.status,
      ...(type === undefined ? {} : { providerType: type }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    },
    spendCap ? ["SPEND_LIMIT_REACHED", false] : undefined,
  );
}

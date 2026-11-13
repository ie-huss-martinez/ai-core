import { AiError, type AiErrorCode } from "./ai-error.js";

/**
 * What a provider's failed response says, as far as `ai-core` keeps it
 * (ADR 0004, ADR 0007): never the request or response body, nor the
 * provider's message, which can repeat the prompt.
 *
 * @internal
 */
export interface ProviderFailure {
  /** The HTTP status, if the provider answered. */
  readonly status?: number;
  /** The provider's error type, such as `"overloaded_error"`. */
  readonly providerType?: string;
  /** The provider's request ID, for its support. */
  readonly requestId?: string;
  /** Seconds to wait, from the provider's `retry-after`. */
  readonly retryAfter?: number;
  /** Whether events were already delivered for this call. */
  readonly partial?: boolean;
}

/** HTTP statuses with a code of their own, and whether retrying can help (ADR 0007). */
const BY_STATUS: Readonly<Record<number, readonly [AiErrorCode, boolean]>> = {
  400: ["PROVIDER_INVALID_REQUEST", false],
  401: ["PROVIDER_AUTHENTICATION", false],
  402: ["PROVIDER_BILLING", false],
  403: ["PROVIDER_PERMISSION", false],
  404: ["PROVIDER_NOT_FOUND", false],
  408: ["PROVIDER_TIMEOUT", true],
  413: ["PROVIDER_REQUEST_TOO_LARGE", false],
  429: ["PROVIDER_RATE_LIMITED", true],
  503: ["PROVIDER_OVERLOADED", true],
  504: ["PROVIDER_TIMEOUT", true],
  529: ["PROVIDER_OVERLOADED", true],
};

/** A short, safe provider value for `details`: provider text is never copied whole. */
const SAFE_VALUE = /^[\w.-]{1,128}$/;

/**
 * The code for an HTTP status, and whether retrying can help (ADR 0007):
 * the statuses listed have their own codes; other 5xx statuses are
 * `PROVIDER_ERROR` and retryable; other statuses are `PROVIDER_ERROR` and
 * not.
 *
 * @internal
 */
export function classifyStatus(status: number): readonly [AiErrorCode, boolean] {
  return BY_STATUS[status] ?? ["PROVIDER_ERROR", status >= 500 && status <= 599];
}

/**
 * Parses a `retry-after` header in either of its forms: whole seconds, or an
 * HTTP date (ADR 0007). Never invents a value: anything else is `undefined`.
 *
 * @param value - The header's value.
 * @param now - The current time, in milliseconds.
 * @returns Seconds to wait, rounded up and never negative.
 * @internal
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || !/[a-z]/i.test(trimmed)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - now) / 1_000));
}

/**
 * Builds the {@link AiError} for a provider's failure, with `details`
 * holding only `retryable`, the status, the provider's error type, its
 * request ID, `retryAfter` and `partial` (ADR 0004, ADR 0007).
 *
 * @param failure - What the provider's response said.
 * @param override - A code and retryability that the adapter decided from
 *   the provider's own error, such as `SPEND_LIMIT_REACHED`.
 * @internal
 */
export function providerError(
  failure: ProviderFailure,
  override?: readonly [AiErrorCode, boolean],
): AiError {
  const [code, retryable] =
    override ??
    (failure.status === undefined ? ["PROVIDER_ERROR", true] : classifyStatus(failure.status));
  const details: Record<string, string | number | boolean> = { retryable };
  if (failure.status !== undefined) {
    details["status"] = failure.status;
  }
  if (failure.providerType !== undefined && SAFE_VALUE.test(failure.providerType)) {
    details["providerType"] = failure.providerType;
  }
  if (failure.requestId !== undefined && SAFE_VALUE.test(failure.requestId)) {
    details["requestId"] = failure.requestId;
  }
  if (failure.retryAfter !== undefined) {
    details["retryAfter"] = failure.retryAfter;
  }
  if (failure.partial) {
    details["partial"] = true;
  }
  const status = failure.status === undefined ? "" : ` with status ${failure.status}`;
  return new AiError(code, `The provider failed${status}.`, { details });
}

/**
 * Builds the error for a request that got no response at all, such as a
 * refused connection or a DNS failure (ADR 0004). It names only the method
 * and the provider's origin: the underlying error isn't kept as `cause`,
 * because platform errors can carry request details.
 *
 * @param method - The HTTP method.
 * @param url - The request's URL; only its origin is kept.
 * @internal
 */
export function networkError(method: string, url: string): AiError {
  return new AiError("NETWORK_ERROR", `The request to ${new URL(url).origin} got no response.`, {
    details: { retryable: true, method, origin: new URL(url).origin },
  });
}

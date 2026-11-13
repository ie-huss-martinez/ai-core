import { AiError, type AiErrorCode, asAiError } from "./ai-error.js";

/**
 * ai-core's own codes that retrying the same call can fix (ADR 0007): a
 * stream cut off by the network. Limits, validation, protocol errors and
 * aborts can't be fixed by retrying.
 */
const RETRYABLE: ReadonlySet<AiErrorCode> = new Set(["STREAM_TRUNCATED", "NETWORK_ERROR"]);

/**
 * Makes a call's error say whether and when to retry, as every call error
 * must (ADR 0007): it keeps a `retryable` the error already has, adds one
 * from its code otherwise, and adds `partial: true` when events were already
 * delivered. Anything that isn't an AiError is adapted first.
 *
 * @param reason - Anything a call threw.
 * @param delivered - Whether the call delivered any event.
 * @internal
 */
export function finishCallError(reason: unknown, delivered: boolean): AiError {
  const error = asAiError(reason);
  const details = error.details ?? {};
  const retryable =
    typeof details["retryable"] === "boolean" ? details["retryable"] : RETRYABLE.has(error.code);
  if (details["retryable"] === retryable && (!delivered || details["partial"] === true)) {
    return error;
  }
  return new AiError(error.code, error.message, {
    details: { ...details, retryable, ...(delivered ? { partial: true } : {}) },
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

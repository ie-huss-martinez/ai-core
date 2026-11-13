import {
  createErrorHelpers,
  isSdkError,
  type SdkCoreErrorCode,
  SdkError,
} from "@hussmartinez/sdk-core";

/**
 * Error codes of `@hussmartinez/ai-core`: sdk-core's own codes, such as
 * `ABORTED`, `TIMEOUT` and `UNSUPPORTED_ENVIRONMENT`, plus ai-core's
 * (ADR 0003 to ADR 0007). They never change meaning once released.
 *
 * Configuration and requests:
 *
 * - `INVALID_CONFIGURATION`: an adapter, the transport or the handler was
 *   created with invalid options, such as a handler without `prepare`.
 * - `INVALID_REQUEST`: a request doesn't match the message model, or the
 *   handler received a field the browser may not set.
 * - `MISSING_API_KEY`: an adapter's key is missing or empty.
 * - `BROWSER_KEY_REFUSED`: an adapter that holds a key was used outside a
 *   recognised server runtime without `dangerouslyAllowBrowser: true`.
 *
 * The request handler:
 *
 * - `METHOD_NOT_ALLOWED`: the request wasn't a `POST`.
 * - `UNSUPPORTED_MEDIA_TYPE`: the request wasn't `application/json`.
 * - `ORIGIN_NOT_ALLOWED`: the request's `Origin` isn't in `allowedOrigins`.
 * - `PROTOCOL_MISMATCH`: the transport and the handler speak different
 *   versions of the wire protocol.
 * - `CONTEXT_CHANGED`: the system prompt or tools changed during a
 *   conversation.
 * - `PREPARE_FAILED`: the host's `prepare` hook threw.
 *
 * Limits and streams, with `details` holding the `limit`, its `maximum`, the
 * `actual` value and the `unit`:
 *
 * - `REQUEST_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `STREAM_TIMEOUT` and
 *   `STREAM_IDLE`: a limit was exceeded.
 * - `STREAM_TRUNCATED`: a response ended before the provider's final event.
 * - `PROVIDER_RESPONSE_INVALID`: a response couldn't be decoded or parsed,
 *   or its events came in an impossible order.
 *
 * Providers:
 *
 * - `SPEND_LIMIT_REACHED`: the provider account's spending cap was reached.
 *   Retrying fails until the provider restores access.
 *
 * `details` never contain keys, prompts, model output, or request or
 * response bodies.
 *
 * @public
 */
export type AiErrorCode =
  | SdkCoreErrorCode
  | "INVALID_CONFIGURATION"
  | "INVALID_REQUEST"
  | "MISSING_API_KEY"
  | "BROWSER_KEY_REFUSED"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "ORIGIN_NOT_ALLOWED"
  | "PROTOCOL_MISMATCH"
  | "CONTEXT_CHANGED"
  | "PREPARE_FAILED"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE"
  | "STREAM_TIMEOUT"
  | "STREAM_IDLE"
  | "STREAM_TRUNCATED"
  | "PROVIDER_RESPONSE_INVALID"
  | "SPEND_LIMIT_REACHED";

/**
 * The error `@hussmartinez/ai-core` throws and rejects with, with a stable
 * `code`, structured `details` and the underlying error as `cause`. Show
 * users the text for its code from {@link aiCoreMessages}, never its
 * `message`, which is for developers.
 *
 * @example
 * ```ts
 * try {
 *   await provider.complete(request);
 * } catch (error) {
 *   if (isAiError(error, "CONTEXT_CHANGED")) {
 *     startNewConversation();
 *   } else {
 *     show(messages.error(error));
 *   }
 * }
 * ```
 *
 * @public
 */
export class AiError extends SdkError<AiErrorCode> {
  /** Always `"AiError"`, which survives minification and the wire protocol. */
  override readonly name = "AiError";
}

/**
 * Checks whether a value is an {@link AiError}, optionally with a given code.
 *
 * Unlike `instanceof`, it recognises errors from another copy of this
 * package or another realm, and errors rebuilt after crossing the wire
 * protocol.
 *
 * @param value - Any thrown value.
 * @param code - When given, the error must also have this code.
 * @public
 */
export function isAiError<Code extends AiErrorCode = AiErrorCode>(
  value: unknown,
  code?: Code,
): value is AiError & { readonly code: Code } {
  return isSdkError(value, code) && value.name === "AiError";
}

/**
 * Turns any failure into an {@link AiError}, aborts into `ABORTED` or
 * `TIMEOUT`, and checks a signal, as every package in the family does
 * (sdk-core ADR 0034).
 *
 * @internal
 */
export const {
  adapt: asAiError,
  abortError,
  throwIfAborted,
} = /* @__PURE__ */ createErrorHelpers(AiError, {
  fallbackCode: "UNKNOWN",
  fallbackMessage: "The AI call failed.",
});

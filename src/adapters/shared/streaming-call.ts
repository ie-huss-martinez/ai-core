import { AiError, abortError } from "../../core/errors/ai-error.js";
import { finishCallError } from "../../core/errors/call-error.js";
import { networkError } from "../../core/errors/provider-errors.js";
import type { ResponsePolicy } from "../../core/limits/ai-limits.js";
import type { AiEvent } from "../../core/model/provider.js";
import { assertKeyMayBeUsed } from "../../core/runtime/server-runtime.js";
import type { SseEvent } from "../../core/sse/sse-parser.js";
import { type AiLimitWarning, CallGuard } from "../../core/stream/call-guard.js";
import { readSseEvents } from "../../core/stream/read-sse-events.js";

/**
 * Maps one provider's server-sent events to ai-core's events.
 *
 * @internal
 */
export interface StreamMapper {
  /**
   * Maps one event.
   *
   * @param partial - Whether events were already delivered, for errors.
   */
  push(event: SseEvent, partial: boolean): AiEvent[];
  /** Whether the provider's final event arrived: anything earlier is a truncated stream. */
  readonly finished: boolean;
}

/**
 * One streaming call to a provider, as every adapter makes it.
 *
 * @internal
 */
export interface StreamingCallOptions {
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly policy: ResponsePolicy;
  readonly signal: AbortSignal | undefined;
  readonly onWarning: ((warning: AiLimitWarning) => void) | undefined;
  readonly dangerouslyAllowBrowser: boolean;
  /**
   * Builds the headers and body. It runs before anything is sent, so a
   * request it rejects, or a missing key, never reaches the provider.
   */
  readonly prepare: () => Promise<{
    readonly headers: Record<string, string>;
    readonly body: string;
  }>;
  /** The error for a response that isn't a success. */
  readonly httpError: (response: Response) => Promise<AiError>;
  /** A mapper for this call's events. */
  readonly mapper: StreamMapper;
  /** The developer-facing message when the body ends before the final event. */
  readonly truncatedMessage: string;
}

/**
 * Makes one streaming call, with everything every adapter must do the same
 * way (ADR 0004, ADR 0005, ADR 0007):
 *
 * - it fails with `ABORTED` for a signal that's already aborted, and checks
 *   the runtime again before every request;
 * - it guards the call with the response limits and the host's signal;
 * - a `fetch` that rejects is `NETWORK_ERROR`, without the platform error;
 * - it requires a `text/event-stream` success;
 * - it delivers no event after an abort, even from the same chunk;
 * - a body that ends before the mapper's final event is `STREAM_TRUNCATED`;
 * - every error says whether to retry, and whether events were delivered.
 *
 * @internal
 */
export async function* streamingCall(options: StreamingCallOptions): AsyncGenerator<AiEvent> {
  let delivered = false;
  let guard: CallGuard | undefined;
  try {
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }
    assertKeyMayBeUsed(options.dangerouslyAllowBrowser);
    const { headers, body } = await options.prepare();
    guard = new CallGuard({
      policy: options.policy,
      signal: options.signal,
      onWarning: options.onWarning,
    });
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: "POST",
        headers,
        body,
        signal: guard.signal,
      });
    } catch {
      // The platform's error isn't kept: it can carry request details (ADR 0004).
      throw guard.signal.aborted ? guard.error() : networkError("POST", options.url);
    }
    if (!response.ok) {
      throw await options.httpError(response);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      response.body?.cancel().catch(() => undefined);
      throw new AiError("PROVIDER_RESPONSE_INVALID", "The response isn't an event stream.", {
        details: { retryable: false },
      });
    }
    for await (const event of readSseEvents(response.body, guard)) {
      for (const mapped of options.mapper.push(event, delivered)) {
        // One provider event can map to several: none goes out after an abort.
        if (guard.signal.aborted) {
          throw guard.error();
        }
        delivered = true;
        yield mapped;
      }
      if (options.mapper.finished) {
        break;
      }
    }
    if (!options.mapper.finished) {
      throw new AiError("STREAM_TRUNCATED", options.truncatedMessage);
    }
  } catch (error) {
    throw finishCallError(error, delivered);
  } finally {
    guard?.dispose();
  }
}

/**
 * Reads an adapter's key for one request (ADR 0004): a string, or a function
 * called every time. A missing or empty key fails with `MISSING_API_KEY`
 * before anything is sent.
 *
 * @param apiKey - The host's option.
 * @param label - The provider's name, for the message.
 * @internal
 */
export async function readApiKey(
  apiKey: string | (() => string | Promise<string>),
  label: string,
): Promise<string> {
  const key = typeof apiKey === "function" ? await apiKey() : apiKey;
  if (typeof key !== "string" || key === "") {
    throw new AiError("MISSING_API_KEY", `The ${label} API key is missing or empty.`, {
      details: { retryable: false },
    });
  }
  return key;
}

/**
 * The error for an adapter created with invalid options.
 *
 * @internal
 */
export function invalidConfiguration(message: string): AiError {
  return new AiError("INVALID_CONFIGURATION", message, { details: { retryable: false } });
}

/**
 * Checks a base URL: `https:`, or `http:` for `localhost` only, with no query
 * or fragment.
 *
 * @internal
 */
export function checkedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfiguration("baseURL isn't a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw invalidConfiguration("baseURL must use https: (or http: for localhost).");
  }
  return url;
}

import { AiError } from "../../core/errors/ai-error.js";
import { parseRetryAfter, providerError } from "../../core/errors/provider-errors.js";
import { type ResponseLimitOverrides, responseLimits } from "../../core/limits/ai-limits.js";
import type {
  AiCallOptions,
  AiEvent,
  AiProvider,
  AiRequest,
  AiResult,
} from "../../core/model/provider.js";
import { AI_CORE, AI_CORE_PROTOCOL, encodePart } from "../../core/protocol/wire.js";
import type { AiLimitWarning } from "../../core/stream/call-guard.js";
import { collectResult } from "../../core/stream/collect-result.js";
import { iterateOnce } from "../../core/stream/iterate-once.js";
import { readCapped } from "../shared/read-capped.js";
import { checkedBaseUrl, invalidConfiguration, streamingCall } from "../shared/streaming-call.js";
import { handlerError, WireStream } from "./stream.js";

/**
 * Options for {@link httpTransport}.
 *
 * @public
 */
export interface HttpTransportOptions {
  /**
   * The handler's URL: a path on the page's own origin, such as
   * `"/api/chat"`, or an absolute `https:` URL (`http:` only for
   * `localhost`).
   */
  readonly url: string;
  /**
   * Headers for the host's own endpoint, such as a session token, or a
   * function that returns them for each call. Never a provider key: keys
   * stay on the server (ADR 0004). `content-type` and `accept` are the
   * transport's own.
   */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  /** The `fetch` to use. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Response limits, instead of the defaults (ADR 0005). They protect the page from a misbehaving server. */
  readonly limits?: ResponseLimitOverrides;
  /** Called at most once per limit per call, before a limit is reached. Never with content. */
  readonly onWarning?: (warning: AiLimitWarning) => void;
}

/** Request fields only the server's `prepare` sets (ADR 0003). */
const SERVER_FIELDS = [
  "system",
  "tools",
  "toolChoice",
  "model",
  "maxOutputTokens",
  "providerOptions",
] as const;

function checkedUrl(url: string): string {
  if (typeof url !== "string" || url === "") {
    throw invalidConfiguration("httpTransport needs the handler's url.");
  }
  if (url.startsWith("/") && !url.startsWith("//")) {
    return url;
  }
  return checkedBaseUrl(url).href;
}

/** The absolute URL for one call: a path resolves against the page. */
function callUrl(url: string): string {
  if (!url.startsWith("/")) {
    return url;
  }
  const page = (globalThis as { location?: { href?: unknown } }).location?.href;
  if (typeof page !== "string") {
    throw invalidConfiguration(
      "A path url needs a page to resolve against: use an absolute URL outside browsers.",
    );
  }
  return new URL(url, page).href;
}

function checkRequest(request: AiRequest): void {
  for (const field of SERVER_FIELDS) {
    if (request[field] !== undefined) {
      throw new AiError(
        "INVALID_REQUEST",
        `httpTransport sends only messages: "${field}" is set by the server, in prepare.`,
        { details: { path: field, retryable: false } },
      );
    }
  }
}

async function httpError(response: Response): Promise<AiError> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = JSON.parse(await readCapped(response)) as { error?: unknown };
      if (body.error !== undefined) {
        const error = handlerError(body.error);
        if (error.code !== "PROVIDER_RESPONSE_INVALID") {
          return error;
        }
      }
    } catch {
      // Not the handler's JSON, or cut off: the status alone decides.
    }
  } else {
    response.body?.cancel().catch(() => undefined);
  }
  // Not one of the handler's own errors, such as a 401 or 429 from prepare.
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  return providerError({
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

/**
 * Creates the browser's provider: it calls the host's own endpoint, made
 * with `createAiHandler`, over the `ai-core/1` protocol (ADR 0003). It holds
 * no key, so it runs in pages and workers, and the server decides the model,
 * system prompt, tools and budget.
 *
 * It sends only the conversation: setting another request field, such as
 * `model` or `system`, fails with `INVALID_REQUEST` before anything is sent.
 * Errors from the handler arrive as the same {@link AiError}s, such as
 * `CONTEXT_CHANGED`, and the response limits apply to the handler's stream
 * too (ADR 0005).
 *
 * @example
 * ```ts
 * import { httpTransport } from "@hussmartinez/ai-core";
 *
 * const provider = httpTransport({ url: "/api/chat" });
 * for await (const event of provider.stream({ messages })) {
 *   if (event.type === "text-delta") show(event.text);
 * }
 * ```
 *
 * @throws An `AiError` `INVALID_CONFIGURATION` for a missing or invalid `url`.
 * @public
 */
export function httpTransport(options: HttpTransportOptions): AiProvider {
  const url = checkedUrl(options.url);
  const policy = responseLimits.resolve(options.limits);
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const { headers } = options;

  // A generator, so a path url outside a page fails the call, not the method call.
  async function* call(
    request: AiRequest,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AiEvent> {
    yield* streamingCall({
      url: callUrl(url),
      fetch: fetchImpl,
      policy,
      signal,
      onWarning: options.onWarning,
      // No key travels with the transport, so ADR 0004's runtime check doesn't apply.
      holdsKey: false,
      dangerouslyAllowBrowser: false,
      prepare: async () => {
        checkRequest(request);
        const own = typeof headers === "function" ? await headers() : (headers ?? {});
        return {
          headers: { ...own, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            protocol: AI_CORE_PROTOCOL,
            messages: request.messages.map((message) => ({
              role: message.role,
              parts: message.parts.map(encodePart),
            })),
          }),
        };
      },
      httpError,
      mapper: new WireStream(),
      truncatedMessage: "The handler's stream ended before its finish event.",
    });
  }

  return {
    provider: AI_CORE,
    stream(request: AiRequest, callOptions: AiCallOptions = {}): AsyncIterable<AiEvent> {
      return iterateOnce(() => call(request, callOptions.signal));
    },
    complete(request: AiRequest, callOptions: AiCallOptions = {}): Promise<AiResult> {
      return collectResult(call(request, callOptions.signal));
    },
  };
}

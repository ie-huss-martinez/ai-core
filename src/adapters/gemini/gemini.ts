import { type ResponseLimitOverrides, responseLimits } from "../../core/limits/ai-limits.js";
import type {
  AiCallOptions,
  AiEvent,
  AiProvider,
  AiRequest,
  AiResult,
} from "../../core/model/provider.js";
import { assertKeyMayBeUsed } from "../../core/runtime/server-runtime.js";
import type { AiLimitWarning } from "../../core/stream/call-guard.js";
import { collectResult } from "../../core/stream/collect-result.js";
import { iterateOnce } from "../../core/stream/iterate-once.js";
import {
  checkedBaseUrl,
  invalidConfiguration,
  readApiKey,
  streamingCall,
} from "../shared/streaming-call.js";
import { geminiHttpError } from "./errors.js";
import { GEMINI, toInteractionBody } from "./request.js";
import { InteractionsStream } from "./stream.js";

/** The Interactions API revision this adapter speaks, as Google's examples send it. */
const API_REVISION = "2026-05-20";

/**
 * Options for {@link createGemini}.
 *
 * @public
 */
export interface GeminiOptions {
  /**
   * The API key, or a function that returns it, read each time a request is
   * built and never stored where it could be logged. It's sent in the
   * `x-goog-api-key` header, never in a URL (ADR 0004).
   */
  readonly apiKey: string | (() => string | Promise<string>);
  /** The model for requests that don't name one. */
  readonly model: string;
  /** The output budget for requests that don't set one. Defaults to 16,000 tokens. */
  readonly maxOutputTokens?: number;
  /**
   * The API's origin. Defaults to `https://generativelanguage.googleapis.com`.
   * Only `https:` is accepted, and `http:` for `localhost`.
   */
  readonly baseURL?: string;
  /** The `fetch` to use. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Response limits, instead of the defaults (ADR 0005). */
  readonly limits?: ResponseLimitOverrides;
  /** Called at most once per limit per call, before a limit is reached. Never with content. */
  readonly onWarning?: (warning: AiLimitWarning) => void;
  /**
   * Lets the adapter run outside a recognised server, such as in a browser
   * where users bring their own keys. Anyone who can read the page can read
   * the key (ADR 0004).
   */
  readonly dangerouslyAllowBrowser?: boolean;
}

function interactionsUrl(baseURL: string | undefined): string {
  const origin = checkedBaseUrl(baseURL ?? "https://generativelanguage.googleapis.com").origin;
  return new URL("/v1beta/interactions?alt=sse", origin).href;
}

/**
 * Creates a provider for Gemini, through Google's Interactions API (ADR 0008):
 * stateless, with the full history sent every call and `store: false` always
 * set, so Google keeps no copy of the conversation. It sends thought steps
 * back unchanged as `provider-state`, never retries, and keeps its key on the
 * server unless `dangerouslyAllowBrowser` is set.
 *
 * @example
 * ```ts
 * import { createGemini } from "@hussmartinez/ai-core/gemini";
 *
 * const provider = createGemini({
 *   apiKey: () => process.env.GEMINI_API_KEY ?? "",
 *   model: "gemini-3.8-flash",
 * });
 * ```
 *
 * @throws An `AiError`: `INVALID_CONFIGURATION` for invalid options, and
 *   `BROWSER_KEY_REFUSED` outside a recognised server without the opt-in.
 * @public
 */
export function createGemini(options: GeminiOptions): AiProvider {
  const dangerouslyAllowBrowser = options.dangerouslyAllowBrowser === true;
  assertKeyMayBeUsed(dangerouslyAllowBrowser);
  if (typeof options.model !== "string" || options.model === "") {
    throw invalidConfiguration("createGemini needs a model.");
  }
  const url = interactionsUrl(options.baseURL);
  const policy = responseLimits.resolve(options.limits);
  const defaults = { model: options.model, maxOutputTokens: options.maxOutputTokens ?? 16_000 };
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // The key stays in this closure: never a property of the provider (ADR 0004).
  const { apiKey } = options;

  const call = (request: AiRequest, signal: AbortSignal | undefined): AsyncGenerator<AiEvent> =>
    streamingCall({
      url,
      fetch: fetchImpl,
      policy,
      signal,
      onWarning: options.onWarning,
      dangerouslyAllowBrowser,
      prepare: async () => ({
        headers: {
          "x-goog-api-key": await readApiKey(apiKey, "Gemini"),
          "api-revision": API_REVISION,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(toInteractionBody(request, defaults)),
      }),
      httpError: geminiHttpError,
      mapper: new InteractionsStream(),
      truncatedMessage: "The response ended before interaction.completed.",
    });

  return {
    provider: GEMINI,
    stream(request: AiRequest, callOptions: AiCallOptions = {}): AsyncIterable<AiEvent> {
      return iterateOnce(() => call(request, callOptions.signal));
    },
    complete(request: AiRequest, callOptions: AiCallOptions = {}): Promise<AiResult> {
      return collectResult(call(request, callOptions.signal));
    },
  };
}

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
import { httpError } from "./errors.js";
import { ANTHROPIC, toAnthropicBody } from "./request.js";
import { AnthropicStream } from "./stream.js";

/**
 * The Messages API version this adapter speaks, the latest one Anthropic
 * documents (ADR 0004). It changes only with a release of ai-core.
 */
const API_VERSION = "2026-10-21";

/**
 * Options for {@link createAnthropic}.
 *
 * @public
 */
export interface AnthropicOptions {
  /**
   * The API key, or a function that returns it, such as from a secret
   * manager. It's read each time a request is built, and never stored where
   * it could be logged (ADR 0004).
   */
  readonly apiKey: string | (() => string | Promise<string>);
  /** The model for requests that don't name one, such as `"claude-opus-5-5"`. */
  readonly model: string;
  /** The output budget for requests that don't set one. Defaults to 16,000 tokens. */
  readonly maxOutputTokens?: number;
  /**
   * The API's origin. Defaults to `https://api.anthropic.com`. Only `https:`
   * is accepted, and `http:` for `localhost`.
   */
  readonly baseURL?: string;
  /** The `fetch` to use, such as an instrumented one. Defaults to the global `fetch`. */
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

function messagesUrl(baseURL: string | undefined): string {
  // Only the origin is used: the path is Anthropic's.
  return new URL("/v1/messages", checkedBaseUrl(baseURL ?? "https://api.anthropic.com").origin)
    .href;
}

/**
 * Creates a provider for Anthropic's Messages API (ADR 0002). It streams
 * every call, replays thinking blocks unchanged as `provider-state`, never
 * retries, and keeps its key on the server unless `dangerouslyAllowBrowser`
 * is set.
 *
 * @example
 * ```ts
 * import { createAnthropic } from "@hussmartinez/ai-core/anthropic";
 *
 * const provider = createAnthropic({
 *   apiKey: () => process.env.ANTHROPIC_API_KEY ?? "",
 *   model: "claude-opus-5-5",
 * });
 * ```
 *
 * @throws An `AiError`: `INVALID_CONFIGURATION` for invalid options, and
 *   `BROWSER_KEY_REFUSED` outside a recognised server without the opt-in.
 * @public
 */
export function createAnthropic(options: AnthropicOptions): AiProvider {
  const dangerouslyAllowBrowser = options.dangerouslyAllowBrowser === true;
  assertKeyMayBeUsed(dangerouslyAllowBrowser);
  if (typeof options.model !== "string" || options.model === "") {
    throw invalidConfiguration("createAnthropic needs a model.");
  }
  const url = messagesUrl(options.baseURL);
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
      prepare: async () => {
        const body = JSON.stringify(toAnthropicBody(request, defaults));
        const headers: Record<string, string> = {
          authorization: `Bearer ${await readApiKey(apiKey, "Anthropic")}`,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
          accept: "text/event-stream",
        };
        if (dangerouslyAllowBrowser) {
          headers["anthropic-dangerous-direct-browser-access"] = "true";
        }
        return { headers, body };
      },
      httpError,
      mapper: new AnthropicStream(),
      truncatedMessage: "The response ended before message_stop.",
    });

  return {
    provider: ANTHROPIC,
    stream(request: AiRequest, callOptions: AiCallOptions = {}): AsyncIterable<AiEvent> {
      return iterateOnce(() => call(request, callOptions.signal));
    },
    complete(request: AiRequest, callOptions: AiCallOptions = {}): Promise<AiResult> {
      return collectResult(call(request, callOptions.signal));
    },
  };
}

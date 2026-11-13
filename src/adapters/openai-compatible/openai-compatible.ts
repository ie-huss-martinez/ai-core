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
import { chatCompletionsHttpError } from "./errors.js";
import { toChatCompletionsBody } from "./request.js";
import { ChatCompletionsStream } from "./stream.js";

/**
 * Options for {@link createOpenAICompatible}.
 *
 * @public
 */
export interface OpenAICompatibleOptions {
  /**
   * The API key, or a function that returns it, read each time a request is
   * built and never stored where it could be logged (ADR 0004).
   */
  readonly apiKey: string | (() => string | Promise<string>);
  /**
   * The API's base URL, up to the version, such as
   * `https://api.openai.com/v1`. Requests go to `<baseURL>/chat/completions`.
   * Only `https:` is accepted, and `http:` for `localhost`.
   */
  readonly baseURL: string;
  /** The model for requests that don't name one. */
  readonly model: string;
  /**
   * The name its `provider-state` is tagged with, and the key of its
   * `providerOptions`. Defaults to `"openai-compatible"`.
   */
  readonly provider?: string;
  /** The output budget for requests that don't set one. Defaults to 16,000 tokens. */
  readonly maxOutputTokens?: number;
  /**
   * Which field carries the output budget. Defaults to
   * `"max_completion_tokens"`, which OpenAI and Kimi document; `max_tokens`
   * is deprecated there, but some compatible APIs only know it.
   */
  readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
  /**
   * Whether to send `store: false`, so the provider keeps no copy of the
   * conversation (ADR 0008). Defaults to `true`: OpenAI documents `store`.
   * Set it to `false` only for an API that rejects unknown fields and
   * doesn't store conversations. Either way, a `store` from `providerOptions`
   * is never sent.
   */
  readonly sendStore?: boolean;
  /** The `fetch` to use. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Response limits, instead of the defaults (ADR 0005). */
  readonly limits?: ResponseLimitOverrides;
  /** Called at most once per limit per call, before a limit is reached. Never with content. */
  readonly onWarning?: (warning: AiLimitWarning) => void;
  /**
   * Lets the adapter run outside a recognised server, such as in a browser
   * where users bring their own keys, where the provider allows it. Anyone who
   * can read the page can read the key (ADR 0004).
   */
  readonly dangerouslyAllowBrowser?: boolean;
}

function completionsUrl(baseURL: string): string {
  const url = checkedBaseUrl(baseURL);
  if (url.search || url.hash) {
    throw invalidConfiguration("baseURL can't have a query or a fragment.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Creates a provider for an OpenAI-compatible Chat Completions API (ADR 0002),
 * such as OpenAI's, Kimi's (see {@link createKimi}), or a local server's. It
 * streams every call with usage, sends a provider's `reasoning_content` back
 * as Kimi requires, never retries, and keeps its key on the server unless
 * `dangerouslyAllowBrowser` is set.
 *
 * @example
 * ```ts
 * import { createOpenAICompatible } from "@hussmartinez/ai-core/openai-compatible";
 *
 * const provider = createOpenAICompatible({
 *   apiKey: () => process.env.OPENAI_API_KEY ?? "",
 *   baseURL: "https://api.openai.com/v1",
 *   model: "gpt-5",
 *   provider: "openai",
 * });
 * ```
 *
 * @throws An `AiError`: `INVALID_CONFIGURATION` for invalid options, and
 *   `BROWSER_KEY_REFUSED` outside a recognised server without the opt-in.
 * @public
 */
export function createOpenAICompatible(options: OpenAICompatibleOptions): AiProvider {
  const dangerouslyAllowBrowser = options.dangerouslyAllowBrowser === true;
  assertKeyMayBeUsed(dangerouslyAllowBrowser);
  if (typeof options.model !== "string" || options.model === "") {
    throw invalidConfiguration("createOpenAICompatible needs a model.");
  }
  if (typeof options.baseURL !== "string") {
    throw invalidConfiguration("createOpenAICompatible needs a baseURL.");
  }
  const url = completionsUrl(options.baseURL);
  const provider = options.provider ?? "openai-compatible";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
    throw invalidConfiguration("provider must be lowercase letters, digits and dashes.");
  }
  const policy = responseLimits.resolve(options.limits);
  const defaults = {
    provider,
    model: options.model,
    maxOutputTokens: options.maxOutputTokens ?? 16_000,
    maxTokensField: options.maxTokensField ?? "max_completion_tokens",
    sendStore: options.sendStore ?? true,
  } as const;
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
          authorization: `Bearer ${await readApiKey(apiKey, provider)}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(toChatCompletionsBody(request, defaults)),
      }),
      httpError: chatCompletionsHttpError,
      mapper: new ChatCompletionsStream(provider),
      truncatedMessage: "The response ended before data: [DONE].",
    });

  return {
    provider,
    stream(request: AiRequest, callOptions: AiCallOptions = {}): AsyncIterable<AiEvent> {
      return iterateOnce(() => call(request, callOptions.signal));
    },
    complete(request: AiRequest, callOptions: AiCallOptions = {}): Promise<AiResult> {
      return collectResult(call(request, callOptions.signal));
    },
  };
}

/**
 * Options for {@link createKimi}: those of {@link createOpenAICompatible},
 * with Kimi's base URL as the default.
 *
 * @public
 */
export type KimiOptions = Omit<OpenAICompatibleOptions, "baseURL" | "provider" | "sendStore"> & {
  /** Defaults to `https://api.moonshot.ai/v1`, Kimi's documented API. */
  readonly baseURL?: string;
};

/**
 * Creates a provider for Kimi (Moonshot AI): the OpenAI-compatible adapter
 * with Kimi's base URL, tagged `"kimi"`. Thinking models' `reasoning_content`
 * is kept and sent back as-is, as Kimi requires for tool calls and
 * multi-turn chats.
 *
 * @example
 * ```ts
 * import { createKimi } from "@hussmartinez/ai-core/openai-compatible";
 *
 * const provider = createKimi({ apiKey: () => process.env.MOONSHOT_API_KEY ?? "", model: "kimi-k3.1-pro" });
 * ```
 *
 * @public
 */
export function createKimi(options: KimiOptions): AiProvider {
  return createOpenAICompatible({
    ...options,
    baseURL: options.baseURL ?? "https://api.moonshot.ai/v1",
    provider: "kimi",
    // Kimi doesn't document `store`; a store from providerOptions still
    // isn't sent (ADR 0008).
    sendStore: false,
  });
}

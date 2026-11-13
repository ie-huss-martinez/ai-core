import type { AiFinishReason, AiJsonValue, AiMessage, AiPart, AiUsage } from "./message.js";

/**
 * A tool the model may call. Its name follows Anthropic's documented rule,
 * `^[a-zA-Z0-9_-]{1,128}$` (ADR 0002).
 *
 * @public
 */
export interface AiTool {
  readonly name: string;
  /** What the tool does and when to use it. Models rely on it heavily. */
  readonly description?: string;
  /** A JSON Schema for the tool's input. */
  readonly inputSchema: AiJsonValue;
}

/**
 * Whether the model may call tools: `auto`, the default, or `none`. Forcing a
 * tool isn't part of the common request, because current Anthropic models
 * reject it (ADR 0002). Use `providerOptions` where a provider supports it.
 *
 * @public
 */
export type AiToolChoice = "auto" | "none";

/**
 * One call to a provider (ADR 0002).
 *
 * @public
 */
export interface AiRequest {
  /** The conversation so far, ending with the message to answer. */
  readonly messages: readonly AiMessage[];
  /** The system prompt. Keep it the same for a whole conversation. */
  readonly system?: string;
  /** Tools the model may call. Keep them the same for a whole conversation. */
  readonly tools?: readonly AiTool[];
  readonly toolChoice?: AiToolChoice;
  /** The model, instead of the adapter's default. */
  readonly model?: string;
  /** The output budget, instead of the adapter's default. */
  readonly maxOutputTokens?: number;
  /**
   * Options for one provider, keyed by its name, such as
   * `{ anthropic: { … } }`. An adapter merges only its own entry into the
   * provider's request body. They're unvalidated, can't change the endpoint,
   * headers or key, and are never logged.
   */
  readonly providerOptions?: { readonly [provider: string]: unknown };
}

/**
 * Options for one call.
 *
 * @public
 */
export interface AiCallOptions {
  /** Aborting it cancels the call, which then fails with `ABORTED`. */
  readonly signal?: AbortSignal;
}

/**
 * The result of {@link AiProvider.complete}.
 *
 * @public
 */
export interface AiResult {
  /** The model's message. */
  readonly message: AiMessage & { readonly role: "assistant" };
  readonly finishReason: AiFinishReason;
  /** The provider's own finish reason, for diagnostics. */
  readonly rawFinishReason?: string;
  readonly usage: AiUsage;
}

/**
 * A piece of text, in order, from a `text` part being streamed.
 *
 * @public
 */
export interface AiTextDeltaEvent {
  readonly type: "text-delta";
  readonly text: string;
}

/**
 * A piece of a `provider-state` part's `summary`, where the provider streams
 * one.
 *
 * @public
 */
export interface AiSummaryDeltaEvent {
  readonly type: "summary-delta";
  readonly text: string;
}

/**
 * A complete part, once it's finished and parsed. Collecting every `part`
 * event gives the message `complete()` returns.
 *
 * @public
 */
export interface AiPartEvent {
  readonly type: "part";
  readonly part: AiPart;
}

/**
 * The last event of a successful stream, exactly once.
 *
 * @public
 */
export interface AiFinishEvent {
  readonly type: "finish";
  readonly finishReason: AiFinishReason;
  readonly rawFinishReason?: string;
  readonly usage: AiUsage;
}

/**
 * An event of {@link AiProvider.stream} (ADR 0002). Errors aren't events: the
 * stream's iterator throws an {@link AiError}.
 *
 * @public
 */
export type AiEvent = AiTextDeltaEvent | AiSummaryDeltaEvent | AiPartEvent | AiFinishEvent;

/**
 * The shape every provider has: each adapter, the browser transport, the
 * fake provider and any custom provider (ADR 0002). SDK ports match it
 * structurally, so an `AiProvider` can be passed to an SDK without the SDK
 * importing ai-core.
 *
 * @public
 */
export interface AiProvider {
  /** The name its `provider-state` is tagged with, such as `"anthropic"`. */
  readonly provider: string;
  /**
   * Sends one call and resolves to the whole result.
   *
   * @throws {@link AiError}, such as `ABORTED` when the signal aborts.
   */
  complete(request: AiRequest, options?: AiCallOptions): Promise<AiResult>;
  /**
   * Sends one call and streams its events. Leaving the loop early cancels
   * the call without an error. A stream can be iterated once.
   */
  stream(request: AiRequest, options?: AiCallOptions): AsyncIterable<AiEvent>;
}

/**
 * A JSON value. Provider state and tool inputs are JSON, so a conversation
 * can be stored and sent as JSON (ADR 0001).
 *
 * @public
 */
export type AiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AiJsonValue[]
  | { readonly [key: string]: AiJsonValue };

/**
 * Opaque state a provider requires back unchanged, attached to a part
 * (ADR 0001), such as Gemini's thought signature on a function call. Only
 * the adapter named by `provider` reads `data`. Everything else keeps it as
 * it is, never displays it, and never sends it to another provider.
 *
 * @public
 */
export interface AiProviderState {
  /** The name of the provider that produced it, such as `"gemini"`. */
  readonly provider: string;
  /** The state, exactly as the adapter produced it. */
  readonly data: AiJsonValue;
}

/**
 * Text. From a model, it's untrusted text, never markup.
 *
 * @public
 */
export interface AiTextPart {
  readonly type: "text";
  readonly text: string;
  /** State the provider attached to this part, replayed unchanged. */
  readonly providerState?: AiProviderState;
}

/**
 * The image media types the message model accepts.
 *
 * @public
 */
export type AiImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * An image, as bytes. There's no URL form, so a provider is never asked to
 * fetch an address (ADR 0001).
 *
 * @public
 */
export interface AiImagePart {
  readonly type: "image";
  readonly mediaType: AiImageMediaType;
  readonly data: Uint8Array;
}

/**
 * A tool call the model made. It's reported, never executed: running it is
 * the host's decision (ADR 0001, sdk-core ADR 0035).
 *
 * @public
 */
export interface AiToolCallPart {
  readonly type: "tool-call";
  /** The provider's ID for the call, which the tool result refers to. */
  readonly id: string;
  /** The tool's name, from the request's tools. */
  readonly name: string;
  /** The parsed JSON arguments. Untrusted: validate before using them. */
  readonly input: AiJsonValue;
  /** State the provider attached to this part, replayed unchanged. */
  readonly providerState?: AiProviderState;
}

/**
 * The result of a tool call, sent in a `user` message.
 *
 * @public
 */
export interface AiToolResultPart {
  readonly type: "tool-result";
  /** The `id` of the tool call this answers. */
  readonly callId: string;
  /** The result, as text, or as text and images. */
  readonly content: string | readonly (AiTextPart | AiImagePart)[];
  /** Whether the tool failed. */
  readonly isError?: boolean;
}

/**
 * State a provider requires back unchanged that isn't a part of its own kind,
 * such as Anthropic's thinking blocks or Kimi's `reasoning_content`
 * (ADR 0001).
 *
 * Keep it in the conversation exactly as received. `data` is opaque: never
 * display, edit, reorder or drop it. `summary` is readable text about the
 * model's reasoning that some providers return. It's untrusted text, which a
 * host may display, and editing it changes nothing that's replayed.
 *
 * @public
 */
export interface AiProviderStatePart {
  readonly type: "provider-state";
  /** The name of the provider that produced it, such as `"anthropic"`. */
  readonly provider: string;
  /** The state, exactly as the adapter produced it. */
  readonly data: AiJsonValue;
  /** Readable text about the model's reasoning, if the provider returned any. */
  readonly summary?: string;
}

/**
 * One part of a message.
 *
 * @public
 */
export type AiPart =
  | AiTextPart
  | AiImagePart
  | AiToolCallPart
  | AiToolResultPart
  | AiProviderStatePart;

/**
 * Who a message is from. The system prompt isn't a message: it's a field of
 * the request, which the server sets (ADR 0001).
 *
 * @public
 */
export type AiRole = "user" | "assistant";

/**
 * A message in a conversation. Keep conversations append-only, replaying
 * every message and part as returned (ADR 0001).
 *
 * @public
 */
export interface AiMessage {
  readonly role: AiRole;
  readonly parts: readonly AiPart[];
}

/**
 * Why the model stopped (ADR 0001):
 *
 * - `stop`: it finished.
 * - `length`: output was cut off by a limit, such as `maxOutputTokens`.
 * - `tool-calls`: the message ends with tool calls for the host to handle.
 * - `refusal`: the model declined. This isn't an error.
 * - `other`: something else. `rawFinishReason` has the provider's value.
 *
 * @public
 */
export type AiFinishReason = "stop" | "length" | "tool-calls" | "refusal" | "other";

/**
 * Token usage. Fields a provider doesn't report are absent, never zero.
 *
 * @public
 */
export interface AiUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

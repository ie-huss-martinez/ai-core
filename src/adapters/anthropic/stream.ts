import { AiError } from "../../core/errors/ai-error.js";
import { providerError } from "../../core/errors/provider-errors.js";
import type { AiFinishReason, AiJsonValue, AiUsage } from "../../core/model/message.js";
import type { AiEvent } from "../../core/model/provider.js";
import type { SseEvent } from "../../core/sse/sse-parser.js";
import { parseEventData } from "../../core/stream/read-sse-events.js";
import { errorTypeFailure } from "./errors.js";
import { ANTHROPIC } from "./request.js";

type Json = { readonly [key: string]: AiJsonValue };

type MutableUsage = { -readonly [Key in keyof AiUsage]: AiUsage[Key] };

type OpenBlock =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "thinking"; thinking: string; signature: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; json: string }
  | { readonly kind: "opaque"; readonly block: Json };

/** Anthropic's stop reasons, as ai-core's finish reasons (ADR 0001). */
const FINISH: Readonly<Record<string, AiFinishReason>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool-calls",
  refusal: "refusal",
};

function invalid(message: string): AiError {
  return new AiError("PROVIDER_RESPONSE_INVALID", message, { details: { retryable: false } });
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Maps the events of one Messages API stream to ai-core's events (ADR 0001,
 * ADR 0002, ADR 0005), checking their order as it goes:
 *
 * - `text` blocks stream `text-delta` events, then a `text` part;
 * - `thinking` blocks stream their readable text as `summary-delta` events,
 *   then a `provider-state` part whose `data` is the exact block, signature
 *   included, to replay unchanged;
 * - `redacted_thinking` and block types it doesn't know arrive whole, and
 *   become `provider-state` parts, so a replay stays valid;
 * - `tool_use` blocks become `tool-call` parts once their JSON input is
 *   complete;
 * - usage is cumulative, so the last report wins;
 * - `ping` events, `citations_delta` and unknown events are ignored, as
 *   Anthropic asks.
 *
 * @internal
 */
export class AnthropicStream {
  /** Whether `message_stop` arrived: anything earlier is a truncated stream. */
  finished = false;

  #started = false;
  readonly #open = new Map<number, OpenBlock>();
  readonly #closed = new Set<number>();
  #stopReason: string | undefined;
  #usage: MutableUsage = {};

  /**
   * Maps one server-sent event.
   *
   * @param partial - Whether events were already delivered, for a provider
   *   error's `details`.
   * @throws {@link AiError} for a provider error event, or an impossible
   *   order of events.
   */
  push(event: SseEvent, partial: boolean): AiEvent[] {
    if (this.finished) {
      return [];
    }
    const data = parseEventData(event);
    if (!isObject(data)) {
      throw invalid("An event's data isn't an object.");
    }
    switch (data["type"]) {
      case "message_start":
        return this.#messageStart(data);
      case "content_block_start":
        return this.#blockStart(data);
      case "content_block_delta":
        return this.#blockDelta(data);
      case "content_block_stop":
        return this.#blockStop(data);
      case "message_delta":
        this.#messageDelta(data);
        return [];
      case "message_stop":
        return this.#messageStop();
      case "error": {
        const error = isObject(data["error"]) ? data["error"] : {};
        throw providerError(
          { providerType: text(error["type"]), partial },
          errorTypeFailure(text(error["type"])),
        );
      }
      default:
        // ping, and event types added after this adapter.
        return [];
    }
  }

  #requireStarted(): void {
    if (!this.#started) {
      throw invalid("A content event arrived before message_start.");
    }
  }

  #index(data: Json): number {
    const index = data["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw invalid("A content event has no valid index.");
    }
    return index;
  }

  #messageStart(data: Json): AiEvent[] {
    if (this.#started) {
      throw invalid("A second message_start arrived.");
    }
    this.#started = true;
    const message = isObject(data["message"]) ? data["message"] : {};
    this.#readUsage(message["usage"]);
    return [];
  }

  #blockStart(data: Json): AiEvent[] {
    this.#requireStarted();
    const index = this.#index(data);
    if (this.#open.has(index) || this.#closed.has(index)) {
      throw invalid("A content block started twice.");
    }
    const block = data["content_block"];
    if (!isObject(block)) {
      throw invalid("content_block_start has no content block.");
    }
    switch (block["type"]) {
      case "text": {
        const initial = text(block["text"]);
        this.#open.set(index, { kind: "text", text: initial });
        return initial ? [{ type: "text-delta", text: initial }] : [];
      }
      case "thinking":
        this.#open.set(index, {
          kind: "thinking",
          thinking: text(block["thinking"]),
          signature: text(block["signature"]),
        });
        return [];
      case "tool_use": {
        const id = text(block["id"]);
        const name = text(block["name"]);
        if (!id || !name) {
          throw invalid("A tool_use block has no id or name.");
        }
        this.#open.set(index, { kind: "tool", id, name, json: "" });
        return [];
      }
      default:
        // redacted_thinking, server tool blocks and types added later arrive
        // whole, and go back unchanged.
        this.#open.set(index, { kind: "opaque", block });
        return [];
    }
  }

  #blockDelta(data: Json): AiEvent[] {
    this.#requireStarted();
    const open = this.#open.get(this.#index(data));
    if (!open) {
      throw invalid("A delta arrived for a block that isn't open.");
    }
    const delta = isObject(data["delta"]) ? data["delta"] : {};
    switch (delta["type"]) {
      case "text_delta": {
        if (open.kind !== "text") {
          throw invalid("A text_delta arrived for a block that isn't text.");
        }
        const piece = text(delta["text"]);
        open.text += piece;
        return piece ? [{ type: "text-delta", text: piece }] : [];
      }
      case "thinking_delta": {
        if (open.kind !== "thinking") {
          throw invalid("A thinking_delta arrived for a block that isn't thinking.");
        }
        const piece = text(delta["thinking"]);
        open.thinking += piece;
        return piece ? [{ type: "summary-delta", text: piece }] : [];
      }
      case "signature_delta":
        if (open.kind !== "thinking") {
          throw invalid("A signature_delta arrived for a block that isn't thinking.");
        }
        open.signature = text(delta["signature"]);
        return [];
      case "input_json_delta":
        if (open.kind !== "tool") {
          throw invalid("An input_json_delta arrived for a block that isn't a tool call.");
        }
        open.json += text(delta["partial_json"]);
        return [];
      default:
        // citations_delta, and delta types added later.
        return [];
    }
  }

  #blockStop(data: Json): AiEvent[] {
    this.#requireStarted();
    const index = this.#index(data);
    const open = this.#open.get(index);
    if (!open) {
      throw invalid("content_block_stop arrived for a block that isn't open.");
    }
    this.#open.delete(index);
    this.#closed.add(index);
    switch (open.kind) {
      case "text":
        return [{ type: "part", part: { type: "text", text: open.text } }];
      case "thinking":
        return [
          {
            type: "part",
            part: {
              type: "provider-state",
              provider: ANTHROPIC,
              data: { type: "thinking", thinking: open.thinking, signature: open.signature },
              ...(open.thinking ? { summary: open.thinking } : {}),
            },
          },
        ];
      case "opaque":
        return [
          { type: "part", part: { type: "provider-state", provider: ANTHROPIC, data: open.block } },
        ];
      case "tool": {
        let input: AiJsonValue;
        try {
          input = open.json === "" ? {} : (JSON.parse(open.json) as AiJsonValue);
        } catch {
          throw invalid("A tool call's input isn't valid JSON.");
        }
        return [{ type: "part", part: { type: "tool-call", id: open.id, name: open.name, input } }];
      }
    }
  }

  #messageDelta(data: Json): void {
    this.#requireStarted();
    const delta = isObject(data["delta"]) ? data["delta"] : {};
    if (typeof delta["stop_reason"] === "string") {
      this.#stopReason = delta["stop_reason"];
    }
    this.#readUsage(data["usage"]);
  }

  #messageStop(): AiEvent[] {
    this.#requireStarted();
    if (this.#open.size > 0) {
      throw invalid("message_stop arrived with a content block still open.");
    }
    this.finished = true;
    return [
      {
        type: "finish",
        finishReason: (this.#stopReason && FINISH[this.#stopReason]) || "other",
        ...(this.#stopReason === undefined ? {} : { rawFinishReason: this.#stopReason }),
        usage: this.#currentUsage(),
      },
    ];
  }

  /** Anthropic's usage is cumulative, so each report replaces the last. */
  #readUsage(value: unknown): void {
    if (!isObject(value)) {
      return;
    }
    const set = (key: keyof MutableUsage, raw: unknown) => {
      const parsed = count(raw);
      if (parsed !== undefined) {
        this.#usage[key] = parsed;
      }
    };
    set("inputTokens", value["input_tokens"]);
    set("outputTokens", value["output_tokens"]);
    set("cacheReadTokens", value["cache_read_input_tokens"]);
    set("cacheWriteTokens", value["cache_creation_input_tokens"]);
    const details = value["output_tokens_details"];
    if (isObject(details)) {
      set("reasoningTokens", details["thinking_tokens"]);
    }
  }

  #currentUsage(): AiUsage {
    return { ...this.#usage };
  }
}

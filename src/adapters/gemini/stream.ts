import { AiError, type AiErrorCode } from "../../core/errors/ai-error.js";
import { classifyStatus, providerError } from "../../core/errors/provider-errors.js";
import type { AiFinishReason, AiJsonValue, AiUsage } from "../../core/model/message.js";
import type { AiEvent } from "../../core/model/provider.js";
import type { SseEvent } from "../../core/sse/sse-parser.js";
import { parseEventData } from "../../core/stream/read-sse-events.js";
import type { StreamMapper } from "../shared/streaming-call.js";
import { GEMINI } from "./request.js";

type Json = { readonly [key: string]: AiJsonValue };
type MutableUsage = { -readonly [Key in keyof AiUsage]: AiUsage[Key] };

type OpenStep =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "thought"; summary: string; signature: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      arguments: string;
      readonly initial: AiJsonValue | undefined;
    }
  | { readonly kind: "opaque"; readonly step: Json };

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function invalid(message: string): AiError {
  return new AiError("PROVIDER_RESPONSE_INVALID", message, { details: { retryable: false } });
}

/** Google's error codes, as the HTTP status each corresponds to. */
const STATUS_OF_CODE: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  resource_exhausted: 429,
  internal: 500,
  unavailable: 503,
  deadline_exceeded: 504,
  gateway_timeout: 504,
};

/**
 * The code and retryability for one of Google's error codes, as for its HTTP
 * status. An unknown code is `PROVIDER_ERROR` and not retryable.
 *
 * @internal
 */
export function errorCodeFailure(code: string): readonly [AiErrorCode, boolean] {
  const status = STATUS_OF_CODE[code.toLowerCase()];
  return status === undefined ? ["PROVIDER_ERROR", false] : classifyStatus(status);
}

/**
 * Maps a stream of Gemini's Interactions API to ai-core's events (ADR 0001,
 * ADR 0002, ADR 0005), checking the order of its steps:
 *
 * - `thought` steps stream their summary as `summary-delta` events (both the
 *   documented `thought_summary` delta and the `thought` spelling one page
 *   uses), take their signature from the `thought_signature` delta, and
 *   become `provider-state` parts to send back unchanged;
 * - `model_output` steps stream `text` deltas, then a `text` part;
 * - `function_call` steps join their `arguments` deltas, then become
 *   `tool-call` parts with Gemini's own call ID;
 * - step types it doesn't know are kept whole as `provider-state`, so a
 *   replay stays valid;
 * - `interaction.completed` ends the stream with its status and usage, and
 *   `error` or `interaction.error` events fail it.
 *
 * @internal
 */
export class InteractionsStream implements StreamMapper {
  finished = false;

  readonly #open = new Map<number, OpenStep>();
  readonly #closed = new Set<number>();
  #toolCalls = 0;

  push(event: SseEvent, partial: boolean): AiEvent[] {
    if (this.finished) {
      return [];
    }
    const data = parseEventData(event);
    if (!isObject(data)) {
      throw invalid("An event's data isn't an object.");
    }
    const type = text(data["event_type"]) || event.event;
    switch (type) {
      case "step.start":
        return this.#start(data);
      case "step.delta":
        return this.#delta(data);
      case "step.stop":
        return this.#stop(data);
      case "interaction.completed":
        return this.#completed(data, partial);
      case "error":
      case "interaction.error": {
        const error = isObject(data["error"]) ? data["error"] : {};
        const code = text(error["code"]) || text(error["status"]);
        throw providerError({ providerType: code, partial }, errorCodeFailure(code));
      }
      default:
        // interaction.created, status updates and event types added later.
        return [];
    }
  }

  #index(data: Json): number {
    const index = data["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw invalid("A step event has no valid index.");
    }
    return index;
  }

  #start(data: Json): AiEvent[] {
    const index = this.#index(data);
    if (this.#open.has(index) || this.#closed.has(index)) {
      throw invalid("A step started twice.");
    }
    const step = isObject(data["step"]) ? data["step"] : {};
    switch (step["type"]) {
      case "model_output":
        this.#open.set(index, { kind: "text", text: "" });
        return [];
      case "thought":
        this.#open.set(index, { kind: "thought", summary: "", signature: text(step["signature"]) });
        return [];
      case "function_call": {
        const id = text(step["id"]);
        const name = text(step["name"]);
        if (!id || !name) {
          throw invalid("A function_call step has no id or name.");
        }
        const initial = step["arguments"];
        this.#open.set(index, {
          kind: "tool",
          id,
          name,
          arguments: typeof initial === "string" ? initial : "",
          initial: isObject(initial) ? initial : undefined,
        });
        return [];
      }
      default:
        this.#open.set(index, { kind: "opaque", step });
        return [];
    }
  }

  #delta(data: Json): AiEvent[] {
    const open = this.#open.get(this.#index(data));
    if (!open) {
      throw invalid("A delta arrived for a step that isn't open.");
    }
    const delta = isObject(data["delta"]) ? data["delta"] : {};
    switch (delta["type"]) {
      case "text": {
        if (open.kind !== "text") {
          throw invalid("A text delta arrived for a step that isn't model output.");
        }
        const piece = text(delta["text"]);
        open.text += piece;
        return piece ? [{ type: "text-delta", text: piece }] : [];
      }
      case "thought_summary":
      case "thought": {
        if (open.kind !== "thought") {
          throw invalid("A thought delta arrived for a step that isn't a thought.");
        }
        // The thinking guide documents thought_summary with content.text; one
        // page uses thought with text. Both mean the same.
        const content = isObject(delta["content"]) ? delta["content"] : {};
        const piece = text(content["text"]) || text(delta["text"]);
        open.summary += piece;
        return piece ? [{ type: "summary-delta", text: piece }] : [];
      }
      case "thought_signature":
        if (open.kind !== "thought") {
          throw invalid("A thought_signature arrived for a step that isn't a thought.");
        }
        open.signature = text(delta["signature"]);
        return [];
      case "arguments":
        if (open.kind !== "tool") {
          throw invalid("An arguments delta arrived for a step that isn't a function call.");
        }
        open.arguments += text(delta["partial_arguments"]);
        return [];
      default:
        return [];
    }
  }

  #stop(data: Json): AiEvent[] {
    const index = this.#index(data);
    const open = this.#open.get(index);
    if (!open) {
      throw invalid("step.stop arrived for a step that isn't open.");
    }
    this.#open.delete(index);
    this.#closed.add(index);
    switch (open.kind) {
      case "text":
        return open.text === "" ? [] : [{ type: "part", part: { type: "text", text: open.text } }];
      case "thought": {
        const step: Record<string, AiJsonValue> = { type: "thought", signature: open.signature };
        if (open.summary) {
          step["summary"] = [{ type: "text", text: open.summary }];
        }
        return [
          {
            type: "part",
            part: {
              type: "provider-state",
              provider: GEMINI,
              data: step,
              ...(open.summary ? { summary: open.summary } : {}),
            },
          },
        ];
      }
      case "tool": {
        let input: AiJsonValue;
        try {
          input =
            open.arguments !== ""
              ? (JSON.parse(open.arguments) as AiJsonValue)
              : (open.initial ?? {});
        } catch {
          throw invalid("A function call's arguments aren't valid JSON.");
        }
        this.#toolCalls += 1;
        return [{ type: "part", part: { type: "tool-call", id: open.id, name: open.name, input } }];
      }
      case "opaque":
        return [
          { type: "part", part: { type: "provider-state", provider: GEMINI, data: open.step } },
        ];
    }
  }

  #completed(data: Json, partial: boolean): AiEvent[] {
    if (this.#open.size > 0) {
      throw invalid("interaction.completed arrived with a step still open.");
    }
    const interaction = isObject(data["interaction"]) ? data["interaction"] : {};
    const status = text(interaction["status"]);
    if (status === "failed") {
      throw providerError({ providerType: "failed", partial }, ["PROVIDER_ERROR", true]);
    }
    this.finished = true;
    const finishReason: AiFinishReason =
      status === "requires_action" || (status === "completed" && this.#toolCalls > 0)
        ? "tool-calls"
        : status === "completed"
          ? "stop"
          : status === "incomplete" || status === "requires_continuation"
            ? "length"
            : "other";
    const usage: MutableUsage = {};
    if (isObject(interaction["usage"])) {
      const raw = interaction["usage"];
      const set = (key: keyof MutableUsage, value: unknown) => {
        const parsed = count(value);
        if (parsed !== undefined) {
          usage[key] = parsed;
        }
      };
      set("inputTokens", raw["total_input_tokens"]);
      set("outputTokens", raw["total_output_tokens"]);
      set("reasoningTokens", raw["total_thought_tokens"]);
    }
    return [
      {
        type: "finish",
        finishReason,
        ...(status ? { rawFinishReason: status } : {}),
        usage,
      },
    ];
  }
}

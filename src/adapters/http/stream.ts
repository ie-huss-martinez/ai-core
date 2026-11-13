import { deserializeError } from "@hussmartinez/sdk-core";
import { AiError, isAiError } from "../../core/errors/ai-error.js";
import type { AiFinishReason, AiUsage } from "../../core/model/message.js";
import type { AiEvent } from "../../core/model/provider.js";
import { AI_CORE_PROTOCOL, decodePart } from "../../core/protocol/wire.js";
import type { SseEvent } from "../../core/sse/sse-parser.js";
import { parseEventData } from "../../core/stream/read-sse-events.js";
import type { StreamMapper } from "../shared/streaming-call.js";

type Json = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FINISH_REASONS: ReadonlySet<string> = new Set<AiFinishReason>([
  "stop",
  "length",
  "tool-calls",
  "refusal",
  "other",
]);

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

function invalid(message: string): AiError {
  return new AiError("PROVIDER_RESPONSE_INVALID", message, { details: { retryable: false } });
}

/**
 * The protocol mismatch error, the same on both sides of the wire.
 *
 * @internal
 */
export function protocolMismatch(): AiError {
  return new AiError(
    "PROTOCOL_MISMATCH",
    "The handler speaks another version of the ai-core protocol.",
    { details: { supported: [AI_CORE_PROTOCOL], retryable: false } },
  );
}

/**
 * Rebuilds an error the handler sent, as an {@link AiError}. Anything else,
 * which the handler never sends, is `PROVIDER_RESPONSE_INVALID`.
 *
 * @internal
 */
export function handlerError(data: unknown): AiError {
  const error = deserializeError(data, { errorClasses: { AiError } });
  return isAiError(error) ? error : invalid("The handler sent an error that isn't an AiError.");
}

function text(data: Json): string {
  if (typeof data["text"] !== "string") {
    throw invalid("A delta event has no text.");
  }
  return data["text"];
}

function usage(value: unknown): AiUsage {
  if (!isObject(value)) {
    throw invalid("A finish event has no usage.");
  }
  const result: { -readonly [Key in keyof AiUsage]: AiUsage[Key] } = {};
  for (const field of USAGE_FIELDS) {
    const count = value[field];
    if (count === undefined) {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw invalid("A finish event's usage isn't a set of token counts.");
    }
    result[field] = count;
  }
  return result;
}

/**
 * Maps the handler's `ai-core/1` events back to ai-core's events (ADR 0003),
 * checking them as hostile input like any provider's (ADR 0005): `start`
 * first, with the same protocol version, then deltas, parts checked against
 * the message model, and `finish` or an `error`. Unknown event types are
 * ignored.
 *
 * @internal
 */
export class WireStream implements StreamMapper {
  finished = false;
  #started = false;

  push(event: SseEvent, _partial: boolean): AiEvent[] {
    if (this.finished) {
      return [];
    }
    const data = parseEventData(event);
    if (!isObject(data)) {
      throw invalid("An event's data isn't an object.");
    }
    if (!this.#started) {
      if (event.event !== "start") {
        throw invalid("The stream didn't begin with a start event.");
      }
      if (data["protocol"] !== AI_CORE_PROTOCOL) {
        throw protocolMismatch();
      }
      this.#started = true;
      return [];
    }
    switch (event.event) {
      case "text-delta":
        return [{ type: "text-delta", text: text(data) }];
      case "summary-delta":
        return [{ type: "summary-delta", text: text(data) }];
      case "part":
        try {
          return [{ type: "part", part: decodePart(data["part"], "part") }];
        } catch {
          throw invalid("A part event doesn't match the message model.");
        }
      case "finish": {
        const finishReason = data["finishReason"];
        const raw = data["rawFinishReason"];
        if (typeof finishReason !== "string" || !FINISH_REASONS.has(finishReason)) {
          throw invalid("A finish event has no valid finishReason.");
        }
        if (raw !== undefined && typeof raw !== "string") {
          throw invalid("A finish event's rawFinishReason isn't a string.");
        }
        this.finished = true;
        return [
          {
            type: "finish",
            finishReason: finishReason as AiFinishReason,
            ...(raw === undefined ? {} : { rawFinishReason: raw }),
            usage: usage(data["usage"]),
          },
        ];
      }
      case "error":
        throw handlerError(data);
      case "start":
        throw invalid("The stream started twice.");
      default:
        return [];
    }
  }
}

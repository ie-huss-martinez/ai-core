import { deserializeError } from "@hussmartinez/sdk-core";
import { AiError, isAiError } from "../../core/errors/ai-error.js";
import type { AiFinishReason, AiUsage } from "../../core/model/message.js";
import type { AiEvent } from "../../core/model/provider.js";
import { AI_CORE_PROTOCOL, decodePart, protocolMismatch } from "../../core/protocol/wire.js";
import type { SseEvent } from "../../core/sse/sse-parser.js";
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

/**
 * Why the handler's stream was refused: a stable token in `details.reason`
 * (sdk-core ADR 0045), listed in `docs/formats/hm-ai-protocol.md`.
 *
 * @internal
 */
export type StreamReason =
  | "invalid-event-data"
  | "missing-start"
  | "duplicate-start"
  | "invalid-delta"
  | "invalid-part"
  | "invalid-finish"
  | "invalid-usage"
  | "unknown-error";

function invalid(message: string, reason: StreamReason): AiError {
  return new AiError("PROVIDER_RESPONSE_INVALID", message, {
    details: { reason, retryable: false },
  });
}

/**
 * Rebuilds an error the handler sent, as an {@link AiError}. Anything else,
 * which the handler never sends, is `PROVIDER_RESPONSE_INVALID`.
 *
 * @internal
 */
export function handlerError(data: unknown): AiError {
  const error = deserializeError(data, { errorClasses: { AiError } });
  return isAiError(error)
    ? error
    : invalid("The handler sent an error that isn't an AiError.", "unknown-error");
}

function text(data: Json): string {
  if (typeof data["text"] !== "string") {
    throw invalid("A delta event has no text.", "invalid-delta");
  }
  return data["text"];
}

function usage(value: unknown): AiUsage {
  if (!isObject(value)) {
    throw invalid("A finish event has no usage.", "invalid-usage");
  }
  const result: { -readonly [Key in keyof AiUsage]: AiUsage[Key] } = {};
  for (const field of USAGE_FIELDS) {
    const count = value[field];
    if (count === undefined) {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw invalid("A finish event's usage isn't a set of token counts.", "invalid-usage");
    }
    result[field] = count;
  }
  return result;
}

/**
 * Maps the handler's `ai-core/1` events back to ai-core's events (ADR 0003),
 * checking them as hostile input like any provider's (ADR 0005), as
 * `formats/hm-ai-protocol/v1.schema.json` describes:
 *
 * - `start` first, with the same protocol version, and only once;
 * - deltas with their text, parts checked against the message model, and
 *   `finish` with a known reason and token counts;
 * - an `error` event rebuilt as the handler's `AiError`;
 * - event types it doesn't know, and fields it doesn't know within the
 *   events it does, are ignored, so a later minor version can add them
 *   while pages still run the previous release's transport.
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
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      // The parser's message can quote the data, so it isn't kept.
      throw invalid("An event's data isn't valid JSON.", "invalid-event-data");
    }
    if (!isObject(data)) {
      throw invalid("An event's data isn't an object.", "invalid-event-data");
    }
    if (!this.#started) {
      if (event.event !== "start") {
        throw invalid("The stream didn't begin with a start event.", "missing-start");
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
          throw invalid("A part event doesn't match the message model.", "invalid-part");
        }
      case "finish": {
        const finishReason = data["finishReason"];
        const raw = data["rawFinishReason"];
        if (typeof finishReason !== "string" || !FINISH_REASONS.has(finishReason)) {
          throw invalid("A finish event has no valid finishReason.", "invalid-finish");
        }
        if (raw !== undefined && typeof raw !== "string") {
          throw invalid("A finish event's rawFinishReason isn't a string.", "invalid-finish");
        }
        const counts = usage(data["usage"]);
        this.finished = true;
        return [
          {
            type: "finish",
            finishReason: finishReason as AiFinishReason,
            ...(raw === undefined ? {} : { rawFinishReason: raw }),
            usage: counts,
          },
        ];
      }
      case "error":
        throw handlerError(data);
      case "start":
        throw invalid("The stream started twice.", "duplicate-start");
      default:
        return [];
    }
  }
}

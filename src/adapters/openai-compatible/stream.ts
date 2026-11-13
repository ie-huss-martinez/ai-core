import { AiError } from "../../core/errors/ai-error.js";
import { providerError } from "../../core/errors/provider-errors.js";
import type { AiFinishReason, AiJsonValue, AiPart, AiUsage } from "../../core/model/message.js";
import type { AiEvent } from "../../core/model/provider.js";
import type { SseEvent } from "../../core/sse/sse-parser.js";
import { parseEventData } from "../../core/stream/read-sse-events.js";
import type { StreamMapper } from "../shared/streaming-call.js";

type Json = { readonly [key: string]: AiJsonValue };
type MutableUsage = { -readonly [Key in keyof AiUsage]: AiUsage[Key] };

/** Chat Completions' finish reasons, as ai-core's (ADR 0001). */
const FINISH: Readonly<Record<string, AiFinishReason>> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "refusal",
};

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function invalid(message: string): AiError {
  return new AiError("PROVIDER_RESPONSE_INVALID", message, { details: { retryable: false } });
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Maps a Chat Completions stream to ai-core's events (ADR 0001, ADR 0002,
 * ADR 0005), for OpenAI and the APIs compatible with it, such as Kimi:
 *
 * - `delta.reasoning_content`, which Kimi streams before the answer, becomes
 *   `summary-delta` events, then a `provider-state` part tagged with this
 *   adapter's provider, to send back as Kimi requires;
 * - `delta.content` and `delta.refusal` become `text-delta` events, then a
 *   `text` part;
 * - `delta.tool_calls` fragments are joined by `index`, and become
 *   `tool-call` parts once the choice finishes;
 * - usage arrives in a final chunk with no choices, and only when
 *   `stream_options.include_usage` is set;
 * - `data: [DONE]` ends the stream: anything earlier is truncated.
 *
 * Only the first choice is read: requests never ask for more.
 *
 * @internal
 */
export class ChatCompletionsStream implements StreamMapper {
  finished = false;

  readonly #provider: string;
  #reasoning = "";
  #text = "";
  readonly #calls = new Map<number, ToolCall>();
  #finishReason: string | undefined;
  #refused = false;
  #usage: MutableUsage = {};

  constructor(provider: string) {
    this.#provider = provider;
  }

  push(event: SseEvent, partial: boolean): AiEvent[] {
    if (this.finished) {
      return [];
    }
    if (event.data === "[DONE]") {
      return this.#done();
    }
    const data = parseEventData(event);
    if (!isObject(data)) {
      throw invalid("A chunk isn't an object.");
    }
    if (isObject(data["error"])) {
      // Some compatible APIs report a failure as a chunk mid-stream.
      throw providerError({ providerType: text(data["error"]["type"]), partial }, [
        "PROVIDER_ERROR",
        false,
      ]);
    }
    this.#readUsage(data["usage"]);
    const choices = Array.isArray(data["choices"]) ? data["choices"] : [];
    const choice = choices.find((item) => isObject(item) && (item["index"] ?? 0) === 0);
    if (!isObject(choice)) {
      return [];
    }
    const events = this.#delta(isObject(choice["delta"]) ? choice["delta"] : {});
    if (typeof choice["finish_reason"] === "string") {
      this.#finishReason = choice["finish_reason"];
    }
    return events;
  }

  #delta(delta: Json): AiEvent[] {
    const events: AiEvent[] = [];
    const reasoning = text(delta["reasoning_content"]);
    if (reasoning) {
      events.push(...this.#closeText());
      this.#reasoning += reasoning;
      events.push({ type: "summary-delta", text: reasoning });
    }
    const content = text(delta["content"]) + text(delta["refusal"]);
    if (delta["refusal"]) {
      this.#refused = true;
    }
    if (content) {
      events.push(...this.#closeReasoning());
      this.#text += content;
      events.push({ type: "text-delta", text: content });
    }
    if (Array.isArray(delta["tool_calls"])) {
      events.push(...this.#closeReasoning(), ...this.#closeText());
      for (const fragment of delta["tool_calls"]) {
        this.#toolFragment(fragment);
      }
    }
    return events;
  }

  #toolFragment(fragment: unknown): void {
    if (!isObject(fragment) || typeof fragment["index"] !== "number") {
      throw invalid("A tool call fragment has no index.");
    }
    const fn = isObject(fragment["function"]) ? fragment["function"] : {};
    const call = this.#calls.get(fragment["index"]) ?? { id: "", name: "", arguments: "" };
    call.id ||= text(fragment["id"]);
    call.name ||= text(fn["name"]);
    call.arguments += text(fn["arguments"]);
    this.#calls.set(fragment["index"], call);
  }

  #closeReasoning(): AiEvent[] {
    if (this.#reasoning === "") {
      return [];
    }
    const part: AiPart = {
      type: "provider-state",
      provider: this.#provider,
      data: { reasoning_content: this.#reasoning },
      summary: this.#reasoning,
    };
    this.#reasoning = "";
    return [{ type: "part", part }];
  }

  #closeText(): AiEvent[] {
    if (this.#text === "") {
      return [];
    }
    const part: AiPart = { type: "text", text: this.#text };
    this.#text = "";
    return [{ type: "part", part }];
  }

  #done(): AiEvent[] {
    const events = [...this.#closeReasoning(), ...this.#closeText()];
    for (const [, call] of [...this.#calls].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) {
        throw invalid("A tool call has no id or name.");
      }
      let input: AiJsonValue;
      try {
        input = call.arguments === "" ? {} : (JSON.parse(call.arguments) as AiJsonValue);
      } catch {
        throw invalid("A tool call's arguments aren't valid JSON.");
      }
      events.push({
        type: "part",
        part: { type: "tool-call", id: call.id, name: call.name, input },
      });
    }
    this.finished = true;
    const raw = this.#finishReason;
    let finishReason: AiFinishReason = (raw && FINISH[raw]) || "other";
    if (this.#refused && finishReason === "stop") {
      finishReason = "refusal";
    }
    events.push({
      type: "finish",
      finishReason,
      ...(raw === undefined ? {} : { rawFinishReason: raw }),
      usage: { ...this.#usage },
    });
    return events;
  }

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
    set("inputTokens", value["prompt_tokens"]);
    set("outputTokens", value["completion_tokens"]);
    if (isObject(value["prompt_tokens_details"])) {
      set("cacheReadTokens", value["prompt_tokens_details"]["cached_tokens"]);
    }
    if (isObject(value["completion_tokens_details"])) {
      set("reasoningTokens", value["completion_tokens_details"]["reasoning_tokens"]);
    }
  }
}

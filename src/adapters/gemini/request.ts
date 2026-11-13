import { toBase64 } from "../../core/encoding/base64.js";
import { AiError } from "../../core/errors/ai-error.js";
import type { AiJsonValue, AiMessage } from "../../core/model/message.js";
import type { AiRequest } from "../../core/model/provider.js";

/** The name Gemini's state is tagged with (ADR 0001). */
export const GEMINI = "gemini";

/** ai-core's rule for tool names (ADR 0002), within Gemini's documented one. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

type Json = { readonly [key: string]: AiJsonValue };

function invalid(message: string): AiError {
  return new AiError("INVALID_REQUEST", message, { details: { retryable: false } });
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tool call names by ID, from the history, for `function_result` steps. */
function toolNames(messages: readonly AiMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-call") {
        names.set(part.id, part.name);
      }
    }
  }
  return names;
}

function userSteps(message: AiMessage, names: ReadonlyMap<string, string>): Json[] {
  const results: Json[] = [];
  const content: Json[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "image":
        content.push({ type: "image", data: toBase64(part.data), mime_type: part.mediaType });
        break;
      case "tool-result": {
        const name = names.get(part.callId);
        if (name === undefined) {
          throw invalid("A tool result must answer a tool call earlier in the conversation.");
        }
        if (
          typeof part.content !== "string" &&
          part.content.some((item) => item.type === "image")
        ) {
          throw invalid("Gemini's function results take only text.");
        }
        const text =
          typeof part.content === "string"
            ? part.content
            : part.content.map((item) => (item.type === "text" ? item.text : "")).join("");
        results.push({
          type: "function_result",
          name,
          call_id: part.callId,
          result: [{ type: "text", text }],
          ...(part.isError === undefined ? {} : { is_error: part.isError }),
        });
        break;
      }
      case "tool-call":
        throw invalid("Tool calls belong in assistant messages.");
      case "provider-state":
        break;
    }
  }
  // Function results answer the model's calls, so they come first.
  return [...results, ...(content.length === 0 ? [] : [{ type: "user_input", content }])];
}

function modelSteps(message: AiMessage): Json[] {
  const steps: Json[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        steps.push({ type: "model_output", content: [{ type: "text", text: part.text }] });
        break;
      case "tool-call":
        steps.push({ type: "function_call", id: part.id, name: part.name, arguments: part.input });
        break;
      case "provider-state":
        // Gemini's own steps, such as thoughts with their signatures, go back
        // exactly as received (ADR 0001); other state is left out.
        if (part.provider === GEMINI) {
          if (!isObject(part.data)) {
            throw invalid("Gemini provider state must be an object, as the adapter produced it.");
          }
          steps.push(part.data);
        }
        break;
      case "image":
        throw invalid("Gemini doesn't take images in model turns.");
      case "tool-result":
        throw invalid("Tool results belong in user messages.");
    }
  }
  return steps;
}

/**
 * The adapter's defaults for one request.
 *
 * @internal
 */
export interface GeminiDefaults {
  readonly model: string;
  readonly maxOutputTokens: number;
}

/**
 * Turns an {@link AiRequest} into a stateless Interactions API request
 * (ADR 0008): the full history as input steps, streamed, never stored.
 * Invalid requests fail with `INVALID_REQUEST` before anything is sent.
 *
 * @internal
 */
export function toInteractionBody(request: AiRequest, defaults: GeminiDefaults): Json {
  if (request.messages.length === 0) {
    throw invalid("A request needs at least one message.");
  }
  const maxTokens = request.maxOutputTokens ?? defaults.maxOutputTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw invalid("maxOutputTokens must be a positive whole number.");
  }
  for (const tool of request.tools ?? []) {
    if (!TOOL_NAME.test(tool.name)) {
      throw invalid("Tool names must match ^[a-zA-Z0-9_-]{1,128}$.");
    }
  }
  const names = toolNames(request.messages);
  const input = request.messages.flatMap((message) =>
    message.role === "user" ? userSteps(message, names) : modelSteps(message),
  );
  const generation: Record<string, AiJsonValue> = { max_output_tokens: maxTokens };
  if (request.toolChoice !== undefined) {
    generation["tool_choice"] = request.toolChoice;
  }
  const own: Record<string, AiJsonValue> = { model: request.model ?? defaults.model, input };
  if (request.system !== undefined) {
    own["system_instruction"] = request.system;
  }
  if (request.tools && request.tools.length > 0) {
    own["tools"] = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
    }));
  }
  const extra = request.providerOptions?.[GEMINI];
  const options = isObject(extra) ? (extra as Record<string, AiJsonValue>) : {};
  const extraGeneration = isObject(options["generation_config"])
    ? options["generation_config"]
    : {};
  return {
    ...own,
    ...options,
    // Host settings such as thinking_summaries join the adapter's own.
    generation_config: { ...generation, ...extraGeneration },
    // ai-core streams every call, and never asks Gemini to keep the
    // conversation (ADR 0008): providerOptions can't change either.
    stream: true,
    store: false,
  };
}

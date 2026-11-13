import { toBase64 } from "../../core/encoding/base64.js";
import { AiError } from "../../core/errors/ai-error.js";
import type { AiJsonValue, AiMessage, AiPart } from "../../core/model/message.js";
import type { AiRequest } from "../../core/model/provider.js";

/** ai-core's rule for tool names (ADR 0002), which fits OpenAI-compatible APIs too. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

type Json = { readonly [key: string]: AiJsonValue };

function invalid(message: string): AiError {
  return new AiError("INVALID_REQUEST", message, { details: { retryable: false } });
}

/** An image as a `data:` URL: the bytes themselves, never an address to fetch (ADR 0001). */
function imageUrl(part: Extract<AiPart, { type: "image" }>): Json {
  return {
    type: "image_url",
    image_url: { url: `data:${part.mediaType};base64,${toBase64(part.data)}` },
  };
}

/**
 * The text of the reasoning a provider returned, from this adapter's own
 * `provider-state`, to send back in `reasoning_content` as Kimi requires.
 */
function ownReasoning(parts: readonly AiPart[], provider: string): string | undefined {
  let reasoning: string | undefined;
  for (const part of parts) {
    if (part.type === "provider-state" && part.provider === provider) {
      const data = part.data;
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        const text = (data as Json)["reasoning_content"];
        if (typeof text === "string") {
          reasoning = (reasoning ?? "") + text;
        }
      }
    }
  }
  return reasoning;
}

function userMessages(message: AiMessage): Json[] {
  const tools: Json[] = [];
  const content: Json[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "image":
        content.push(imageUrl(part));
        break;
      case "tool-result": {
        if (
          typeof part.content !== "string" &&
          part.content.some((item) => item.type === "image")
        ) {
          throw invalid("OpenAI-compatible APIs take only text in tool results.");
        }
        const text =
          typeof part.content === "string"
            ? part.content
            : part.content.map((item) => (item.type === "text" ? item.text : "")).join("");
        tools.push({ role: "tool", tool_call_id: part.callId, content: text });
        break;
      }
      case "tool-call":
        throw invalid("Tool calls belong in assistant messages.");
      case "provider-state":
        // Provider state lives in assistant messages; nothing to send.
        break;
    }
  }
  const only = content.length === 1 ? content[0] : undefined;
  const user: Json[] =
    content.length === 0
      ? []
      : [{ role: "user", content: only?.["type"] === "text" ? (only["text"] ?? "") : content }];
  // Tool results answer the assistant's tool calls, so they come first.
  return [...tools, ...user];
}

function assistantMessage(message: AiMessage, provider: string): Json[] {
  let text = "";
  const calls: Json[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        text += part.text;
        break;
      case "tool-call":
        calls.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
        break;
      case "image":
        throw invalid("OpenAI-compatible APIs don't take images in assistant messages.");
      case "tool-result":
        throw invalid("Tool results belong in user messages.");
      case "provider-state":
        // Read below: only this adapter's own reasoning goes back.
        break;
    }
  }
  const reasoning = ownReasoning(message.parts, provider);
  if (text === "" && calls.length === 0 && reasoning === undefined) {
    return [];
  }
  return [
    {
      role: "assistant",
      content: text === "" ? null : text,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
      ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
    },
  ];
}

/**
 * The adapter's defaults for one request.
 *
 * @internal
 */
export interface OpenAICompatibleDefaults {
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly maxTokensField: "max_completion_tokens" | "max_tokens";
}

/**
 * Turns an {@link AiRequest} into a Chat Completions body, streaming with
 * usage. Invalid requests fail with `INVALID_REQUEST` before anything is
 * sent.
 *
 * @internal
 */
export function toChatCompletionsBody(
  request: AiRequest,
  defaults: OpenAICompatibleDefaults,
): Json {
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
  const messages: Json[] =
    request.system === undefined ? [] : [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    messages.push(
      ...(message.role === "user"
        ? userMessages(message)
        : assistantMessage(message, defaults.provider)),
    );
  }
  const own: Record<string, AiJsonValue> = {
    model: request.model ?? defaults.model,
    messages,
    [defaults.maxTokensField]: maxTokens,
    stream_options: { include_usage: true },
  };
  if (request.tools && request.tools.length > 0) {
    own["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.inputSchema,
      },
    }));
  }
  if (request.toolChoice !== undefined) {
    own["tool_choice"] = request.toolChoice;
  }
  const extra = request.providerOptions?.[defaults.provider];
  const options =
    typeof extra === "object" && extra !== null && !Array.isArray(extra)
      ? (extra as Record<string, AiJsonValue>)
      : {};
  // providerOptions come after the adapter's own fields (ADR 0002), but the
  // stream is ai-core's.
  return { ...own, ...options, stream: true };
}

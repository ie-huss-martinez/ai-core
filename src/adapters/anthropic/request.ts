import { toBase64 } from "../../core/encoding/base64.js";
import { AiError } from "../../core/errors/ai-error.js";
import type { AiJsonValue, AiMessage, AiPart } from "../../core/model/message.js";
import type { AiRequest } from "../../core/model/provider.js";

/** The name Anthropic's state is tagged with (ai-core ADR 0001). */
export const ANTHROPIC = "anthropic";

/** Anthropic's documented rule for tool names, which ai-core adopts (ADR 0002). */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

type Block = { readonly [key: string]: AiJsonValue };

function invalid(message: string): AiError {
  return new AiError("INVALID_REQUEST", message, { details: { retryable: false } });
}

function image(part: Extract<AiPart, { type: "image" }>): Block {
  return {
    type: "image",
    source: { type: "base64", media_type: part.mediaType, data: toBase64(part.data) },
  };
}

/** One part as Anthropic content blocks: none for another provider's state. */
function blocks(part: AiPart, role: AiMessage["role"]): Block[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "image":
      return [image(part)];
    case "tool-call":
      if (role !== "assistant") {
        throw invalid("Tool calls belong in assistant messages.");
      }
      return [{ type: "tool_use", id: part.id, name: part.name, input: part.input }];
    case "tool-result": {
      if (role !== "user") {
        throw invalid("Tool results belong in user messages.");
      }
      const content =
        typeof part.content === "string"
          ? part.content
          : part.content.map((item) =>
              item.type === "text" ? { type: "text", text: item.text } : image(item),
            );
      return [
        {
          type: "tool_result",
          tool_use_id: part.callId,
          content,
          ...(part.isError === undefined ? {} : { is_error: part.isError }),
        },
      ];
    }
    case "provider-state": {
      // Anthropic's own blocks, such as thinking and redacted_thinking, go back
      // exactly as received; anything else, including ai-core's context hash
      // and other providers' state, is left out (ADR 0001).
      if (part.provider !== ANTHROPIC) {
        return [];
      }
      const data = part.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw invalid("Anthropic provider state must be an object, as the adapter produced it.");
      }
      return [data as Block];
    }
  }
}

/**
 * The adapter's defaults and the host's options for one request.
 *
 * @internal
 */
export interface RequestDefaults {
  readonly model: string;
  readonly maxOutputTokens: number;
}

/**
 * Turns an {@link AiRequest} into a Messages API request body, streaming.
 * Invalid requests fail with `INVALID_REQUEST` before anything is sent.
 *
 * @internal
 */
export function toAnthropicBody(request: AiRequest, defaults: RequestDefaults): Block {
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
  const messages = request.messages
    .map((message) => ({
      role: message.role,
      content: message.parts.flatMap((part) => blocks(part, message.role)),
    }))
    // A message that held only another provider's state has nothing left to send.
    .filter((message) => message.content.length > 0);

  const own: Record<string, AiJsonValue> = {
    model: request.model ?? defaults.model,
    max_tokens: maxTokens,
    messages,
  };
  if (request.system !== undefined) {
    own["system"] = request.system;
  }
  if (request.tools && request.tools.length > 0) {
    own["tools"] = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.inputSchema,
    }));
  }
  if (request.toolChoice !== undefined) {
    own["tool_choice"] = { type: request.toolChoice };
  }
  const extra = request.providerOptions?.[ANTHROPIC];
  const options =
    typeof extra === "object" && extra !== null && !Array.isArray(extra)
      ? (extra as Record<string, AiJsonValue>)
      : {};
  // The host's providerOptions come after the adapter's own fields (ADR 0002),
  // but the stream is ai-core's: everything it does depends on it.
  return { ...own, ...options, stream: true };
}

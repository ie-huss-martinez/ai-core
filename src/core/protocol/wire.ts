import { fromBase64, toBase64 } from "../encoding/base64.js";
import { AiError } from "../errors/ai-error.js";
import type {
  AiImageMediaType,
  AiImagePart,
  AiJsonValue,
  AiMessage,
  AiPart,
  AiProviderState,
  AiTextPart,
} from "../model/message.js";

/**
 * The wire protocol's version, which the handler and the transport of one
 * release always share (ADR 0003).
 *
 * @internal
 */
export const AI_CORE_PROTOCOL = "ai-core/1";

/**
 * The provider name of the handler's own state, such as the context hash
 * (ADR 0003). Adapters never send it to a provider.
 *
 * @internal
 */
export const AI_CORE = "ai-core";

type Json = { readonly [key: string]: unknown };

const MEDIA_TYPES: ReadonlySet<string> = new Set<AiImageMediaType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Field names worth repeating in an error. Anything else could be content. */
const NAMEABLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(message: string, path: string): AiError {
  return new AiError("INVALID_REQUEST", message, { details: { path, retryable: false } });
}

/**
 * Checks that an object has only the given fields, naming the first other
 * one when its name is safe to repeat.
 *
 * @internal
 */
export function onlyFields(value: Json, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = NAMEABLE.test(key) ? `"${key}"` : "a field";
      throw invalid(
        `${path || "The body"} has ${field}, which isn't allowed here.`,
        NAMEABLE.test(key) ? `${path ? `${path}.` : ""}${key}` : path,
      );
    }
  }
}

function object(value: unknown, path: string): Json {
  if (!isObject(value)) {
    throw invalid(`${path} must be an object.`, path);
  }
  return value;
}

function string(value: unknown, path: string, { empty = true } = {}): string {
  if (typeof value !== "string" || (!empty && value === "")) {
    throw invalid(`${path} must be a ${empty ? "" : "non-empty "}string.`, path);
  }
  return value;
}

function json(value: Json, key: string, path: string): AiJsonValue {
  if (!(key in value)) {
    throw invalid(`${path}.${key} is missing.`, `${path}.${key}`);
  }
  // Parsed JSON is always a JSON value.
  return value[key] as AiJsonValue;
}

function providerState(value: unknown, path: string): AiProviderState {
  const state = object(value, path);
  onlyFields(state, ["provider", "data"], path);
  return {
    provider: string(state["provider"], `${path}.provider`, { empty: false }),
    data: json(state, "data", path),
  };
}

function image(value: Json, path: string): AiImagePart {
  onlyFields(value, ["type", "mediaType", "data"], path);
  const mediaType = string(value["mediaType"], `${path}.mediaType`);
  if (!MEDIA_TYPES.has(mediaType)) {
    throw invalid(`${path}.mediaType isn't a supported image type.`, `${path}.mediaType`);
  }
  const data = fromBase64(string(value["data"], `${path}.data`));
  if (data === undefined) {
    throw invalid(`${path}.data must be padded, standard base64.`, `${path}.data`);
  }
  return { type: "image", mediaType: mediaType as AiImageMediaType, data };
}

function text(value: Json, path: string): AiTextPart {
  onlyFields(value, ["type", "text", "providerState"], path);
  return {
    type: "text",
    text: string(value["text"], `${path}.text`),
    ...(value["providerState"] === undefined
      ? {}
      : { providerState: providerState(value["providerState"], `${path}.providerState`) }),
  };
}

function part(value: unknown, path: string): AiPart {
  const raw = object(value, path);
  switch (raw["type"]) {
    case "text":
      return text(raw, path);
    case "image":
      return image(raw, path);
    case "tool-call":
      onlyFields(raw, ["type", "id", "name", "input", "providerState"], path);
      return {
        type: "tool-call",
        id: string(raw["id"], `${path}.id`, { empty: false }),
        name: string(raw["name"], `${path}.name`, { empty: false }),
        input: json(raw, "input", path),
        ...(raw["providerState"] === undefined
          ? {}
          : { providerState: providerState(raw["providerState"], `${path}.providerState`) }),
      };
    case "tool-result": {
      onlyFields(raw, ["type", "callId", "content", "isError"], path);
      const content = raw["content"];
      const isError = raw["isError"];
      if (isError !== undefined && typeof isError !== "boolean") {
        throw invalid(`${path}.isError must be a boolean.`, `${path}.isError`);
      }
      return {
        type: "tool-result",
        callId: string(raw["callId"], `${path}.callId`, { empty: false }),
        content:
          typeof content === "string"
            ? content
            : list(content, `${path}.content`).map((item, index) => {
                const itemPath = `${path}.content[${index}]`;
                const entry = object(item, itemPath);
                if (entry["type"] === "text") {
                  return text(entry, itemPath);
                }
                if (entry["type"] === "image") {
                  return image(entry, itemPath);
                }
                throw invalid(`${itemPath} must be a text or image part.`, `${itemPath}.type`);
              }),
        ...(isError === undefined ? {} : { isError }),
      };
    }
    case "provider-state": {
      onlyFields(raw, ["type", "provider", "data", "summary"], path);
      const summary = raw["summary"];
      return {
        type: "provider-state",
        provider: string(raw["provider"], `${path}.provider`, { empty: false }),
        data: json(raw, "data", path),
        ...(summary === undefined ? {} : { summary: string(summary, `${path}.summary`) }),
      };
    }
    default:
      throw invalid(`${path}.type isn't a known part type.`, `${path}.type`);
  }
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${path} must be an array.`, path);
  }
  return value;
}

/**
 * Checks parsed JSON against the message model (ADR 0001) and rebuilds the
 * messages, with images as bytes. Anything else, including fields the model
 * doesn't have, fails with `INVALID_REQUEST` and the field's path in
 * `details.path`. Errors never repeat content.
 *
 * @internal
 */
export function decodeMessages(value: unknown, path = "messages"): AiMessage[] {
  const messages = list(value, path).map((entry, index): AiMessage => {
    const messagePath = `${path}[${index}]`;
    const message = object(entry, messagePath);
    onlyFields(message, ["role", "parts"], messagePath);
    const role = message["role"];
    if (role !== "user" && role !== "assistant") {
      throw invalid(`${messagePath}.role must be "user" or "assistant".`, `${messagePath}.role`);
    }
    const parts = list(message["parts"], `${messagePath}.parts`).map((item, partIndex) =>
      part(item, `${messagePath}.parts[${partIndex}]`),
    );
    for (const [partIndex, item] of parts.entries()) {
      if (item.type === "tool-call" && role !== "assistant") {
        throw invalid(
          "Tool calls belong in assistant messages.",
          `${messagePath}.parts[${partIndex}]`,
        );
      }
      if (item.type === "tool-result" && role !== "user") {
        throw invalid(
          "Tool results belong in user messages.",
          `${messagePath}.parts[${partIndex}]`,
        );
      }
    }
    return { role, parts };
  });
  if (messages.length === 0) {
    throw invalid("A request needs at least one message.", path);
  }
  return messages;
}

/**
 * Turns a part into JSON for the wire, with image bytes as base64.
 *
 * @internal
 */
export function encodePart(value: AiPart): AiJsonValue {
  switch (value.type) {
    case "image":
      return { type: "image", mediaType: value.mediaType, data: toBase64(value.data) };
    case "tool-result":
      return typeof value.content === "string"
        ? (value as unknown as AiJsonValue)
        : {
            ...value,
            content: value.content.map((item) => encodePart(item)),
          };
    default:
      return value as unknown as AiJsonValue;
  }
}

/**
 * Removes every `provider-state` part and `providerState` field from a
 * conversation, and any message left with no parts (ADR 0003).
 *
 * Use it to continue a conversation after the handler answered
 * `CONTEXT_CHANGED`: the model loses its earlier reasoning, such as thinking
 * blocks and thought signatures, but keeps the text, images, tool calls and
 * results. The input isn't changed.
 *
 * @example
 * ```ts
 * if (isAiError(error, "CONTEXT_CHANGED")) {
 *   conversation = withoutProviderState(conversation);
 * }
 * ```
 *
 * @public
 */
export function withoutProviderState(messages: readonly AiMessage[]): AiMessage[] {
  return messages.flatMap((message) => {
    const parts = message.parts.flatMap((item): AiPart[] => {
      if (item.type === "provider-state") {
        return [];
      }
      if ((item.type === "text" || item.type === "tool-call") && item.providerState) {
        const { providerState: _dropped, ...rest } = item;
        return [rest];
      }
      return [item];
    });
    return parts.length === 0 ? [] : [{ role: message.role, parts }];
  });
}

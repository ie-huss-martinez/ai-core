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

/**
 * Why a body, a message or a part was refused: a stable token in
 * `details.reason`, which conformance vectors and ports compare, never the
 * message (sdk-core ADR 0045). `docs/formats/hm-ai-protocol.md` lists them.
 *
 * @internal
 */
export type WireReason =
  | "malformed-body"
  | "missing-protocol"
  | "unsupported-protocol"
  | "unknown-field"
  | "missing-field"
  | "not-an-object"
  | "not-an-array"
  | "not-a-string"
  | "empty-string"
  | "not-a-boolean"
  | "no-messages"
  | "invalid-role"
  | "unknown-part-type"
  | "unsupported-media-type"
  | "invalid-base64"
  | "misplaced-tool-call"
  | "misplaced-tool-result"
  | "invalid-context-hash"
  | "context-changed";

/**
 * An `INVALID_REQUEST` with its path and reason, for the handler's own checks.
 *
 * @internal
 */
export function invalid(message: string, path: string, reason: WireReason): AiError {
  return new AiError("INVALID_REQUEST", message, { details: { path, reason, retryable: false } });
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
        "unknown-field",
      );
    }
  }
}

function object(value: unknown, path: string): Json {
  if (!isObject(value)) {
    throw invalid(`${path} must be an object.`, path, "not-an-object");
  }
  return value;
}

function string(value: unknown, path: string, { empty = true } = {}): string {
  if (typeof value !== "string") {
    throw invalid(
      `${path} must be a string.`,
      path,
      value === undefined ? "missing-field" : "not-a-string",
    );
  }
  if (!empty && value === "") {
    throw invalid(`${path} must not be empty.`, path, "empty-string");
  }
  return value;
}

function json(value: Json, key: string, path: string): AiJsonValue {
  if (!(key in value)) {
    throw invalid(`${path}.${key} is missing.`, `${path}.${key}`, "missing-field");
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
    throw invalid(
      `${path}.mediaType isn't a supported image type.`,
      `${path}.mediaType`,
      "unsupported-media-type",
    );
  }
  const data = fromBase64(string(value["data"], `${path}.data`));
  if (data === undefined) {
    throw invalid(
      `${path}.data must be padded, standard base64.`,
      `${path}.data`,
      "invalid-base64",
    );
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

/**
 * Checks one part against the message model, as {@link decodeMessages} does,
 * with images as bytes.
 *
 * @internal
 */
export function decodePart(value: unknown, path: string): AiPart {
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
        throw invalid(`${path}.isError must be a boolean.`, `${path}.isError`, "not-a-boolean");
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
                throw invalid(
                  `${itemPath} must be a text or image part.`,
                  `${itemPath}.type`,
                  "unknown-part-type",
                );
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
      throw invalid(`${path}.type isn't a known part type.`, `${path}.type`, "unknown-part-type");
  }
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(
      `${path} must be an array.`,
      path,
      value === undefined ? "missing-field" : "not-an-array",
    );
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
      throw invalid(
        `${messagePath}.role must be "user" or "assistant".`,
        `${messagePath}.role`,
        "invalid-role",
      );
    }
    const parts = list(message["parts"], `${messagePath}.parts`).map((item, partIndex) =>
      decodePart(item, `${messagePath}.parts[${partIndex}]`),
    );
    for (const [partIndex, item] of parts.entries()) {
      if (item.type === "tool-call" && role !== "assistant") {
        throw invalid(
          "Tool calls belong in assistant messages.",
          `${messagePath}.parts[${partIndex}]`,
          "misplaced-tool-call",
        );
      }
      if (item.type === "tool-result" && role !== "user") {
        throw invalid(
          "Tool results belong in user messages.",
          `${messagePath}.parts[${partIndex}]`,
          "misplaced-tool-result",
        );
      }
    }
    return { role, parts };
  });
  if (messages.length === 0) {
    throw invalid("A request needs at least one message.", path, "no-messages");
  }
  return messages;
}

/**
 * The error for another version of the protocol, the same on both sides of
 * the wire (ADR 0003), with the versions this side speaks.
 *
 * @internal
 */
export function protocolMismatch(): AiError {
  return new AiError(
    "PROTOCOL_MISMATCH",
    "The other side speaks another version of the ai-core protocol.",
    {
      details: { supported: [AI_CORE_PROTOCOL], reason: "unsupported-protocol", retryable: false },
    },
  );
}

/**
 * Checks a request body, parsed from JSON, as the handler receives it
 * (ADR 0003): `{ protocol: "ai-core/1", messages }`, and nothing else.
 *
 * @throws An `AiError`: `PROTOCOL_MISMATCH` for another protocol version,
 *   and `INVALID_REQUEST` for anything else, with `details.reason`.
 * @internal
 */
export function decodeRequestBody(value: unknown): {
  readonly protocol: typeof AI_CORE_PROTOCOL;
  readonly messages: AiMessage[];
} {
  if (!isObject(value)) {
    throw invalid("The body must be a JSON object.", "", "malformed-body");
  }
  const protocol = value["protocol"];
  if (protocol === undefined) {
    throw invalid("The body has no protocol.", "protocol", "missing-protocol");
  }
  if (typeof protocol !== "string") {
    throw invalid("The body's protocol must be a string.", "protocol", "not-a-string");
  }
  if (protocol !== AI_CORE_PROTOCOL) {
    throw protocolMismatch();
  }
  for (const key of Object.keys(value)) {
    if (key !== "protocol" && key !== "messages") {
      const named = NAMEABLE.test(key);
      throw invalid(
        `The body has ${named ? `"${key}"` : "a field"} besides protocol and messages. The server sets everything else, in prepare.`,
        named ? key : "",
        "unknown-field",
      );
    }
  }
  return { protocol: AI_CORE_PROTOCOL, messages: decodeMessages(value["messages"]) };
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

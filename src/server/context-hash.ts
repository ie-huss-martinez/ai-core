import { AiError } from "../core/errors/ai-error.js";
import type { AiTool } from "../core/model/provider.js";

/** A UTF-16 surrogate without its pair, which RFC 8785 refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function notJson(what: string): AiError {
  return new AiError(
    "PREPARE_FAILED",
    `prepare returned a system prompt or tools that aren't JSON: ${what}.`,
    { details: { reason: "non-json-settings", retryable: false } },
  );
}

function string(value: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw notJson("a string with a lone surrogate");
  }
  // ECMAScript's serialisation, which RFC 8785 adopts for well-formed strings.
  return JSON.stringify(value);
}

/**
 * Serialises a JSON value with the JSON Canonicalization Scheme, RFC 8785
 * (sdk-core ADR 0045): no whitespace, object keys sorted by their UTF-16
 * code units, and strings and numbers as ECMAScript serialises them.
 *
 * - An object field whose value is `undefined` is left out, as if absent,
 *   which is also how `JSON.stringify` sends it to a provider.
 * - Anything else that isn't JSON fails, as RFC 8785 requires: a number
 *   that isn't finite, a string with a lone surrogate, an `undefined` array
 *   element or hole, a function, a symbol, a bigint, or an object that isn't
 *   a plain object or array.
 *
 * @throws An `AiError` `PREPARE_FAILED` with `details.reason`
 *   `"non-json-settings"`, never with the value.
 * @internal
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw notJson("a number that isn't finite");
      }
      return JSON.stringify(value);
    case "string":
      return string(value);
    case "object": {
      if (Array.isArray(value)) {
        // Array.from visits holes too, as undefined, which fails below.
        return `[${Array.from(value, (item: unknown) => canonicalJson(item)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw notJson("an object that isn't a plain object");
      }
      const record = value as Record<string, unknown>;
      // The default sort compares UTF-16 code units, as RFC 8785 requires.
      const fields = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${string(key)}:${canonicalJson(record[key])}`);
      return `{${fields.join(",")}}`;
    }
    default:
      throw notJson(`a value of type ${typeof value}`);
  }
}

/**
 * The canonical JSON that {@link contextHash} hashes: `system`, or `null`
 * when there's none, and each tool's `name`, `description` and
 * `inputSchema`, in order, or an empty list when there are none.
 *
 * @internal
 */
export function contextCanonicalJson(
  system: string | undefined,
  tools: readonly AiTool[] | undefined,
): string {
  return canonicalJson({
    system: system ?? null,
    tools: (tools ?? []).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });
}

/**
 * The context hash of ADR 0003, as `docs/formats/hm-ai-context-hash.md`
 * defines it: the lowercase hex SHA-256, with Web Crypto, of the UTF-8
 * bytes of {@link contextCanonicalJson}.
 *
 * @throws An `AiError` `PREPARE_FAILED` with `details.reason`
 *   `"non-json-settings"` when the system prompt or tools aren't JSON.
 * @internal
 */
export async function contextHash(
  system: string | undefined,
  tools: readonly AiTool[] | undefined,
): Promise<string> {
  const canonical = contextCanonicalJson(system, tools);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

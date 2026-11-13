import type { AiTool } from "../core/model/provider.js";

/**
 * JSON with object keys sorted at every level, so equal values always
 * encode the same way. `undefined` fields are left out, as `JSON.stringify`
 * does.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The context hash of ADR 0003: a hex SHA-256 digest, with Web Crypto, of a
 * canonical JSON encoding of the call's system prompt and tools. No tools
 * and an empty list hash the same, as do no system prompt and `null`.
 *
 * @internal
 */
export async function contextHash(
  system: string | undefined,
  tools: readonly AiTool[] | undefined,
): Promise<string> {
  const encoded = canonical({
    system: system ?? null,
    tools: (tools ?? []).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

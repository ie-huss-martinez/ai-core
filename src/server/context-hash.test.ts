import { describe, expect, it } from "vitest";
import type { AiTool } from "../core/model/provider.js";
import { canonicalJson, contextCanonicalJson, contextHash } from "./context-hash.js";

const tool = {
  name: "look",
  description: "Looks",
  inputSchema: { type: "object", properties: {} },
};

describe("contextHash", () => {
  it("is a hex SHA-256 digest", async () => {
    expect(await contextHash("Be brief.", [tool])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores key order at every level", async () => {
    const reordered = {
      inputSchema: { properties: {}, type: "object" },
      description: "Looks",
      name: "look",
    };
    expect(await contextHash("Be brief.", [reordered])).toBe(
      await contextHash("Be brief.", [tool]),
    );
  });

  it("treats no tools as an empty list, and no system prompt as null", async () => {
    expect(await contextHash(undefined, undefined)).toBe(await contextHash(undefined, []));
  });

  it("changes when the system prompt, a tool or the tools' order changes", async () => {
    const base = await contextHash("Be brief.", [tool, { ...tool, name: "other" }]);
    for (const changed of [
      await contextHash("Be brief!", [tool, { ...tool, name: "other" }]),
      await contextHash("Be brief.", [tool, { ...tool, name: "other", description: "x" }]),
      await contextHash("Be brief.", [{ ...tool, name: "other" }, tool]),
      await contextHash("", [tool, { ...tool, name: "other" }]),
    ]) {
      expect(changed).not.toBe(base);
    }
  });

  it("tells an empty system prompt from none", async () => {
    expect(await contextHash("", undefined)).not.toBe(await contextHash(undefined, undefined));
  });
});

/** Values a JSON vector file can't hold, so they're tested here (the vectors are in conformance/). */
describe("canonicalJson: values that aren't JSON", () => {
  it("leaves out object fields that are undefined, as if absent", () => {
    expect(canonicalJson({ b: 1, a: undefined, c: { d: undefined } })).toBe('{"b":1,"c":{}}');
    expect(
      // A host without exactOptionalPropertyTypes can pass this.
      contextCanonicalJson(undefined, [
        { name: "t", description: undefined, inputSchema: {} } as unknown as AiTool,
      ]),
    ).toBe(contextCanonicalJson(undefined, [{ name: "t", inputSchema: {} }]));
  });

  it("writes -0 as 0, as RFC 8785 does", () => {
    expect(canonicalJson([-0, 0])).toBe("[0,0]");
  });

  it("accepts an object without a prototype, and keys like __proto__ as ordinary keys", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["b"] = 1;
    Object.defineProperty(bare, "__proto__", { value: 2, enumerable: true });
    expect(canonicalJson(bare)).toBe('{"__proto__":2,"b":1}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an undefined array element", [1, undefined]],
    // biome-ignore lint/suspicious/noSparseArray: the hole is what's tested.
    ["an array hole", [1, , 2]],
    ["a function", { f: () => 1 }],
    ["a symbol", { s: Symbol("s") }],
    ["a bigint", { n: 1n }],
    ["a date", { d: new Date(0) }],
    ["a map", { m: new Map() }],
    ["a class instance", { i: new (class Point {})() }],
  ])("refuses %s, without repeating it", (_, value) => {
    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining({
        code: "PREPARE_FAILED",
        details: { reason: "non-json-settings", retryable: false },
      }),
    );
  });

  it("rejects a hash of settings that aren't JSON", async () => {
    await expect(
      contextHash(undefined, [{ name: "t", inputSchema: { maximum: Number.NaN } }]),
    ).rejects.toMatchObject({ code: "PREPARE_FAILED", details: { reason: "non-json-settings" } });
  });
});

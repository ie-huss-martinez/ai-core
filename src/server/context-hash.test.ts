import { describe, expect, it } from "vitest";
import { contextHash } from "./context-hash.js";

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

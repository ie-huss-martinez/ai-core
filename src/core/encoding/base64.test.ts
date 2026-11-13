import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "./base64.js";

describe("base64", () => {
  it("round-trips every byte value, at every padding length", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    for (const length of [0, 1, 2, 3, 256]) {
      const bytes = all.subarray(0, length);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it("round-trips more than one chunk", () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, index) => index % 251);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it.each([
    ["missing padding", "QQ"],
    ["whitespace", "QUJD RA=="],
    ["a line break", "QUJD\nRA=="],
    ["the URL-safe alphabet", "-_8="],
    ["padding in the middle", "QQ==QUJD"],
    ["a data URL", "data:image/png;base64,QUJD"],
  ])("rejects %s", (_, text) => {
    expect(fromBase64(text)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { assertKeyMayBeUsed, isRecognisedServer } from "./server-runtime.js";

/**
 * Detection in real browsers (ADR 0004): a page and a dedicated worker are
 * never servers. Anthropic's own SDK only checks for a page's document, so a
 * worker is the case that matters most.
 */
describe("runtime detection in a browser", () => {
  it("doesn't treat a page as a server, and refuses without the opt-in", () => {
    expect(isRecognisedServer()).toBe(false);
    expect(() => assertKeyMayBeUsed(undefined)).toThrow("dangerouslyAllowBrowser");
    expect(() => assertKeyMayBeUsed(true)).not.toThrow();
  });

  it("doesn't treat a dedicated worker as a server", async () => {
    const worker = new Worker(new URL("./fixtures/probe.worker.ts", import.meta.url), {
      type: "module",
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    worker.terminate();
    expect(result).toBe(false);
  });
});

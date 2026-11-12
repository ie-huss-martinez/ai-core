import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Each public entry, imported from source in a real browser. ai-core runs in
 * pages too, through the transport or the opt-in browser-key mode, so no
 * entry may make a request when it's imported there either (ADR 0035).
 */
const entries = {
  ".": () => import("./index.js"),
  "./server": () => import("./server.js"),
  "./anthropic": () => import("./anthropic.js"),
  "./gemini": () => import("./gemini.js"),
  "./openai-compatible": () => import("./openai-compatible.js"),
  "./testing": () => import("./testing.js"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("importing in a browser", () => {
  it.each(Object.entries(entries))("imports %s without any request", async (_, load) => {
    const network = [
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(XMLHttpRequest.prototype, "open"),
      vi.spyOn(navigator, "sendBeacon"),
    ];
    const sockets = vi.spyOn(globalThis, "WebSocket");
    const events = vi.spyOn(globalThis, "EventSource");
    await expect(load()).resolves.toBeTypeOf("object");
    for (const spy of [...network, sockets, events]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

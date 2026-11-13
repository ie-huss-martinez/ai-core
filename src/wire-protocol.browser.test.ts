import { describe, expect, it } from "vitest";
import { httpTransport } from "./adapters/http/transport.js";
import { createAiHandler } from "./server/handler.js";
import { createFakeProvider } from "./testing/fake-provider.js";

/**
 * The transport in a real page: it holds no key, so it runs where adapters
 * refuse to, and a path url resolves against the page (ADR 0003). The
 * handler answers in the page too, through an injected fetch, so nothing
 * leaves the browser.
 */
describe("httpTransport in a browser", () => {
  it("calls the handler at a path on the page's origin", async () => {
    const handler = createAiHandler({
      provider: createFakeProvider([{ parts: [{ type: "text", text: "Hello from the server" }] }]),
      prepare: () => ({ maxOutputTokens: 100 }),
    });
    const urls: string[] = [];
    const transport = httpTransport({
      url: "/api/chat",
      fetch: (input, init) => {
        const request = new Request(input, init);
        urls.push(request.url);
        return handler(request);
      },
    });
    const result = await transport.complete({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    });
    expect(urls).toEqual([new URL("/api/chat", location.href).href]);
    expect(result.message.parts.at(-1)).toEqual({ type: "text", text: "Hello from the server" });
  });
});

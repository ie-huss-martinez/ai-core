import { describe, expect, it } from "vitest";
import { createAnthropic } from "./anthropic.js";

const STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Grüße 👋"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/**
 * The adapter in a real page (ADR 0004): it refuses to hold a key there, and
 * with the opt-in it streams with the browser's own fetch, streams and
 * decoder, and sends Anthropic's browser-access header.
 */
describe("createAnthropic in a browser", () => {
  it("refuses without dangerouslyAllowBrowser", () => {
    expect(() => createAnthropic({ apiKey: "k", model: "m" })).toThrow("dangerouslyAllowBrowser");
  });

  it("streams with the opt-in, and sends the browser-access header", async () => {
    const sent: Headers[] = [];
    const provider = createAnthropic({
      apiKey: "k",
      model: "m",
      dangerouslyAllowBrowser: true,
      fetch: async (_, init) => {
        sent.push(new Headers(init?.headers));
        const bytes = new TextEncoder().encode(STREAM);
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) {
                controller.enqueue(new Uint8Array([byte]));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const result = await provider.complete({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    });
    expect(result.message.parts).toEqual([{ type: "text", text: "Grüße 👋" }]);
    expect(sent[0]?.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  });
});

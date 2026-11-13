import { describe, expect, it } from "vitest";
import { isAiError } from "../core/errors/ai-error.js";
import type { AiEvent, AiRequest } from "../core/model/provider.js";
import { createFakeProvider } from "./fake-provider.js";

const request = (text: string): AiRequest => ({
  messages: [{ role: "user", parts: [{ type: "text", text }] }],
});

async function collect(events: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const seen: AiEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

describe("createFakeProvider", () => {
  it("answers with its turns in order, and records the requests", async () => {
    const provider = createFakeProvider([
      { parts: [{ type: "text", text: "First" }] },
      { parts: [{ type: "text", text: "Second" }] },
    ]);
    expect((await provider.complete(request("a"))).message.parts).toEqual([
      { type: "text", text: "First" },
    ]);
    expect((await provider.complete(request("b"))).message.parts).toEqual([
      { type: "text", text: "Second" },
    ]);
    expect(provider.requests.map((r) => r.messages[0]?.parts[0])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(provider.provider).toBe("fake");
  });

  it("streams text in pieces of chunkSize", async () => {
    const provider = createFakeProvider([
      { parts: [{ type: "text", text: "abcdefg" }], chunkSize: 3 },
    ]);
    const events = await collect(provider.stream(request("hi")));
    expect(
      events.filter((e) => e.type === "text-delta").map((e) => e.type === "text-delta" && e.text),
    ).toEqual(["abc", "def", "g"]);
  });

  it("finishes with tool-calls when the parts end with a tool call, and stop otherwise", async () => {
    const provider = createFakeProvider([
      { parts: [{ type: "tool-call", id: "1", name: "t", input: {} }] },
      {
        parts: [{ type: "text", text: "done" }],
        finishReason: "length",
        rawFinishReason: "max_tokens",
      },
    ]);
    expect((await provider.complete(request("a"))).finishReason).toBe("tool-calls");
    expect(await provider.complete(request("b"))).toMatchObject({
      finishReason: "length",
      rawFinishReason: "max_tokens",
    });
  });

  it("fails clearly when no turn is scripted for a call", async () => {
    const provider = createFakeProvider([]);
    await expect(provider.complete(request("a"))).rejects.toThrow("no turn scripted for call 1");
  });

  it("needs a signal for a hanging turn", async () => {
    const provider = createFakeProvider([{ hang: true }]);
    const error = await provider.complete(request("a")).catch((caught: unknown) => caught);
    expect(isAiError(error, "INVALID_REQUEST")).toBe(true);
  });
});

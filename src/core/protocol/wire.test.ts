import { describe, expect, it } from "vitest";
import { isAiError } from "../errors/ai-error.js";
import type { AiMessage } from "../model/message.js";
import { decodeMessages, encodePart, withoutProviderState } from "./wire.js";

function rejection(value: unknown): { path: unknown; message: string } {
  try {
    decodeMessages(value);
  } catch (error) {
    expect(isAiError(error, "INVALID_REQUEST")).toBe(true);
    const { details, message } = error as { details: { path?: unknown }; message: string };
    return { path: details.path, message };
  }
  throw new Error("expected the messages to be rejected");
}

const user = (...parts: unknown[]) => ({ role: "user", parts });

describe("decodeMessages", () => {
  it("rebuilds every part of the model, with images as bytes", () => {
    const messages = decodeMessages([
      user(
        { type: "text", text: "Hi" },
        { type: "image", mediaType: "image/png", data: "AAEC" },
        {
          type: "tool-result",
          callId: "c1",
          content: [
            { type: "text", text: "ok" },
            { type: "image", mediaType: "image/gif", data: "/w==" },
          ],
          isError: false,
        },
      ),
      {
        role: "assistant",
        parts: [
          { type: "provider-state", provider: "anthropic", data: { a: [1] }, summary: "s" },
          { type: "text", text: "Yes", providerState: { provider: "gemini", data: "sig" } },
          { type: "tool-call", id: "c1", name: "look", input: { q: 1 } },
        ],
      },
    ]);
    expect(messages[0]?.parts[1]).toEqual({
      type: "image",
      mediaType: "image/png",
      data: new Uint8Array([0, 1, 2]),
    });
    expect(messages[0]?.parts[2]).toEqual({
      type: "tool-result",
      callId: "c1",
      content: [
        { type: "text", text: "ok" },
        { type: "image", mediaType: "image/gif", data: new Uint8Array([255]) },
      ],
      isError: false,
    });
    expect(messages[1]?.parts).toEqual([
      { type: "provider-state", provider: "anthropic", data: { a: [1] }, summary: "s" },
      { type: "text", text: "Yes", providerState: { provider: "gemini", data: "sig" } },
      { type: "tool-call", id: "c1", name: "look", input: { q: 1 } },
    ]);
  });

  it("round-trips with encodePart", () => {
    const message: AiMessage = {
      role: "user",
      parts: [
        { type: "image", mediaType: "image/webp", data: new Uint8Array([9, 8, 7, 6]) },
        {
          type: "tool-result",
          callId: "c",
          content: [{ type: "image", mediaType: "image/jpeg", data: new Uint8Array([1]) }],
        },
      ],
    };
    const wire = JSON.parse(
      JSON.stringify([{ role: message.role, parts: message.parts.map(encodePart) }]),
    );
    expect(decodeMessages(wire)).toEqual([message]);
  });

  it.each([
    ["not a list", {}, "messages"],
    ["an empty list", [], "messages"],
    ["a message that isn't an object", ["hi"], "messages[0]"],
    ["an unknown role", [{ role: "system", parts: [] }], "messages[0].role"],
    ["an extra message field", [{ role: "user", parts: [], name: "x" }], "messages[0].name"],
    ["an unknown part type", [user({ type: "video" })], "messages[0].parts[0].type"],
    [
      "an extra part field",
      [user({ type: "text", text: "a", cache: true })],
      "messages[0].parts[0].cache",
    ],
    ["text that isn't a string", [user({ type: "text", text: 1 })], "messages[0].parts[0].text"],
    [
      "an unsupported image type",
      [user({ type: "image", mediaType: "image/svg+xml", data: "" })],
      "messages[0].parts[0].mediaType",
    ],
    [
      "an image URL instead of bytes",
      [user({ type: "image", mediaType: "image/png", data: "https://example.com/a.png" })],
      "messages[0].parts[0].data",
    ],
    [
      "a tool call in a user message",
      [user({ type: "tool-call", id: "c", name: "n", input: {} })],
      "messages[0].parts[0]",
    ],
    [
      "a tool result in an assistant message",
      [{ role: "assistant", parts: [{ type: "tool-result", callId: "c", content: "x" }] }],
      "messages[0].parts[0]",
    ],
    [
      "a tool call without input",
      [{ role: "assistant", parts: [{ type: "tool-call", id: "c", name: "n" }] }],
      "messages[0].parts[0].input",
    ],
    [
      "provider state without a provider",
      [{ role: "assistant", parts: [{ type: "provider-state", provider: "", data: 1 }] }],
      "messages[0].parts[0].provider",
    ],
    [
      "a non-boolean isError",
      [user({ type: "tool-result", callId: "c", content: "x", isError: "yes" })],
      "messages[0].parts[0].isError",
    ],
    [
      "a tool call inside a tool result",
      [user({ type: "tool-result", callId: "c", content: [{ type: "tool-call" }] })],
      "messages[0].parts[0].content[0].type",
    ],
  ])("rejects %s, naming the field", (_, value, path) => {
    expect(rejection(value).path).toBe(path);
  });

  it("never repeats a field name that could be content", () => {
    const { path, message } = rejection([
      user({ type: "text", text: "a", "my secret plans": true }),
    ]);
    expect(message).not.toContain("secret");
    expect(path).toBe("messages[0].parts[0]");
  });
});

describe("withoutProviderState", () => {
  it("drops provider state, and messages left empty, without changing the input", () => {
    const messages: AiMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Hi" }] },
      { role: "assistant", parts: [{ type: "provider-state", provider: "ai-core", data: {} }] },
      {
        role: "assistant",
        parts: [
          { type: "provider-state", provider: "anthropic", data: "thinking", summary: "s" },
          { type: "text", text: "Hello", providerState: { provider: "x", data: 1 } },
          {
            type: "tool-call",
            id: "c",
            name: "n",
            input: {},
            providerState: { provider: "g", data: 2 },
          },
        ],
      },
    ];
    const copy = structuredClone(messages);
    expect(withoutProviderState(messages)).toEqual([
      { role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Hello" },
          { type: "tool-call", id: "c", name: "n", input: {} },
        ],
      },
    ]);
    expect(messages).toEqual(copy);
  });
});

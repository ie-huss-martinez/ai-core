import { inspect } from "node:util";
import { serializeError } from "@hussmartinez/sdk-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAiError } from "../../core/errors/ai-error.js";
import type { AiMessage, AiPart } from "../../core/model/message.js";
import type { AiEvent, AiRequest } from "../../core/model/provider.js";
import {
  type Chunking,
  type FixtureFetchOptions,
  fixtureFetch,
  loadFixture,
} from "../../test/fixture-fetch.js";
import { defineProviderContract } from "../../testing/contract.js";
import { type AnthropicOptions, createAnthropic } from "./anthropic.js";

const KEY = "sk-ant-sentinel-key-0123456789abcdef";
const PROMPT = "sentinel prompt: my secret plans";

const ask = (text = PROMPT): AiRequest => ({
  messages: [{ role: "user", parts: [{ type: "text", text }] }],
});

function setup(
  name: string,
  fetchOptions: FixtureFetchOptions = {},
  options: Partial<AnthropicOptions> = {},
) {
  const fake = fixtureFetch(loadFixture(`anthropic/${name}`), fetchOptions);
  const provider = createAnthropic({
    apiKey: KEY,
    model: "claude-opus-5-5",
    fetch: fake.fetch,
    ...options,
  });
  return { provider, requests: fake.requests };
}

async function collect(events: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const seen: AiEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the request (verified against the Messages API reference)", () => {
  it("posts to /v1/messages with the key, version and JSON, streaming", async () => {
    const { provider, requests } = setup("text");
    await provider.complete(ask("Hello"));
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "anthropic-version": "2026-10-21",
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(request?.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      stream: true,
    });
  });

  it("maps every part, replays Anthropic's state exactly, and drops other providers'", async () => {
    const thinking = { type: "thinking", thinking: "Hmm.", signature: "sig-1" };
    const redacted = { type: "redacted_thinking", data: "opaque-1" };
    const messages: AiMessage[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) },
        ],
      },
      {
        role: "assistant",
        parts: [
          { type: "provider-state", provider: "ai-core", data: { context: "sha256-x" } },
          { type: "provider-state", provider: "anthropic", data: thinking, summary: "Hmm." },
          { type: "provider-state", provider: "anthropic", data: redacted },
          { type: "provider-state", provider: "gemini", data: { thoughtSignature: "g" } },
          { type: "tool-call", id: "toolu_1", name: "look", input: { zoom: 2 } },
        ],
      },
      {
        role: "user",
        parts: [{ type: "tool-result", callId: "toolu_1", content: "A cat.", isError: false }],
      },
      { role: "assistant", parts: [{ type: "provider-state", provider: "kimi", data: "r" }] },
    ];
    const { provider, requests } = setup("text");
    await provider.complete({
      messages,
      system: "Be brief.",
      tools: [{ name: "look", description: "Looks closer.", inputSchema: { type: "object" } }],
      toolChoice: "auto",
      maxOutputTokens: 500,
      model: "claude-sonnet-5-5",
      providerOptions: {
        anthropic: { thinking: { type: "adaptive", display: "summarized" }, stream: false },
        gemini: { ignored: true },
      },
    });
    expect(requests[0]?.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 500,
      system: "Be brief.",
      tools: [{ name: "look", description: "Looks closer.", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            thinking,
            redacted,
            { type: "tool_use", id: "toolu_1", name: "look", input: { zoom: 2 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "A cat.", is_error: false },
          ],
        },
      ],
      thinking: { type: "adaptive", display: "summarized" },
      // providerOptions can't turn streaming off: everything depends on it.
      stream: true,
    });
  });

  it("rejects an invalid request before sending anything", async () => {
    const { provider, requests } = setup("text");
    for (const request of [
      { messages: [] },
      { ...ask(), tools: [{ name: "has spaces", inputSchema: {} }] },
      { ...ask(), maxOutputTokens: 0 },
      {
        messages: [
          { role: "user", parts: [{ type: "tool-call", id: "1", name: "t", input: {} }] },
        ] satisfies AiMessage[],
      },
    ] as AiRequest[]) {
      const error = await failure(() => provider.complete(request));
      expect(isAiError(error, "INVALID_REQUEST")).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });
});

describe("the stream", () => {
  it("maps text, usage and the finish reason", async () => {
    const { provider } = setup("text");
    const result = await provider.complete(ask());
    expect(result).toEqual({
      message: {
        role: "assistant",
        parts: [{ type: "text", text: "Hello there! How can I help today?" }],
      },
      finishReason: "stop",
      rawFinishReason: "end_turn",
      usage: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("keeps thinking blocks whole for replay, with their text as summary", async () => {
    const { provider } = setup("thinking");
    const events = await collect(provider.stream(ask()));
    expect(
      events
        .filter((e) => e.type === "summary-delta")
        .map((e) => e.type === "summary-delta" && e.text),
    ).toEqual(["The user wants a greeting. ", "Keep it short."]);
    const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []));
    expect(parts).toEqual<AiPart[]>([
      {
        type: "provider-state",
        provider: "anthropic",
        data: {
          type: "thinking",
          thinking: "The user wants a greeting. Keep it short.",
          signature: "EqQBCgIYAhIMfixture-signature-0001",
        },
        summary: "The user wants a greeting. Keep it short.",
      },
      {
        type: "provider-state",
        provider: "anthropic",
        data: { type: "redacted_thinking", data: "EmwKAhgBEgyfixture-redacted-0001" },
      },
      { type: "text", text: "Hi! 👋 Grüße." },
    ]);
    expect(events.at(-1)).toMatchObject({ usage: { outputTokens: 42, reasoningTokens: 30 } });
  });

  it("sends thinking back exactly as received on the next turn", async () => {
    const first = setup("thinking");
    const result = await first.provider.complete(ask());
    const second = setup("text");
    await second.provider.complete({
      messages: [...ask().messages, result.message, ...ask("And now?").messages],
    });
    const body = second.requests[0]?.body as { messages: { content: unknown[] }[] };
    expect(body.messages[1]?.content).toEqual([
      {
        type: "thinking",
        thinking: "The user wants a greeting. Keep it short.",
        signature: "EqQBCgIYAhIMfixture-signature-0001",
      },
      { type: "redacted_thinking", data: "EmwKAhgBEgyfixture-redacted-0001" },
      { type: "text", text: "Hi! 👋 Grüße." },
    ]);
  });

  it("reports tool calls with their parsed input", async () => {
    const { provider } = setup("tool-call");
    const result = await provider.complete(ask());
    expect(result.finishReason).toBe("tool-calls");
    expect(result.message.parts.at(-1)).toEqual({
      type: "tool-call",
      id: "toolu_fixture_0001",
      name: "get_weather",
      input: { location: "San Francisco, CA" },
    });
  });

  it.each([
    ["refusal", "refusal", "refusal"],
    ["max-tokens", "length", "max_tokens"],
  ])("maps the %s stop reason", async (fixture, finishReason, raw) => {
    const { provider } = setup(fixture);
    expect(await provider.complete(ask())).toMatchObject({ finishReason, rawFinishReason: raw });
  });

  it.each<Chunking>(["whole", "bytes", 7, 64])(
    "gives the same result however the body arrives (%s)",
    async (chunking) => {
      const whole = await setup("thinking").provider.complete(ask());
      expect(await setup("thinking", { chunking }).provider.complete(ask())).toEqual(whole);
    },
  );
});

describe("failures (ADR 0007)", () => {
  it("maps a 401 to PROVIDER_AUTHENTICATION, not retryable, with the request ID", async () => {
    const error = await failure(() => setup("error-401").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_AUTHENTICATION")).toBe(true);
    expect((error as { details: unknown }).details).toEqual({
      retryable: false,
      status: 401,
      providerType: "authentication_error",
      requestId: "req_fixture_0001",
    });
  });

  it("maps a 429 to PROVIDER_RATE_LIMITED with retryAfter", async () => {
    const error = await failure(() => setup("error-429").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_RATE_LIMITED")).toBe(true);
    expect(error).toMatchObject({ details: { retryable: true, retryAfter: 20 } });
  });

  it("maps a spend-cap 429 to SPEND_LIMIT_REACHED, not retryable", async () => {
    const error = await failure(() => setup("error-429-spend-cap").provider.complete(ask()));
    expect(isAiError(error, "SPEND_LIMIT_REACHED")).toBe(true);
    expect(error).toMatchObject({ details: { retryable: false, status: 429 } });
  });

  it("maps a 529 to PROVIDER_OVERLOADED", async () => {
    const error = await failure(() => setup("error-529").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_OVERLOADED")).toBe(true);
  });

  it("fails on an error event mid-stream, as partial and retryable", async () => {
    const { provider } = setup("overloaded-midstream");
    const seen: AiEvent[] = [];
    const error = await failure(async () => {
      for await (const event of provider.stream(ask())) {
        seen.push(event);
      }
    });
    expect(seen).toEqual([{ type: "text-delta", text: "Hello" }]);
    expect(isAiError(error, "PROVIDER_OVERLOADED")).toBe(true);
    expect(error).toMatchObject({
      details: { retryable: true, partial: true, providerType: "overloaded_error" },
    });
  });

  it("fails with STREAM_TRUNCATED when the body ends before message_stop", async () => {
    const text = loadFixture("anthropic/text");
    const cut = new TextDecoder().decode(text.body).indexOf("event: message_delta");
    const error = await failure(() => setup("text", { truncateAt: cut }).provider.complete(ask()));
    expect(isAiError(error, "STREAM_TRUNCATED")).toBe(true);
    expect(error).toMatchObject({ details: { retryable: true, partial: true } });
  });

  it("fails with PROVIDER_RESPONSE_INVALID on malformed JSON", async () => {
    const error = await failure(() => setup("malformed").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_RESPONSE_INVALID")).toBe(true);
    expect(error).toMatchObject({ details: { retryable: false } });
  });

  it("fails with PROVIDER_RESPONSE_INVALID when a success isn't an event stream", async () => {
    const fixture = {
      ...loadFixture("anthropic/text"),
      headers: { "content-type": "application/json" },
    };
    const fake = fixtureFetch(fixture);
    const provider = createAnthropic({ apiKey: KEY, model: "m", fetch: fake.fetch });
    expect(
      isAiError(await failure(() => provider.complete(ask())), "PROVIDER_RESPONSE_INVALID"),
    ).toBe(true);
  });

  it("fails with NETWORK_ERROR, keeping only the method and origin", async () => {
    const provider = createAnthropic({
      apiKey: KEY,
      model: "m",
      fetch: () => Promise.reject(new TypeError(`fetch failed: ${KEY} ${PROMPT}`)),
    });
    const error = await failure(() => provider.complete(ask()));
    expect(isAiError(error, "NETWORK_ERROR")).toBe(true);
    expect((error as Error).cause).toBeUndefined();
    expect((error as { details: unknown }).details).toEqual({
      retryable: true,
      method: "POST",
      origin: "https://api.anthropic.com",
    });
  });
});

describe("configuration and keys (ADR 0004)", () => {
  it("needs a model, and an https base URL (http only for localhost)", () => {
    expect(() => createAnthropic({ apiKey: KEY, model: "" })).toThrow("needs a model");
    expect(() =>
      createAnthropic({ apiKey: KEY, model: "m", baseURL: "http://proxy.example" }),
    ).toThrow("https:");
    expect(() =>
      createAnthropic({ apiKey: KEY, model: "m", baseURL: "http://localhost:8080" }),
    ).not.toThrow();
  });

  it("uses the base URL's origin only", async () => {
    const fake = fixtureFetch(loadFixture("anthropic/text"));
    const provider = createAnthropic({
      apiKey: KEY,
      model: "m",
      baseURL: "https://gateway.example/some/path?x=1",
      fetch: fake.fetch,
    });
    await provider.complete(ask());
    expect(fake.requests[0]?.url).toBe("https://gateway.example/v1/messages");
  });

  it("reads a key function on every request, and fails without a key before sending", async () => {
    const apiKey = vi.fn(async () => KEY);
    const fake = fixtureFetch(loadFixture("anthropic/text"));
    const provider = createAnthropic({ apiKey, model: "m", fetch: fake.fetch });
    await provider.complete(ask());
    await provider.complete(ask());
    expect(apiKey).toHaveBeenCalledTimes(2);
    const empty = createAnthropic({ apiKey: () => "", model: "m", fetch: fake.fetch });
    expect(isAiError(await failure(() => empty.complete(ask())), "MISSING_API_KEY")).toBe(true);
    expect(fake.requests).toHaveLength(2);
  });

  it("never exposes the key through the provider object", () => {
    const { provider } = setup("text");
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify({ ...provider })).not.toContain(KEY);
    expect(Object.keys(provider).sort()).toEqual(["complete", "provider", "stream"]);
  });

  it("refuses outside a server, and with the opt-in sends the browser header", async () => {
    vi.stubGlobal("document", {});
    expect(() => setup("text")).toThrow("dangerouslyAllowBrowser");
    const { provider, requests } = setup("text", {}, { dangerouslyAllowBrowser: true });
    await provider.complete(ask());
    expect(requests[0]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });
});

describe("secrets never leak (ADR 0004 sentinel test)", () => {
  const paths: Record<string, () => Promise<unknown>> = {
    authentication: () => setup("error-401").provider.complete(ask()),
    "rate limit": () => setup("error-429").provider.complete(ask()),
    "spend cap": () => setup("error-429-spend-cap").provider.complete(ask()),
    "error event mid-stream": () => setup("overloaded-midstream").provider.complete(ask()),
    "malformed stream": () => setup("malformed").provider.complete(ask()),
    truncation: () => setup("text", { truncateAt: 40 }).provider.complete(ask()),
    "network failure": () =>
      createAnthropic({
        apiKey: KEY,
        model: "m",
        fetch: () => Promise.reject(new TypeError(`${KEY} ${PROMPT}`)),
      }).complete(ask()),
    abort: async () => {
      const controller = new AbortController();
      const { provider } = setup("text", { hang: true, truncateAt: 600 });
      const events = provider.stream(ask(), { signal: controller.signal })[Symbol.asyncIterator]();
      await events.next();
      controller.abort();
      await events.next();
    },
  };

  it.each(Object.entries(paths))(
    "keeps the key and the prompt out of the %s error",
    async (_, run) => {
      const logs: string[] = [];
      for (const method of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, method).mockImplementation((...args) => {
          logs.push(inspect(args));
        });
      }
      const error = await failure(run);
      expect(isAiError(error)).toBe(true);
      const seen: string[] = [
        String((error as Error).message),
        JSON.stringify(serializeError(error)),
        ...logs,
      ];
      for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
        seen.push(inspect(cause, { depth: 5 }));
        if (cause instanceof Error && cause.cause === cause) {
          break;
        }
      }
      for (const text of seen) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(PROMPT);
      }
    },
  );
});

defineProviderContract(
  (scenario) => {
    const text = loadFixture("anthropic/text");
    const firstEvents = new TextDecoder().decode(text.body).indexOf("event: content_block_stop");
    const fixtures = {
      text: setup("text"),
      "tool-call": setup("tool-call"),
      error: setup("error-429"),
      slow: setup("text", { truncateAt: firstEvents, hang: true }),
    };
    return fixtures[scenario].provider;
  },
  { describe, it },
);

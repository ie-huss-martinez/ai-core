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
import {
  createKimi,
  createOpenAICompatible,
  type OpenAICompatibleOptions,
} from "./openai-compatible.js";

const KEY = "sk-sentinel-key-0123456789abcdef";
const PROMPT = "sentinel prompt: my secret plans";
const BASE = "https://api.openai.com/v1";

const ask = (text = PROMPT): AiRequest => ({
  messages: [{ role: "user", parts: [{ type: "text", text }] }],
});

function setup(
  name: string,
  fetchOptions: FixtureFetchOptions = {},
  options: Partial<OpenAICompatibleOptions> = {},
) {
  const fake = fixtureFetch(loadFixture(name), fetchOptions);
  const provider = createOpenAICompatible({
    apiKey: KEY,
    baseURL: BASE,
    model: "gpt-5",
    provider: "openai",
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

describe("the request (verified against OpenAI's specification and Kimi's API reference)", () => {
  it("posts to <baseURL>/chat/completions, streaming with usage", async () => {
    const { provider, requests } = setup("openai-compatible/text");
    await provider.complete(ask("Hello"));
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(requests[0]?.body).toEqual({
      model: "gpt-5",
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 16_000,
      stream_options: { include_usage: true },
      stream: true,
    });
  });

  it("maps every part: tool results first, images as data URLs, its own reasoning back", async () => {
    const messages: AiMessage[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "Look." },
          { type: "image", mediaType: "image/jpeg", data: new Uint8Array([255, 216, 255]) },
        ],
      },
      {
        role: "assistant",
        parts: [
          { type: "provider-state", provider: "ai-core", data: { context: "sha256-x" } },
          { type: "provider-state", provider: "openai", data: { reasoning_content: "Thinking." } },
          { type: "provider-state", provider: "anthropic", data: { type: "thinking" } },
          { type: "text", text: "Checking." },
          { type: "tool-call", id: "call_1", name: "look", input: { zoom: 2 } },
        ],
      },
      {
        role: "user",
        parts: [
          { type: "tool-result", callId: "call_1", content: [{ type: "text", text: "A cat." }] },
          { type: "text", text: "Thanks!" },
        ],
      },
      { role: "assistant", parts: [{ type: "provider-state", provider: "gemini", data: "g" }] },
    ];
    const { provider, requests } = setup("openai-compatible/text");
    await provider.complete({
      messages,
      system: "Be brief.",
      tools: [{ name: "look", description: "Looks closer.", inputSchema: { type: "object" } }],
      toolChoice: "none",
      providerOptions: { openai: { reasoning_effort: "low", stream: false }, kimi: { x: 1 } },
    });
    expect(requests[0]?.body).toEqual({
      model: "gpt-5",
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "Look." },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "look", arguments: '{"zoom":2}' } },
          ],
          reasoning_content: "Thinking.",
        },
        { role: "tool", tool_call_id: "call_1", content: "A cat." },
        { role: "user", content: "Thanks!" },
      ],
      max_completion_tokens: 16_000,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: { name: "look", description: "Looks closer.", parameters: { type: "object" } },
        },
      ],
      tool_choice: "none",
      reasoning_effort: "low",
      stream: true,
    });
  });

  it("can send max_tokens instead, for APIs that only know it", async () => {
    const { provider, requests } = setup(
      "openai-compatible/text",
      {},
      { maxTokensField: "max_tokens" },
    );
    await provider.complete({ ...ask(), maxOutputTokens: 300 });
    expect(requests[0]?.body).toMatchObject({ max_tokens: 300 });
    expect(requests[0]?.body).not.toHaveProperty("max_completion_tokens");
  });

  it("rejects an invalid request before sending anything", async () => {
    const { provider, requests } = setup("openai-compatible/text");
    for (const request of [
      { messages: [] },
      { ...ask(), tools: [{ name: "has spaces", inputSchema: {} }] },
      {
        messages: [
          {
            role: "user",
            parts: [
              {
                type: "tool-result",
                callId: "1",
                content: [{ type: "image", mediaType: "image/png", data: new Uint8Array([1]) }],
              },
            ],
          },
        ],
      },
    ] as AiRequest[]) {
      expect(isAiError(await failure(() => provider.complete(request)), "INVALID_REQUEST")).toBe(
        true,
      );
    }
    expect(requests).toHaveLength(0);
  });
});

describe("the stream", () => {
  it("maps text, usage and the finish reason", async () => {
    expect(await setup("openai-compatible/text").provider.complete(ask())).toEqual({
      message: {
        role: "assistant",
        parts: [{ type: "text", text: "Hello there! How can I help today?" }],
      },
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 9, cacheReadTokens: 4, reasoningTokens: 0 },
    });
  });

  it("joins tool call fragments, and finishes with tool-calls", async () => {
    const result = await setup("openai-compatible/tool-call").provider.complete(ask());
    expect(result.message.parts).toEqual<AiPart[]>([
      { type: "text", text: "Let me check." },
      {
        type: "tool-call",
        id: "call_fixture_0001",
        name: "get_weather",
        input: { location: "Paris" },
      },
    ]);
    expect(result.finishReason).toBe("tool-calls");
  });

  it("maps length, and a refusal as refusal text", async () => {
    expect(await setup("openai-compatible/length").provider.complete(ask())).toMatchObject({
      finishReason: "length",
    });
    expect(await setup("openai-compatible/refusal").provider.complete(ask())).toMatchObject({
      finishReason: "refusal",
      message: { parts: [{ type: "text", text: "I can't help with that." }] },
    });
  });

  it.each<Chunking>(["whole", "bytes", 5, 64])(
    "gives the same result however the body arrives (%s)",
    async (chunking) => {
      const whole = await setup("openai-compatible/tool-call").provider.complete(ask());
      expect(
        await setup("openai-compatible/tool-call", { chunking }).provider.complete(ask()),
      ).toEqual(whole);
    },
  );
});

describe("Kimi (the preset)", () => {
  function kimi(fetchOptions: FixtureFetchOptions = {}) {
    const fake = fixtureFetch(loadFixture("kimi/thinking"), fetchOptions);
    return {
      provider: createKimi({ apiKey: KEY, model: "kimi-k3.1-pro", fetch: fake.fetch }),
      requests: fake.requests,
    };
  }

  it("uses Kimi's documented base URL, and tags its state kimi", async () => {
    const { provider, requests } = kimi();
    expect(provider.provider).toBe("kimi");
    await provider.complete(ask());
    expect(requests[0]?.url).toBe("https://api.moonshot.ai/v1/chat/completions");
  });

  it("keeps reasoning_content as provider state, with its text as summary", async () => {
    const events = await collect(kimi().provider.stream(ask()));
    expect(events.filter((e) => e.type === "summary-delta")).toHaveLength(2);
    expect(events.flatMap((e) => (e.type === "part" ? [e.part] : []))).toEqual<AiPart[]>([
      {
        type: "provider-state",
        provider: "kimi",
        data: { reasoning_content: "The user wants a greeting. Keep it short." },
        summary: "The user wants a greeting. Keep it short.",
      },
      { type: "text", text: "Hi! 👋 Grüße." },
    ]);
  });

  it("sends the complete assistant message back, reasoning_content included", async () => {
    const result = await kimi().provider.complete(ask());
    const next = kimi();
    await next.provider.complete({
      messages: [...ask().messages, result.message, ...ask("More?").messages],
    });
    const body = next.requests[0]?.body as { messages: unknown[] };
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "Hi! 👋 Grüße.",
      reasoning_content: "The user wants a greeting. Keep it short.",
    });
  });
});

describe("failures (ADR 0007)", () => {
  it("maps a 401, keeping the error code and request ID, never the message", async () => {
    const error = await failure(() =>
      setup("openai-compatible/error-401").provider.complete(ask()),
    );
    expect(isAiError(error, "PROVIDER_AUTHENTICATION")).toBe(true);
    expect((error as { details: unknown }).details).toEqual({
      retryable: false,
      status: 401,
      providerType: "invalid_api_key",
      requestId: "req_fixture_0001",
    });
  });

  it("maps a 429 with retryAfter, and a 500 as retryable", async () => {
    const limited = await failure(() =>
      setup("openai-compatible/error-429").provider.complete(ask()),
    );
    expect(isAiError(limited, "PROVIDER_RATE_LIMITED")).toBe(true);
    expect(limited).toMatchObject({ details: { retryable: true, retryAfter: 7 } });
    const server = await failure(() =>
      setup("openai-compatible/error-500").provider.complete(ask()),
    );
    expect(isAiError(server, "PROVIDER_ERROR")).toBe(true);
    expect(server).toMatchObject({ details: { retryable: true } });
  });

  it("fails on an error chunk mid-stream, as partial", async () => {
    const error = await failure(() =>
      setup("openai-compatible/error-midstream").provider.complete(ask()),
    );
    expect(isAiError(error, "PROVIDER_ERROR")).toBe(true);
    expect(error).toMatchObject({ details: { partial: true, providerType: "server_error" } });
  });

  it("fails with STREAM_TRUNCATED without data: [DONE]", async () => {
    const body = new TextDecoder().decode(loadFixture("openai-compatible/text").body);
    const error = await failure(() =>
      setup("openai-compatible/text", {
        truncateAt: body.indexOf("data: [DONE]"),
      }).provider.complete(ask()),
    );
    expect(isAiError(error, "STREAM_TRUNCATED")).toBe(true);
    expect(error).toMatchObject({ details: { retryable: true, partial: true } });
  });

  it("fails with PROVIDER_RESPONSE_INVALID on malformed JSON", async () => {
    const error = await failure(() =>
      setup("openai-compatible/malformed").provider.complete(ask()),
    );
    expect(isAiError(error, "PROVIDER_RESPONSE_INVALID")).toBe(true);
  });
});

describe("configuration and keys (ADR 0004)", () => {
  it("needs a model and a base URL, https only (http for localhost), with no query", () => {
    const make = (options: Partial<OpenAICompatibleOptions>) => () =>
      createOpenAICompatible({ apiKey: KEY, baseURL: BASE, model: "m", ...options });
    expect(make({ model: "" })).toThrow("needs a model");
    expect(make({ baseURL: "http://api.example/v1" })).toThrow("https:");
    expect(make({ baseURL: "https://api.example/v1?key=x" })).toThrow("query");
    expect(make({ provider: "Bad Name" })).toThrow("provider");
    expect(make({ baseURL: "http://localhost:11434/v1/" })).not.toThrow();
  });

  it("keeps the base URL's path, without a trailing slash", async () => {
    const { provider, requests } = setup(
      "openai-compatible/text",
      {},
      { baseURL: "http://localhost:11434/v1/" },
    );
    await provider.complete(ask());
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("never exposes the key through the provider object", () => {
    const { provider } = setup("openai-compatible/text");
    expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(Object.keys(provider).sort()).toEqual(["complete", "provider", "stream"]);
  });

  it("refuses outside a server without the opt-in", () => {
    vi.stubGlobal("document", {});
    expect(() => setup("openai-compatible/text")).toThrow("dangerouslyAllowBrowser");
    expect(() =>
      setup("openai-compatible/text", {}, { dangerouslyAllowBrowser: true }),
    ).not.toThrow();
  });
});

describe("secrets never leak (ADR 0004 sentinel test)", () => {
  const paths: Record<string, () => Promise<unknown>> = {
    authentication: () => setup("openai-compatible/error-401").provider.complete(ask()),
    "rate limit": () => setup("openai-compatible/error-429").provider.complete(ask()),
    "server error": () => setup("openai-compatible/error-500").provider.complete(ask()),
    "error chunk mid-stream": () =>
      setup("openai-compatible/error-midstream").provider.complete(ask()),
    "malformed stream": () => setup("openai-compatible/malformed").provider.complete(ask()),
    truncation: () => setup("openai-compatible/text", { truncateAt: 60 }).provider.complete(ask()),
    "network failure": () =>
      createOpenAICompatible({
        apiKey: KEY,
        baseURL: BASE,
        model: "m",
        fetch: () => Promise.reject(new TypeError(`${KEY} ${PROMPT}`)),
      }).complete(ask()),
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
      const seen = [
        String((error as Error).message),
        JSON.stringify(serializeError(error)),
        ...logs,
      ];
      for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
        seen.push(inspect(cause, { depth: 5 }));
      }
      for (const text of seen) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(PROMPT);
      }
    },
  );
});

describe("provider contract, OpenAI-compatible", () => {
  defineProviderContract(
    (scenario) => {
      const body = new TextDecoder().decode(loadFixture("openai-compatible/text").body);
      const fixtures = {
        text: () => setup("openai-compatible/text"),
        "tool-call": () => setup("openai-compatible/tool-call"),
        error: () => setup("openai-compatible/error-429"),
        slow: () =>
          setup("openai-compatible/text", { truncateAt: body.indexOf('"How can'), hang: true }),
      };
      return fixtures[scenario]().provider;
    },
    { describe, it },
  );
});

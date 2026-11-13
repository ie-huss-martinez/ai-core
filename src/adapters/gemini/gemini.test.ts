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
import { createGemini, type GeminiOptions } from "./gemini.js";

const KEY = "AIzaSy-sentinel-key-0123456789abcdef";
const PROMPT = "sentinel prompt: my secret plans";

const ask = (text = PROMPT): AiRequest => ({
  messages: [{ role: "user", parts: [{ type: "text", text }] }],
});

function setup(
  name: string,
  fetchOptions: FixtureFetchOptions = {},
  options: Partial<GeminiOptions> = {},
) {
  const fake = fixtureFetch(loadFixture(`gemini/${name}`), fetchOptions);
  const provider = createGemini({
    apiKey: KEY,
    model: "gemini-3.8-flash",
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

describe("the request (verified against Google's Interactions documentation)", () => {
  it("posts to /v1beta/interactions, streaming, stateless and never stored (ADR 0008)", async () => {
    const { provider, requests } = setup("text");
    await provider.complete(ask("Hello"));
    expect(requests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse",
    );
    expect(requests[0]?.headers).toEqual({
      "x-goog-api-key": KEY,
      "api-revision": "2026-05-20",
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(requests[0]?.body).toEqual({
      model: "gemini-3.8-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: "Hello" }] }],
      generation_config: { max_output_tokens: 16_000 },
      stream: true,
      store: false,
    });
  });

  it("keeps store: false and streaming whatever providerOptions say", async () => {
    const { provider, requests } = setup("text");
    await provider.complete({
      ...ask(),
      providerOptions: {
        gemini: { store: true, stream: false, generation_config: { thinking_summaries: "auto" } },
      },
    });
    expect(requests[0]?.body).toMatchObject({
      store: false,
      stream: true,
      generation_config: { max_output_tokens: 16_000, thinking_summaries: "auto" },
    });
  });

  it("sends the full history: Gemini's own steps exactly, results with their call's name", async () => {
    const thought = {
      type: "thought",
      signature: "sig-1",
      summary: [{ type: "text", text: "Hmm." }],
    };
    const messages: AiMessage[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "Weather in Paris?" },
          { type: "image", mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) },
        ],
      },
      {
        role: "assistant",
        parts: [
          { type: "provider-state", provider: "ai-core", data: { context: "sha256-x" } },
          { type: "provider-state", provider: "gemini", data: thought, summary: "Hmm." },
          { type: "provider-state", provider: "anthropic", data: { type: "thinking" } },
          { type: "tool-call", id: "fc_1", name: "get_weather", input: { location: "Paris" } },
        ],
      },
      {
        role: "user",
        parts: [{ type: "tool-result", callId: "fc_1", content: "22°C", isError: false }],
      },
    ];
    const { provider, requests } = setup("text");
    await provider.complete({
      messages,
      system: "Be brief.",
      tools: [{ name: "get_weather", description: "Weather.", inputSchema: { type: "object" } }],
      toolChoice: "auto",
    });
    expect(requests[0]?.body).toEqual({
      model: "gemini-3.8-flash",
      system_instruction: "Be brief.",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Weather.",
          parameters: { type: "object" },
        },
      ],
      input: [
        {
          type: "user_input",
          content: [
            { type: "text", text: "Weather in Paris?" },
            { type: "image", data: "iVBORw==", mime_type: "image/png" },
          ],
        },
        thought,
        {
          type: "function_call",
          id: "fc_1",
          name: "get_weather",
          arguments: { location: "Paris" },
        },
        {
          type: "function_result",
          name: "get_weather",
          call_id: "fc_1",
          result: [{ type: "text", text: "22°C" }],
          is_error: false,
        },
      ],
      generation_config: { max_output_tokens: 16_000, tool_choice: "auto" },
      stream: true,
      store: false,
    });
  });

  it("rejects a tool result without its call, before sending", async () => {
    const { provider, requests } = setup("text");
    const error = await failure(() =>
      provider.complete({
        messages: [
          { role: "user", parts: [{ type: "tool-result", callId: "nope", content: "x" }] },
        ],
      }),
    );
    expect(isAiError(error, "INVALID_REQUEST")).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("the stream", () => {
  it("maps the documented example: a thought with its signature, then text", async () => {
    const result = await setup("text").provider.complete(ask());
    expect(result).toEqual({
      message: {
        role: "assistant",
        parts: [
          {
            type: "provider-state",
            provider: "gemini",
            data: { type: "thought", signature: "EvEFCu4Ffixture-signature-0001" },
          },
          { type: "text", text: "Hello there! How can I help today?" },
        ],
      },
      finishReason: "stop",
      rawFinishReason: "completed",
      usage: { inputTokens: 8, outputTokens: 12 },
    });
  });

  it("maps both documented thought-delta spellings identically", async () => {
    const summaries = await collect(setup("thinking").provider.stream(ask()));
    const alternative = await collect(setup("thinking-alt-delta").provider.stream(ask()));
    expect(alternative).toEqual(summaries);
    expect(summaries.flatMap((e) => (e.type === "part" ? [e.part] : []))[0]).toEqual<AiPart>({
      type: "provider-state",
      provider: "gemini",
      data: {
        type: "thought",
        signature: "EvEFCu4Ffixture-signature-0001",
        summary: [{ type: "text", text: "The user wants a greeting. Keep it short." }],
      },
      summary: "The user wants a greeting. Keep it short.",
    });
    expect(summaries.at(-1)).toMatchObject({ usage: { reasoningTokens: 297 } });
  });

  it("sends a thought back exactly as the stream produced it", async () => {
    const first = await setup("thinking").provider.complete(ask());
    const next = setup("text");
    await next.provider.complete({
      messages: [...ask().messages, first.message, ...ask("More?").messages],
    });
    const input = (next.requests[0]?.body as { input: unknown[] } | undefined)?.input ?? [];
    expect(input[1]).toEqual(
      first.message.parts[0]?.type === "provider-state" && first.message.parts[0].data,
    );
  });

  it("reports function calls with Gemini's id, and finishes with tool-calls", async () => {
    const result = await setup("tool-call").provider.complete(ask());
    expect(result.message.parts.at(-1)).toEqual({
      type: "tool-call",
      id: "fc_fixture_0001",
      name: "get_weather",
      input: { location: "Paris" },
    });
    expect(result).toMatchObject({
      finishReason: "tool-calls",
      rawFinishReason: "requires_action",
    });
  });

  it("maps incomplete to length", async () => {
    expect(await setup("incomplete").provider.complete(ask())).toMatchObject({
      finishReason: "length",
      rawFinishReason: "incomplete",
    });
  });

  it.each<Chunking>(["whole", "bytes", 9, 64])(
    "gives the same result however the body arrives (%s)",
    async (chunking) => {
      const whole = await setup("thinking").provider.complete(ask());
      expect(await setup("thinking", { chunking }).provider.complete(ask())).toEqual(whole);
    },
  );
});

describe("failures (ADR 0007)", () => {
  it("maps a 429 to PROVIDER_RATE_LIMITED, keeping Google's status name", async () => {
    const error = await failure(() => setup("error-429").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_RATE_LIMITED")).toBe(true);
    expect(error).toMatchObject({
      details: { retryable: true, status: 429, providerType: "RESOURCE_EXHAUSTED" },
    });
  });

  it("maps an error event mid-stream by its code, as partial", async () => {
    const error = await failure(() => setup("error-midstream").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_TIMEOUT")).toBe(true);
    expect(error).toMatchObject({
      details: { retryable: true, partial: true, providerType: "gateway_timeout" },
    });
  });

  it("fails a failed interaction as retryable", async () => {
    const error = await failure(() => setup("failed").provider.complete(ask()));
    expect(isAiError(error, "PROVIDER_ERROR")).toBe(true);
    expect(error).toMatchObject({ details: { retryable: true } });
  });

  it("fails with STREAM_TRUNCATED without interaction.completed", async () => {
    const body = new TextDecoder().decode(loadFixture("gemini/text").body);
    const error = await failure(() =>
      setup("text", { truncateAt: body.indexOf("event: interaction.completed") }).provider.complete(
        ask(),
      ),
    );
    expect(isAiError(error, "STREAM_TRUNCATED")).toBe(true);
  });

  it("fails with PROVIDER_RESPONSE_INVALID on malformed JSON", async () => {
    expect(
      isAiError(
        await failure(() => setup("malformed").provider.complete(ask())),
        "PROVIDER_RESPONSE_INVALID",
      ),
    ).toBe(true);
  });
});

describe("configuration and keys (ADR 0004)", () => {
  it("needs a model, and an https base URL", () => {
    expect(() => createGemini({ apiKey: KEY, model: "" })).toThrow("needs a model");
    expect(() =>
      createGemini({ apiKey: KEY, model: "m", baseURL: "http://gemini.example" }),
    ).toThrow("https:");
  });

  it("sends the key in a header, never in the URL", async () => {
    const { provider, requests } = setup("text");
    await provider.complete(ask());
    expect(requests[0]?.url).not.toContain(KEY);
    expect(requests[0]?.url).not.toContain("key=");
  });

  it("never exposes the key through the provider object", () => {
    const { provider } = setup("text");
    expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(KEY);
  });

  it("refuses outside a server without the opt-in", () => {
    vi.stubGlobal("document", {});
    expect(() => setup("text")).toThrow("dangerouslyAllowBrowser");
  });
});

describe("secrets never leak (ADR 0004 sentinel test)", () => {
  const paths: Record<string, () => Promise<unknown>> = {
    "rate limit": () => setup("error-429").provider.complete(ask()),
    "error event mid-stream": () => setup("error-midstream").provider.complete(ask()),
    "failed interaction": () => setup("failed").provider.complete(ask()),
    "malformed stream": () => setup("malformed").provider.complete(ask()),
    truncation: () => setup("text", { truncateAt: 80 }).provider.complete(ask()),
    "network failure": () =>
      createGemini({
        apiKey: KEY,
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

describe("provider contract, Gemini", () => {
  defineProviderContract(
    (scenario) => {
      const body = new TextDecoder().decode(loadFixture("gemini/text").body);
      const fixtures = {
        text: () => setup("text"),
        "tool-call": () => setup("tool-call"),
        error: () => setup("error-429"),
        slow: () => setup("text", { truncateAt: body.indexOf("How can"), hang: true }),
      };
      return fixtures[scenario]().provider;
    },
    { describe, it },
  );
});

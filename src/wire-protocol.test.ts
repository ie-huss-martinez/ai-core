/**
 * The browser transport, alone and wired to a real handler (ADR 0003): both
 * sides of the ai-core/1 protocol. It lives beside the entries rather than
 * in src/adapters, because adapters never import the server, tests included.
 */
import { inspect } from "node:util";
import { serializeError } from "@hussmartinez/sdk-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HttpTransportOptions, httpTransport } from "./adapters/http/transport.js";
import { AiError, isAiError } from "./core/errors/ai-error.js";
import type { AiMessage } from "./core/model/message.js";
import type { AiEvent, AiRequest } from "./core/model/provider.js";
import { withoutProviderState } from "./core/protocol/wire.js";
import { type AiCallSettings, createAiHandler } from "./server/handler.js";
import { fakeScenarios } from "./test/fake-scenarios.js";
import { defineProviderContract } from "./testing/contract.js";
import { createFakeProvider, type FakeTurn } from "./testing/fake-provider.js";

const URL_ = "https://app.example.com/api/chat";
const TOKEN = "session-sentinel-token-0123456789";
const PROMPT = "sentinel prompt: my secret plans";
const SETTINGS: AiCallSettings = { system: "Be brief.", maxOutputTokens: 100 };

const hi: AiMessage = { role: "user", parts: [{ type: "text", text: "Hi" }] };
const ask = (messages: readonly AiMessage[] = [hi]): AiRequest => ({ messages });

/** A transport wired to a real handler, as a page and its server would be. */
function wired(
  turns: readonly FakeTurn[] | ((request: AiRequest, index: number) => FakeTurn),
  prepare: () => AiCallSettings | Response = () => SETTINGS,
  options: Partial<HttpTransportOptions> = {},
) {
  const provider = createFakeProvider(turns);
  const handler = createAiHandler({ provider, prepare });
  const requests: Request[] = [];
  const transport = httpTransport({
    url: URL_,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    },
    ...options,
  });
  return { transport, provider, requests };
}

/** A transport that receives a canned response. */
function canned(
  body: string,
  init: ResponseInit = {},
  options: Partial<HttpTransportOptions> = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        ...init,
      }),
  );
  return { transport: httpTransport({ url: URL_, fetch, ...options }), fetch };
}

const sse = (...events: [string, unknown][]) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const START: [string, unknown] = ["start", { protocol: "ai-core/1" }];
const FINISH: [string, unknown] = ["finish", { finishReason: "stop", usage: {} }];

async function failure(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (error) {
    expect(isAiError(error)).toBe(true);
    return error as AiError;
  }
  throw new Error("expected the call to fail");
}

async function collect(events: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const seen: AiEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("httpTransport: configuration", () => {
  it.each([
    "",
    "ftp://app.example.com/chat",
    "http://app.example.com/chat",
    "//evil.example/chat",
    "chat",
  ])("rejects the url %j", (url) => {
    expect(() => httpTransport({ url })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
  });

  it("accepts a path, https: and http: on localhost", () => {
    for (const url of ["/api/chat", URL_, "http://localhost:3000/api/chat"]) {
      expect(httpTransport({ url }).provider).toBe("ai-core");
    }
  });

  it("resolves a path against the page", async () => {
    vi.stubGlobal("location", { href: "https://app.example.com/chat/42" });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(sse(START, FINISH), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await httpTransport({ url: "/api/chat", fetch }).complete(ask());
    expect(fetch.mock.calls[0]?.[0]).toBe(URL_);
  });

  it("fails the call, not the method, for a path outside a page", async () => {
    const transport = httpTransport({ url: "/api/chat", fetch: vi.fn() });
    const pending = transport.complete(ask());
    expect((await failure(() => pending)).code).toBe("INVALID_CONFIGURATION");
  });

  it("runs outside a server, because it holds no key", async () => {
    vi.stubGlobal("process", undefined);
    const { transport } = canned(sse(START, FINISH));
    await expect(transport.complete(ask())).resolves.toMatchObject({ finishReason: "stop" });
  });
});

describe("httpTransport: the request", () => {
  it("sends only the protocol and the messages, with images as base64", async () => {
    const { transport, fetch } = canned(sse(START, FINISH));
    await transport.complete({
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Look" },
            { type: "image", mediaType: "image/png", data: new Uint8Array([0, 1, 2]) },
          ],
        },
      ],
    });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      protocol: "ai-core/1",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Look" },
            { type: "image", mediaType: "image/png", data: "AAEC" },
          ],
        },
      ],
    });
  });

  it("sends the host's headers, with its own content-type and accept", async () => {
    const headers = vi.fn(async () => ({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "text/plain",
    }));
    const { transport, fetch } = canned(sse(START, FINISH), {}, { headers });
    await transport.complete(ask());
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(headers).toHaveBeenCalledTimes(1);
  });

  it.each([
    "system",
    "tools",
    "toolChoice",
    "model",
    "maxOutputTokens",
    "providerOptions",
  ] as const)("rejects %s locally, before any request", async (field) => {
    const { transport, fetch } = canned(sse(START, FINISH));
    const error = await failure(() =>
      transport.complete({
        ...ask(),
        [field]: field === "maxOutputTokens" ? 10 : "x",
      } as AiRequest),
    );
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.details).toMatchObject({ path: field });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("httpTransport: with the handler", () => {
  it("returns the answer, with the handler's context part first", async () => {
    const { transport } = wired([
      { parts: [{ type: "text", text: "Hello there" }], usage: { outputTokens: 2 } },
    ]);
    const result = await transport.complete(ask());
    expect(result.message.parts[0]).toMatchObject({ type: "provider-state", provider: "ai-core" });
    expect(result.message.parts.slice(1)).toEqual([{ type: "text", text: "Hello there" }]);
    expect(result).toMatchObject({ finishReason: "stop", usage: { outputTokens: 2 } });
  });

  it("streams deltas and parts in order, with image bytes rebuilt", async () => {
    const { transport } = wired([
      {
        parts: [
          { type: "text", text: "Hi there" },
          { type: "image", mediaType: "image/gif", data: new Uint8Array([255]) },
        ],
        chunkSize: 4,
      },
    ]);
    const events = await collect(transport.stream(ask()));
    expect(events.slice(1)).toEqual([
      { type: "text-delta", text: "Hi t" },
      { type: "text-delta", text: "here" },
      { type: "part", part: { type: "text", text: "Hi there" } },
      {
        type: "part",
        part: { type: "image", mediaType: "image/gif", data: new Uint8Array([255]) },
      },
      { type: "finish", finishReason: "stop", usage: {} },
    ]);
  });

  it("continues a conversation, and fails fast with CONTEXT_CHANGED when the prompt changes", async () => {
    let settings = SETTINGS;
    const { transport, provider } = wired(
      () => ({ parts: [{ type: "text", text: "ok" }] }),
      () => settings,
    );
    const first = await transport.complete(ask());
    const history: AiMessage[] = [hi, first.message, hi];
    await transport.complete(ask(history));
    expect(provider.requests[1]?.messages).toEqual([
      hi,
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      hi,
    ]);

    settings = { ...SETTINGS, system: "Be brief. Today is Friday." };
    const error = await failure(() => transport.complete(ask(history)));
    expect(error.code).toBe("CONTEXT_CHANGED");
    expect(error.details).toMatchObject({ messageIndex: 1, retryable: false });
    expect(provider.requests).toHaveLength(2);

    await expect(transport.complete(ask(withoutProviderState(history)))).resolves.toBeDefined();
  });

  it("rebuilds the handler's errors, mid-stream with partial: true", async () => {
    const { transport } = wired([
      {
        parts: [{ type: "text", text: "Hi" }],
        error: new AiError("PROVIDER_OVERLOADED", "Overloaded.", {
          details: { retryable: true, status: 529 },
        }),
      },
    ]);
    const error = await failure(() => transport.complete(ask()));
    expect(error).toBeInstanceOf(AiError);
    expect(error.code).toBe("PROVIDER_OVERLOADED");
    expect(error.details).toEqual({ retryable: true, status: 529, partial: true });
  });

  it("rebuilds the handler's errors before the stream", async () => {
    const { transport } = wired([], () => ({ maxOutputTokens: 0 }));
    expect((await failure(() => transport.complete(ask()))).code).toBe("PREPARE_FAILED");
  });

  it.each([
    [401, {}, "PROVIDER_AUTHENTICATION", { status: 401, retryable: false }],
    [
      429,
      { "retry-after": "5" },
      "PROVIDER_RATE_LIMITED",
      { status: 429, retryable: true, retryAfter: 5 },
    ],
  ] as const)("maps prepare's own %i by its status", async (status, headers, code, details) => {
    const { transport } = wired([], () => new Response("Sign in first", { status, headers }));
    const error = await failure(() => transport.complete(ask()));
    expect(error.code).toBe(code);
    expect(error.details).toEqual(details);
  });
});

describe("httpTransport: the handler's stream is hostile input too", () => {
  it.each([
    ["no start event", sse(["text-delta", { text: "Hi" }], FINISH), "PROVIDER_RESPONSE_INVALID"],
    [
      "another protocol version",
      sse(["start", { protocol: "ai-core/2" }], FINISH),
      "PROTOCOL_MISMATCH",
    ],
    ["two start events", sse(START, START, FINISH), "PROVIDER_RESPONSE_INVALID"],
    [
      "a delta without text",
      sse(START, ["text-delta", { text: 1 }], FINISH),
      "PROVIDER_RESPONSE_INVALID",
    ],
    [
      "a part outside the message model",
      sse(
        START,
        ["part", { part: { type: "image", mediaType: "image/png", data: "https://x" } }],
        FINISH,
      ),
      "PROVIDER_RESPONSE_INVALID",
    ],
    [
      "an unknown finish reason",
      sse(START, ["finish", { finishReason: "done", usage: {} }]),
      "PROVIDER_RESPONSE_INVALID",
    ],
    [
      "usage that isn't counts",
      sse(START, ["finish", { finishReason: "stop", usage: { inputTokens: -1 } }]),
      "PROVIDER_RESPONSE_INVALID",
    ],
    ["data that isn't JSON", "event: start\ndata: {\n\n", "PROVIDER_RESPONSE_INVALID"],
    ["no finish event", sse(START, ["text-delta", { text: "Hi" }]), "STREAM_TRUNCATED"],
    [
      "an error that isn't an AiError",
      sse(START, ["error", { name: "TypeError", code: "UNKNOWN", message: "x" }]),
      "PROVIDER_RESPONSE_INVALID",
    ],
  ])("fails on %s", async (_, body, code) => {
    const { transport } = canned(body);
    expect((await failure(() => transport.complete(ask()))).code).toBe(code);
  });

  it("ignores event types it doesn't know, for later additions", async () => {
    const { transport } = canned(sse(START, ["ping", {}], ["text-delta", { text: "Hi" }], FINISH));
    expect((await collect(transport.stream(ask()))).map((event) => event.type)).toEqual([
      "text-delta",
      "finish",
    ]);
  });

  it("fails a success that isn't an event stream", async () => {
    const { transport } = canned("{}", { headers: { "content-type": "application/json" } });
    expect((await failure(() => transport.complete(ask()))).code).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("applies the response limits to the handler's stream", async () => {
    const { transport } = canned(
      sse(START, ["text-delta", { text: "x".repeat(2_000) }], FINISH),
      {},
      { limits: { responseBytes: 1_000 } },
    );
    expect((await failure(() => transport.complete(ask()))).code).toBe("RESPONSE_TOO_LARGE");
  });

  it("fails with NETWORK_ERROR when the handler can't be reached", async () => {
    const transport = httpTransport({
      url: URL_,
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const error = await failure(() => transport.complete(ask()));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.details).toMatchObject({ retryable: true, origin: "https://app.example.com" });
  });
});

describe("httpTransport: secrets never leak (sentinel test)", () => {
  const prompt = ask([{ role: "user", parts: [{ type: "text", text: PROMPT }] }]);
  const options = { headers: { authorization: `Bearer ${TOKEN}` } };
  const paths: Record<string, () => Promise<unknown>> = {
    "a handler error": () =>
      wired(
        [{ error: new AiError("PROVIDER_ERROR", "Failed.", { details: { retryable: true } }) }],
        undefined,
        options,
      ).transport.complete(prompt),
    "prepare's 401": () =>
      wired(
        [],
        () => new Response(`${TOKEN} ${PROMPT}`, { status: 401 }),
        options,
      ).transport.complete(prompt),
    "a network failure": () =>
      httpTransport({
        url: URL_,
        ...options,
        fetch: () => Promise.reject(new TypeError(`${TOKEN} ${PROMPT}`)),
      }).complete(prompt),
    "an invalid part": () =>
      canned(
        sse(START, ["part", { part: { type: "text", text: 1, [PROMPT]: TOKEN } }]),
        {},
        options,
      ).transport.complete(prompt),
    "invalid JSON": () =>
      canned(`event: start\ndata: {${PROMPT}\n\n`, {}, options).transport.complete(prompt),
    "a server-only field": () =>
      httpTransport({ url: URL_, ...options, fetch: vi.fn() }).complete({
        ...prompt,
        system: PROMPT,
      }),
  };

  it.each(Object.entries(paths))("keeps the token and the prompt out of %s", async (_, run) => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        logs.push(inspect(args));
      });
    }
    const error = await failure(run);
    const seen = [error.message, JSON.stringify(serializeError(error)), ...logs];
    for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
      seen.push(inspect(cause, { depth: 5 }));
    }
    for (const text of seen) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(PROMPT);
    }
  });
});

describe("httpTransport with the handler: the provider contract", () => {
  defineProviderContract(
    (scenario) => wired(() => fakeScenarios[scenario]).transport,
    { describe, it },
    // The fake's state reaches the page tagged "fake", as the server's provider tagged it.
    { relaysState: true },
  );
});

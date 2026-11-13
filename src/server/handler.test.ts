import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError } from "../core/errors/ai-error.js";
import type { AiMessage } from "../core/model/message.js";
import type { AiEvent, AiProvider, AiRequest } from "../core/model/provider.js";
import { createFakeProvider, type FakeTurn } from "../testing/fake-provider.js";
import { type AiCallSettings, type AiHandlerOptions, createAiHandler } from "./handler.js";

const KEY = "sk-ant-sentinel-key-0123456789abcdef";
const PROMPT = "sentinel prompt: my secret plans";
const URL_ = "https://app.example.com/api/chat";

const SETTINGS: AiCallSettings = {
  system: "Be brief.",
  maxOutputTokens: 500,
  tools: [{ name: "look", inputSchema: { type: "object" } }],
};

const hello: AiMessage = { role: "user", parts: [{ type: "text", text: "Hi" }] };

function setup(
  turns: readonly FakeTurn[] = [{ parts: [{ type: "text", text: "Hello there" }] }],
  options: Partial<AiHandlerOptions> = {},
) {
  const provider = createFakeProvider(turns);
  const prepare = vi.fn<AiHandlerOptions["prepare"]>(() => SETTINGS);
  const handler = createAiHandler({ provider, prepare, ...options });
  return { handler, provider, prepare };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ask = (messages: unknown = [hello], extra: object = {}) =>
  post({ protocol: "ai-core/1", messages, ...extra });

async function errorOf(response: Response) {
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const { error } = (await response.json()) as {
    error: { name: string; code: string; message: string; details?: Record<string, unknown> };
  };
  expect(error.name).toBe("AiError");
  return error;
}

interface WireEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

async function eventsOf(response: Response): Promise<WireEvent[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [event, data] = block.split("\n");
      return {
        event: event?.replace(/^event: /, "") ?? "",
        data: JSON.parse(data?.replace(/^data: /, "") ?? "null"),
      };
    });
}

/** The assistant message a client would store from a stream. */
function assistantOf(events: readonly WireEvent[]): AiMessage {
  return {
    role: "assistant",
    parts: events
      .filter((e) => e.event === "part")
      .map((e) => e.data["part"]) as AiMessage["parts"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAiHandler: configuration", () => {
  it("requires prepare, so an open proxy can't be deployed by accident", () => {
    const provider = createFakeProvider([]);
    expect(() => createAiHandler({ provider } as unknown as AiHandlerOptions)).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
  });

  it("requires a provider", () => {
    expect(() =>
      createAiHandler({ prepare: () => SETTINGS } as unknown as AiHandlerOptions),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it.each(["https://app.example.com/", "app.example.com", "https://app.example.com/chat", "*"])(
    "rejects the allowed origin %s",
    (origin) => {
      expect(() => setup([], { allowedOrigins: [origin] })).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
    },
  );

  it("rejects unknown limits, including response limits", () => {
    expect(() => setup([], { limits: { responseBytes: 1 } as never })).toThrow(TypeError);
  });
});

describe("createAiHandler: what it accepts", () => {
  it("answers 405 to anything but POST, with Allow", async () => {
    const { handler, prepare } = setup();
    const response = await handler(new Request(URL_));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await errorOf(response)).code).toBe("METHOD_NOT_ALLOWED");
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["no content type", undefined],
    ["a form", "application/x-www-form-urlencoded"],
    ["plain text", "text/plain"],
    ["a JSON-like type", "application/json-patch+json"],
  ])("answers 415 to %s", async (_, type) => {
    const { handler } = setup();
    const request = new Request(URL_, {
      method: "POST",
      body: JSON.stringify({ protocol: "ai-core/1", messages: [hello] }),
      headers: type ? { "content-type": type } : {},
    });
    if (!type) {
      request.headers.delete("content-type");
    }
    const response = await handler(request);
    expect(response.status).toBe(415);
    expect((await errorOf(response)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("accepts JSON with a charset, in any case", async () => {
    const { handler } = setup();
    const response = await handler(
      post(
        { protocol: "ai-core/1", messages: [hello] },
        { "content-type": "Application/JSON; charset=UTF-8" },
      ),
    );
    expect(response.status).toBe(200);
  });

  describe("allowedOrigins", () => {
    const options = { allowedOrigins: ["https://app.example.com"] };

    it.each([
      ["another origin", { origin: "https://evil.example" }],
      ["no origin", {}],
      ["the origin with a trailing slash", { origin: "https://app.example.com/" }],
    ])("answers 403 to %s, before prepare", async (_, headers) => {
      const { handler, prepare } = setup(undefined, options);
      const response = await handler(post({ protocol: "ai-core/1", messages: [hello] }, headers));
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("ORIGIN_NOT_ALLOWED");
      expect(prepare).not.toHaveBeenCalled();
    });

    it("accepts a listed origin, and passes it to prepare", async () => {
      const { handler, prepare } = setup(undefined, options);
      const response = await handler(
        post({ protocol: "ai-core/1", messages: [hello] }, { origin: "https://app.example.com" }),
      );
      expect(response.status).toBe(200);
      expect(prepare.mock.calls[0]?.[0].origin).toBe("https://app.example.com");
    });
  });

  describe("the requestBytes limit", () => {
    it("answers 413 from content-length, without reading the body", async () => {
      const { handler, prepare } = setup(undefined, { limits: { requestBytes: 100 } });
      const pulled = vi.fn();
      // No queue: the stream is pulled only when someone reads it.
      const body = new ReadableStream({ pull: pulled }, { highWaterMark: 0 });
      const response = await handler(
        new Request(URL_, {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "101" },
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(413);
      const error = await errorOf(response);
      expect(error.code).toBe("REQUEST_TOO_LARGE");
      expect(error.details).toMatchObject({ limit: "requestBytes", maximum: 100, actual: 101 });
      expect(pulled).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    });

    it("answers 413 while reading a body with no content-length, and stops reading", async () => {
      const { handler } = setup(undefined, { limits: { requestBytes: 100 } });
      let chunks = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(60));
        },
      });
      const response = await handler(
        new Request(URL_, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(413);
      expect((await errorOf(response)).details).toMatchObject({ actual: 120 });
      expect(chunks).toBeLessThan(5);
    });

    it("warns once, without content, above the warning threshold", async () => {
      const onWarning = vi.fn();
      const { handler } = setup(undefined, {
        limits: { requestBytes: { maximum: 10_000, warning: 10 } },
        onWarning,
      });
      const request = ask();
      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning).toHaveBeenCalledWith({
        limit: "requestBytes",
        actual: expect.any(Number),
        maximum: 10_000,
      });
    });
  });

  describe("the body", () => {
    it.each([
      ["invalid JSON", "{"],
      ["an array", "[]"],
      ["no protocol", { messages: [hello] }],
      ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
    ])("answers 400 INVALID_REQUEST to %s", async (_, body) => {
      const { handler, prepare } = setup();
      const response = await handler(
        new Request(URL_, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body:
            body instanceof Uint8Array || typeof body === "string" ? body : JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("INVALID_REQUEST");
      expect(prepare).not.toHaveBeenCalled();
    });

    it("answers 400 PROTOCOL_MISMATCH to another version, with the supported ones", async () => {
      const { handler } = setup();
      const response = await handler(post({ protocol: "ai-core/2", messages: [hello] }));
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("PROTOCOL_MISMATCH");
      expect(error.details).toMatchObject({ supported: ["ai-core/1"] });
    });

    it.each(["model", "system", "tools", "maxOutputTokens", "providerOptions", "toolChoice"])(
      "rejects %s from the browser, naming it, before prepare",
      async (field) => {
        const { handler, prepare, provider } = setup();
        const response = await handler(ask([hello], { [field]: "x" }));
        expect(response.status).toBe(400);
        const error = await errorOf(response);
        expect(error.code).toBe("INVALID_REQUEST");
        expect(error.message).toContain(`"${field}"`);
        expect(error.details).toMatchObject({ path: field });
        expect(prepare).not.toHaveBeenCalled();
        expect(provider.requests).toHaveLength(0);
      },
    );

    it("rejects messages that don't match the model, naming the field", async () => {
      const { handler } = setup();
      const response = await handler(ask([{ role: "user", parts: [{ type: "video" }] }]));
      expect(response.status).toBe(400);
      expect((await errorOf(response)).details).toMatchObject({
        path: "messages[0].parts[0].type",
      });
    });
  });
});

describe("createAiHandler: prepare", () => {
  it("receives the request, the checked body and the origin", async () => {
    const { handler, prepare } = setup();
    const request = post(
      {
        protocol: "ai-core/1",
        messages: [
          { role: "user", parts: [{ type: "image", mediaType: "image/png", data: "AAE=" }] },
        ],
      },
      { origin: "https://app.example.com" },
    );
    await handler(request);
    const context = prepare.mock.calls[0]?.[0];
    expect(context?.request).toBe(request);
    expect(context?.origin).toBe("https://app.example.com");
    expect(context?.body).toEqual({
      protocol: "ai-core/1",
      messages: [
        {
          role: "user",
          parts: [{ type: "image", mediaType: "image/png", data: new Uint8Array([0, 1]) }],
        },
      ],
    });
  });

  it("returns prepare's Response unchanged, and calls no provider", async () => {
    const rejection = new Response("Slow down", { status: 429, headers: { "retry-after": "5" } });
    const { handler, provider } = setup(undefined, { prepare: async () => rejection });
    expect(await handler(ask())).toBe(rejection);
    expect(provider.requests).toHaveLength(0);
  });

  it("answers 500 PREPARE_FAILED when prepare throws, without the thrown error", async () => {
    const { handler, provider } = setup(undefined, {
      prepare: () => {
        throw new Error("database password hunter2");
      },
    });
    const response = await handler(ask());
    expect(response.status).toBe(500);
    const text = await response.clone().text();
    expect(text).not.toContain("hunter2");
    expect((await errorOf(response)).code).toBe("PREPARE_FAILED");
    expect(provider.requests).toHaveLength(0);
  });

  it.each([
    ["no maxOutputTokens", { system: "x" }],
    ["a fractional budget", { maxOutputTokens: 1.5 }],
    ["a zero budget", { maxOutputTokens: 0 }],
    ["a misspelt setting", { maxOutputTokens: 10, maxTokens: 10 }],
    ["an empty model", { maxOutputTokens: 10, model: "" }],
    ["a forced tool", { maxOutputTokens: 10, toolChoice: "required" }],
    ["tools without a schema", { maxOutputTokens: 10, tools: [{ name: "t" }] }],
    ["nothing", undefined],
    [
      "a tool schema that isn't JSON",
      { maxOutputTokens: 10, tools: [{ name: "t", inputSchema: { maximum: Number.NaN } }] },
    ],
  ])("answers 500 PREPARE_FAILED when prepare returns %s", async (_, settings) => {
    const { handler, provider } = setup(undefined, {
      prepare: () => settings as unknown as AiCallSettings,
    });
    const response = await handler(ask());
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("PREPARE_FAILED");
    expect(provider.requests).toHaveLength(0);
  });

  it("sends the provider prepare's settings and the conversation, nothing from the browser", async () => {
    const { handler, provider } = setup(undefined, {
      prepare: () => ({
        ...SETTINGS,
        model: "claude-sonnet-5-5",
        toolChoice: "auto",
        providerOptions: { anthropic: { metadata: { user_id: "u1" } } },
      }),
    });
    await eventsOf(await handler(ask()));
    expect(provider.requests).toEqual([
      {
        messages: [hello],
        maxOutputTokens: 500,
        model: "claude-sonnet-5-5",
        system: "Be brief.",
        tools: SETTINGS.tools,
        toolChoice: "auto",
        providerOptions: { anthropic: { metadata: { user_id: "u1" } } },
      },
    ]);
  });
});

describe("createAiHandler: the ai-core/1 stream", () => {
  it("streams start, the context part, then the provider's events", async () => {
    const { handler } = setup([
      {
        parts: [
          { type: "provider-state", provider: "fake", data: { t: 1 }, summary: "Thinking" },
          { type: "text", text: "Hello there" },
          { type: "image", mediaType: "image/png", data: new Uint8Array([0, 1]) },
        ],
        usage: { inputTokens: 3, outputTokens: 2 },
        chunkSize: 6,
      },
    ]);
    const response = await handler(ask());
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const events = await eventsOf(response);
    expect(events[0]).toEqual({ event: "start", data: { protocol: "ai-core/1" } });
    expect(events[1]).toEqual({
      event: "part",
      data: {
        part: {
          type: "provider-state",
          provider: "ai-core",
          data: { context: expect.stringMatching(/^[0-9a-f]{64}$/) },
        },
      },
    });
    expect(events.slice(2)).toEqual([
      { event: "summary-delta", data: { text: "Thinki" } },
      { event: "summary-delta", data: { text: "ng" } },
      {
        event: "part",
        data: {
          part: { type: "provider-state", provider: "fake", data: { t: 1 }, summary: "Thinking" },
        },
      },
      { event: "text-delta", data: { text: "Hello " } },
      { event: "text-delta", data: { text: "there" } },
      { event: "part", data: { part: { type: "text", text: "Hello there" } } },
      { event: "part", data: { part: { type: "image", mediaType: "image/png", data: "AAE=" } } },
      {
        event: "finish",
        data: { finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } },
      },
    ]);
  });

  it("ends a failed call with an error event instead of finish, without its cause", async () => {
    const error = new AiError("PROVIDER_OVERLOADED", "Overloaded.", {
      details: { retryable: true, status: 529, partial: true },
      cause: new Error("internal detail"),
    });
    const { handler } = setup([{ parts: [{ type: "text", text: "Hi" }], error }]);
    const events = await eventsOf(await handler(ask()));
    expect(events.map((e) => e.event)).toEqual(["start", "part", "text-delta", "part", "error"]);
    expect(events.at(-1)?.data).toEqual({
      name: "AiError",
      code: "PROVIDER_OVERLOADED",
      message: "Overloaded.",
      details: { retryable: true, status: 529, partial: true },
    });
  });

  it("sends only UNKNOWN for a provider's error that isn't an AiError", async () => {
    const provider: AiProvider = {
      provider: "custom",
      complete: () => Promise.reject(new Error("unused")),
      // biome-ignore lint/correctness/useYield: it fails before any event.
      async *stream() {
        throw new TypeError("connect ECONNREFUSED 10.0.0.7:8443");
      },
    };
    const handler = createAiHandler({ provider, prepare: () => SETTINGS });
    const events = await eventsOf(await handler(ask()));
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { name: "AiError", code: "UNKNOWN", message: "The AI call failed." },
    });
  });

  it("fails a stream that ends without finish, or sends an unknown event", async () => {
    const providers: AiProvider[] = [
      {
        provider: "custom",
        complete: () => Promise.reject(new Error("unused")),
        async *stream() {
          yield { type: "text-delta", text: "Hi" };
        },
      },
      {
        provider: "custom",
        complete: () => Promise.reject(new Error("unused")),
        async *stream() {
          yield { type: "evil\ndata: {}" } as unknown as AiEvent;
        },
      },
    ];
    const expected = [
      ["start", "part", "text-delta", "error"],
      ["start", "part", "error"],
    ];
    for (const [index, provider] of providers.entries()) {
      const handler = createAiHandler({ provider, prepare: () => SETTINGS });
      const events = await eventsOf(await handler(ask()));
      // Nothing from the unknown event reaches the wire, not even its type.
      expect(events.map((e) => e.event)).toEqual(expected[index]);
      expect(events.at(-1)).toMatchObject({
        event: "error",
        data: { code: "PROVIDER_RESPONSE_INVALID" },
      });
    }
  });

  it("drops ai-core state from the provider, so the stream has one context part", async () => {
    const { handler } = setup([
      {
        parts: [
          { type: "provider-state", provider: "ai-core", data: { context: "other" } },
          { type: "text", text: "Hi" },
        ],
      },
    ]);
    const events = await eventsOf(await handler(ask()));
    expect(events.filter((e) => e.event === "part")).toHaveLength(2);
  });

  it("aborts the provider's call when the client goes away", async () => {
    let seen: AbortSignal | undefined;
    const provider: AiProvider = {
      provider: "custom",
      complete: () => Promise.reject(new Error("unused")),
      async *stream(_request: AiRequest, options) {
        seen = options?.signal;
        yield { type: "text-delta", text: "Hi" };
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
      },
    };
    const handler = createAiHandler({ provider, prepare: () => SETTINGS });
    const response = await handler(ask());
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.read();
    await reader?.read();
    expect(seen?.aborted).toBe(false);
    await reader?.cancel();
    expect(seen?.aborted).toBe(true);
  });
});

describe("createAiHandler: a stable system prompt and tools (ADR 0003)", () => {
  async function firstTurn() {
    const { handler } = setup();
    return assistantOf(await eventsOf(await handler(ask())));
  }

  it("accepts a first turn, which has no hash yet", async () => {
    const { handler } = setup();
    expect((await handler(ask())).status).toBe(200);
  });

  it("accepts a conversation whose context is unchanged, without sending the provider the hash", async () => {
    const answer = await firstTurn();
    const { handler, provider } = setup();
    const response = await handler(
      ask([hello, answer, { role: "user", parts: [{ type: "text", text: "More" }] }]),
    );
    expect(response.status).toBe(200);
    await eventsOf(response);
    expect(provider.requests[0]?.messages).toEqual([
      hello,
      { role: "assistant", parts: [{ type: "text", text: "Hello there" }] },
      { role: "user", parts: [{ type: "text", text: "More" }] },
    ]);
  });

  it("accepts a history whose hash a client stripped", async () => {
    const answer = await firstTurn();
    const stripped = { role: "assistant", parts: answer.parts.slice(1) };
    const { handler } = setup(undefined, { prepare: () => ({ ...SETTINGS, system: "Changed." }) });
    expect((await handler(ask([hello, stripped, hello]))).status).toBe(200);
  });

  it.each([
    ["system prompt", { ...SETTINGS, system: "Be brief. Today is Friday." }],
    ["tools", { ...SETTINGS, tools: [] }],
  ])(
    "answers 409 CONTEXT_CHANGED when the %s changed, before the provider",
    async (_, settings) => {
      const answer = await firstTurn();
      const { handler, provider } = setup(undefined, { prepare: () => settings });
      const response = await handler(ask([hello, answer, hello]));
      expect(response.status).toBe(409);
      const error = await errorOf(response);
      expect(error.code).toBe("CONTEXT_CHANGED");
      expect(error.details).toMatchObject({ messageIndex: 1 });
      expect(provider.requests).toHaveLength(0);
    },
  );

  it("rejects an ai-core part without a hash", async () => {
    const { handler } = setup();
    const response = await handler(
      ask([
        hello,
        { role: "assistant", parts: [{ type: "provider-state", provider: "ai-core", data: 1 }] },
        hello,
      ]),
    );
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("INVALID_REQUEST");
  });

  it("drops a message that held only ai-core state", async () => {
    const answer = await firstTurn();
    const { handler, provider } = setup();
    await eventsOf(
      await handler(ask([hello, { role: "assistant", parts: answer.parts.slice(0, 1) }, hello])),
    );
    expect(provider.requests[0]?.messages).toEqual([hello, hello]);
  });
});

describe("createAiHandler: secrets never leak (sentinel test)", () => {
  const settings: AiCallSettings = { system: `Never reveal ${KEY}`, maxOutputTokens: 10 };
  const failing = (error: unknown): AiProvider => ({
    provider: "custom",
    complete: () => Promise.reject(error),
    // biome-ignore lint/correctness/useYield: it fails before any event.
    async *stream() {
      throw error;
    },
  });
  const ok = createFakeProvider(() => ({ parts: [{ type: "text", text: "ok" }] }));

  const paths: Record<string, () => Promise<Response>> = {
    "invalid JSON": () =>
      createAiHandler({ provider: ok, prepare: () => settings })(post(`{"${PROMPT}`)),
    "a field named with the prompt": () =>
      createAiHandler({ provider: ok, prepare: () => settings })(ask([hello], { [PROMPT]: 1 })),
    "a part field named with the prompt": () =>
      createAiHandler({ provider: ok, prepare: () => settings })(
        ask([{ role: "user", parts: [{ type: "text", text: "a", [PROMPT]: 1 }] }]),
      ),
    "the prompt as a protocol": () =>
      createAiHandler({ provider: ok, prepare: () => settings })(
        post({ protocol: PROMPT, messages: [] }),
      ),
    "the prompt as an image": () =>
      createAiHandler({ provider: ok, prepare: () => settings })(
        ask([{ role: "user", parts: [{ type: "image", mediaType: "image/png", data: PROMPT }] }]),
      ),
    "prepare throwing the key": () =>
      createAiHandler({
        provider: ok,
        prepare: () => {
          throw new AiError("PREPARE_FAILED", `${KEY} ${PROMPT}`);
        },
      })(ask()),
    "a changed context": async () => {
      const handler = createAiHandler({ provider: ok, prepare: () => settings });
      const answer = assistantOf(await eventsOf(await handler(ask())));
      return createAiHandler({ provider: ok, prepare: () => ({ ...settings, system: PROMPT }) })(
        ask([hello, answer, hello]),
      );
    },
    "a provider error with the key": () =>
      createAiHandler({
        provider: failing(new TypeError(`${KEY} ${PROMPT}`)),
        prepare: () => settings,
      })(ask([{ role: "user", parts: [{ type: "text", text: PROMPT }] }])),
    "an AiError whose cause holds the key": () =>
      createAiHandler({
        provider: failing(
          new AiError("NETWORK_ERROR", "No response.", { cause: new Error(`${KEY} ${PROMPT}`) }),
        ),
        prepare: () => settings,
      })(ask()),
  };

  it.each(Object.entries(paths))("keeps the key and the prompt out of %s", async (_, run) => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        logs.push(inspect(args));
      });
    }
    const response = await run();
    const text = await response.text();
    expect(response.status === 200 ? text.includes("event: error") : response.status >= 400).toBe(
      true,
    );
    for (const seen of [text, ...logs]) {
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain(PROMPT);
    }
    expect(logs).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAiError } from "../errors/ai-error.js";
import { type ResponseLimitOverrides, responseLimits } from "../limits/ai-limits.js";
import type { SseEvent } from "../sse/sse-parser.js";
import { type AiLimitWarning, CallGuard } from "./call-guard.js";
import { parseEventData, readSseEvents } from "./read-sse-events.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A response body the test feeds by hand, which records whether it was cancelled. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    body,
    state,
    send: (chunk: Uint8Array | string) =>
      controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk),
    end: () => controller.close(),
    fail: (reason: unknown) => controller.error(reason),
  };
}

function guard(
  limits?: ResponseLimitOverrides,
  options: { signal?: AbortSignal; onWarning?: (warning: AiLimitWarning) => void } = {},
) {
  return new CallGuard({ policy: responseLimits.resolve(limits), ...options });
}

/** Reads every event, and settles to the events or the error thrown. */
async function readAll(
  events: AsyncIterable<SseEvent>,
): Promise<{ events: SseEvent[]; error?: unknown }> {
  const seen: SseEvent[] = [];
  try {
    for await (const event of events) {
      seen.push(event);
    }
    return { events: seen };
  } catch (error) {
    return { events: seen, error };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readSseEvents", () => {
  it("yields events from bytes split inside multi-byte characters", async () => {
    const source = controlledBody();
    const bytes = encode('data: {"text":"Grüße 👋"}\n\n');
    const split = bytes.indexOf(0x9f); // Inside the emoji's four bytes.
    source.send(bytes.subarray(0, split));
    source.send(bytes.subarray(split));
    source.end();
    const call = guard();
    const result = await readAll(readSseEvents(source.body, call));
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual([{ event: "message", data: '{"text":"Grüße 👋"}' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends without an error when the body ends: truncation is the caller's to judge", async () => {
    const source = controlledBody();
    source.send("data: complete\n\ndata: cut off");
    source.end();
    const result = await readAll(readSseEvents(source.body, guard()));
    expect(result).toEqual({ events: [{ event: "message", data: "complete" }] });
  });

  it("fails on invalid UTF-8, and cancels the body", async () => {
    const source = controlledBody();
    source.send(new Uint8Array([0x64, 0x61, 0xff, 0x0a]));
    const call = guard();
    const result = await readAll(readSseEvents(source.body, call));
    expect(isAiError(result.error, "PROVIDER_RESPONSE_INVALID")).toBe(true);
    expect(source.state.cancelled).toBe(true);
    expect(call.signal.aborted).toBe(true);
  });

  it("fails when the body ends in the middle of a character", async () => {
    const source = controlledBody();
    source.send(encode("data: 👋").subarray(0, 8));
    source.end();
    const result = await readAll(readSseEvents(source.body, guard()));
    expect(isAiError(result.error, "PROVIDER_RESPONSE_INVALID")).toBe(true);
  });

  it("fails with STREAM_TRUNCATED when the body fails while being read", async () => {
    const source = controlledBody();
    source.send("data: a\n\n");
    source.fail(new TypeError("terminated"));
    const result = await readAll(readSseEvents(source.body, guard()));
    expect(isAiError(result.error, "STREAM_TRUNCATED")).toBe(true);
  });

  it("leaves early quietly: the body and the call are cancelled, with no error", async () => {
    const source = controlledBody();
    source.send("data: a\n\ndata: b\n\n");
    const call = guard();
    for await (const event of readSseEvents(source.body, call)) {
      expect(event.data).toBe("a");
      break;
    }
    expect(source.state.cancelled).toBe(true);
    expect(call.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("readSseEvents under the response limits (ADR 0005)", () => {
  it("counts bytes before decoding, and stops at responseBytes", async () => {
    const source = controlledBody();
    const warnings: AiLimitWarning[] = [];
    const call = guard(
      { responseBytes: { maximum: 30, warning: 10 } },
      { onWarning: (warning) => warnings.push(warning) },
    );
    source.send("data: first event\n\n"); // 19 bytes
    source.send("data: over the limit\n\n"); // 41 in total
    source.send("data: never read\n\n");
    const result = await readAll(readSseEvents(source.body, call));
    expect(result.events.map(({ data }) => data)).toEqual(["first event"]);
    expect(isAiError(result.error, "RESPONSE_TOO_LARGE")).toBe(true);
    expect(result.error).toMatchObject({
      details: { limit: "responseBytes", maximum: 30, actual: 41, unit: "bytes" },
    });
    expect(source.state.cancelled).toBe(true);
    expect(warnings).toEqual([{ limit: "responseBytes", actual: 19, maximum: 30 }]);
  });

  it("fails with STREAM_IDLE when nothing arrives for idleTime, including the first byte", async () => {
    const source = controlledBody();
    const call = guard({ idleTime: 1_000 });
    const result = readAll(readSseEvents(source.body, call));
    await vi.advanceTimersByTimeAsync(1_001);
    const { error } = await result;
    expect(isAiError(error, "STREAM_IDLE")).toBe(true);
    expect(source.state.cancelled).toBe(true);
  });

  it("resets the idle timer on every chunk, pings included", async () => {
    const source = controlledBody();
    const call = guard({ idleTime: 1_000 });
    const result = readAll(readSseEvents(source.body, call));
    for (let step = 0; step < 5; step += 1) {
      await vi.advanceTimersByTimeAsync(900);
      source.send('event: ping\ndata: {"type":"ping"}\n\n');
    }
    source.end();
    const { error, events } = await result;
    expect(error).toBeUndefined();
    expect(events).toHaveLength(5);
  });

  it("fails with STREAM_TIMEOUT after streamDuration, however active the stream", async () => {
    const source = controlledBody();
    const warnings: AiLimitWarning[] = [];
    const call = guard(
      { streamDuration: { maximum: 5_000, warning: 3_000 }, idleTime: 1_000 },
      { onWarning: (warning) => warnings.push(warning) },
    );
    const result = readAll(readSseEvents(source.body, call));
    for (let step = 0; step < 12 && !call.signal.aborted; step += 1) {
      source.send("data: tick\n\n");
      await vi.advanceTimersByTimeAsync(500);
    }
    const { error } = await result;
    expect(isAiError(error, "STREAM_TIMEOUT")).toBe(true);
    expect(source.state.cancelled).toBe(true);
    expect(warnings).toEqual([{ limit: "streamDuration", actual: 3_000, maximum: 5_000 }]);
  });

  it("warns once about idleTime when the host sets a warning", async () => {
    const source = controlledBody();
    const warnings: AiLimitWarning[] = [];
    const call = guard(
      { idleTime: { maximum: 1_000, warning: 500 } },
      { onWarning: (warning) => warnings.push(warning) },
    );
    const result = readAll(readSseEvents(source.body, call));
    await vi.advanceTimersByTimeAsync(600);
    source.send("data: a\n\n");
    await vi.advanceTimersByTimeAsync(600);
    source.end();
    await result;
    expect(warnings).toEqual([{ limit: "idleTime", actual: 500, maximum: 1_000 }]);
  });

  it("disables a limit set to Infinity", async () => {
    const source = controlledBody();
    const call = guard({ idleTime: Number.POSITIVE_INFINITY });
    const result = readAll(readSseEvents(source.body, call));
    // Ten minutes of silence: far past the default idleTime, within streamDuration.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    source.send("data: late\n\n");
    source.end();
    const { error, events } = await result;
    expect(error).toBeUndefined();
    expect(events).toHaveLength(1);
  });
});

describe("readSseEvents and the host's signal", () => {
  it("fails with ABORTED when the host aborts, and cancels the body", async () => {
    const source = controlledBody();
    const host = new AbortController();
    const call = guard(undefined, { signal: host.signal });
    const result = readAll(readSseEvents(source.body, call));
    source.send("data: a\n\n");
    await vi.advanceTimersByTimeAsync(10);
    host.abort();
    const { error, events } = await result;
    expect(events).toHaveLength(1);
    expect(isAiError(error, "ABORTED")).toBe(true);
    expect(source.state.cancelled).toBe(true);
  });

  it("delivers no more events after an abort, even from the same chunk", async () => {
    const source = controlledBody();
    const host = new AbortController();
    source.send("data: a\n\ndata: b\n\n");
    const events = readSseEvents(source.body, guard(undefined, { signal: host.signal }));
    expect((await events.next()).value).toEqual({ event: "message", data: "a" });
    host.abort();
    const error = await events.next().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isAiError(error, "ABORTED")).toBe(true);
  });

  it("fails with TIMEOUT when the host's signal times out", async () => {
    const source = controlledBody();
    const host = new AbortController();
    host.abort(new DOMException("Timed out", "TimeoutError"));
    const { error } = await readAll(
      readSseEvents(source.body, guard(undefined, { signal: host.signal })),
    );
    expect(isAiError(error, "TIMEOUT")).toBe(true);
  });
});

describe("CallGuard", () => {
  it("fails with UNSUPPORTED_ENVIRONMENT without AbortSignal.any", () => {
    vi.stubGlobal(
      "AbortSignal",
      Object.assign(function AbortSignal() {}, { any: undefined }),
    );
    let error: unknown;
    try {
      guard();
    } catch (caught) {
      error = caught;
    }
    expect(isAiError(error, "UNSUPPORTED_ENVIRONMENT")).toBe(true);
    expect(error).toMatchObject({ details: { feature: "AbortSignal.any" } });
  });
});

describe("parseEventData", () => {
  it("parses JSON data", () => {
    expect(parseEventData({ event: "message_start", data: '{"type":"message_start"}' })).toEqual({
      type: "message_start",
    });
  });

  it("fails with PROVIDER_RESPONSE_INVALID, never echoing the data", () => {
    const secret = "the user's prompt";
    let error: unknown;
    try {
      parseEventData({ event: "content_block_delta", data: `{"text":"${secret}` });
    } catch (caught) {
      error = caught;
    }
    expect(isAiError(error, "PROVIDER_RESPONSE_INVALID")).toBe(true);
    expect(error).toMatchObject({ details: { event: "content_block_delta" } });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String((error as Error).message)).not.toContain(secret);
  });

  it("leaves out an event name that isn't short and plain", () => {
    let error: unknown;
    try {
      parseEventData({ event: "<script>", data: "{" });
    } catch (caught) {
      error = caught;
    }
    expect(isAiError(error, "PROVIDER_RESPONSE_INVALID")).toBe(true);
    expect((error as { details?: unknown }).details).toBeUndefined();
  });
});

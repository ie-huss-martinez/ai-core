import { describe, expect, it } from "vitest";
import { isAiError } from "../errors/ai-error.js";
import { responseLimits } from "../limits/ai-limits.js";
import type { SseEvent } from "../sse/sse-parser.js";
import { CallGuard } from "./call-guard.js";
import { readSseEvents } from "./read-sse-events.js";

/**
 * The reader in real browsers, which bring their own ReadableStream,
 * TextDecoder and AbortSignal.any: the transport runs it there (ADR 0005).
 */
function body(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function readAll(events: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const seen: SseEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

describe("readSseEvents in a browser", () => {
  it("decodes characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"Grüße 世界 👋"}\r\n\r\n');
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const guard = new CallGuard({ policy: responseLimits.resolve() });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    expect(await readAll(readSseEvents(source, guard))).toEqual([
      { event: "message", data: '{"text":"Grüße 世界 👋"}' },
    ]);
  });

  it("stops at responseBytes and cancels the body", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const guard = new CallGuard({ policy: responseLimits.resolve({ responseBytes: 20 }) });
    const source = body(
      [encoder.encode("data: one\n\n"), encoder.encode("data: two, too many\n\n")],
      () => {
        cancelled = true;
      },
    );
    const error = await readAll(readSseEvents(source, guard)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isAiError(error, "RESPONSE_TOO_LARGE")).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("fails with ABORTED when the host aborts", async () => {
    const host = new AbortController();
    const guard = new CallGuard({ policy: responseLimits.resolve(), signal: host.signal });
    const source = body([new TextEncoder().encode("data: a\n\n")]);
    const events = readSseEvents(source, guard);
    const first = await events.next();
    expect(first.value).toEqual({ event: "message", data: "a" });
    host.abort();
    const error = await events.next().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isAiError(error, "ABORTED")).toBe(true);
  });
});

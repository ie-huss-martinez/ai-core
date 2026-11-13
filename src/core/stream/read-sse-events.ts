import { AiError, isAiError } from "../errors/ai-error.js";
import type { AiJsonValue } from "../model/message.js";
import { type SseEvent, SseParser } from "../sse/sse-parser.js";
import type { CallGuard } from "./call-guard.js";

/** A short, safe name for an event, for `details`. Event names come from the provider. */
const EVENT_NAME = /^[\w.-]{1,64}$/;

function invalidResponse(
  message: string,
  details?: { readonly event?: string; readonly reason?: string },
): AiError {
  return new AiError("PROVIDER_RESPONSE_INVALID", message, details ? { details } : {});
}

/**
 * Reads a `text/event-stream` body under a {@link CallGuard} (ADR 0005), and
 * yields its events.
 *
 * - Each chunk is counted against `responseBytes` before it's decoded, so an
 *   over-limit body is never held whole.
 * - UTF-8 is decoded strictly, across chunk boundaries: invalid bytes, or a
 *   character cut off at the end, fail with `PROVIDER_RESPONSE_INVALID`.
 * - A limit, the host's abort, or any failure cancels the body's reader, so
 *   the connection closes and nothing more is read, then throws the call's
 *   {@link AiError}.
 * - Leaving the loop early cancels the reader and the call quietly.
 * - A body that fails while being read throws `STREAM_TRUNCATED`. A body
 *   that ends normally just ends: whether it ended too early is for the
 *   caller to decide, from the provider's final event.
 *
 * @param body - The response body.
 * @param guard - The call's guard, whose signal was passed to `fetch`.
 * @internal
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  guard: CallGuard,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const cancelReader = (): void => {
    reader.cancel(guard.signal.reason).catch(() => undefined);
  };
  let completed = false;
  try {
    if (guard.signal.aborted) {
      throw guard.error();
    }
    guard.signal.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parser = new SseParser();
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        if (guard.signal.aborted) {
          throw guard.error();
        }
        throw new AiError("STREAM_TRUNCATED", "The response failed while being read.", {
          cause,
        });
      }
      if (guard.signal.aborted) {
        throw guard.error();
      }
      if (result.done) {
        break;
      }
      guard.received(result.value.byteLength);
      let text: string;
      try {
        text = decoder.decode(result.value, { stream: true });
      } catch {
        throw invalidResponse("The response isn't valid UTF-8.", { reason: "invalid-utf8" });
      }
      for (const event of parser.push(text)) {
        // A chunk can hold several events: none goes out after an abort.
        if (guard.signal.aborted) {
          throw guard.error();
        }
        yield event;
      }
    }
    let rest: string;
    try {
      rest = decoder.decode();
    } catch {
      throw invalidResponse("The response ends in the middle of a UTF-8 character.", {
        reason: "truncated-utf8",
      });
    }
    for (const event of [...parser.push(rest), ...parser.finish()]) {
      if (guard.signal.aborted) {
        throw guard.error();
      }
      yield event;
    }
    completed = true;
  } catch (error) {
    const failure = isAiError(error)
      ? error
      : new AiError("UNKNOWN", "Reading the response failed.", { cause: error });
    guard.fail(failure);
    throw failure;
  } finally {
    guard.signal.removeEventListener("abort", cancelReader);
    if (!completed) {
      // Left early, or failed: make sure the connection closes.
      guard.cancel();
      cancelReader();
    }
    guard.dispose();
  }
}

/**
 * Parses an event's data as JSON.
 *
 * @throws {@link AiError} `PROVIDER_RESPONSE_INVALID` when it isn't JSON. The
 *   error never contains the data, which can repeat the prompt.
 * @internal
 */
export function parseEventData(event: SseEvent): AiJsonValue {
  try {
    return JSON.parse(event.data) as AiJsonValue;
  } catch {
    throw invalidResponse(
      "An event's data isn't valid JSON.",
      EVENT_NAME.test(event.event) ? { event: event.event } : undefined,
    );
  }
}

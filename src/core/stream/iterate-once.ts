import { AiError } from "../errors/ai-error.js";

/**
 * Wraps a stream so it can be iterated once, as every provider's stream can
 * (ADR 0002). A second iteration throws `INVALID_REQUEST` instead of
 * sending the call again.
 *
 * @param start - Starts the call and returns its events. It runs on the
 *   first iteration, not before.
 * @internal
 */
export function iterateOnce<Event>(start: () => AsyncIterator<Event>): AsyncIterable<Event> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) {
        throw new AiError(
          "INVALID_REQUEST",
          "This stream was already iterated. Call stream() again to send another request.",
        );
      }
      used = true;
      return start();
    },
  };
}

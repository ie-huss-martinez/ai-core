import { AiError } from "../errors/ai-error.js";
import type { AiPart } from "../model/message.js";
import type { AiEvent, AiResult } from "../model/provider.js";

/**
 * Collects a stream's events into the result `complete()` returns: every
 * `part`, in order, and the `finish` event's reason and usage (ADR 0002).
 *
 * @throws {@link AiError} `STREAM_TRUNCATED` when the stream ends without a
 *   `finish` event, and whatever the stream throws.
 * @internal
 */
export async function collectResult(events: AsyncIterable<AiEvent>): Promise<AiResult> {
  const parts: AiPart[] = [];
  for await (const event of events) {
    if (event.type === "part") {
      parts.push(event.part);
    } else if (event.type === "finish") {
      return {
        message: { role: "assistant", parts },
        finishReason: event.finishReason,
        ...(event.rawFinishReason === undefined ? {} : { rawFinishReason: event.rawFinishReason }),
        usage: event.usage,
      };
    }
  }
  throw new AiError("STREAM_TRUNCATED", "The stream ended without a finish event.");
}

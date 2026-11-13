import { AiError, abortError } from "../core/errors/ai-error.js";
import type { AiFinishReason, AiPart, AiUsage } from "../core/model/message.js";
import type {
  AiCallOptions,
  AiEvent,
  AiProvider,
  AiRequest,
  AiResult,
} from "../core/model/provider.js";
import { collectResult } from "../core/stream/collect-result.js";
import { iterateOnce } from "../core/stream/iterate-once.js";

/**
 * One scripted answer of a {@link FakeProvider}.
 *
 * @public
 */
export interface FakeTurn {
  /** The answer's parts, in order. Text and summaries are also streamed in pieces. */
  readonly parts?: readonly AiPart[];
  /** Defaults to `"stop"`, or `"tool-calls"` when the parts end with a tool call. */
  readonly finishReason?: AiFinishReason;
  readonly rawFinishReason?: string;
  /** Defaults to `{}`: no usage reported. */
  readonly usage?: AiUsage;
  /**
   * Fails the call with this error after the parts are streamed. With no
   * parts, the call fails before any event.
   */
  readonly error?: AiError;
  /**
   * Never finishes: the stream waits after its parts until the call is
   * aborted, as a slow provider would.
   */
  readonly hang?: boolean;
  /** How many characters each `text-delta` and `summary-delta` carries. Defaults to 8. */
  readonly chunkSize?: number;
}

/**
 * Options for {@link createFakeProvider}.
 *
 * @public
 */
export interface FakeProviderOptions {
  /** The name its `provider-state` is tagged with. Defaults to `"fake"`. */
  readonly provider?: string;
}

/**
 * A provider for tests that answers with scripted turns, without any network
 * (ADR 0006). It passes the provider contract suite, as every provider must.
 *
 * @public
 */
export interface FakeProvider extends AiProvider {
  /** Every request it received, in order. */
  readonly requests: readonly AiRequest[];
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function* pieces(text: string, size: number): Generator<string> {
  for (let start = 0; start < text.length; start += size) {
    yield text.slice(start, start + size);
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

/**
 * Creates a {@link FakeProvider}.
 *
 * @example
 * ```ts
 * const provider = createFakeProvider([
 *   { parts: [{ type: "text", text: "Hello!" }] },
 *   { error: new AiError("STREAM_IDLE", "Too slow.", { details: { retryable: true } }) },
 * ]);
 * await mySdk.ask("Hi", { provider });
 * expect(provider.requests[0]?.messages).toHaveLength(1);
 * ```
 *
 * @param turns - The answers, one per call, in order; or a function that
 *   chooses the answer for each request.
 * @param options - Its provider name.
 * @public
 */
export function createFakeProvider(
  turns: readonly FakeTurn[] | ((request: AiRequest, index: number) => FakeTurn),
  options: FakeProviderOptions = {},
): FakeProvider {
  const provider = options.provider ?? "fake";
  const requests: AiRequest[] = [];

  const turnFor = (request: AiRequest): FakeTurn => {
    const index = requests.length;
    requests.push(request);
    const turn = typeof turns === "function" ? turns(request, index) : turns[index];
    if (!turn) {
      throw new AiError("UNKNOWN", `The fake provider has no turn scripted for call ${index + 1}.`);
    }
    return turn;
  };

  async function* events(request: AiRequest, signal?: AbortSignal): AsyncGenerator<AiEvent> {
    if (signal?.aborted) {
      throw abortError(signal);
    }
    const turn = turnFor(request);
    const size = Math.max(1, turn.chunkSize ?? 8);
    const parts = turn.parts ?? [];
    const step = async (): Promise<void> => {
      await pause();
      if (signal?.aborted) {
        throw abortError(signal);
      }
    };
    for (const part of parts) {
      if (part.type === "text") {
        for (const text of pieces(part.text, size)) {
          await step();
          yield { type: "text-delta", text };
        }
      } else if (part.type === "provider-state" && part.summary) {
        for (const text of pieces(part.summary, size)) {
          await step();
          yield { type: "summary-delta", text };
        }
      }
      await step();
      yield { type: "part", part };
    }
    if (turn.error) {
      throw turn.error;
    }
    if (turn.hang) {
      if (!signal) {
        throw new AiError("INVALID_REQUEST", "A hanging fake turn needs a signal to end it.");
      }
      await waitForAbort(signal);
    }
    await step();
    const last = parts.at(-1);
    yield {
      type: "finish",
      finishReason: turn.finishReason ?? (last?.type === "tool-call" ? "tool-calls" : "stop"),
      ...(turn.rawFinishReason === undefined ? {} : { rawFinishReason: turn.rawFinishReason }),
      usage: turn.usage ?? {},
    };
  }

  return {
    provider,
    requests,
    stream(request: AiRequest, callOptions: AiCallOptions = {}): AsyncIterable<AiEvent> {
      return iterateOnce(() => events(request, callOptions.signal));
    },
    complete(request: AiRequest, callOptions: AiCallOptions = {}): Promise<AiResult> {
      return collectResult(events(request, callOptions.signal));
    },
  };
}

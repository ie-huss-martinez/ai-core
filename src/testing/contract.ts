import { serializeError } from "@hussmartinez/sdk-core";
import { isAiError } from "../core/errors/ai-error.js";
import type { AiPart } from "../core/model/message.js";
import type { AiEvent, AiProvider, AiRequest } from "../core/model/provider.js";

/**
 * What a provider must do for one test of the contract suite. The factory
 * builds a fresh provider for each test, set up to behave this way, such as
 * an adapter whose injected `fetch` replays a recorded fixture (ADR 0006).
 *
 * - `text`: answers with at least one non-empty `text` part and finishes
 *   with `stop`.
 * - `tool-call`: answers with at least one `tool-call` part and finishes
 *   with `tool-calls`.
 * - `error`: fails with an `AiError` whose `details.retryable` is a boolean.
 * - `slow`: delivers at least one event, then waits until the call is
 *   aborted, never finishing on its own.
 *
 * @public
 */
export type ContractScenario = "text" | "tool-call" | "error" | "slow";

/**
 * The test functions the suite registers its tests with. Vitest's, Jest's
 * and `node:test`'s `describe` and `it` all fit, so `ai-core` doesn't
 * depend on a test framework (ADR 0002). Each test throws an `Error` with a
 * clear message when the provider breaks the contract.
 *
 * @public
 */
export interface ContractTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

/** A prompt that must never appear in an error. */
const SENTINEL = "contract-sentinel-prompt-7f3a";

/** A plain request, with the sentinel in the user's message. */
const REQUEST: AiRequest = {
  messages: [{ role: "user", parts: [{ type: "text", text: `Say hello. ${SENTINEL}` }] }],
};

/** A request whose history holds another provider's state, which must be accepted. */
const FOREIGN_HISTORY: AiRequest = {
  messages: [
    { role: "user", parts: [{ type: "text", text: "Hi." }] },
    {
      role: "assistant",
      parts: [
        { type: "provider-state", provider: "contract-foreign", data: { opaque: true } },
        { type: "text", text: "Hello." },
      ],
    },
    { role: "user", parts: [{ type: "text", text: "Say hello again." }] },
  ],
};

class ContractViolation extends Error {
  override readonly name = "ContractViolation";
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation(message);
  }
}

/** Compares parts as JSON, with image bytes as arrays. */
function sameParts(a: readonly AiPart[], b: readonly AiPart[]): boolean {
  const json = (parts: readonly AiPart[]) =>
    JSON.stringify(parts, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value));
  return json(a) === json(b);
}

async function collect(stream: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function failure(run: () => Promise<unknown>, violation: string): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new ContractViolation(violation);
}

/** Checks the order and consistency of a stream's events (ADR 0002). */
function checkEvents(events: readonly AiEvent[]): AiPart[] {
  const parts: AiPart[] = [];
  let text = "";
  let summary = "";
  events.forEach((event, index) => {
    switch (event.type) {
      case "text-delta":
        text += event.text;
        break;
      case "summary-delta":
        summary += event.text;
        break;
      case "part": {
        const { part } = event;
        if (part.type === "text") {
          check(
            text === part.text,
            `A text part's deltas must add up to its text: got ${JSON.stringify(text)}.`,
          );
        } else {
          check(text === "", "text-delta events must be followed by their text part.");
        }
        if (part.type === "provider-state") {
          check(
            summary === (part.summary ?? ""),
            "A provider-state part's summary-delta events must add up to its summary.",
          );
        } else {
          check(
            summary === "",
            "summary-delta events must be followed by their provider-state part.",
          );
        }
        text = "";
        summary = "";
        parts.push(part);
        break;
      }
      case "finish":
        check(index === events.length - 1, "finish must be the last event.");
        check(
          text === "" && summary === "",
          "Deltas must be followed by their part before finish.",
        );
        break;
      default:
        check(false, `Unknown event type: ${JSON.stringify((event as { type: unknown }).type)}.`);
    }
  });
  check(
    events.filter(({ type }) => type === "finish").length === 1,
    "A successful stream must have exactly one finish event.",
  );
  return parts;
}

function checkOwnState(provider: AiProvider, parts: readonly AiPart[]): void {
  for (const part of parts) {
    if (part.type === "provider-state") {
      check(
        part.provider === provider.provider,
        `provider-state must be tagged ${JSON.stringify(provider.provider)}, not ${JSON.stringify(part.provider)}.`,
      );
    }
    if ((part.type === "text" || part.type === "tool-call") && part.providerState) {
      check(
        part.providerState.provider === provider.provider,
        `providerState must be tagged ${JSON.stringify(provider.provider)}.`,
      );
    }
  }
}

/**
 * Registers the provider contract suite (ADR 0002): the behaviour every
 * provider shares, whether it's an adapter, the browser transport, a fake or
 * a host's own. Every adapter in `ai-core` passes it, and so must custom
 * providers.
 *
 * @example
 * ```ts
 * import { describe, it } from "vitest";
 * import { defineProviderContract } from "@hussmartinez/ai-core/testing";
 *
 * defineProviderContract((scenario) => createMyProvider(fixtureFor(scenario)), { describe, it });
 * ```
 *
 * @param makeProvider - Builds a fresh provider for one test, behaving as
 *   the scenario asks. It's called once or twice per test.
 * @param api - The test framework's `describe` and `it`.
 * @public
 */
export function defineProviderContract(
  makeProvider: (scenario: ContractScenario) => AiProvider | Promise<AiProvider>,
  api: ContractTestApi,
): void {
  const { describe, it } = api;

  describe("provider contract (ai-core ADR 0002)", () => {
    it("has a provider name", async () => {
      const provider = await makeProvider("text");
      check(
        typeof provider.provider === "string" && provider.provider.length > 0,
        "provider must be a non-empty string.",
      );
    });

    it("streams deltas, then their part, then exactly one finish", async () => {
      const provider = await makeProvider("text");
      const events = await collect(provider.stream(REQUEST));
      const parts = checkEvents(events);
      check(
        parts.some((part) => part.type === "text" && part.text.length > 0),
        "The text scenario must answer with a non-empty text part.",
      );
      const finish = events.at(-1);
      check(
        finish?.type === "finish" && finish.finishReason === "stop",
        "It must finish with stop.",
      );
      checkOwnState(provider, parts);
    });

    it("returns from complete() what the stream delivers", async () => {
      const streamed = checkEvents(await collect((await makeProvider("text")).stream(REQUEST)));
      const result = await (await makeProvider("text")).complete(REQUEST);
      check(result.message.role === "assistant", "complete() must return an assistant message.");
      check(
        sameParts(result.message.parts, streamed),
        "complete() must return the streamed parts.",
      );
      check(result.finishReason === "stop", "complete() must report the finish reason.");
      check(
        typeof result.usage === "object" && result.usage !== null,
        "complete() must report usage.",
      );
    });

    it("accepts another provider's state in the history", async () => {
      const result = await (await makeProvider("text")).complete(FOREIGN_HISTORY);
      check(result.finishReason === "stop", "A history with another provider's state must work.");
    });

    it("reports tool calls with JSON input, and finishes with tool-calls", async () => {
      const provider = await makeProvider("tool-call");
      const events = await collect(provider.stream(REQUEST));
      const parts = checkEvents(events);
      const calls = parts.filter((part) => part.type === "tool-call");
      check(calls.length > 0, "The tool-call scenario must answer with a tool-call part.");
      for (const call of calls) {
        check(call.id.length > 0 && call.name.length > 0, "A tool call needs an id and a name.");
        check(
          JSON.parse(JSON.stringify(call.input)) !== undefined,
          "A tool call's input must be JSON.",
        );
      }
      const finish = events.at(-1);
      check(
        finish?.type === "finish" && finish.finishReason === "tool-calls",
        "It must finish with tool-calls.",
      );
      checkOwnState(provider, parts);
    });

    it("fails with an AiError that says whether to retry", async () => {
      const error = await failure(
        async () => (await makeProvider("error")).complete(REQUEST),
        "The error scenario must fail.",
      );
      check(isAiError(error), "A failure must be an AiError.");
      check(
        typeof (error.details as { retryable?: unknown } | undefined)?.retryable === "boolean",
        "A call's error must have a boolean details.retryable (ADR 0007).",
      );
    });

    it("fails the stream the same way", async () => {
      const provider = await makeProvider("error");
      const error = await failure(
        () => collect(provider.stream(REQUEST)),
        "The error scenario must fail the stream.",
      );
      check(isAiError(error), "A stream's failure must be an AiError, thrown, not an event.");
    });

    it("never puts the prompt in an error", async () => {
      const error = await failure(
        async () => (await makeProvider("error")).complete(REQUEST),
        "The error scenario must fail.",
      );
      check(isAiError(error), "A failure must be an AiError.");
      check(
        !error.message.includes(SENTINEL) &&
          !JSON.stringify(serializeError(error)).includes(SENTINEL),
        "An error must never contain the prompt (sdk-core ADR 0035).",
      );
    });

    it("fails with ABORTED when aborted mid-stream", async () => {
      const provider = await makeProvider("slow");
      const controller = new AbortController();
      const events = provider
        .stream(REQUEST, { signal: controller.signal })
        [Symbol.asyncIterator]();
      const first = await events.next();
      check(!first.done, "The slow scenario must deliver an event before waiting.");
      controller.abort();
      const error = await failure(
        () => events.next(),
        "Aborting must fail the stream with ABORTED, not deliver more events.",
      );
      check(isAiError(error, "ABORTED"), "Aborting must fail the stream with ABORTED.");
    });

    it("fails with ABORTED when the signal is already aborted", async () => {
      const provider = await makeProvider("slow");
      const controller = new AbortController();
      controller.abort();
      const error = await failure(
        () => provider.complete(REQUEST, { signal: controller.signal }),
        "An aborted signal must fail the call with ABORTED.",
      );
      check(isAiError(error, "ABORTED"), "An aborted signal must fail the call with ABORTED.");
    });

    it("can be left early without an error", async () => {
      const provider = await makeProvider("slow");
      for await (const _ of provider.stream(REQUEST)) {
        break;
      }
    });

    it("can be iterated only once", async () => {
      const stream = (await makeProvider("text")).stream(REQUEST);
      await collect(stream);
      const error = await failure(
        () => collect(stream),
        "A second iteration must throw an AiError, not send the call again.",
      );
      check(isAiError(error), "A second iteration must throw an AiError, not send the call again.");
    });
  });
}

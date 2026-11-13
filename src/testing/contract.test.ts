import { describe, expect, it } from "vitest";
import { AiError } from "../core/errors/ai-error.js";
import type { AiEvent, AiProvider, AiRequest } from "../core/model/provider.js";
import { fakeScenarios } from "../test/fake-scenarios.js";
import { type ContractScenario, type ContractTestApi, defineProviderContract } from "./contract.js";
import { createFakeProvider } from "./fake-provider.js";

/** Registers the suite without running it, so each test can be run against a broken provider. */
function contractTests(make: (scenario: ContractScenario) => AiProvider) {
  const tests = new Map<string, () => Promise<void>>();
  const api: ContractTestApi = {
    describe: (_, body) => body(),
    it: (name, body) => {
      tests.set(name, body);
    },
  };
  defineProviderContract(make, api);
  return (name: string): Promise<void> => {
    const test = tests.get(name);
    if (!test) {
      throw new Error(`No contract test named ${name}`);
    }
    return test();
  };
}

const fake = (scenario: ContractScenario) => createFakeProvider(() => fakeScenarios[scenario]);

/** The fake provider, with its stream's events rewritten. */
function withEvents(
  rewrite: (events: AiEvent[]) => AiEvent[],
): (scenario: ContractScenario) => AiProvider {
  return (scenario) => {
    const provider = fake(scenario);
    const rewritten = async function* (request: AiRequest) {
      const events: AiEvent[] = [];
      for await (const event of provider.stream(request)) {
        events.push(event);
      }
      yield* rewrite(events);
    };
    return { ...provider, stream: (request) => rewritten(request) };
  };
}

describe("the contract suite", () => {
  it("passes a provider that keeps the contract", async () => {
    const run = contractTests(fake);
    await expect(
      run("streams deltas, then their part, then exactly one finish"),
    ).resolves.toBeUndefined();
  });

  it("catches an event after finish", async () => {
    const run = contractTests(
      withEvents((events) => [...events, { type: "text-delta", text: "late" }]),
    );
    await expect(run("streams deltas, then their part, then exactly one finish")).rejects.toThrow(
      "finish must be the last event.",
    );
  });

  it("catches deltas that don't add up to their part", async () => {
    const run = contractTests(
      withEvents((events) =>
        events.map((event) => (event.type === "text-delta" ? { ...event, text: "x" } : event)),
      ),
    );
    await expect(run("streams deltas, then their part, then exactly one finish")).rejects.toThrow(
      "deltas must add up",
    );
  });

  it("catches provider state tagged with another provider's name", async () => {
    const run = contractTests((scenario) =>
      createFakeProvider(() => fakeScenarios[scenario], { provider: "renamed" }),
    );
    await expect(run("streams deltas, then their part, then exactly one finish")).rejects.toThrow(
      'provider-state must be tagged "renamed"',
    );
  });

  it("catches a failure that isn't an AiError with retryable", async () => {
    const run = contractTests((scenario) =>
      scenario === "error"
        ? createFakeProvider([{ error: new AiError("STREAM_IDLE", "No retryable detail.") }])
        : fake(scenario),
    );
    await expect(run("fails with an AiError that says whether to retry")).rejects.toThrow(
      "details.retryable",
    );
  });

  it("catches an error that repeats the prompt", async () => {
    const run = contractTests((scenario) =>
      scenario === "error"
        ? createFakeProvider((request) => ({
            error: new AiError("STREAM_IDLE", "Failed.", {
              details: { retryable: true, echo: JSON.stringify(request.messages) },
            }),
          }))
        : fake(scenario),
    );
    await expect(run("never puts the prompt in an error")).rejects.toThrow(
      "never contain the prompt",
    );
  });

  it("catches a stream that can be iterated twice", async () => {
    const run = contractTests((scenario) => {
      const provider = fake(scenario);
      // Starts a new call on every iteration instead of refusing.
      return {
        ...provider,
        stream: (request) => ({
          [Symbol.asyncIterator]: () => provider.stream(request)[Symbol.asyncIterator](),
        }),
      };
    });
    await expect(run("can be iterated only once")).rejects.toThrow("second iteration");
  });

  it("catches an abort that doesn't fail with ABORTED", async () => {
    const run = contractTests((scenario) => {
      if (scenario !== "slow") {
        return fake(scenario);
      }
      // Ignores the signal: it keeps delivering events after an abort.
      const provider = createFakeProvider([
        { parts: [{ type: "text", text: "Thinking hard" }], chunkSize: 4 },
      ]);
      return { ...provider, stream: (request) => provider.stream(request) };
    });
    await expect(run("fails with ABORTED when aborted mid-stream")).rejects.toThrow(
      "Aborting must fail the stream with ABORTED",
    );
  });
});

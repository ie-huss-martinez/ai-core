import { AiError } from "../core/errors/ai-error.js";
import type { ContractScenario } from "../testing/contract.js";
import type { FakeTurn } from "../testing/fake-provider.js";

/** The fake provider's turn for each scenario of the contract suite. */
export const fakeScenarios: Record<ContractScenario, FakeTurn> = {
  text: {
    parts: [
      { type: "provider-state", provider: "fake", data: { step: 1 }, summary: "Thinking it over." },
      { type: "text", text: "Hello there! How can I help today?" },
    ],
    usage: { inputTokens: 12, outputTokens: 9 },
  },
  "tool-call": {
    parts: [
      { type: "text", text: "Let me check." },
      {
        type: "tool-call",
        id: "call_1",
        name: "get_weather",
        input: { city: "Paris" },
        providerState: { provider: "fake", data: "signature" },
      },
    ],
  },
  error: {
    error: new AiError("STREAM_IDLE", "The fake provider went quiet.", {
      details: { retryable: true },
    }),
  },
  slow: { parts: [{ type: "text", text: "Thinking" }], hang: true },
};

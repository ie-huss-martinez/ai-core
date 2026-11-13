import { describe, it } from "vitest";
import { fakeScenarios } from "../test/fake-scenarios.js";
import { defineProviderContract } from "./contract.js";
import { createFakeProvider } from "./fake-provider.js";

defineProviderContract((scenario) => createFakeProvider(() => fakeScenarios[scenario]), {
  describe,
  it,
});

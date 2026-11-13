/**
 * Testing tools: the provider contract suite, which every provider must
 * pass, and a fake provider for hosts' and SDKs' own tests.
 *
 * @remarks
 * The suite takes the test functions (`describe` and `it`) as arguments, so
 * the package doesn't depend on a test framework (ADR 0002). The fake
 * provider makes no request (ADR 0006).
 *
 * @packageDocumentation
 */

export type {
  ContractScenario,
  ContractTestApi,
  ProviderContractOptions,
} from "./testing/contract.js";
export { defineProviderContract } from "./testing/contract.js";
export type { FakeProvider, FakeProviderOptions, FakeTurn } from "./testing/fake-provider.js";
export { createFakeProvider } from "./testing/fake-provider.js";

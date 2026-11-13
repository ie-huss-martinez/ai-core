// Any test that reaches the real network fails loudly (ADR 0006): adapters
// must use the fetch a test gives them.
globalThis.fetch = (() => {
  throw new Error("A test made an unplanned network request. Inject a fake fetch instead.");
}) as typeof fetch;

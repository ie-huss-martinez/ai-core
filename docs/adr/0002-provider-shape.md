# 0002. One provider shape for adapters, the transport and custom providers

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-13. The contract suite takes `{ describe, it }` only, without `expect`, and throws its own errors: `node:test` has no `expect`, and matchers differ between frameworks, while `describe` and `it` have the same shape in Vitest, Jest and `node:test`. The decision that `ai-core` depends on no test framework is unchanged.

## Context

[sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md) says no SDK imports `ai-core`. An SDK that needs AI defines its own provider port, for example `AiProvider` with `complete()` and `stream()` taking an `AbortSignal`, and the host passes a provider in. `ai-core` must export providers that fit those ports structurally, without either package depending on the other.

The same shape has to serve everywhere a provider appears:

- **Adapters** for each API, used on the host's server, or in the browser with the opt-in.
- **The browser transport,** which talks to the host's request handler and must look like any other provider to the code using it.
- **Custom providers** written by hosts, such as a backend of their own, and the fake provider used in tests.

Request options also differ by provider and change often. Two examples, checked on 2026-11-12:
- Anthropic's current models reject forced tool choice. "`tool_choice: {"type": "any"}` and `tool_choice: {"type": "tool", "name": "..."}` fail, whereas `tool_choice: {"type": "auto"}` (the default) and `tool_choice: {"type": "none"}` still work". On Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and 5.2 and Mythos 5.1 and 5.2, forced choice returns a 400 ([Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools): "Forcing tool use").
- Anthropic tool names must match `^[a-zA-Z0-9_-]{1,128}$` (same page: "Specifying client tools").

## Decision

### The shape

```ts
interface AiProvider {
  readonly provider: string;
  complete(request: AiRequest, options?: { signal?: AbortSignal }): Promise<AiResult>;
  stream(request: AiRequest, options?: { signal?: AbortSignal }): AsyncIterable<AiEvent>;
}
```

- **Everything implements it:** every adapter, the browser transport, the fake provider and any custom provider. Code that receives a provider can't tell, and doesn't need to tell, which one it has.
- **`provider`** is the name its `provider-state` is tagged with ([0001](0001-message-model-and-provider-state.md)), such as `"anthropic"`, `"gemini"` or `"kimi"`. A provider replays only state with its own name.
- **SDK ports match it structurally.** An SDK's port declares the subset it uses, and an `ai-core` provider is assignable to it. The examples that connect an SDK to `ai-core` are type-checked, so a change on either side that breaks the match fails there. `ai-core`'s exported types never change in a way that breaks a structural match without a breaking-change changeset.

### Requests

- **`AiRequest`** has these fields:
  - `messages`;
  - `system?`;
  - `tools?`: name, description and JSON Schema for the input;
  - `toolChoice?`;
  - `model?`;
  - `maxOutputTokens?`;
  - `providerOptions?`.
- **`toolChoice` is `"auto"` or `"none"`.** Forced choice is left out of the common request, because current Anthropic models reject it. A host that needs it on a provider that supports it uses `providerOptions`.
- **Tool names** follow Anthropic's documented rule, `^[a-zA-Z0-9_-]{1,128}$`. Each adapter's pull request checks it against its provider's documentation, and narrows it for every provider if needed. An invalid name fails with `INVALID_REQUEST` before any request is made.
- **Sampling parameters** such as `temperature` aren't part of the common request. Providers differ on them, and some current models reject them. Hosts set them through `providerOptions` where a provider supports them.
- **`model` and `maxOutputTokens`** fall back to the adapter's configured defaults when they're absent.
- **`providerOptions`** maps provider names to objects, such as `{ anthropic: { … } }`. An adapter merges only its own entry into the provider's request body, after the fields it sets itself, and never lets it change the endpoint, headers or key. It's unvalidated and documented as such. It's never logged or put in errors or events.

### Results and events

- **`complete()`** resolves to an `AiResult`: the assistant message, finish reason, raw finish reason and usage ([0001](0001-message-model-and-provider-state.md)).
- **`stream()`** returns an `AsyncIterable<AiEvent>`, with these events:

  | Event | Fields | When |
  |---|---|---|
  | `text-delta` | `text` | Each piece of a `text` part, in order. |
  | `summary-delta` | `text` | Each piece of a `provider-state` part's `summary`, where the provider streams one. |
  | `part` | `part` | Each complete part, including `provider-state` and `tool-call`, once it's finished and parsed. |
  | `finish` | `finishReason`, `rawFinishReason`, `usage` | Last, exactly once, after a successful stream. |

  Collecting every `part` event gives the same message `complete()` returns. Tool-call arguments aren't streamed in pieces in the first release.
- **Errors are thrown, not emitted.** A failed call rejects `complete()`, or makes the stream's iterator throw an `AiError` with a stable code.

### Cancellation

- **An aborted `signal`** cancels the request, closes the provider's connection, and rejects or throws `ABORTED`.
- **Leaving a stream early,** by `break` or `return` from `for await`, also cancels the request and closes the connection, without an error.
- **A stream can be iterated once.** A second iteration throws.

### Custom providers

- **The contract suite in `./testing`,** `defineProviderContract(makeProvider, { describe, it, expect })`, checks the behaviour above for any provider: events, errors, cancellation and `provider-state` replay. The host passes the test functions in, so `ai-core` doesn't depend on a test framework. Every adapter, the transport and the fake provider pass it.

## Alternatives considered

- **Separate shapes for adapters and the transport:** rejected. Code using a provider in the browser and on the server would differ, and SDK ports would need two variants.
- **Callbacks or an event emitter for streams:** rejected. An async iterable composes with `for await`, cancels by leaving the loop, and needs no listener cleanup.
- **Emitting errors as events:** rejected. Callers would have to check every event for errors, and an unchecked error would look like a short, successful answer.
- **A shared port package that SDKs and `ai-core` both import:** rejected in sdk-core ADR 0035, which chose structural matching.
- **Forced tool choice and sampling parameters in the common request:** rejected. They'd fail on current Anthropic models, and their meaning differs between providers. `providerOptions` keeps them available where they work.

## Consequences

- Hosts can swap an adapter for the transport, a custom backend or the fake provider without changing the code that uses it, and SDK ports accept any of them.
- Every adapter and the transport have to pass the same contract suite, so differences between providers stay inside the adapters.
- Features outside the common request, such as forced tool choice, sampling or a provider's new parameters, need `providerOptions` and provider-specific knowledge from the host.
- Changing the shape is a breaking change for every SDK port that matches it, so it changes only with a breaking changeset and an ADR.

# 0008. ai-core never asks a provider to retain conversations

- **Status:** Accepted
- **Date:** 2026-11-13
- **Amended:** 2026-11-13. The OpenAI-compatible adapter sends `store: false` by default, because OpenAI's specification documents `store`. The Kimi preset doesn't send it, because Kimi's API reference doesn't document `store`, and a compatible API may reject unknown fields. A host can also leave it out with `sendStore: false`, for such an API. Either way, a `store` from `providerOptions` is removed, never sent.

## Context

Some providers can keep conversations on their own servers, and some do it by default. Checked against their documentation on 2026-11-13:

- **Gemini's Interactions API** stores interactions unless told not to. The documentation says "you can opt into stateless behavior by setting `store=false`", and that by default interactions are stored ([Interactions API](https://aistudio.google.com/docs/interactions)). Google calls it "Generally Available and the recommended interface for all new projects", while "the original `generateContent` API … is now considered legacy" but "remains fully supported" (same page).
- **OpenAI's Chat Completions** has a `store` parameter: "Whether or not to store the output of this chat completion request for use in our model distillation or evals products", with a default of `false` ([OpenAI's OpenAPI specification](https://github.com/openai/openai-openapi), `CreateChatCompletionRequest.store`).

`ai-core` is stateless by design. Hosts keep conversations and send the history with every call ([ADR 0001](0001-message-model-and-provider-state.md)), so a provider's copy is never needed. A stored copy is one more place where users' prompts live, under terms the host may not have reviewed. [sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md) limits what `ai-core` sends to what a call needs.

## Decision

- **ai-core never asks a provider to retain conversations.** Where a provider offers server-side storage, the adapter turns it off in every request:
  - **Gemini** sends `store: false`, and uses the Interactions API statelessly, sending the full history with every call;
  - **OpenAI-compatible** sends `store: false` (see the amendment for Kimi and for APIs that reject unknown fields).
- **`providerOptions` can't turn storage back on.** The adapter sets the field after merging the host's options, as it does for `stream: true` ([ADR 0002](0002-provider-shape.md)).
- **Features that need server-side storage aren't supported.** Examples are Gemini's `previous_interaction_id` and background interactions, which the documentation says are incompatible with `store=false`.
- **A provider's own data-use terms are the host's responsibility.** Logging, abuse monitoring or training use, for example on free tiers, are separate from `store`. The README says so for each provider.

## Alternatives considered

- **For Gemini, the `generateContent` API, which has no storage parameter:** rejected. Google calls it "legacy" (quoted above). Its streaming is documented by a single example, `…/models/{model}:streamGenerateContent?alt=sse`, whose chunks are each a `GenerateContentResponse` ([Text generation, `generateContent`](https://aistudio.google.com/docs/text-generation?generate-content=true)). Function calling and thinking are now documented only for Interactions. A new adapter on a legacy API would likely need replacing soon.
- **Leaving storage to the host, through `providerOptions`:** rejected. A default of storing at the provider, or a single option away from it, puts users' conversations in a second place without anyone deciding to.
- **Using storage to save tokens, with `previous_interaction_id`:** rejected. It would make conversations depend on the provider's copy, break the history model of ADR 0001, and need the stored copy for privacy reasons we avoid.

## Consequences

- Users' conversations live only where the host keeps them, apart from whatever the provider's own terms allow for processing.
- Every call sends the full history. That costs input tokens, which providers' prompt caching reduces.
- An adapter for a new provider must check its documentation for storage and turn it off. Its tests check that the request turns storage off, and that `providerOptions` can't turn it on.

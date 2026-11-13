# 0003. The request handler, a required `prepare`, and the `ai-core/1` protocol

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-13, with details the implementation settled:
  - an event's `data` holds its fields without `type`, which is in `event:`;
  - errors cross the wire without their `cause`, which may hold server-side details, and a provider's failure that isn't an `AiError` is sent only as `UNKNOWN`;
  - the handler removes its own `ai-core` parts from the history before calling the provider, and a message left empty is dropped. It also drops `ai-core` parts from the provider's events, so a stream has exactly one context part;
  - with `allowedOrigins` set, a request with no `Origin` gets 403;
  - a missing `protocol` is `INVALID_REQUEST`, and only another version is `PROTOCOL_MISMATCH`;
  - settings from `prepare` that don't match `AiCallSettings`, such as a misspelt field or no `maxOutputTokens`, get 500 with `PREPARE_FAILED`;
  - the handler takes `onWarning` for `requestBytes`, as [0005](0005-limits-and-streams.md) describes;
  - an `ai-core` part whose `data` has no `context` string is `INVALID_REQUEST`.

## Context

By default, keys stay on the host's server, and the browser talks only to the host's own endpoint ([sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md)). `ai-core` provides that endpoint, `createAiHandler`, and the browser transport that calls it. The endpoint spends the host's money on every call, so its defaults decide whether a quick deployment is safe:

- **An open proxy:** a handler that forwards whatever it receives, to whoever sends it, lets anyone spend the host's key.
- **A browser that chooses the model, the system prompt or `max_tokens`** can pick the most expensive model, remove the host's instructions or run up output tokens.
- **Cross-site requests:** a plain HTML form on another site can `POST` to the endpoint with the user's cookies, without a CORS preflight, unless the endpoint requires a request that needs one.
- **Changing the system prompt or tools mid-conversation breaks the conversation.** On Anthropic models with preserved thinking, "if your code changes `system`, `tools`, or an earlier message, every thinking block that already follows the change fails the prefix check. Then the request can get a 400 error" ([Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), "Preserved thinking", checked 2026-11-12). A system prompt that includes the current date, or a deployment that edits the prompt, does exactly that. [0001](0001-message-model-and-provider-state.md) requires conversations with a stable system prompt and tools. This record makes that rule enforced, not just documented.

## Decision

### `createAiHandler({ provider, prepare, limits?, allowedOrigins? })`

It returns `(request: Request) => Promise<Response>`, which works in Next.js route handlers, Hono, Node, Deno, Bun and Workers.

- **`prepare` is required.** Without it, `createAiHandler` throws `INVALID_CONFIGURATION` at construction, so an unauthenticated proxy can't be deployed by accident.
- **`prepare(context)`** runs before anything is sent to a provider. `context` holds the `Request`, the validated body and the request's `Origin`.
- **What `prepare` returns:**
  - **a `Response`,** to reject the call, for example a 401 or a 429; the handler returns it unchanged;
  - **or the call's settings:** `model`, `system`, `tools`, `toolChoice` and `providerOptions`, and **a required `maxOutputTokens`**, so the output budget is always set by the server.

  It's also where the host authenticates and rate-limits the caller. The README shows a complete example of both.
- **If `prepare` throws,** the handler answers 500 with `PREPARE_FAILED`. The thrown error is never sent or logged by `ai-core`.

### What the handler accepts

- **Only `POST`,** answering 405 with `METHOD_NOT_ALLOWED` otherwise, with no CORS handling of its own. The handler never adds CORS headers, and the documentation tells hosts not to add permissive ones.
- **Only `content-type: application/json`** (parameters such as `charset` aside), answering 415 with `UNSUPPORTED_MEDIA_TYPE` otherwise. A cross-site form can't send that content type without a preflight, which fails without CORS headers.
- **`allowedOrigins`,** optional. When it's set, a request whose `Origin` isn't in the list gets a 403 with `ORIGIN_NOT_ALLOWED` before `prepare` runs. It's off by default, because proxies can rewrite origins. The preflight already blocks cross-site browsers, and this is a second layer for hosts that want it.
- **The request size is limited** by the `requestBytes` limit, defined with the other limits in the limits ADR that follows. The handler checks `content-length` first, then counts bytes while reading the body, so an over-limit body is never read whole. Exceeding it answers 413 with `REQUEST_TOO_LARGE`.
- **The body is validated strictly,** after the size check:
  - it's `{ protocol: "ai-core/1", messages }`, and nothing else;
  - messages are checked against the model in [0001](0001-message-model-and-provider-state.md);
  - **any other field,** including `model`, `system`, `tools`, `maxOutputTokens` or `providerOptions`, is rejected with `INVALID_REQUEST` (400), naming the field. It isn't ignored silently, so a client that tries to set a budget learns that it can't;
  - an unknown `protocol` gets 400 with `PROTOCOL_MISMATCH` and the supported versions in `details`.
- **The handler never logs** request or response bodies, prompts, outputs or keys. Hosts that want logs wrap the handler.

### Stable system prompt and tools, enforced

- **The handler hashes the context.** For each call, it computes a SHA-256 digest, with Web Crypto, of a canonical JSON encoding of `prepare`'s `system` and `tools`.
- **The hash goes into the conversation.** The first part of every assistant message the handler returns is a `provider-state` part with `provider: "ai-core"` and `data: { context: "<digest>" }`. Adapters never send it to a provider, because its provider name isn't theirs ([0001](0001-message-model-and-provider-state.md)).
- **The handler checks it on every call.** Before calling the provider, it compares every `ai-core` context part in the incoming history with the current digest. On any mismatch it answers 409 with `CONTEXT_CHANGED`, and the provider is never called. Assistant messages without a context part aren't checked.
- **Recovery:** `details` names the first mismatching message. Hosts recover by starting a new conversation, or by removing all `provider-state` from the history with the exported `withoutProviderState(messages)` and continuing without the earlier reasoning.
- **The README warns** that volatile data, such as the current date, belongs in messages, not in the system prompt.

### The `ai-core/1` protocol

- **Request:** `POST` with `content-type: application/json`. The body is `{ protocol: "ai-core/1", messages }`, with image bytes as base64.
- **Errors before the stream:** a JSON body `{ error: <serializeError output> }`, with these statuses:

  | Status | Code |
  |---|---|
  | 400 | `INVALID_REQUEST`, `PROTOCOL_MISMATCH` |
  | 403 | `ORIGIN_NOT_ALLOWED` |
  | 405 | `METHOD_NOT_ALLOWED` |
  | 409 | `CONTEXT_CHANGED` |
  | 413 | `REQUEST_TOO_LARGE` |
  | 415 | `UNSUPPORTED_MEDIA_TYPE` |
  | 500 | `PREPARE_FAILED` |
  | any | whatever `prepare` returned |

- **Success:** 200 with `content-type: text/event-stream`. Each server-sent event's `event:` field is the event type, and its `data:` field is JSON.
  - **`start` first,** with `{ protocol: "ai-core/1" }`.
  - **Then the events of [0002](0002-provider-shape.md):** `text-delta`, `summary-delta`, `part` and `finish`. The first `part` is the `ai-core` context part.
  - **An `error` event** with `serializeError()` output replaces `finish` when the provider fails mid-stream. Then the stream closes.
  - **The secrets rules apply to every byte sent:** no key, request or response body, or provider headers.
- **The transport** (`httpTransport({ url, headers?, fetch? })`) is an `AiProvider` with `provider: "ai-core"`.
  - **Both methods stream:** `stream()` maps the events above, and `complete()` collects them.
  - **It checks `start.protocol`,** failing with `PROTOCOL_MISMATCH` on another version, and rebuilds errors from `error` events or error bodies with `deserializeError`.
  - **It sends only `{ protocol, messages }`.** Other request fields of [0002](0002-provider-shape.md), if a caller sets them, fail locally with `INVALID_REQUEST` before any request, because the server would reject them.
  - **`headers`** carries the host's own credentials for its endpoint, such as a session token, never a provider key.

## Alternatives considered

- **`prepare` optional, open by default:** rejected. The easiest deployment would be an open proxy to the host's key.
- **Letting the body set the model or budgets within limits that `prepare` sets:** rejected for now. It's more code and more ways to get it wrong. A host that wants to offer a choice reads it in `prepare`, from its own session or headers, and decides there.
- **Ignoring unexpected body fields silently:** rejected. A client that thinks it set `maxOutputTokens` should learn that it didn't.
- **The reviewer's suggestion, where the transport remembers the hash per conversation and echoes it:** not taken, for two reasons:
  - the transport is stateless, and a call doesn't know which conversation it belongs to; adding conversation IDs would add state to both sides;
  - a hash kept in the transport's memory is lost on a page reload, or when a conversation is restored from storage or continued on another device.

  Putting the hash in the history itself keeps the handler and transport stateless, and protects the conversation wherever it's stored. A client that strips the part loses only the check, and only for itself, because the provider would still reject a changed context.
- **Signing the hash with a server secret:** rejected. The check protects hosts and users from mistakes, not from an attacker. A forged hash only makes the attacker's own call fail at the provider instead of at the handler. System prompts aren't secrets either, since models can be prompted to reveal them, so an unkeyed digest reveals nothing worth protecting. The README says to keep secrets out of system prompts.
- **Hashing the model too:** rejected. Switching model doesn't fail; the other model just doesn't read the earlier thinking ([0001](0001-message-model-and-provider-state.md)).
- **WebSockets, or newline-delimited JSON, instead of server-sent events:** rejected. Server-sent events over `fetch` work in every target runtime and browser, through proxies, and reuse the parser the adapters already need.

## Consequences

- A host can't deploy the handler without deciding who may call it and what each call may cost.
- Changing the system prompt or tools during a conversation fails fast with `CONTEXT_CHANGED` and a clear recovery, instead of a provider error after the call has started.
- Browsers can't choose models, prompts or budgets. Products that want user choice implement it in `prepare`.
- A new protocol version is needed for any incompatible change to the wire format. The transport and handler of one `ai-core` release always speak the same version.

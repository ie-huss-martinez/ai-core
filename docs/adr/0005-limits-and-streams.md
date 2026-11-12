# 0005. Limits on requests and responses, and how streams are read

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

[sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md) treats provider responses and model output as hostile input. Response size, stream duration and idle time are limited with `sdk-core`'s `defineLimits`, and a malformed response fails with a specific code. [0003](0003-request-handler-and-wire-protocol.md) adds a limit on the requests the handler accepts. What's left to decide is the limits' values, how each is measured, and how streams are read so that the limits can't be bypassed.

What `sdk-core` provides: `defineLimits` takes definitions with a `code`, a `unit` (`bytes`, `milliseconds`…), a `default` and an optional `warning`. Hosts override them with `{ maximum, warning }`, and `Infinity` disables one. `check(limit, actual)` throws the SDK's error with `details` holding `limit`, `maximum`, `actual` and `unit`, and `error(limit, actual)` builds that error for limits measured another way, such as time ([sdk-core `policy/limits.ts`](https://github.com/ie-huss-martinez/sdk-core/blob/main/packages/sdk-core/src/policy/limits.ts)).

What Anthropic documents about its streams, checked on 2026-11-12 ([Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)):

- "Event streams might also include any number of `ping` events."
- "The API might occasionally send errors in the event stream", such as `overloaded_error`, which "would normally correspond to an HTTP 529".
- "New event types may be added, and your code should handle unknown event types gracefully."
- `usage` in `message_delta` is "cumulative", and "some blocks arrive whole, with no deltas", such as `redacted_thinking`.
- On interruption, "tool use and thinking blocks cannot be partially recovered".

`AbortSignal.any()`, which combines the host's signal with ai-core's own, is "Baseline Widely available" and has been "available across browsers since March 2024" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)). That's within the family's browser support ([sdk-core ADR 0013](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0013-browser-and-react-support.md)) and Node 24.

## Decision

### The limits

| Limit | Unit | Default | Warning | Code | Measured |
|---|---|---|---|---|---|
| `responseBytes` | bytes | 16 MB | 8 MB | `RESPONSE_TOO_LARGE` | Raw bytes of one response body, counted before decoding, as they arrive. |
| `streamDuration` | milliseconds | 15 minutes | 10 minutes | `STREAM_TIMEOUT` | From sending the request to the end of the body. |
| `idleTime` | milliseconds | 2 minutes | none | `STREAM_IDLE` | The longest gap between two chunks, including the wait for the first one. Any bytes count as activity, including `ping` events. |
| `requestBytes` | bytes | 8 MB | 4 MB | `REQUEST_TOO_LARGE` | The handler only: the incoming body, by `content-length` and then while reading. |

- **Why these values:**
  - a full 128K-token answer, with SSE framing and JSON escaping, is a few megabytes, so 16 MB is ample;
  - long reasoning turns can run many minutes, so `streamDuration` has headroom over the ten minutes many SDKs use as a request timeout;
  - images in base64 make up most of a large request.
- **Where hosts set them:**
  - adapters and the transport take a `limits` option for the three response limits;
  - the handler takes `limits` for `requestBytes`, and passes nothing to the browser;
  - unknown names are an error, as with `filePolicy`, and `Infinity` disables a limit, which the documentation advises against.
- **Warnings** go to an optional `onWarning({ limit, actual, maximum })` callback, at most once per limit per call. They never carry content. Without the callback, warnings are dropped.
- **Both sides apply them.** The transport applies the response limits to the handler's stream too. A browser is protected from a misbehaving server, and a server from a misbehaving provider.

### Reading a stream

- **Everything streams.** `complete()` streams internally and collects the events. That way the limits and idle checks apply equally to both methods, and long answers don't hit request timeouts.
- **One controller per call.** Each call has an internal `AbortController`, combined with the host's signal through `AbortSignal.any`. If that's missing, the call fails with `UNSUPPORTED_ENVIRONMENT`. A limit, a parse failure, the host's abort or leaving the iterator early all abort the controller. That cancels the body's reader, so the provider's connection closes and nothing more is read.
- **Bytes are counted first.** Each chunk's length is checked against `responseBytes` before it's decoded or buffered. An over-limit response is never held whole in memory.
- **Strict decoding.** UTF-8 is decoded with `TextDecoder` in `fatal` streaming mode. A character split across chunks is decoded correctly, and invalid UTF-8 fails with `PROVIDER_RESPONSE_INVALID`.
- **One SSE parser for every provider and the transport,** following the WHATWG event-stream rules:
  - lines end in CRLF, LF or CR;
  - comment lines are ignored;
  - several `data:` lines are joined with newlines;
  - an event is dispatched on a blank line;
  - an unfinished event at the end of the body is discarded.

  Property tests split recorded streams at every byte position, including inside multi-byte characters, and compare the events.
- **Event data is JSON,** parsed after the event is complete. Invalid JSON, a missing required field, or an event out of order fails with `PROVIDER_RESPONSE_INVALID`. Examples of out-of-order events: a delta for a block that hasn't started, or a second start. Nothing half-parsed is passed on.
- **Unknown event types are ignored,** as Anthropic's documentation asks. They still count towards the byte and idle limits.
- **A body that ends without the provider's final event fails with `STREAM_TRUNCATED`.** Anthropic's final event is `message_stop`; each adapter's pull request names its provider's, and the transport's is `finish` or `error`.
- **A provider's own error event** mid-stream fails the call with the adapter's mapped code, and the provider's error type in `details`. The message text is never included, because it can repeat input.
- **Usage** is taken from the provider's last report. Anthropic's is cumulative, so it's never summed.

### After a failure

- **Events already delivered stay delivered.** A stream that fails after some `text-delta` events has shown that text. The error that follows says why the stream ended. `complete()` rejects with the error and returns no partial message.
- **No partial parts.** A `tool-call` or `provider-state` part is only ever emitted complete, because a partial one can't be replayed or recovered.
- **No automatic retry,** and no continuation request. Recovery belongs to the host. The record on retries covers why.

## Alternatives considered

- **Limits only on the server:** rejected. The browser would trust the handler's stream without bounds, and a bug or a compromised server could exhaust a user's tab.
- **A non-streaming request for `complete()`:** rejected. It would need a separate size and time path, its body arrives whole, and long answers would hit request timeouts.
- **`EventSource`:** rejected. It can't `POST` or send headers, and it reconnects automatically. ai-core reads the body with `fetch` and its own parser instead.
- **Lenient decoding and parsing,** such as replacing invalid UTF-8 or skipping bad events: rejected. A response that doesn't parse can't be trusted to be complete or in order, and skipping events would pass on half-parsed results.
- **Failing on unknown event types:** rejected. Providers add event types without new API versions, and Anthropic's documentation asks clients to ignore them.
- **A limit on the number of events or parts:** not added. Every event costs bytes, so `responseBytes` already bounds them. One can be added later if a parser path is found that's expensive per event but cheap per byte.

## Consequences

- No response, however large, slow or malformed, can make ai-core read without bound, hang, or pass on a half-parsed result, on the server or in the browser.
- Hosts with unusual needs, such as very long reasoning or large image batches, raise a limit explicitly, and they see warnings before they hit it if they pass `onWarning`.
- Anyone using `ai-core` sees the same error codes, whichever provider is behind it.
- Each adapter's pull request names its provider's final event, error event and usage semantics, checked against its documentation, and adds recorded or synthetic fixtures for each failure path.

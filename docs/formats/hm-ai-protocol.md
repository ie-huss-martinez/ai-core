# `hm-ai-protocol`, version 1: the `ai-core/1` wire protocol

The protocol between the browser transport (`httpTransport`) and the request handler (`createAiHandler`), decided in [ADR 0003](../adr/0003-request-handler-and-wire-protocol.md) and recorded here as a portable format ([sdk-core ADR 0045](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0045-portable-formats-and-conformance-vectors.md)). A handler or a client in another language speaks it by matching the schema and passing the vectors in [`conformance/`](../../conformance).

**On the wire, the protocol is named `"ai-core/1"`; its schema is the format `hm-ai-protocol`, version 1.** ADR 0045's `{ "format", "version" }` fields are for stored documents, while a protocol carries one identifier that both sides compare before anything else, so the wire keeps `"ai-core/1"`, and `hm-ai-protocol` v1 names its schema.

| Schema | What it holds |
|---|---|
| [`formats/hm-ai-protocol/v1.schema.json`](../../formats/hm-ai-protocol/v1.schema.json) | The request body at its root. Each event's data in `$defs`: `startEvent`, `textDeltaEvent`, `summaryDeltaEvent`, `partEvent`, `finishEvent` and `errorEvent` |

The schema ships with the package, as `@hussmartinez/ai-core/formats/hm-ai-protocol/v1.schema.json`. Both readers, the handler's and the transport's, accept exactly what it accepts: the tests check every vector against both, and check that one extra field anywhere in a valid request body is refused by both.

**Receivers ignore fields and events they don't know, so later minor versions can add them.** A page can run the previous release's transport, from its cache, against a newly deployed handler. So the event schemas allow fields they don't list, and the transport ignores them, while it stays strict on the types and values of the fields it knows. Two things stay strict:

- **the request,** which the handler refuses with `unknown-field`, because it's the security boundary;
- **the parts inside a `part` event,** which follow the message model, because the page sends them back to the handler in the next request. So a later version that needs more in a part adds a new part type or a new protocol identifier, never a new field on an existing part, which pages running the previous release would refuse.

## Request

`POST` with `content-type: application/json`:

```json
{
  "protocol": "ai-core/1",
  "messages": [{ "role": "user", "parts": [{ "type": "text", "text": "Hi" }] }]
}
```

- **`messages`** follow the message model of [ADR 0001](../adr/0001-message-model-and-provider-state.md): `text`, `image`, `tool-call`, `tool-result` and `provider-state` parts. Tool calls appear only in assistant messages, and tool results only in user messages.
- **Images are standard, padded base64** with their media type. Base64 is the transport's encoding of bytes on the wire. ADR 0045's content-addressed assets are for stored documents, and the protocol stores nothing.
- **`data`, `input` and `providerState.data`** hold any JSON, and are carried unchanged.
- **Nothing else.** The model, system prompt, tools and budget come from the server's `prepare`, so any other body field is refused.

## Events

A `200` answer is `text/event-stream`. Each event's `event:` field is its type, and its `data:` is JSON:

| Event | Data | When |
|---|---|---|
| `start` | `{ "protocol": "ai-core/1" }` | First, once |
| `part` | `{ "part": <part> }` | Each finished part. The first is the handler's context part ([`hm-ai-context-hash`](hm-ai-context-hash.md)) |
| `text-delta` | `{ "text": "…" }` | A piece of the text part that follows |
| `summary-delta` | `{ "text": "…" }` | A piece of the summary of the `provider-state` part that follows |
| `finish` | `{ "finishReason", "rawFinishReason"?, "usage" }` | Last, on success |
| `error` | An `AiError`, as `serializeError` writes it, without `cause` or `stack` | Last, instead of `finish`, on failure |

A reader ignores event types it doesn't know, and fields it doesn't know within the events above, so a later minor version can add either without a new protocol identifier. A stream that ends without `finish` or `error` was cut off.

Errors before a stream are JSON bodies, `{ "error": <the same AiError> }`, with the statuses of ADR 0003.

## Framing

The event stream follows the WHATWG HTML standard's rules for [interpreting an event stream](https://html.spec.whatwg.org/multipage/server-sent-events.html). The same reader serves the transport and every adapter, so these rules hold for providers' streams too:

- the body is UTF-8, decoded strictly, across chunk boundaries. Invalid bytes are refused with `PROVIDER_RESPONSE_INVALID` and `details.reason` `"invalid-utf8"`, and a body that ends inside a character with `"truncated-utf8"`;
- a leading byte order mark is ignored;
- lines end in CRLF, LF or CR. A CR at the end of a chunk can be half of a CRLF, so it waits for the next chunk, and a CR at the very end of the body still ends its line;
- `data:` lines are joined with LF; `event:` sets the type, which is `message` without it; `id:` sets the last event ID, unless it contains NULL; comments, `retry:` and other fields are ignored;
- a blank line dispatches the event, unless it has no data, and an unfinished event at the end of the body is discarded.

## Rejections

Every refusal carries a stable `details.reason`, which vectors and ports compare, never the message.

The handler, reading a request:

| Code | Reason | When |
|---|---|---|
| `INVALID_REQUEST` | `malformed-body` | The body isn't UTF-8, isn't JSON, or isn't a JSON object |
| `INVALID_REQUEST` | `missing-protocol` | The body has no `protocol` |
| `PROTOCOL_MISMATCH` | `unsupported-protocol` | Another protocol identifier. `details.supported` lists this side's |
| `INVALID_REQUEST` | `unknown-field` | A field the format doesn't have, at any level |
| `INVALID_REQUEST` | `missing-field` | A required field is absent |
| `INVALID_REQUEST` | `not-an-object`, `not-an-array`, `not-a-string`, `not-a-boolean` | A field of the wrong type |
| `INVALID_REQUEST` | `empty-string` | An empty `id`, `name`, `callId` or `provider` |
| `INVALID_REQUEST` | `no-messages` | No messages, or none besides the handler's own state |
| `INVALID_REQUEST` | `invalid-role` | A role other than `user` or `assistant` |
| `INVALID_REQUEST` | `unknown-part-type` | A part type the model doesn't have, or a tool result holding anything but text and images |
| `INVALID_REQUEST` | `unsupported-media-type` | An image type other than PNG, JPEG, WebP or GIF |
| `INVALID_REQUEST` | `invalid-base64` | Image data that isn't standard, padded base64 |
| `INVALID_REQUEST` | `misplaced-tool-call`, `misplaced-tool-result` | A tool call in a user message, or a tool result in an assistant message |
| `INVALID_REQUEST` | `invalid-context-hash` | An `ai-core` part without a context hash |
| `CONTEXT_CHANGED` | `context-changed` | The system prompt or tools changed. `details.messageIndex` names the message |

`details.path` names the field, such as `messages[1].parts[0].type`, when its name is safe to repeat.

The transport, reading events:

| Code | Reason | When |
|---|---|---|
| `PROVIDER_RESPONSE_INVALID` | `invalid-event-data` | An event's data isn't JSON, or isn't a JSON object |
| `PROVIDER_RESPONSE_INVALID` | `missing-start` | The first event isn't `start` |
| `PROVIDER_RESPONSE_INVALID` | `duplicate-start` | A second `start` |
| `PROTOCOL_MISMATCH` | `unsupported-protocol` | `start` names another protocol identifier |
| `PROVIDER_RESPONSE_INVALID` | `invalid-delta` | A delta without text |
| `PROVIDER_RESPONSE_INVALID` | `invalid-part` | A part outside the message model, including a field the model doesn't have |
| `PROVIDER_RESPONSE_INVALID` | `invalid-finish` | An unknown `finishReason`, or a `rawFinishReason` that isn't a string |
| `PROVIDER_RESPONSE_INVALID` | `invalid-usage` | No usage, or a count that isn't a non-negative number |
| `PROVIDER_RESPONSE_INVALID` | `unknown-error` | An `error` event that isn't an `AiError` |

An `error` event that is an `AiError` is the handler's own failure, such as `PROVIDER_OVERLOADED`, and is rebuilt as it was sent.

## Conformance

| File | Subject | What it checks |
|---|---|---|
| [`hm-ai-protocol-request.json`](../../conformance/hm-ai-protocol-request.json) | `hm-ai-protocol-request` | Request bodies as the handler reads them: every part type in its place, unicode, hostile keys in opaque data, and each rejection with its reason |
| [`hm-ai-protocol-events.json`](../../conformance/hm-ai-protocol-events.json) | `hm-ai-protocol-events` | Event sequences as the transport reads them: what's delivered, whether it finished, unknown events and fields ignored, and each rejection with its reason |
| [`hm-ai-sse-framing.json`](../../conformance/hm-ai-sse-framing.json) | `hm-ai-sse-framing` | Bytes to events: every line ending, CRs at chunk ends, characters split between chunks, byte order marks, IDs, comments, unfinished events, and invalid or cut-off UTF-8. Chunks are base64, so any split can be expressed |

They're hand-written: each expected value is the format's rule, stated directly. [`scripts/generate-sse-vectors.py`](../../scripts/generate-sse-vectors.py) writes the framing file, splitting each hand-written case's bytes in the ways that matter. It uses Python's standard library only, and is run by hand, never in CI.

## Not covered here

Conversations that a host stores aren't a format of ai-core yet. They're the same JSON as `messages`, but a stored format would follow ADR 0045's rules for documents, such as assets instead of inline base64, and would be decided in its own record.

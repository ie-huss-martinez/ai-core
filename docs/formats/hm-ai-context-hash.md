# `hm-ai-context-hash`, version 1

The context hash of [ADR 0003](../adr/0003-request-handler-and-wire-protocol.md): the fingerprint of a conversation's system prompt and tools. The request handler puts it in every answer, and refuses a later call whose system prompt or tools have changed with `CONTEXT_CHANGED`. It's computed in a language-neutral way ([sdk-core ADR 0045](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0045-portable-formats-and-conformance-vectors.md), section 4), so a handler written in another language gives the same hash for the same settings, and a conversation can move between them.

## Definition

1. Build this JSON value from the settings `prepare` returned:

   ```json
   {
     "system": "You are a helpful assistant.",
     "tools": [{ "name": "look", "description": "Looks something up.", "inputSchema": { "type": "object" } }]
   }
   ```

   - `system` is the system prompt, or `null` when there's none. An empty string is a system prompt, so it differs from none.
   - `tools` lists each tool's `name`, `description` and `inputSchema`, and nothing else, in the order `prepare` gave them. A tool without a description has no `description` field. With no tools, `tools` is `[]`.
2. Serialise it with the JSON Canonicalization Scheme, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): no whitespace, object keys sorted by their UTF-16 code units at every level, array order kept, and strings and numbers as ECMAScript serialises them.
3. Encode the result as UTF-8, and hash it with SHA-256.
4. The hash is the digest in lowercase hex, 64 characters.

With no system prompt and no tools, the canonical JSON is `{"system":null,"tools":[]}`, and the hash is `71c702edfb2d7645f1054f9f536a7399d30d4a29aeb9610e6ed5916729c7b1f7`.

## Values that aren't JSON

RFC 8785 refuses input that isn't JSON. So does the handler, which answers 500 with `PREPARE_FAILED` and `details.reason` `"non-json-settings"`, before calling the provider, for:

- a number that isn't finite: `NaN`, `Infinity` or `-Infinity`;
- a string, or an object key, with a lone UTF-16 surrogate;
- an `undefined` array element, or a hole in an array;
- a function, a symbol, a bigint, or an object that isn't a plain object or array, such as a `Date` or a `Map`.

**An object field whose value is `undefined` is left out, as if it were absent.** That's how TypeScript's optional fields and `JSON.stringify` treat it, so the hash covers exactly the JSON the provider receives. A port in a language without `undefined` has nothing to do here.

No length limit applies to the hashed values. If one is added, it counts Unicode code points, as sdk-core ADR 0045 requires.

## Where it appears

In the first part of every answer the handler streams, as a `provider-state` part:

```json
{ "type": "provider-state", "provider": "ai-core", "data": { "context": "<the hash>" } }
```

It isn't signed: it protects hosts and users from mistakes, not from an attacker ([ADR 0003](../adr/0003-request-handler-and-wire-protocol.md)).

## Conformance

A port proves it computes the same hash by passing the vectors in [`conformance/`](../../conformance):

| File | Subject | What it checks |
|---|---|---|
| [`hm-ai-canonical-json.json`](../../conformance/hm-ai-canonical-json.json) | `hm-ai-canonical-json` | RFC 8785 itself, with the RFC's own samples verbatim: the sample object of sections 3.2.2 to 3.2.4, the property-sorting sample, every number in Appendix B, and refusals of `NaN`, `Infinity` and lone surrogates |
| [`hm-ai-context-hash.json`](../../conformance/hm-ai-context-hash.json) | `hm-ai-context-hash` | The value of step 1, its canonical JSON and its hash: escapes, non-ASCII text, key order, tool order, hostile keys such as `__proto__`, and UTF-16 versus code-point ordering |

Their expected values come from RFC 8785 and from an implementation independent of ai-core's, never from ai-core itself.

# 0006. Tests replay recorded provider responses, recorded only by hand

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

[sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md) says `ai-core`'s tests replay recorded provider responses, and that CI never calls a provider or holds a provider key. Three questions follow:

- **Recording:** how the recordings are made;
- **Safety:** what they may contain;
- **Coverage:** how they cover failures that a live provider won't produce on demand.

Real responses carry more than the answer. Anthropic's responses include a `request-id`, and also `anthropic-organization-id` and `anthropic-workspace-id` headers, which identify the account that made the call ([API overview](https://platform.claude.com/docs/en/api/overview), "Response headers", checked 2026-11-12). The prompts used, and the model's answers, end up in the repository. A key used for recording must never reach a file.

Some cases can't be recorded reliably:
- rate limits and overloads;
- an `error` event in the middle of a stream, which Anthropic documents with the example `{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}` ([Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming), "Error events");
- truncated connections.

## Decision

### Format

- **One file per case:** `test/fixtures/<provider>/<case>.http`. It holds:
  - a header block of `#` comment lines: the provider, endpoint, API version, model, recording date, and whether it's `recorded` or `synthetic`;
  - the HTTP status line;
  - the allowlisted response headers;
  - a blank line;
  - the response body, byte for byte as received.
- **Test fixtures, not published:** fixtures live in `test/`, outside `src/`. They need no changeset and aren't shipped.

### Replay

- **A fake `fetch`.** Adapters take an optional `fetch` ([0002](0002-provider-shape.md)), and tests pass a fake that serves a fixture.
- **The fake checks the request.** It asserts the request's method, URL, headers and body against what the test expects, with the key replaced by a sentinel. So a test checks both what an adapter sends and how it reads the reply.
- **Chunking is the test's choice.** Bodies are replayed in whole, in single bytes, and at every split position, including inside multi-byte characters ([0005](0005-limits-and-streams.md)), because recordings don't preserve chunk boundaries.
- **Delays are simulated with fake timers,** so tests of `idleTime` and `streamDuration` take no real time.
- **No real network.** The test setup replaces the global `fetch` with one that fails any call a test didn't provide, so an adapter that forgets the injected `fetch` fails loudly.

### Recording

- **`scripts/record-fixtures.mjs`** records fixtures. Only the owner or a maintainer runs it, by hand, with a key from the environment. It's never part of `pnpm verify` or CI. It sends a fixed, harmless set of prompts per case, defined in the script, with small output budgets.
- **Before writing a file, it:**
  - keeps only the allowlisted headers, which are `content-type`, `retry-after` and the provider's request ID, and drops all others, including Anthropic's organisation and workspace IDs;
  - replaces request IDs with stable placeholders such as `req_fixture_0001`;
  - refuses to write if the key, or any 8-character substring of it, appears anywhere in the output.
- **Committing** runs the secret scan through the pre-commit hook. The pull request that adds or updates fixtures says which were re-recorded, and the reviewer reads the diff.
- **Authentication failures** are recorded with a deliberately invalid key.
- **Each adapter's pull request** extends the header allowlist with its provider's equivalents, after checking its documentation.

### Synthetic fixtures

- **Hand-written fixtures cover what can't be recorded on demand:** rate limits with `retry-after`, overloads, an error event mid-stream, and malformed responses.
  - Each is marked `synthetic` in its header block.
  - It follows the provider's documented shape, and the header block links that documentation.
- **Derived fixtures:** truncated and oversized streams are generated from recorded ones in the test code, by cutting or repeating events.

### Keeping them current

- **Fixtures are re-recorded before each minor release,** and whenever an adapter changes its API version. The diff shows what changed in the providers' responses.
- **An optional `pnpm smoke` script** sends one small real request per configured provider, for the owner to run by hand with their own keys. It's outside `verify` and CI, and its results aren't committed.

## Alternatives considered

- **Calling providers in CI, with keys as secrets:** rejected. ADR 0035 forbids it. It would also make CI cost money, depend on providers' uptime and rate limits, and put keys in reach of workflows.
- **Hand-written fixtures only:** rejected. They'd encode what the documentation says rather than what providers send, and the two differ, for example in `ping` events, field order and extra fields.
- **Recording automatically when a test runs with a key** (a "record mode"): rejected. A forgotten environment variable could re-record and commit fixtures, or call a provider during an ordinary test run.
- **Storing full response headers:** rejected. They identify the account, organisation and workspace, and include rate-limit details nobody needs in a test.
- **Snapshot tests of adapters' outputs, without fixtures:** rejected. They'd check that output doesn't change, not that it's right for what the provider actually sent.

## Consequences

- CI never costs money, never holds a key, and doesn't fail when a provider is down.
- Tests exercise real response bytes, including the provider's own framing and quirks, and every failure path has a fixture, recorded or synthetic.
- Fixtures can go stale between re-recordings. The release checklist and the smoke script catch that before a release, not in CI.
- Recording needs the owner's keys and a little money, once per provider per release.

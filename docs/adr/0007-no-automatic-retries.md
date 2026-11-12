# 0007. No automatic retries: errors say whether and when to retry

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

Provider SDKs commonly retry failed calls on their own. Anthropic's "automatically retries transient failures (such as connection errors, rate limits, and 5xx server errors) with exponential backoff, twice by default, honoring the `retry-after` header when present" ([Errors](https://platform.claude.com/docs/en/api/errors), checked 2026-11-12). In `ai-core`, a retry spends the host's money and holds a user's request open, so whether to retry is a decision with costs.

What Anthropic documents about failures that look retryable ([Rate limits](https://platform.claude.com/docs/en/api/rate-limits) and [Errors](https://platform.claude.com/docs/en/api/errors), checked 2026-11-12):

- **`retry-after`** is "the number of seconds to wait until you can retry the request. Earlier retries might fail. Not every 429 carries it."
- **A spend-cap 429** has "no `retry-after` header. Retrying, including the SDK's automatic retries, fails until access resumes", which can be the start of the next month. It's identified by `error.details.error_code`, `enforced_spend_limit_reached`.
- **A ramp-limit 429** (`error_code` `ramp_limit_exceeded`) follows "a sharp increase in usage". The advice is to wait at least `retry-after` and "hold your traffic at a level where requests succeed". An automatic retry from every user at once is the opposite.
- **500 `api_error`:** "Retry the request with exponential backoff". **529 `overloaded_error`:** "the API is temporarily overloaded".
- **Errors mid-stream:** "an error can occur after the API returns a 200 response" ([Errors](https://platform.claude.com/docs/en/api/errors)). At that point the user may have seen part of an answer, and "tool use and thinking blocks cannot be partially recovered" ([Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)).

The family already decided the same for worker calls: they "are never retried automatically, because an operation isn't known to be safe to repeat. Whether to retry is the caller's decision" ([sdk-core ADR 0018](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0018-worker-rpc-protocol.md)).

## Decision

### Nothing retries on its own

- **Adapters, the handler and the transport never retry, resend or continue a call.** One call from the host is at most one request to the provider ([0003](0003-request-handler-and-wire-protocol.md)), and the security policy promises "once per call".

### Errors say whether and when to retry

- **Every `AiError` from a call carries these `details`:**
  - **`retryable`** (`true` or `false`): whether the same call can succeed later without changes;
  - **`retryAfter`** (seconds): only when the provider sent one, parsed from `retry-after` in either of its forms (seconds or an HTTP date), and never invented.
- **Classification:**

  | Failure | `retryable` |
  |---|---|
  | Network failure before any response byte | `true` |
  | Rate limit (429 without a spend-cap code) | `true` |
  | 500, 504 and timeout errors | `true` |
  | 529 overloaded | `true` |
  | A provider error event mid-stream of a retryable type | `true` |
  | 400, 401, 402, 403, 404, 413 | `false` |
  | Spend cap: Anthropic's `enforced_spend_limit_reached`, with its own code `SPEND_LIMIT_REACHED` | `false` |
  | Any ai-core limit, validation or protocol error | `false` |
  | `ABORTED` | `false` |

  Each adapter's pull request maps its provider's statuses and error types to this, from its documentation, and the mapping is tested with fixtures ([0006](0006-recorded-fixtures.md)).
- **Partial output:** when a call fails after any event was delivered, `details` also has `partial: true`. Retrying it means a new answer, not the rest of the old one, and the host decides how to present that.
- **Across the handler:** `retryable`, `retryAfter` and `partial` reach the browser unchanged, inside the serialised error ([0003](0003-request-handler-and-wire-protocol.md)). The browser can show "try again in 20 seconds" without knowing the provider.

### If a retry helper is added later

A future, opt-in helper that wraps a provider must meet all of these, and needs its own ADR:
- it retries only when `retryable` is `true` and `partial` isn't;
- it waits at least `retryAfter` when there is one, and backs off exponentially, with jitter, when there isn't;
- it caps attempts and the total wait, inside the call's `streamDuration` and the host's signal;
- it never retries a stream that has delivered an event.

## Alternatives considered

- **Retrying like the vendor SDKs, twice by default:** rejected.
  - Behind the handler, each user action could cost up to three calls, with no sign to the host.
  - Retries hold users' requests open for the backoff.
  - When a spend cap or a ramp limit is hit, every user retrying at once makes it worse, and a spend-cap 429 keeps failing for days.
- **Retrying only before the first byte:** rejected for now. It's safer, but still spends money and time the host didn't choose. Hosts that want it can add it with the information each error carries, and a helper can come later under the conditions above.
- **Retrying inside the handler, transparently to the browser:** rejected. The handler would hold a request open across several provider calls, under limits meant for one.
- **No retry information in errors:** rejected. Hosts would have to parse provider errors themselves, which is what `ai-core` exists to avoid.

## Consequences

- One call is one provider request, so hosts can reason about cost, rate limits and latency directly.
- Hosts that want retries write a few lines around a call, guided by `retryable`, `retryAfter` and `partial`, or wait for an opt-in helper.
- Transient failures reach users more often than with a vendor SDK. The errors carry what's needed to recover gracefully.
- Spend caps and ramp limits are never made worse by `ai-core`.

# ai-core

A headless AI provider layer for the `@hussmartinez` family: Anthropic, Gemini and OpenAI-compatible adapters, a server request handler and a browser transport. It's the family's only package with network code, and it makes requests only to endpoints the host configures, with API keys kept on the server by default.

No `@hussmartinez` SDK imports it. An SDK that needs AI defines its own provider port, and the host passes a provider built with `ai-core` or its own backend.

This repository publishes **`@hussmartinez/ai-core`**. It follows the family standards in [`sdk-core`'s `STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md), and in particular the decisions on [`ai-core` and host-configured network access](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md), [hostile input and no network](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md) and [ports and adapters](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md).

> Status: not published yet. 0.1.0 is the first release.

- [How it fits together](#how-it-fits-together)
- [Quick start](#quick-start)
- [Providers](#providers)
- [The request handler](#the-request-handler)
- [Conversations](#conversations)
- [Streaming, cancelling and tools](#streaming-cancelling-and-tools)
- [Errors](#errors)
- [Limits](#limits)
- [Content Security Policy](#content-security-policy)
- [Keys in the browser](#keys-in-the-browser)
- [Data and providers](#data-and-providers)
- [Testing](#testing)
- [Runtimes](#runtimes)
- [Development](#development)

## How it fits together

```text
browser                           your server                          provider
───────                           ───────────                          ────────
httpTransport ── POST /api/chat ─▶ createAiHandler
  (no key)       ai-core/1, SSE    ├─ prepare: who may call, and the
                                   │  model, system prompt and budget
                                   └─ adapter (holds the key) ────────▶ Anthropic,
                                                                        Gemini, …
```

Every provider, whether an adapter, the browser transport, the fake provider or one you write, has the same shape: `AiProvider`, with `complete()` and `stream()` ([ADR 0002](docs/adr/0002-provider-shape.md)). Code written against it works with any of them.

| Entry | What it holds |
|---|---|
| `@hussmartinez/ai-core` | The message model, `AiError`, limits, the message catalogue, `httpTransport` and `withoutProviderState` |
| `@hussmartinez/ai-core/server` | `createAiHandler` |
| `@hussmartinez/ai-core/anthropic` | `createAnthropic` |
| `@hussmartinez/ai-core/gemini` | `createGemini` |
| `@hussmartinez/ai-core/openai-compatible` | `createOpenAICompatible` and `createKimi` |
| `@hussmartinez/ai-core/testing` | `createFakeProvider` and `defineProviderContract` |

Each provider has its own entry, so you bundle only the ones you use. The only runtime dependency is `@hussmartinez/sdk-core`.

## Quick start

```sh
pnpm add @hussmartinez/ai-core @hussmartinez/sdk-core
```

On the server, a route handler, here in Next.js. Keep the key in the server's environment:

```ts
// app/api/chat/route.ts
import { createAnthropic } from "@hussmartinez/ai-core/anthropic";
import { createAiHandler } from "@hussmartinez/ai-core/server";

export const dynamic = "force-dynamic";

export const POST = createAiHandler({
  provider: createAnthropic({
    apiKey: () => process.env.ANTHROPIC_API_KEY ?? "",
    model: "claude-sonnet-5-5",
  }),
  async prepare({ request }) {
    const user = await getSignedInUser(request); // your own session check
    if (!user) {
      return new Response(null, { status: 401 });
    }
    return { system: "You are a helpful assistant.", maxOutputTokens: 2_000 };
  },
});
```

In the page, the transport, which holds no key:

```ts
import { httpTransport } from "@hussmartinez/ai-core";

const provider = httpTransport({ url: "/api/chat" });

for await (const event of provider.stream({ messages })) {
  if (event.type === "text-delta") {
    showText(event.text);
  }
}
```

[`examples/next`](examples/next) is a complete, tested version, with streaming, errors, a Stop button and a strict Content Security Policy.

## Providers

Every adapter streams. Each takes `apiKey`, as a string or a function that's read for each request and never stored, and `model`. Optionally, it takes `maxOutputTokens` (16,000 by default), `baseURL`, `fetch`, `limits` and `onWarning`. None of them retries on its own ([ADR 0007](docs/adr/0007-no-automatic-retries.md)).

| Factory | Calls | Default endpoint | Key header |
|---|---|---|---|
| `createAnthropic` | Claude Messages API, version `2026-10-21` | `https://api.anthropic.com` | `Authorization: Bearer` |
| `createGemini` | Gemini Interactions API, without storage | `https://generativelanguage.googleapis.com` | `x-goog-api-key` |
| `createOpenAICompatible` | Any Chat Completions API | `baseURL`, required | `Authorization: Bearer` |
| `createKimi` | Kimi, through Chat Completions | `https://api.moonshot.ai/v1` | `Authorization: Bearer` |

- **Anthropic:** thinking blocks arrive as `provider-state` parts, and go back unchanged on the next turn, as Anthropic requires. An account that reached its spend limit fails with `SPEND_LIMIT_REACHED`.
- **Gemini:** ai-core sends `store: false` and the full history with every call ([ADR 0008](docs/adr/0008-no-provider-side-storage.md)). Thought steps and their signatures are kept as `provider-state`.
- **OpenAI-compatible:**
  - Set `baseURL` to the API's root, such as `https://api.openai.com/v1`, and `provider` to a name for its state and `providerOptions`, such as `"openai"`.
  - `maxTokensField` chooses `max_completion_tokens` (the default) or `max_tokens`.
  - It sends `store: false`; `sendStore: false` leaves the field out for APIs that reject it.
- **Kimi:** a preset of the OpenAI-compatible adapter. A thinking model's `reasoning_content` is kept as `provider-state` and sent back as-is, as Kimi requires.
- **Options for one provider:** `providerOptions: { anthropic: { … } }` adds fields to that provider's request body. They're unvalidated, can't change the endpoint, headers or key, and can't turn on provider-side storage.
- **Your own provider:** any object with `provider`, `complete()` and `stream()` works. Run the contract suite against it (see [Testing](#testing)).

`baseURL` must use `https:`, or `http:` for `localhost` and `127.0.0.1`, such as a local model server.

## The request handler

`createAiHandler({ provider, prepare, limits?, allowedOrigins?, onWarning? })` returns `(request: Request) => Promise<Response>`, for Next.js route handlers, Hono, Node, Deno, Bun and Workers ([ADR 0003](docs/adr/0003-request-handler-and-wire-protocol.md)).

- **`prepare` is required.** Without it, `createAiHandler` throws, so an open proxy to your key can't be deployed by accident. It runs before anything reaches the provider, and gets `{ request, body, origin }`.
  - **To refuse a call,** return a `Response`, such as a 401 or a 429. The handler returns it unchanged.
  - **To allow it,** return the call's settings: `maxOutputTokens`, which is required, and optionally `model`, `system`, `tools`, `toolChoice` and `providerOptions`.
  - **If it throws,** the handler answers 500 with `PREPARE_FAILED`, and your error is never sent or logged.
- **The browser sends only the conversation.** The body is `{ protocol: "ai-core/1", messages }`. Any other field, such as `model` or `maxOutputTokens`, is rejected with 400, naming the field, so a page can never choose the model, the prompt or the budget.
- **What it accepts:**
  - only `POST` (405 otherwise);
  - only `content-type: application/json` (415 otherwise);
  - bodies within `requestBytes` (413 otherwise);
  - with `allowedOrigins`, such as `["https://app.example.com"]`, only those exact origins (403 otherwise, before `prepare` runs).
- **No CORS headers.** The handler adds none, which keeps cross-site pages out. Don't add permissive ones.
- **It never logs** requests, responses, prompts, outputs or keys. Wrap it if you want logs.

A `prepare` that authenticates and rate-limits:

```ts
import type { AiPrepareContext } from "@hussmartinez/ai-core/server";

const windowMs = 60_000;
const perWindow = 20;
const calls = new Map<string, { start: number; count: number }>();

async function prepare({ request }: AiPrepareContext) {
  const user = await getSignedInUser(request);
  if (!user) {
    return new Response(null, { status: 401 });
  }
  // A fixed window per user, in this process's memory. With several server
  // instances, keep the counts in a shared store such as Redis instead.
  const now = Date.now();
  const entry = calls.get(user.id);
  if (!entry || now - entry.start >= windowMs) {
    calls.set(user.id, { start: now, count: 1 });
  } else if (++entry.count > perWindow) {
    const retryAfter = Math.ceil((entry.start + windowMs - now) / 1_000);
    return new Response(null, { status: 429, headers: { "retry-after": String(retryAfter) } });
  }
  return {
    model: user.plan === "pro" ? "claude-opus-5-5" : "claude-sonnet-5-5",
    system: "You are a helpful assistant.",
    maxOutputTokens: user.plan === "pro" ? 8_000 : 2_000,
  };
}
```

In the browser, the transport reports a 401 as `PROVIDER_AUTHENTICATION`, and a 429 as `PROVIDER_RATE_LIMITED` with `details.retryAfter`.

## Conversations

Your application keeps the conversation, and sends all of it with every call ([ADR 0001](docs/adr/0001-message-model-and-provider-state.md)).

- **Append, never edit.** Keep every message and every part exactly as returned, including `provider-state` parts. They hold what providers need back unchanged, such as Anthropic's thinking blocks and Gemini's thought signatures.
- **Never display `provider-state` data.** Its `summary`, when present, is readable reasoning that you may show, as untrusted text.
- **Model output is untrusted text,** never markup. Render it as text, or sanitise it if you render Markdown.
- **Keep the system prompt and tools the same for a whole conversation.** Put volatile data, such as today's date or the user's local time, in messages. Changing them mid-conversation makes providers reject the earlier reasoning.

The handler enforces that last rule. The first part of every answer it returns is a small `ai-core` part, holding a hash of the system prompt and tools. If they've changed since, the next call fails with 409 `CONTEXT_CHANGED` before the provider is called. Either start a new conversation, or continue without the earlier reasoning:

```ts
import { isAiError, withoutProviderState } from "@hussmartinez/ai-core";

try {
  await send(conversation);
} catch (error) {
  if (isAiError(error, "CONTEXT_CHANGED")) {
    conversation = withoutProviderState(conversation);
    await send(conversation);
  }
}
```

Switching provider mid-conversation is allowed: each adapter sends only its own provider's state, and leaves out the rest.

## Streaming, cancelling and tools

- **`stream(request, { signal })`** yields `text-delta`, `summary-delta` and `part` events, and finally `finish`, with the finish reason and token usage. Collecting the `part` events gives the whole answer. A stream can be iterated once.
- **`complete(request, { signal })`** resolves to `{ message, finishReason, usage }`.
- **Cancelling:** abort the signal, and the call fails with `ABORTED`. Leaving a `for await` loop early also cancels it, quietly. Through the transport, an abort reaches the handler, which aborts the provider's call.
- **Errors aren't events.** The stream throws an `AiError`.
- **Tools:** pass `tools`, each with a JSON Schema, from `prepare` through the handler. The model's calls arrive as `tool-call` parts, whose `input` is untrusted JSON. **ai-core never runs a tool.** Validate the input, run the tool if you decide to, and send the result as a `tool-result` part in the next user message.

## Errors

Every failure is an `AiError` with a stable `code`. Check it with `isAiError(error, "CODE")`, which also recognises errors rebuilt from the handler's responses.

- **`details.retryable`** says whether the same call can succeed later, and `details.retryAfter` gives the seconds to wait, when the provider sent them. ai-core never retries for you.
- **`details.partial: true`** means events were already delivered before the failure.
- **Show users the catalogue's text, never `error.message`,** which is for developers:

```ts
import { aiCoreMessages } from "@hussmartinez/ai-core";
import { createMessages } from "@hussmartinez/sdk-core";

const messages = createMessages(aiCoreMessages, { locale: "en" });
showError(messages.error(error)); // "The assistant is busy. Please try again in a moment."
```

The codes are documented on `AiErrorCode`, and the handler's statuses in [ADR 0003](docs/adr/0003-request-handler-and-wire-protocol.md).

## Limits

Provider responses are hostile input ([ADR 0005](docs/adr/0005-limits-and-streams.md)). Each limit fails with its own code, and `onWarning` is called once before it's reached, never with content.

| Limit | Default | Warning | Code | Where |
|---|---|---|---|---|
| `responseBytes` | 16 MB | 8 MB | `RESPONSE_TOO_LARGE` | Adapters and the transport |
| `streamDuration` | 15 minutes | 10 minutes | `STREAM_TIMEOUT` | Adapters and the transport |
| `idleTime` | 2 minutes | none | `STREAM_IDLE` | Adapters and the transport |
| `requestBytes` | 8 MB | 4 MB | `REQUEST_TOO_LARGE` | The handler |

Override them with `limits`, such as `{ streamDuration: 30 * 60 * 1_000 }` for long reasoning. Unknown names throw. The transport applies the response limits to your own handler's stream too, so a misbehaving server can't exhaust a user's tab.

## Content Security Policy

With the transport, the page talks only to your own handler. Allow just that:

```text
connect-src 'self'
```

If the handler is on another origin, list that origin instead. ai-core needs nothing else: no scripts, styles, fonts, images or workers from elsewhere. [`examples/next`](examples/next) runs under this policy, and its end-to-end tests fail on any violation.

With [keys in the browser](#keys-in-the-browser), `connect-src` lists the exact provider origins you call, and nothing broader:

| Provider | `connect-src` |
|---|---|
| Anthropic | `https://api.anthropic.com` |
| Gemini | `https://generativelanguage.googleapis.com` |
| Kimi | `https://api.moonshot.ai` |
| OpenAI-compatible | the origin of your `baseURL` |

## Keys in the browser

By default, an adapter refuses to run anywhere it doesn't recognise as a server, failing with `BROWSER_KEY_REFUSED`. That includes pages and browser workers ([ADR 0004](docs/adr/0004-keys-and-runtime-detection.md)). It recognises Node, Bun, Deno, Vercel and Next.js Edge, and Cloudflare Workers.

`dangerouslyAllowBrowser: true` lets an adapter run in a browser, **for applications where users bring their own keys**. Anyone who can read the page can read the key, so never put your own key there. With the option set, the Anthropic adapter also sends `anthropic-dangerous-direct-browser-access: true`, as Anthropic's own SDK does for browser calls. Whether a provider accepts calls from browsers at all is up to the provider.

## Data and providers

ai-core never asks a provider to keep your users' conversations ([ADR 0008](docs/adr/0008-no-provider-side-storage.md)). Where a provider offers server-side storage, the adapter turns it off in every request, and `providerOptions` can't turn it back on: Gemini and OpenAI-compatible APIs always get `store: false`. Your application keeps the conversation and sends it with each call.

`store` is only one of the ways a provider can retain data. Each provider's own terms decide what else happens to what you send, such as logging, abuse monitoring or training use, which can differ on free tiers. Reviewing those terms, and choosing a tier and settings that fit your users, is your responsibility as the host. Checked on 2026-11-13:

- **Anthropic:** its [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) say "Anthropic may not train models on Customer Content from Services."
- **Gemini:** the [Gemini API Additional Terms of Service](https://aistudio.google.com/docs/terms) differ by tier.
  - **Unpaid Services:** Google uses what you submit, and the responses, "to provide, improve, and develop" its products, and "human reviewers may read, annotate, and process your API input and output". The terms say: "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
  - **Paid Services:** Google doesn't use prompts or responses "to improve our products", and "logs prompts and responses for a limited period of time" for safety and policy enforcement.
- **Kimi:** the [Kimi OpenPlatform Privacy Policy](https://platform.kimi.ai/docs/agreement/userprivacy) covers the platform as a whole, including using data for "training and refining our underlying technology, such as machine learning models and algorithms". Read it before sending personal data.
- **Other OpenAI-compatible APIs:** check the terms of the API you configure.

## Testing

Your tests never need a network or a key.

```ts
import { createFakeProvider, defineProviderContract } from "@hussmartinez/ai-core/testing";
import { describe, it } from "vitest";

// A scripted provider for your own tests. It records every request.
const provider = createFakeProvider([{ parts: [{ type: "text", text: "Hello!" }] }]);

// The suite every provider passes. It works with Vitest, Jest and node:test.
defineProviderContract((scenario) => createMyProvider(scenario), { describe, it });
```

For a provider that passes on another provider's state, as the transport does, give `defineProviderContract` a third argument, `{ relaysState: true }`.

## Runtimes

- **Servers:** Node 24 or later, Bun, Deno, Vercel and Next.js Edge, and Cloudflare Workers: anywhere with `fetch`, web streams and Web Crypto. A missing feature fails with `UNSUPPORTED_ENVIRONMENT`, naming it.
- **Browsers:** the family's supported browsers, the last two major versions ([sdk-core ADR 0013](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0013-browser-and-react-support.md)), for the transport and the message model.
- **Module format:** ES modules only. No entry makes a request, reads a key or touches storage when it's imported.

## Development

The repository root is the published package, laid out as in the family's [standard layout](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md#repository-layout). The source is in [`src`](src), with one entry file per export (`.`, `./server`, `./anthropic`, `./gemini`, `./openai-compatible` and `./testing`). The pnpm workspace also holds:

- [`examples/next`](examples/next), a Next.js application that uses the built package;
- [`e2e`](e2e), the Playwright suite that runs against it, with a local stand-in for the provider.

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. The exact pnpm version is pinned in `package.json`, and pnpm switches to it automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs
pnpm verify:fast   # the subset the pre-push hook runs
```

Browser and end-to-end tests need Playwright's browsers once: `pnpm exec playwright install chromium`. Add `firefox webkit` to run all three engines, with `CI=1` or `pnpm test:browser:all`.

`pnpm verify` runs, in order:

| Step | Script | Tool |
|---|---|---|
| Format and lint | `lint` | Biome |
| Types | `typecheck` | TypeScript |
| Dependency rules | `lint:deps` | dependency-cruiser, through `hm-lint-deps` |
| One copy of each family package | `check:single-copy` | `hm-check-single-copy` |
| Build | `build` | Vite, then api-extractor for the type declarations |
| Unit tests | `test` | Vitest, in Node, including every built entry imported without a request |
| Browser tests | `test:browser` | Vitest in Chromium, and in Firefox and WebKit too in CI |
| Example build | `build:examples` | Next.js, a production build of [`examples/next`](examples/next) |
| End-to-end tests | `test:e2e` | Playwright against the example, with a local stand-in for the provider |
| Size budgets | `check:size` | size-limit, brotli size of each entry point |
| API reports | `check:api` | api-extractor, one report per entry point in [`api`](api) |
| Package checks | `check:package` | publint and Are the Types Wrong? |

There's no CSS step, because ai-core renders nothing. The configuration extends the shared presets in [`@hussmartinez/sdk-config`](https://www.npmjs.com/package/@hussmartinez/sdk-config). The git hooks ([ADR 0016](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0016-git-hooks-and-merge-guards.md)) run automatically:
- on commit, a secret scan and lint of the staged files;
- on the commit message, a Conventional Commits check;
- on push, `pnpm verify:fast`.

When a change alters the public API on purpose, update the reports with `pnpm api:update` and commit them. Real provider fixtures are recorded by hand only, with `pnpm record-fixtures <provider>` and the provider's key in the environment ([ADR 0006](docs/adr/0006-recorded-fixtures.md)).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Coding agents also start with [`AGENTS.md`](AGENTS.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in the [security policy](SECURITY.md), which also says exactly what ai-core sends, to where and when.

## License

[Apache-2.0](LICENSE)

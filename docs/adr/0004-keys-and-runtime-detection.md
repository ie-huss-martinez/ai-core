# 0004. Keys stay on the server: how adapters hold keys and recognise a server

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

[sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md) keeps API keys on the host's server by default, and lets an adapter run in a browser only when the host passes `dangerouslyAllowBrowser: true`. Two questions decide whether that holds in practice: how an adapter holds a key without leaking it, and how it tells a server from a browser.

What the providers and runtimes document, checked on 2026-11-12:

- **Anthropic** authenticates with `Authorization: Bearer <key>`, or with `x-api-key`, "legacy fallback for `Authorization`, still supported", and requires `anthropic-version` ([API overview](https://platform.claude.com/docs/en/api/overview), "Authentication"). Its TypeScript SDK refuses browsers by default, "to avoid exposing your secret API credentials", unless `dangerouslyAllowBrowser` is set ([README](https://github.com/anthropics/anthropic-sdk-typescript)). With that option set, it sends `anthropic-dangerous-direct-browser-access: true` ([`src/client.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)). The SDK detects a browser only by `window`, `window.document` and `navigator` ([`src/internal/detect-platform.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/internal/detect-platform.ts)), so it doesn't recognise a browser worker.
- **Gemini** takes the key in the `x-goog-api-key` header. Its documentation warns: "Do not hardcode API keys directly in web or mobile apps", "Keys compiled in client-side code can be extracted by users", and recommends to "run a backend proxy server to make the actual API calls" ([API keys](https://aistudio.google.com/docs/api-key)).
- **Cloudflare Workers** expose `navigator.userAgent` with the value `'Cloudflare-Workers'`, on by default since the `global_navigator` compatibility date of 2022-03-21. That "can be used, for example, to reliably determine that code is running within the Workers environment" ([Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/), [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)).
- **Deno 2** tells code to use `globalThis` in place of `window` ([migration guide](https://docs.deno.com/runtime/reference/migration_guide/)).
- **Browser workers** have `importScripts()`, a method of `WorkerGlobalScope`. In module workers it exists but throws when called ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts)).
- **Server runtimes** are recognised by Anthropic's SDK through Node's `process` (`Object.prototype.toString` gives `[object process]`), `Deno.build`, and the `EdgeRuntime` global ([`src/internal/detect-platform.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/internal/detect-platform.ts)).

The ways a runtime check can go wrong aren't symmetric:
- **Mistaking a browser for a server** sends the host's key to every visitor.
- **Mistaking a server for a browser** stops the adapter with a clear error.

## Decision

### Holding keys

- **Adapters take `apiKey`** as a string, or as a function returning a string or a promise of one, so hosts can read it from a secret manager. The function is called each time a request is built, and its result isn't cached.
- **The key lives in a closure or a private (`#`) field.** It's never an enumerable property of an adapter, so `JSON.stringify`, `structuredClone`, spreading and logging an adapter never show it. Tests check each of those.
- **Keys go only in headers:**
  - `Authorization: Bearer` for Anthropic and OpenAI-compatible APIs;
  - `x-goog-api-key` for Gemini;
  - never in a URL, so they don't end up in proxy or server logs. Gemini's query-parameter form isn't used.
  
  Each adapter's pull request re-checks its header against the provider's documentation.
- **A missing or empty key** fails with `MISSING_API_KEY` before any request is made.
- **The secrets rules of ADR 0035** apply to every path the key could take, and the sentinel tests check them.
- **The transport holds no provider key.** Its `headers` carry only the host's own credentials for its endpoint.

### Recognising a server

An adapter runs without the opt-in only where **all** of these hold:

1. **There's no page:** `globalThis.document` is undefined.
2. **There's no browser worker:** `globalThis.importScripts` isn't a function.
3. **The runtime is positively recognised as a server,** by at least one of:
   - **Node, and Bun, which reports itself the same way:** `Object.prototype.toString.call(globalThis.process) === "[object process]"`. That's true of Node's real `process`, and not of a bundler's `process` shim, which is a plain object.
   - **Deno:** `globalThis.Deno?.build` is an object.
   - **Vercel and Next.js Edge:** `globalThis.EdgeRuntime` is defined.
   - **Cloudflare Workers:** `globalThis.navigator?.userAgent === "Cloudflare-Workers"`.

- **Anywhere else, it refuses** with `BROWSER_KEY_REFUSED`, unless the host passes `dangerouslyAllowBrowser: true`. That includes pages, browser workers, test environments with a DOM such as jsdom, and any runtime it doesn't recognise. The error's message explains the risk and the opt-in.
- **The check runs when the adapter is created, and again before each request,** so an adapter created on a server and moved to a page, for example through a bundling mistake, still refuses.
- **The opt-in is the only escape hatch.** A server runtime that isn't recognised is reported as an issue and added to the list. There's no separate "trust me, it's a server" option, because it would be one more way to send a key to a browser.

### With the opt-in

- **`dangerouslyAllowBrowser: true` turns off the refusal, and nothing else.** All other rules still apply.
- **Anthropic's adapter** sends `anthropic-dangerous-direct-browser-access: true` only with the opt-in, as Anthropic's own SDK does.
- **Other providers work in a browser only where they allow cross-origin requests.** Each adapter's pull request checks its provider's documentation and states the result in the README. Gemini's documentation recommends a backend proxy instead.
- **The README's CSP section** lists the exact provider origins for this mode, and `connect-src 'self'` for the handler mode.

### Tested where it runs

- **Node:** refusal with a DOM (jsdom), with `importScripts`, and with a bundler-style `process` shim; success with the real `process`.
- **Real browsers, through Vitest's browser mode:** refusal in a page and in a dedicated worker, and success only with the opt-in.
- **Cloudflare's runtime (workerd, through Miniflare):** success, if its install passes the family's supply-chain settings. This also confirms that Workers define neither `document` nor `importScripts`. Otherwise, a simulated Workers global scope (`navigator.userAgent` and no `document` or `importScripts`), with the pull request saying so.
- **Deno and Edge runtimes:** simulated globals, because neither runs in CI.

## Alternatives considered

- **Detecting browsers the way Anthropic's SDK does,** by `window.document`: rejected. It lets a browser worker through, and treats unknown runtimes as servers, the wrong way round.
- **Refusing only in pages:** rejected for the same reason. Workers on a page can read the key just as easily.
- **A `serverRuntime: true` override for unknown runtimes:** rejected. It's an opt-out of the same check under a less alarming name.
- **Keys as plain adapter properties:** rejected. Logging an adapter or serialising an object that contains it would print the key.
- **Gemini's `?key=` query parameter:** rejected. URLs are logged by proxies, servers and browsers.

## Consequences

- An adapter can't send a key from a browser by accident, including from a worker, a jsdom test or a misbundled server module.
- Hosts on a server runtime that isn't recognised get a clear error, and need a new release or the opt-in. The list is short and documented.
- Browser-key mode needs the provider's CORS support and the host's explicit choice, and its README section says what that exposes.
- Every adapter's pull request has to confirm its authentication header and CORS behaviour against the provider's documentation.

# Working in this repository

This repository is part of the `@hussmartinez` SDK family and is public. Treat it as a showcase: code, commits and pull requests should read as professional work.

It publishes `@hussmartinez/ai-core`: a headless AI provider layer. It contains:
- a message model;
- adapters for Anthropic, Gemini and OpenAI-compatible providers, including a Kimi preset;
- a server request handler, and a browser transport that talks only to that handler.

It's the family's only package with network code. It makes requests only through adapters and transports that the host creates, to endpoints the host configures, and it renders nothing. No `@hussmartinez` SDK imports it: an SDK that needs AI defines its own provider port, and the host passes a provider built with `ai-core` or its own backend.

## Before changing anything

- Read [`STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md) in `sdk-core`. It is binding for every repository in the family.
- Check the decision records before changing anything they cover.
  - Family-wide decisions live in [`sdk-core`'s `docs/adr`](https://github.com/ie-huss-martinez/sdk-core/tree/main/docs/adr), and changes to them belong in `sdk-core`, not here.
  - Decisions specific to this repository live in `docs/adr` here.
  - To change a decision, write a new ADR that supersedes the old one, in the same pull request as the change.
- The records that matter most here:
  - [0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md): `ai-core`, network access, secrets and hostile output; the most important;
  - [0012](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md) and [0020](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0020-file-policy.md): hostile input and limits;
  - [0004](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0004-entry-points-and-module-format.md) and [0033](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0033-api-reports-for-several-entry-points.md): entry points and their API reports;
  - [0008](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md) and [0017](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0017-core-errors-and-shared-runtime-imports.md): layers;
  - [0034](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0034-shared-error-helpers.md): error helpers;
  - [0013](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0013-browser-and-react-support.md): browser support;
  - [0014](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0014-accessibility-and-translatable-text.md) and [0019](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0019-message-catalogues.md): text and message catalogues;
  - [0021](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0021-version-and-release-with-changesets.md) and [0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md): releases and CI.

## Making changes

- **Pull requests:** work on a branch and open one focused pull request per change. Never push to `main`; it is protected.
- **One pull request at a time:** after opening a pull request, stop and report its link, a short summary and your `pnpm verify` result. Start the next change only once it's merged, from an up-to-date `main`.
- **Never merge your own pull request:** a separate reviewer reads the full diff, runs `pnpm verify` independently for code changes, and squash-merges it. An agent that wrote a pull request never reviews or merges it. See [How pull requests are reviewed](CONTRIBUTING.md#how-pull-requests-are-reviewed).
- **Pull request descriptions:** cover what changed, why, and how it was tested. They can be as detailed as useful, because they don't go into git history.
- **Squash commits:** the merger writes the commit message on `main`. Its title is the pull request title plus `(#N)`, and its body is 2–6 lines of plain prose. See [How pull requests are merged](CONTRIBUTING.md#how-pull-requests-are-merged).
- **Commits:** follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`). The pull request title becomes the squash commit, so write it as a Conventional Commit too.
- **Changesets:** a pull request that changes the published package's source or `package.json` adds a changeset with `pnpm changeset`. Write its note for the package's users: what changed for them, the API they'll see, and how to migrate if it breaks. Versions and changelogs come from changesets, not commits. See [Changesets](CONTRIBUTING.md#changesets).
- **Signing:** commits are signed; don't disable signing.
- **No attribution:** don't add AI or tool attribution to commits or pull requests.
- **ADRs:** add one for any significant decision. That means anything affecting the public API, the wire protocol, cross-package consistency, security, keys or what is sent to a provider, or anything hard to reverse.
- **Other repositories:** don't edit them from here. If this repository needs a change elsewhere, such as a shared helper in `@hussmartinez/sdk-core`, propose it in that repository.

## ai-core rules

These follow from the standards and [ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md). They're repeated here because they apply to almost every change in this repository.

- **Layers:**
  - code lives in `src/core` (`model`, `errors`, `limits`, `sse`), `src/adapters` (one folder per provider, and the HTTP transport), `src/server`, `src/testing` and `src/messages`;
  - the core never imports an adapter, the server or the testing code, and adapters never import the server;
  - `dependency-cruiser` enforces the layer rules;
  - there's no React, DOM rendering or CSS in this package.
- **Network:**
  - nothing is requested on import, and a test proves it for every entry point;
  - a request is made only by an adapter or transport that the host created, to the endpoint it was configured with, for a call the host or the user started;
  - there's no telemetry, and event callbacks never carry prompts, outputs or keys.
- **Keys:**
  - keys stay on the server by default;
  - adapters read the key only when building a request, and never store it where it could be serialised or logged;
  - in a browser page or browser worker, an adapter refuses to run with `BROWSER_KEY_REFUSED` unless the host passes `dangerouslyAllowBrowser: true`;
  - when the runtime is unclear, it refuses;
  - the detection is tested in Node, in a Workers runtime where possible, and in a real browser page and worker.
- **Secrets never leak:**
  - keys never appear in an error's `message`, `details` or `cause` chain, in `serializeError()` output, in events, in logs or in the handler's error responses;
  - `cause` never holds a request, headers or a raw response;
  - `details` keeps only the status, the provider's error type or code, `retryAfter` and the provider's request ID, and never request or response bodies;
  - each adapter, and the handler, has a sentinel test with a planted key and prompt across its failure paths.
- **The request handler:**
  - `createAiHandler` requires `prepare`, and throws at construction without it;
  - `prepare` authenticates and rate-limits the request, and sets the model, system prompt, tools and output budgets such as `max_tokens`, which never come from the browser's body;
  - the handler accepts only `POST` with `content-type: application/json`, and never logs bodies;
  - hosts must not add permissive CORS headers.
- **Provider responses are hostile input:**
  - response size, stream duration and idle time, and the handler's request size, are limited with `defineLimits`, each failing with its own code;
  - a malformed response fails with a specific code, and is never passed on half-parsed.
- **Provider state and tool calls:**
  - opaque `provider-state` parts, such as Anthropic's thinking blocks, are replayed to the provider unchanged and are never display content;
  - tool calls are reported, never executed automatically.
- **Tests make no real requests:**
  - tests replay recorded provider responses through an injected `fetch`;
  - CI never calls a provider and never holds a key;
  - fixtures are recorded only by hand with `scripts/record-fixtures.mjs`, with request IDs replaced and only allowlisted headers kept, and they're scanned and reviewed before they're committed.
- **Provider details are checked, not remembered:** every provider-specific fact, such as a header, version, URL, event name or CORS behaviour, is confirmed against the provider's live documentation in the pull request that relies on it, and the pull request quotes the documentation's URL.
- **Dependencies:** no vendor SDKs. Adapters use `fetch` and the package's own SSE parser, and `@hussmartinez/sdk-core` is the only runtime dependency.
- **Errors and text:**
  - `AiError` extends `SdkError`, with stable `SCREAMING_SNAKE_CASE` codes;
  - every code has a message in `src/messages/en.ts`, and a test checks it;
  - user-facing text never comes from `error.message`.
- **Entry points:**
  - each adapter has its own entry, so hosts bundle only what they use;
  - `./server` holds the handler;
  - `./testing` holds the contract suite, which takes its test functions as arguments and doesn't depend on a test framework;
  - every entry has a size budget.
- **Runtimes:** the last two major versions of the family's browsers ([ADR 0013](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0013-browser-and-react-support.md)), and server runtimes with the Fetch API and web streams, from Node 24. A missing platform feature fails with `UNSUPPORTED_ENVIRONMENT`, naming the feature.

## Verifying changes

- **Hooks:** they run automatically: linting and a secret scan on commit, commit message checks, and `pnpm verify:fast` on push. Never use `--no-verify`. If a hook is wrong or too slow, fix it in its own pull request.
- **Before marking a pull request ready,** run the full `pnpm verify` locally and report its results in the description.
- **CI:** it runs `pnpm verify`, checks the pull request title, and checks for a changeset when the published package changes. All three must pass before merging. CI is the final gate, not a substitute for local verification.
- **Never weaken a check to make it pass.** That includes lint rules, size budgets, the API report, the limits, the sentinel tests, the no-request-on-import test and the no-network assertion. Fix the cause, or propose the change in its own pull request with an ADR if the rule itself is wrong.

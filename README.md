# ai-core

A headless AI provider layer for the `@hussmartinez` family: Anthropic, Gemini and OpenAI-compatible adapters, a server request handler and a browser transport. It's the family's only package with network code, and it makes requests only to endpoints the host configures, with API keys kept on the server by default.

No `@hussmartinez` SDK imports it. An SDK that needs AI defines its own provider port, and the host passes a provider built with `ai-core` or its own backend.

This repository will publish **`@hussmartinez/ai-core`**. It follows the family standards in [`sdk-core`'s `STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md), and in particular the decisions on [`ai-core` and host-configured network access](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md), [hostile input and no network](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md) and [ports and adapters](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md).

> Status: being bootstrapped. No packages are published yet.

## Data and providers

ai-core never asks a provider to keep your users' conversations ([ADR 0008](docs/adr/0008-no-provider-side-storage.md)). Where a provider offers server-side storage, the adapter turns it off in every request, and `providerOptions` can't turn it back on. Gemini, for example, always gets `store: false`. Your application keeps the conversation and sends it with each call.

`store` is only one of the ways a provider can retain data. Each provider's own terms decide what else happens to what you send, such as logging, abuse monitoring, or training use, which can differ on free tiers. Reviewing those terms, and choosing a tier and settings that fit your users, is your responsibility as the host.

## Development

The repository root is the published package, laid out as in the family's [standard layout](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md#repository-layout): the source is in [`src`](src), with one entry file per export (`.`, `./server`, `./anthropic`, `./gemini`, `./openai-compatible` and `./testing`). The pnpm workspace also holds [`examples/next`](examples/next), a Next.js application that uses the built package, and [`e2e`](e2e), the Playwright suite that runs against it with a local stand-in for the provider.

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. The exact pnpm version is pinned in `package.json`, and pnpm switches to it automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs
pnpm verify:fast   # the subset the pre-push hook runs
```

Browser tests need Playwright's browsers once: `pnpm exec playwright install chromium`, plus `firefox webkit` to run all three engines with `CI=1` or `pnpm test:browser:all`.

`pnpm verify` runs, in order:

| Step | Script | Tool |
|---|---|---|
| Format and lint | `lint` | Biome |
| Types | `typecheck` | TypeScript |
| Dependency rules | `lint:deps` | dependency-cruiser, through `hm-lint-deps` |
| Build | `build` | Vite, then api-extractor for the type declarations |
| Unit tests | `test` | Vitest, in Node, including every built entry imported without a request |
| Browser tests | `test:browser` | Vitest in Chromium, and in Firefox and WebKit too in CI |
| Size budgets | `check:size` | size-limit, brotli size of each entry point |
| API reports | `check:api` | api-extractor, one report per entry point in [`api`](api) |
| Package checks | `check:package` | publint and Are the Types Wrong? |

There's no CSS step: ai-core renders nothing. The configuration extends the shared presets in [`@hussmartinez/sdk-config`](https://www.npmjs.com/package/@hussmartinez/sdk-config). The git hooks ([ADR 0016](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0016-git-hooks-and-merge-guards.md)) run automatically: a secret scan and lint of staged files on commit, a Conventional Commits check of the message, and `pnpm verify:fast` on push.

When a change alters the public API on purpose, update the reports with `pnpm api:update` and commit them.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Coding agents also start with [`AGENTS.md`](AGENTS.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in the [security policy](SECURITY.md), which also says exactly what ai-core sends, to where and when.

## License

[Apache-2.0](LICENSE)

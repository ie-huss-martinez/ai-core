# ai-core

A headless AI provider layer for the `@hussmartinez` family: Anthropic, Gemini and OpenAI-compatible adapters, a server request handler and a browser transport. It's the family's only package with network code, and it makes requests only to endpoints the host configures, with API keys kept on the server by default.

No `@hussmartinez` SDK imports it. An SDK that needs AI defines its own provider port, and the host passes a provider built with `ai-core` or its own backend.

This repository will publish **`@hussmartinez/ai-core`**. It follows the family standards in [`sdk-core`'s `STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md), and in particular the decisions on [`ai-core` and host-configured network access](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md), [hostile input and no network](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md) and [ports and adapters](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md).

> Status: being bootstrapped. No packages are published yet.

## License

[Apache-2.0](LICENSE)

---
"@hussmartinez/ai-core": minor
---

First release of `@hussmartinez/ai-core`, the `@hussmartinez` family's AI provider layer. It has adapters for Anthropic, Gemini and OpenAI-compatible APIs, with a Kimi preset, plus a server request handler and a browser transport that talks only to it. It's the family's only package with network code. It makes requests only through adapters and transports your application creates, to the endpoints you configure, and API keys stay on your server by default.

- **Package shape:** an ES module package with one entry per part, so you bundle only what you use:
  - the core and browser transport, `@hussmartinez/ai-core`;
  - the request handler, `@hussmartinez/ai-core/server`;
  - one entry per provider: `/anthropic`, `/gemini` and `/openai-compatible`;
  - a contract-test suite for custom providers, `@hussmartinez/ai-core/testing`.
- **No request on import:** no entry makes a network request when it's imported, in browsers or on servers.

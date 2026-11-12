# Security policy

`@hussmartinez/ai-core` sends what users type to AI providers, holds the API keys that pay for those calls, and passes what models write back to other people's applications. A vulnerability here can leak a host's paid API key, turn a host's server into an open proxy that anyone can spend through, or let a model's output or a provider's response escape the limits that protect the page or the server. It's the only package in the `@hussmartinez` family with network code. Reports are among the most valuable this project can receive. Thank you for taking the time to report one privately.

## What ai-core sends, to where, and when

This is the package's promise. Anything that breaks it is a vulnerability.

- **Nothing on import.** No entry point makes a request, reads a key or touches storage when it's imported, in a browser or on a server. Tests check every entry in both.
- **No telemetry.** ai-core never sends usage data, errors or analytics anywhere. Event callbacks never contain prompts, model output or keys.
- **Provider adapters** (`/anthropic`, `/gemini`, `/openai-compatible`) send a request only when the host calls `complete()` or `stream()` on an adapter the host created.
  - **To:** the endpoint the adapter is configured with, and nowhere else. That's the provider's documented API URL by default, or the `baseURL` the host sets.
  - **What:** the messages, system prompt, tool definitions and options of that one call, with the API key in the provider's authentication header. Images are sent as the bytes the host passed, never as URLs for the provider to fetch.
  - **When:** once per call. ai-core never retries on its own.
- **The server handler** (`/server`) makes no request of its own. It runs the host's required `prepare` hook first, then calls the provider the host gave it.
  - **Who decides:** `prepare` authenticates and rate-limits the caller, and sets the model, system prompt, tools and output budgets. The browser's request body only supplies messages and a small set of allowed options.
  - **What it accepts:** only `POST` requests with `content-type: application/json`, within the request size limit.
- **The browser transport** sends each call to the one URL the host configured, normally the host's own handler, and nowhere else.
- **Keys stay on the server by default.** An adapter refuses to run in a browser page or browser worker unless the host passes `dangerouslyAllowBrowser: true`, for applications where users bring their own keys. A key is read only when a request is built. It never appears in errors, serialised errors, events, logs or the handler's responses.
- **Responses are hostile input.** Response size, stream duration and idle time are limited, and so is the size of requests the handler accepts. Each limit fails with its own error code. Model output is delivered as data, never as markup, and tool calls are never executed automatically.

## Reporting a vulnerability

**Please don't open a public issue, pull request or discussion.**

Report it through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to [the advisory form](https://github.com/ie-huss-martinez/ai-core/security/advisories/new). Only the maintainer can see the report.

Please include:

- the affected version, or the commit;
- what an attacker can do, and under which conditions;
- steps to reproduce it, or a proof of concept. If it needs a crafted provider response or stream, attach it to the private report.
- **Never attach a real API key, real prompts or conversations, or a provider's full response with account details.** Revoke any key that may have leaked before you report, and use placeholders.

## What to expect

- **Acknowledgement** within 7 days.
- **Updates** at least every 14 days until the issue is resolved.
- **A fix and an advisory.** Once a fix is released, a GitHub Security Advisory describes the issue, with a CVE where it applies. You're credited in the advisory unless you'd rather not be.
- **Coordinated disclosure.** Please keep the issue private until the advisory is published, or for 90 days after your report, whichever comes first. If a fix needs longer, we'll agree on a date with you.

## Supported versions

The package is pre-1.0. Security fixes go into the latest release only. No version has been published yet.

## Scope

In scope is everything in this repository: `@hussmartinez/ai-core`, its adapters, server handler, browser transport and contract suite, the workflows that verify and release it, and the published package. Examples:

- **key leaks:**
  - an API key reaching an error's `message`, `details` or `cause`, `serializeError()` output, an event, a log, the handler's response, a fixture or the published package;
  - a key being read or kept longer than one request needs;
  - an adapter running with a key in a browser without `dangerouslyAllowBrowser: true`, including through a runtime that the browser detection mistakes for a server.
- **open-proxy misuse of the handler:**
  - a request that reaches the provider without passing the host's `prepare` hook;
  - a handler created without `prepare`;
  - a browser request body that chooses the model, the system prompt, the tools, `max_tokens` or other output budgets;
  - a cross-site request that triggers a call without CORS preflight, such as a form post or a non-JSON content type;
  - the handler forwarding a request to a URL taken from the request.
- **requests ai-core shouldn't make:**
  - any request on import;
  - telemetry;
  - a request to an origin other than the one the adapter or transport was configured with, including through redirects or URLs in model output or messages;
  - an automatic retry;
  - an image or other resource fetched by URL.
- **output escaping its limits:**
  - a provider response, stream or handler request beyond the configured size, duration or idle limits that is still read, buffered or passed on;
  - a malformed or adversarial stream that hangs, exhausts memory, crashes the server or the page, or is passed on half-parsed;
  - model output or tool-call arguments that ai-core delivers as markup or executes.
- **leaks between calls or users:** one call's or one user's prompt, output, key or provider state showing up in another's, on a server handling many users or a page with several conversations.
- **leaks of prompts and output:** request or response bodies, prompts or model output reaching error `details`, events or logs.
- **the supply chain and release:** weaknesses in the build, release or publishing workflows, such as unpinned actions, excessive permissions, a runtime dependency added without review, or a recorded fixture that contains a secret.

**A known vulnerability in third-party code that ai-core bundles is in scope** when the latest release still ships the affected version, because applications can only get the fix from us. ai-core has no runtime dependency except `@hussmartinez/sdk-core`.

Out of scope:

- **a host's own server, authentication, rate limiting or storage,** including a `prepare` hook that lets everyone through. Report those to the application. A handler that skips `prepare`, or lets the body override it, is in scope;
- **what a model says,** such as wrong, unsafe or biased answers, or prompt injection that changes the model's reply but nothing outside it. Report those to the provider or the host. Prompt injection that makes ai-core itself request something, execute a tool or leak a key is in scope;
- **the providers' own APIs and accounts.** Report those to the provider;
- **keys a host deliberately exposes** by passing `dangerouslyAllowBrowser: true`. That opt-in sends the key from the browser by design;
- issues that need an already compromised device, browser, server or build environment;
- responses that are merely slow within the configured limits. Report those as a public issue.

Vulnerabilities in the shared runtime go to [sdk-core's security policy](https://github.com/ie-huss-martinez/sdk-core/security/policy).

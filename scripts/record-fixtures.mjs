#!/usr/bin/env node
// Records provider responses as test fixtures (ADR 0006). Run it by hand,
// never in CI, with your own key in the environment:
//
//   ANTHROPIC_API_KEY=… pnpm record-fixtures anthropic
//   MOONSHOT_API_KEY=… pnpm record-fixtures kimi
//
// It sends a fixed, harmless set of prompts with small output budgets, keeps
// only allowlisted headers, replaces request IDs, and refuses to write a file
// if the key, or any 8-character piece of it, appears in it. Read the diff
// before committing: the pre-commit hook also runs the secret scan.

import { writeFileSync } from "node:fs";

const user = (text) => [{ role: "user", content: [{ type: "text", text }] }];
const weatherTool = {
  name: "get_weather",
  description: "Gets the current weather for a city. Use it for any question about the weather.",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "A city, such as Paris" } },
    required: ["location"],
  },
};

/**
 * Each provider: its endpoint, its key's environment variable, how to
 * authenticate, which headers to keep, and its cases. Every case is a fixed,
 * harmless prompt with a small output budget.
 */
const PROVIDERS = {
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    keyVariable: "ANTHROPIC_API_KEY",
    model: process.env.RECORD_MODEL ?? "claude-opus-5-5",
    apiVersion: "2026-10-21",
    requestIdHeader: "request-id",
    headers: (key) => ({
      authorization: `Bearer ${key}`,
      "anthropic-version": "2026-10-21",
      "content-type": "application/json",
      accept: "text/event-stream",
    }),
    cases: {
      text: { max_tokens: 200, messages: user("Say hello in one short sentence.") },
      thinking: {
        max_tokens: 2_000,
        thinking: { type: "adaptive", display: "summarized" },
        messages: user("What is 17 times 23? Answer in one sentence."),
      },
      "tool-call": {
        max_tokens: 300,
        tools: [
          {
            name: weatherTool.name,
            description: weatherTool.description,
            input_schema: weatherTool.parameters,
          },
        ],
        messages: user("What's the weather like in Paris right now?"),
      },
      "max-tokens": { max_tokens: 5, messages: user("Count slowly from one to twenty.") },
      "error-401": { max_tokens: 20, messages: user("Hello."), invalidKey: true },
    },
  },
  kimi: {
    endpoint: "https://api.moonshot.ai/v1/chat/completions",
    keyVariable: "MOONSHOT_API_KEY",
    model: process.env.RECORD_MODEL ?? "kimi-k3.1-pro",
    requestIdHeader: "x-request-id",
    headers: (key) => ({
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    }),
    cases: {
      text: {
        max_completion_tokens: 200,
        stream_options: { include_usage: true },
        messages: user("Say hello in one short sentence."),
      },
      thinking: {
        max_completion_tokens: 2_000,
        stream_options: { include_usage: true },
        messages: user("What is 17 times 23? Answer in one sentence."),
      },
      "tool-call": {
        max_completion_tokens: 300,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: weatherTool }],
        messages: user("What's the weather like in Paris right now?"),
      },
      "error-401": { max_completion_tokens: 20, messages: user("Hello."), invalidKey: true },
    },
  },
};

const INVALID_KEY = "sk-deliberately-invalid-key-for-fixtures";

function fail(message) {
  process.stderr.write(`record-fixtures: ${message}\n`);
  process.exit(1);
}

/** Every 8-character piece of the key: none may appear in a fixture. */
function keyPieces(key) {
  const pieces = new Set();
  for (let start = 0; start + 8 <= key.length; start += 1) {
    pieces.add(key.slice(start, start + 8));
  }
  return pieces;
}

async function record(providerName, config, name, testCase, key, index) {
  const { invalidKey, ...body } = testCase;
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: config.headers(invalidKey ? INVALID_KEY : key),
    body: JSON.stringify({ model: config.model, stream: true, ...body }),
  });
  const placeholder = `req_fixture_${String(index + 1).padStart(4, "0")}`;
  const requestId = response.headers.get(config.requestIdHeader);
  let text = await response.text();
  if (requestId) {
    text = text.replaceAll(requestId, placeholder);
  }
  const headers = ["content-type", "retry-after", config.requestIdHeader].flatMap((header) => {
    const value = response.headers.get(header);
    if (value === null) {
      return [];
    }
    return [`${header}: ${header === config.requestIdHeader ? placeholder : value}`];
  });
  const file = [
    `# provider: ${providerName}`,
    `# endpoint: POST ${config.endpoint}`,
    ...(config.apiVersion ? [`# api-version: ${config.apiVersion}`] : []),
    `# model: ${config.model}`,
    `# date: ${new Date().toISOString().slice(0, 10)}`,
    "# kind: recorded",
    `HTTP/1.1 ${response.status} ${response.statusText}`,
    ...headers,
    "",
    text,
  ].join("\n");
  for (const piece of keyPieces(key)) {
    if (file.includes(piece)) {
      fail(`${name}: the response contains part of the key, so nothing was written.`);
    }
  }
  writeFileSync(new URL(`../test/fixtures/${providerName}/${name}.http`, import.meta.url), file);
  process.stdout.write(`recorded ${providerName}/${name} (${response.status})\n`);
}

const [providerName, ...only] = process.argv.slice(2);
const config = PROVIDERS[providerName];
if (!config) {
  fail(`usage: record-fixtures <${Object.keys(PROVIDERS).join(" | ")}> [case …]`);
}
const key = process.env[config.keyVariable];
if (!key) {
  fail(`set ${config.keyVariable} to record. Nothing was sent.`);
}
const names = only.length > 0 ? only : Object.keys(config.cases);
for (const [index, name] of names.entries()) {
  const testCase = config.cases[name];
  if (!testCase) {
    fail(`unknown case ${name}; cases: ${Object.keys(config.cases).join(", ")}`);
  }
  await record(providerName, config, name, testCase, key, index);
}

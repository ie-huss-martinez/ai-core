#!/usr/bin/env node
// Records provider responses as test fixtures (ADR 0006). Run it by hand,
// never in CI, with your own key in the environment:
//
//   ANTHROPIC_API_KEY=… pnpm record-fixtures anthropic
//
// It sends a fixed, harmless set of prompts with small output budgets, keeps
// only allowlisted headers, replaces request IDs, and refuses to write a file
// if the key, or any 8-character piece of it, appears in it. Read the diff
// before committing: the pre-commit hook also runs the secret scan.

import { writeFileSync } from "node:fs";

const API_VERSION = "2026-10-21";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.RECORD_MODEL ?? "claude-opus-5-5";
const KEEP_HEADERS = ["content-type", "retry-after", "request-id"];

const user = (text) => [{ role: "user", content: [{ type: "text", text }] }];

/** Each case: the fixture's name, the request body, and the key to use. */
const CASES = {
  text: { body: { max_tokens: 200, messages: user("Say hello in one short sentence.") } },
  thinking: {
    body: {
      max_tokens: 2_000,
      thinking: { type: "adaptive", display: "summarized" },
      messages: user("What is 17 times 23? Answer in one sentence."),
    },
  },
  "tool-call": {
    body: {
      max_tokens: 300,
      tools: [
        {
          name: "get_weather",
          description:
            "Gets the current weather for a city. Use it for any question about the weather.",
          input_schema: {
            type: "object",
            properties: { location: { type: "string", description: "A city, such as Paris" } },
            required: ["location"],
          },
        },
      ],
      messages: user("What's the weather like in Paris right now?"),
    },
  },
  "max-tokens": { body: { max_tokens: 5, messages: user("Count slowly from one to twenty.") } },
  "error-401": {
    body: { max_tokens: 20, messages: user("Hello.") },
    key: "sk-ant-deliberately-invalid-key-for-fixtures",
  },
};

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

async function record(name, testCase, key, index) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${testCase.key ?? key}`,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ model: MODEL, stream: true, ...testCase.body }),
  });
  const placeholder = `req_fixture_${String(index + 1).padStart(4, "0")}`;
  const requestId = response.headers.get("request-id");
  let body = await response.text();
  if (requestId) {
    body = body.replaceAll(requestId, placeholder);
  }
  const headers = KEEP_HEADERS.flatMap((header) => {
    const value = response.headers.get(header);
    if (value === null) {
      return [];
    }
    return [`${header}: ${header === "request-id" ? placeholder : value}`];
  });
  const file = [
    "# provider: anthropic",
    `# endpoint: POST ${ENDPOINT}`,
    `# api-version: ${API_VERSION}`,
    `# model: ${MODEL}`,
    `# date: ${new Date().toISOString().slice(0, 10)}`,
    "# kind: recorded",
    `HTTP/1.1 ${response.status} ${response.statusText}`,
    ...headers,
    "",
    body,
  ].join("\n");
  for (const piece of keyPieces(key)) {
    if (file.includes(piece)) {
      fail(`${name}: the response contains part of the key, so nothing was written.`);
    }
  }
  writeFileSync(new URL(`../test/fixtures/anthropic/${name}.http`, import.meta.url), file);
  process.stdout.write(`recorded ${name} (${response.status})\n`);
}

const [provider, ...only] = process.argv.slice(2);
if (provider !== "anthropic") {
  fail("usage: record-fixtures anthropic [case …]");
}
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  fail("set ANTHROPIC_API_KEY to record. Nothing was sent.");
}
const names = only.length > 0 ? only : Object.keys(CASES);
for (const [index, name] of names.entries()) {
  const testCase = CASES[name];
  if (!testCase) {
    fail(`unknown case ${name}; cases: ${Object.keys(CASES).join(", ")}`);
  }
  await record(name, testCase, key, index);
}

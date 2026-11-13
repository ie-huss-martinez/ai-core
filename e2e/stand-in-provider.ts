/**
 * A local stand-in for Anthropic's Messages API, so the example's server
 * calls a real HTTP endpoint without a real key or network (ADR 0006). It
 * answers by the last user message:
 *
 * - "overloaded": 529 with Anthropic's `overloaded_error`;
 * - "slow": a long answer, one piece every 200 ms, to test cancelling;
 * - anything else: a thinking block, then the answer in pieces.
 *
 * `GET /__log` returns what it received, with `authorized` instead of the
 * key, and `POST /__reset` clears it. Only the test runner calls those.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ANSWER_PIECES,
  API_KEY,
  PROVIDER_PORT,
  PROVIDER_URL,
  type ProviderRecord,
  THINKING,
} from "./constants.ts";

const records: ProviderRecord[] = [];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(request: IncomingMessage): Promise<ProviderRecord["body"]> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRecord["body"];
}

function lastUserText(body: ProviderRecord["body"]): string {
  const last = body.messages?.at(-1);
  return JSON.stringify(last?.content ?? "");
}

async function stream(
  response: ServerResponse,
  record: ProviderRecord,
  blocks: readonly { readonly start: object; readonly deltas: readonly object[] }[],
  delay: number,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "request-id": "req_e2e_0001",
  });
  const send = (event: string, data: object) =>
    response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: "msg_e2e_0001",
      type: "message",
      role: "assistant",
      content: [],
      model: record.body.model,
      stop_reason: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  });
  for (const [index, block] of blocks.entries()) {
    send("content_block_start", { index, content_block: block.start });
    for (const delta of block.deltas) {
      if (response.destroyed) {
        return;
      }
      await pause(delay);
      send("content_block_delta", { index, delta });
    }
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } });
  send("message_stop", {});
  response.end();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", PROVIDER_URL);
  if (request.method === "GET" && url.pathname === "/__log") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(records));
    return;
  }
  if (request.method === "POST" && url.pathname === "/__reset") {
    records.length = 0;
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }

  const record: ProviderRecord = {
    authorized: request.headers.authorization === `Bearer ${API_KEY}`,
    anthropicVersion: request.headers["anthropic-version"]?.toString() ?? null,
    body: await readJson(request),
    closedEarly: false,
  };
  records.push(record);
  response.on("close", () => {
    if (!response.writableFinished) {
      record.closedEarly = true;
    }
  });

  const text = lastUserText(record.body);
  if (!record.authorized) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "authentication_error" } }));
  } else if (text.includes("overloaded")) {
    response.writeHead(529, { "content-type": "application/json", "request-id": "req_e2e_0002" });
    response.end(
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    );
  } else if (text.includes("slow")) {
    const pieces = Array.from({ length: 100 }, (_, index) => ({
      type: "text_delta",
      text: `piece ${index + 1}. `,
    }));
    await stream(response, record, [{ start: { type: "text", text: "" }, deltas: pieces }], 200);
  } else {
    await stream(
      response,
      record,
      [
        {
          start: { type: "thinking", thinking: "", signature: "" },
          deltas: [
            { type: "thinking_delta", thinking: THINKING.thinking },
            { type: "signature_delta", signature: THINKING.signature },
          ],
        },
        {
          start: { type: "text", text: "" },
          deltas: ANSWER_PIECES.map((piece) => ({ type: "text_delta", text: piece })),
        },
      ],
      150,
    );
  }
});

server.listen(PROVIDER_PORT, "127.0.0.1");

import { readFileSync } from "node:fs";

/** One recorded or synthetic response, as stored in test/fixtures (ADR 0006). */
export interface Fixture {
  readonly meta: Readonly<Record<string, string>>;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * Reads `test/fixtures/<name>.http`: `#` lines of metadata, the status line,
 * headers, a blank line, then the body exactly as the provider sent it.
 */
export function loadFixture(name: string): Fixture {
  const text = readFileSync(new URL(`../../test/fixtures/${name}.http`, import.meta.url), "utf8");
  const lines = text.split("\n");
  const meta: Record<string, string> = {};
  let line = 0;
  for (; lines[line]?.startsWith("#"); line += 1) {
    const [key, ...rest] = (lines[line] ?? "").slice(1).split(":");
    meta[(key ?? "").trim()] = rest.join(":").trim();
  }
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[line] ?? "")?.[1]);
  line += 1;
  const headers: Record<string, string> = {};
  for (; (lines[line] ?? "") !== ""; line += 1) {
    const [key, ...rest] = (lines[line] ?? "").split(":");
    headers[(key ?? "").trim().toLowerCase()] = rest.join(":").trim();
  }
  const body = lines.slice(line + 1).join("\n");
  return { meta, status, headers, body: new TextEncoder().encode(body) };
}

/** How the fake splits a body into chunks: as recorded bodies keep no chunk boundaries. */
export type Chunking = "whole" | "bytes" | number;

export interface FixtureFetchOptions {
  readonly chunking?: Chunking;
  /** After the body, wait until the request is aborted instead of ending. */
  readonly hang?: boolean;
  /** Cut the body to this many bytes, as a dropped connection would. */
  readonly truncateAt?: number;
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function chunksOf(body: Uint8Array, chunking: Chunking): Uint8Array[] {
  if (chunking === "whole") {
    return [body];
  }
  const size = chunking === "bytes" ? 1 : chunking;
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < body.length; start += size) {
    chunks.push(body.subarray(start, start + size));
  }
  return chunks;
}

/**
 * A `fetch` that answers every request with a fixture, records the requests
 * it receives, and honours the request's signal, as a real one would.
 */
export function fixtureFetch(fixture: Fixture, options: FixtureFetchOptions = {}) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const body =
      options.truncateAt === undefined
        ? fixture.body
        : fixture.body.subarray(0, options.truncateAt);
    const chunks = chunksOf(body, options.chunking ?? "whole");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
      async pull(controller) {
        const next = chunks.shift();
        if (next) {
          controller.enqueue(next);
          return;
        }
        if (options.hang && !signal?.aborted) {
          await new Promise((resolve) =>
            signal?.addEventListener("abort", resolve, { once: true }),
          );
          return;
        }
        controller.close();
      },
    });
    return new Response(stream, { status: fixture.status, headers: fixture.headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

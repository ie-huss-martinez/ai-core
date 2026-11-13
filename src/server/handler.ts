import { serializeError } from "@hussmartinez/sdk-core";
import { AiError, isAiError } from "../core/errors/ai-error.js";
import { type RequestLimitOverrides, requestLimits } from "../core/limits/ai-limits.js";
import type { AiMessage, AiProviderStatePart } from "../core/model/message.js";
import type {
  AiEvent,
  AiProvider,
  AiRequest,
  AiTool,
  AiToolChoice,
} from "../core/model/provider.js";
import { AI_CORE, AI_CORE_PROTOCOL, decodeMessages, encodePart } from "../core/protocol/wire.js";
import type { AiLimitWarning } from "../core/stream/call-guard.js";
import { contextHash } from "./context-hash.js";
import { readBody } from "./read-body.js";

/**
 * The body the browser sends, once the handler has checked it (ADR 0003):
 * the protocol version and the conversation, and nothing else.
 *
 * @public
 */
export interface AiHandlerBody {
  /** The protocol version, which is always `"ai-core/1"` here. */
  readonly protocol: "ai-core/1";
  /** The conversation, checked against the message model, with images as bytes. */
  readonly messages: readonly AiMessage[];
}

/**
 * What `prepare` receives for each request.
 *
 * @public
 */
export interface AiPrepareContext {
  /** The incoming request, for its headers, cookies and signal. Its body is already read. */
  readonly request: Request;
  /** The checked body. */
  readonly body: AiHandlerBody;
  /** The request's `Origin` header, or `null` when it has none. */
  readonly origin: string | null;
}

/**
 * The settings `prepare` returns for a call: everything but the
 * conversation, chosen on the server (ADR 0003).
 *
 * @public
 */
export interface AiCallSettings {
  /** The output budget. Required, so the server always sets it. */
  readonly maxOutputTokens: number;
  /** The model, instead of the provider's default. */
  readonly model?: string;
  /**
   * The system prompt. Keep it the same for a whole conversation, and keep
   * volatile data such as the date in messages instead: a change fails the
   * next call with `CONTEXT_CHANGED`. Don't put secrets in it, because a
   * model can be asked to repeat it.
   */
  readonly system?: string;
  /** Tools the model may call. Keep them the same for a whole conversation. */
  readonly tools?: readonly AiTool[];
  /** Whether the model may call tools: `"auto"`, the default, or `"none"`. */
  readonly toolChoice?: AiToolChoice;
  /** Options for one provider, keyed by its name (ADR 0002). */
  readonly providerOptions?: { readonly [provider: string]: unknown };
}

/**
 * Options for {@link createAiHandler}.
 *
 * @public
 */
export interface AiHandlerOptions {
  /** The provider that answers, such as an adapter created on the server. */
  readonly provider: AiProvider;
  /**
   * Runs for every valid request, before anything is sent to the provider.
   * Authenticate and rate-limit the caller here, and return a `Response`,
   * such as a 401 or a 429, to reject the call; the handler returns it
   * unchanged. Otherwise return the call's settings.
   *
   * If it throws, the handler answers 500 with `PREPARE_FAILED`, and the
   * thrown error is never sent or logged.
   */
  readonly prepare: (
    context: AiPrepareContext,
  ) => AiCallSettings | Response | Promise<AiCallSettings | Response>;
  /** The request limit, instead of the default 8 MB (ADR 0005). */
  readonly limits?: RequestLimitOverrides;
  /**
   * When set, only requests whose `Origin` is in this list are accepted,
   * such as `["https://app.example.com"]`. Others, including requests with
   * no `Origin`, get 403 with `ORIGIN_NOT_ALLOWED` before `prepare` runs.
   */
  readonly allowedOrigins?: readonly string[];
  /** Called at most once per request, before the request limit is reached. Never with content. */
  readonly onWarning?: (warning: AiLimitWarning) => void;
}

/** The status of each error the handler answers with before the stream. */
const STATUS: Partial<Record<string, number>> = {
  INVALID_REQUEST: 400,
  PROTOCOL_MISMATCH: 400,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  CONTEXT_CHANGED: 409,
  REQUEST_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

const EVENT_TYPES: ReadonlySet<string> = new Set(["text-delta", "summary-delta", "part", "finish"]);

const SETTINGS = [
  "maxOutputTokens",
  "model",
  "system",
  "tools",
  "toolChoice",
  "providerOptions",
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(code: ConstructorParameters<typeof AiError>[0], message: string): AiError {
  return new AiError(code, message, { details: { retryable: false } });
}

/**
 * An error as sent to the browser: an `AiError` without its cause, which
 * may hold server-side details, and anything else as a plain failure.
 */
function wireError(error: unknown) {
  return serializeError(isAiError(error) ? error : new AiError("UNKNOWN", "The AI call failed."), {
    maxDepth: 0,
  });
}

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function errorResponse(error: AiError, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: wireError(error) }), {
    status: STATUS[error.code] ?? 500,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function checkConfiguration(options: AiHandlerOptions): void {
  if (!isObject(options)) {
    throw fail("INVALID_CONFIGURATION", "createAiHandler needs options.");
  }
  if (typeof options.prepare !== "function") {
    throw fail(
      "INVALID_CONFIGURATION",
      "createAiHandler needs prepare, which authenticates callers and sets each call's model and budget.",
    );
  }
  if (!isObject(options.provider) || typeof options.provider.stream !== "function") {
    throw fail("INVALID_CONFIGURATION", "createAiHandler needs a provider.");
  }
  if (options.allowedOrigins !== undefined) {
    if (!Array.isArray(options.allowedOrigins)) {
      throw fail("INVALID_CONFIGURATION", "allowedOrigins must be a list of origins.");
    }
    for (const origin of options.allowedOrigins) {
      let parsed: string | undefined;
      try {
        parsed = new URL(String(origin)).origin;
      } catch {
        parsed = undefined;
      }
      if (parsed !== origin) {
        throw fail(
          "INVALID_CONFIGURATION",
          "Each allowed origin must be a scheme, host and optional port, such as https://app.example.com, with no path or trailing slash.",
        );
      }
    }
  }
  for (const [feature, present] of [
    ["crypto.subtle", typeof globalThis.crypto?.subtle?.digest === "function"],
    ["ReadableStream", typeof ReadableStream === "function"],
    ["Response", typeof Response === "function"],
    ["AbortSignal.any", typeof AbortSignal.any === "function"],
  ] as const) {
    if (!present) {
      throw new AiError("UNSUPPORTED_ENVIRONMENT", `The request handler needs ${feature}.`, {
        details: { feature, retryable: false },
      });
    }
  }
}

function isJson(request: Request): boolean {
  const type = request.headers.get("content-type");
  return type?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function checkBody(value: unknown): AiHandlerBody {
  if (!isObject(value)) {
    throw fail("INVALID_REQUEST", "The body must be a JSON object.");
  }
  const protocol = value["protocol"];
  if (typeof protocol !== "string") {
    throw fail("INVALID_REQUEST", "The body has no protocol.");
  }
  if (protocol !== AI_CORE_PROTOCOL) {
    throw new AiError("PROTOCOL_MISMATCH", "The handler doesn't speak this protocol version.", {
      details: { supported: [AI_CORE_PROTOCOL], retryable: false },
    });
  }
  for (const key of Object.keys(value)) {
    if (key !== "protocol" && key !== "messages") {
      const named = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key);
      throw new AiError(
        "INVALID_REQUEST",
        `The body has ${named ? `"${key}"` : "a field"} besides protocol and messages. The server sets everything else, in prepare.`,
        { details: { ...(named ? { path: key } : {}), retryable: false } },
      );
    }
  }
  return { protocol: AI_CORE_PROTOCOL, messages: decodeMessages(value["messages"]) };
}

/** Checks prepare's settings, naming the first invalid one but never its value. */
function checkSettings(value: unknown): AiCallSettings {
  const invalid = (what: string) =>
    fail("PREPARE_FAILED", `prepare returned ${what}. See AiCallSettings.`);
  if (!isObject(value)) {
    throw invalid("neither a Response nor settings");
  }
  for (const key of Object.keys(value)) {
    if (!(SETTINGS as readonly string[]).includes(key)) {
      throw invalid("a setting the handler doesn't know");
    }
  }
  const { maxOutputTokens, model, system, tools, toolChoice, providerOptions } = value;
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1
  ) {
    throw invalid("no maxOutputTokens, or one that isn't a positive whole number");
  }
  if (model !== undefined && (typeof model !== "string" || model === "")) {
    throw invalid("a model that isn't a non-empty string");
  }
  if (system !== undefined && typeof system !== "string") {
    throw invalid("a system prompt that isn't a string");
  }
  if (
    tools !== undefined &&
    (!Array.isArray(tools) ||
      !tools.every(
        (tool) =>
          isObject(tool) &&
          typeof tool["name"] === "string" &&
          (tool["description"] === undefined || typeof tool["description"] === "string") &&
          "inputSchema" in tool,
      ))
  ) {
    throw invalid("tools that aren't a list of AiTool");
  }
  if (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none") {
    throw invalid('a toolChoice other than "auto" or "none"');
  }
  if (providerOptions !== undefined && !isObject(providerOptions)) {
    throw invalid("providerOptions that aren't an object");
  }
  return value as unknown as AiCallSettings;
}

/**
 * Compares every context part in the history with the current hash, and
 * returns the history without them: the provider never sees them.
 */
function checkContext(messages: readonly AiMessage[], hash: string): AiMessage[] {
  const kept: AiMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const parts = message.parts.filter((part) => {
      if (part.type !== "provider-state" || part.provider !== AI_CORE) {
        return true;
      }
      const context = isObject(part.data) ? part.data["context"] : undefined;
      if (typeof context !== "string") {
        throw new AiError("INVALID_REQUEST", "An ai-core state part has no context hash.", {
          details: { path: `messages[${index}]`, retryable: false },
        });
      }
      if (context !== hash) {
        throw new AiError(
          "CONTEXT_CHANGED",
          "The system prompt or tools changed since this conversation started. Start a new conversation, or continue with withoutProviderState(messages).",
          { details: { messageIndex: index, retryable: false } },
        );
      }
      return false;
    });
    if (parts.length > 0) {
      kept.push({ role: message.role, parts });
    }
  }
  return kept;
}

const encoder = /* @__PURE__ */ new TextEncoder();

function frame(type: string, data: unknown): Uint8Array {
  // JSON.stringify escapes line breaks, so data stays on one line.
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventData(event: AiEvent): unknown {
  switch (event.type) {
    case "part":
      return { part: encodePart(event.part) };
    case "finish":
      return {
        finishReason: event.finishReason,
        ...(event.rawFinishReason === undefined ? {} : { rawFinishReason: event.rawFinishReason }),
        usage: event.usage,
      };
    default:
      return { text: event.text };
  }
}

function streamResponse(
  provider: AiProvider,
  call: AiRequest,
  contextPart: AiProviderStatePart,
  requestSignal: AbortSignal,
): Response {
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal]);
  let iterator: AsyncIterator<AiEvent> | undefined;
  let open = true;

  const end = (stream: ReadableStreamDefaultController<Uint8Array>, error?: unknown): void => {
    if (!open) {
      return;
    }
    open = false;
    if (error !== undefined) {
      stream.enqueue(frame("error", wireError(error)));
    }
    stream.close();
    void iterator?.return?.()?.catch(() => undefined);
  };

  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(frame("start", { protocol: AI_CORE_PROTOCOL }));
      stream.enqueue(frame("part", { part: contextPart }));
    },
    async pull(stream) {
      try {
        iterator ??= provider.stream(call, { signal })[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          if (!open) {
            return;
          }
          if (next.done) {
            end(
              stream,
              fail(
                "PROVIDER_RESPONSE_INVALID",
                "The provider's stream ended without a finish event.",
              ),
            );
            return;
          }
          const event = next.value;
          if (typeof event !== "object" || event === null || !EVENT_TYPES.has(event.type)) {
            end(stream, fail("PROVIDER_RESPONSE_INVALID", "The provider sent an unknown event."));
            return;
          }
          // The handler owns ai-core's state: a provider's, such as another
          // handler's context part through a transport, isn't passed on.
          if (
            event.type === "part" &&
            event.part.type === "provider-state" &&
            event.part.provider === AI_CORE
          ) {
            continue;
          }
          stream.enqueue(frame(event.type, eventData(event)));
          if (event.type === "finish") {
            end(stream);
          }
          return;
        }
      } catch (error) {
        end(stream, error);
      }
    },
    cancel() {
      open = false;
      controller.abort();
      void iterator?.return?.()?.catch(() => undefined);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      "cache-control": "no-store, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

/**
 * Creates the server endpoint that the browser transport calls (ADR 0003).
 * It returns a `(request: Request) => Promise<Response>` function, for
 * Next.js route handlers, Hono, Node, Deno, Bun and Workers.
 *
 * For each request, it:
 *
 * 1. accepts only `POST` (405) with `content-type: application/json` (415),
 *    from an allowed origin when `allowedOrigins` is set (403), within the
 *    `requestBytes` limit (413);
 * 2. accepts only `{ protocol: "ai-core/1", messages }` (400);
 * 3. runs `prepare`, which may reject the call with its own `Response`;
 * 4. checks that the system prompt and tools haven't changed during the
 *    conversation (409 `CONTEXT_CHANGED`);
 * 5. streams the provider's events as `ai-core/1` server-sent events.
 *
 * It never logs, and never adds CORS headers: don't add permissive ones.
 *
 * @example
 * ```ts
 * import { createAnthropic } from "@hussmartinez/ai-core/anthropic";
 * import { createAiHandler } from "@hussmartinez/ai-core/server";
 *
 * export const POST = createAiHandler({
 *   provider: createAnthropic({ apiKey: () => process.env.ANTHROPIC_API_KEY ?? "", model: "claude-sonnet-5-5" }),
 *   async prepare({ request }) {
 *     const user = await authenticate(request);
 *     if (!user) {
 *       return new Response(null, { status: 401 });
 *     }
 *     return { system: "You are a helpful assistant.", maxOutputTokens: 2_000 };
 *   },
 * });
 * ```
 *
 * @throws An `AiError`: `INVALID_CONFIGURATION` without `prepare` or a
 *   provider, or with an invalid `allowedOrigins`, and
 *   `UNSUPPORTED_ENVIRONMENT` without Web Crypto or web streams; `TypeError`
 *   for unknown `limits`.
 * @public
 */
export function createAiHandler(
  options: AiHandlerOptions,
): (request: Request) => Promise<Response> {
  checkConfiguration(options);
  const { provider, prepare, onWarning } = options;
  const policy = requestLimits.resolve(options.limits);
  const allowedOrigins = options.allowedOrigins ? new Set(options.allowedOrigins) : undefined;

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") {
        return errorResponse(fail("METHOD_NOT_ALLOWED", "The handler accepts only POST."), {
          allow: "POST",
        });
      }
      const origin = request.headers.get("origin");
      if (allowedOrigins && (origin === null || !allowedOrigins.has(origin))) {
        return errorResponse(fail("ORIGIN_NOT_ALLOWED", "This origin isn't allowed."));
      }
      if (!isJson(request)) {
        return errorResponse(
          fail(
            "UNSUPPORTED_MEDIA_TYPE",
            "The handler accepts only content-type: application/json.",
          ),
        );
      }
      const text = await readBody(request, policy, onWarning);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The parser's message quotes the body, so it isn't kept.
        throw fail("INVALID_REQUEST", "The body isn't valid JSON.");
      }
      const body = checkBody(parsed);

      let prepared: unknown;
      try {
        prepared = await prepare({ request, body, origin });
      } catch {
        // The host's error is never sent or logged (ADR 0003).
        throw fail("PREPARE_FAILED", "prepare threw an error.");
      }
      if (prepared instanceof Response) {
        return prepared;
      }
      const settings = checkSettings(prepared);

      const hash = await contextHash(settings.system, settings.tools);
      const messages = checkContext(body.messages, hash);
      if (messages.length === 0) {
        throw fail(
          "INVALID_REQUEST",
          "A request needs at least one message besides ai-core's state.",
        );
      }
      const call: AiRequest = {
        messages,
        maxOutputTokens: settings.maxOutputTokens,
        ...(settings.model === undefined ? {} : { model: settings.model }),
        ...(settings.system === undefined ? {} : { system: settings.system }),
        ...(settings.tools === undefined ? {} : { tools: settings.tools }),
        ...(settings.toolChoice === undefined ? {} : { toolChoice: settings.toolChoice }),
        ...(settings.providerOptions === undefined
          ? {}
          : { providerOptions: settings.providerOptions }),
      };
      return streamResponse(
        provider,
        call,
        { type: "provider-state", provider: AI_CORE, data: { context: hash } },
        request.signal,
      );
    } catch (error) {
      return errorResponse(
        isAiError(error) ? error : new AiError("UNKNOWN", "The AI call failed."),
      );
    }
  };
}

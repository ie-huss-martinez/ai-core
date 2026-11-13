import {
  defineLimits,
  type FilePolicy,
  type FilePolicyOverrides,
  type Limits,
} from "@hussmartinez/sdk-core";
import { AiError } from "../errors/ai-error.js";

/**
 * The limits on responses that adapters and the transport read (ADR 0005).
 *
 * | Limit | Code | Default maximum | Default warning |
 * |---|---|---|---|
 * | `responseBytes` | `RESPONSE_TOO_LARGE` | 16 MB | 8 MB |
 * | `streamDuration` | `STREAM_TIMEOUT` | 15 minutes | 10 minutes |
 * | `idleTime` | `STREAM_IDLE` | 2 minutes | none |
 *
 * `responseBytes` counts a response body's raw bytes as they arrive, before
 * decoding. `streamDuration` runs from sending the request to the end of the
 * body. `idleTime` is the longest gap between two chunks, including the wait
 * for the first. Sizes are decimal: 1 MB is 1,000,000 bytes.
 *
 * @public
 */
export const responseLimitDefinitions = {
  responseBytes: {
    code: "RESPONSE_TOO_LARGE",
    unit: "bytes",
    default: 16_000_000,
    warning: 8_000_000,
  },
  streamDuration: {
    code: "STREAM_TIMEOUT",
    unit: "milliseconds",
    default: 15 * 60 * 1_000,
    warning: 10 * 60 * 1_000,
  },
  idleTime: { code: "STREAM_IDLE", unit: "milliseconds", default: 2 * 60 * 1_000 },
} as const;

/**
 * The limit on requests that the request handler accepts (ADR 0005).
 *
 * | Limit | Code | Default maximum | Default warning |
 * |---|---|---|---|
 * | `requestBytes` | `REQUEST_TOO_LARGE` | 8 MB | 4 MB |
 *
 * The handler checks `content-length` first, then counts bytes while reading
 * the body.
 *
 * @public
 */
export const requestLimitDefinitions = {
  requestBytes: {
    code: "REQUEST_TOO_LARGE",
    unit: "bytes",
    default: 8_000_000,
    warning: 4_000_000,
  },
} as const;

/**
 * The type of {@link responseLimitDefinitions}.
 *
 * @public
 */
export type ResponseLimitDefinitions = typeof responseLimitDefinitions;

/**
 * The type of {@link requestLimitDefinitions}.
 *
 * @public
 */
export type RequestLimitDefinitions = typeof requestLimitDefinitions;

/**
 * The names of every ai-core limit.
 *
 * @public
 */
export type AiLimitName = keyof ResponseLimitDefinitions | keyof RequestLimitDefinitions;

/**
 * A host's `limits` for adapters and the transport: a new maximum, or
 * `{ maximum, warning }`, for any response limit. `Infinity` disables a
 * maximum, which removes a protection against hostile responses, or disables
 * a warning. Unknown names, including `requestBytes`, throw `TypeError`.
 *
 * @example
 * ```ts
 * // Long reasoning turns: allow 30 minutes per stream.
 * const limits: ResponseLimitOverrides = { streamDuration: 30 * 60 * 1_000 };
 * ```
 *
 * @public
 */
export type ResponseLimitOverrides = FilePolicyOverrides<ResponseLimitDefinitions>;

/**
 * A host's `limits` for the request handler. Unknown names, including the
 * response limits, throw `TypeError`.
 *
 * @public
 */
export type RequestLimitOverrides = FilePolicyOverrides<RequestLimitDefinitions>;

/**
 * Resolved response limits. Violations throw {@link AiError}.
 *
 * @public
 */
export type ResponsePolicy = FilePolicy<ResponseLimitDefinitions>;

/**
 * Resolved request limits. Violations throw {@link AiError}.
 *
 * @public
 */
export type RequestPolicy = FilePolicy<RequestLimitDefinitions>;

/**
 * The response limits, ready to resolve a host's `limits`. Violations are
 * thrown as {@link AiError}, with `details` naming the limit.
 *
 * @example
 * ```ts
 * const policy = responseLimits.resolve(options.limits);
 * policy.check("responseBytes", bytesRead); // throws AiError("RESPONSE_TOO_LARGE") above 16 MB
 * ```
 *
 * @public
 */
export const responseLimits: Limits<ResponseLimitDefinitions> = /* @__PURE__ */ defineLimits(
  responseLimitDefinitions,
  { errorClass: AiError },
);

/**
 * The request limits, ready to resolve a host's `limits` for the handler.
 *
 * @public
 */
export const requestLimits: Limits<RequestLimitDefinitions> = /* @__PURE__ */ defineLimits(
  requestLimitDefinitions,
  { errorClass: AiError },
);

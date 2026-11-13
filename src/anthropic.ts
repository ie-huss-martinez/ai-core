/**
 * Anthropic adapter for the Claude Messages API.
 *
 * @remarks
 * Keys stay on the server by default: outside a recognised server runtime it
 * refuses to run unless the host passes `dangerouslyAllowBrowser: true`
 * (ADR 0004). It speaks API version `2026-10-21`, streams every call, and
 * never retries (ADR 0007).
 *
 * @packageDocumentation
 */

export type { AnthropicOptions } from "./adapters/anthropic/anthropic.js";
export { createAnthropic } from "./adapters/anthropic/anthropic.js";
export type { AiLimitWarning } from "./core/stream/call-guard.js";

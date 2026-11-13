/**
 * Adapter for OpenAI-compatible Chat Completions APIs, with a Kimi preset.
 *
 * @remarks
 * Keys stay on the server by default: outside a recognised server runtime it
 * refuses to run unless the host passes `dangerouslyAllowBrowser: true`
 * (ADR 0004). It streams every call with usage, and never retries (ADR 0007).
 *
 * @packageDocumentation
 */

export type {
  KimiOptions,
  OpenAICompatibleOptions,
} from "./adapters/openai-compatible/openai-compatible.js";
export {
  createKimi,
  createOpenAICompatible,
} from "./adapters/openai-compatible/openai-compatible.js";
export type { AiLimitWarning } from "./core/stream/call-guard.js";

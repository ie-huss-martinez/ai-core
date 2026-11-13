/**
 * Google Gemini adapter, through the Interactions API.
 *
 * @remarks
 * Stateless: it sends the full history every call and always sets
 * `store: false`, so Google keeps no copy of the conversation (ADR 0008).
 * Keys stay on the server by default: outside a recognised server runtime it
 * refuses to run unless the host passes `dangerouslyAllowBrowser: true`
 * (ADR 0004). It never retries (ADR 0007).
 *
 * @packageDocumentation
 */

export type { GeminiOptions } from "./adapters/gemini/gemini.js";
export { createGemini } from "./adapters/gemini/gemini.js";
export type { AiLimitWarning } from "./core/stream/call-guard.js";

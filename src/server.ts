/**
 * Server request handler: `createAiHandler`, the endpoint the browser
 * transport calls, with a required `prepare` hook (ADR 0003).
 *
 * @remarks
 * Runs in runtimes with the Fetch API, web streams and Web Crypto, such as
 * Next.js route handlers, Node, Deno, Bun and Workers.
 *
 * @packageDocumentation
 */

export type {
  AiCallSettings,
  AiHandlerBody,
  AiHandlerOptions,
  AiPrepareContext,
} from "./server/handler.js";
export { createAiHandler } from "./server/handler.js";

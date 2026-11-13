import { AiError } from "../errors/ai-error.js";

/**
 * The globals runtime detection reads. Tests pass their own; adapters use
 * `globalThis`.
 *
 * @internal
 */
export type RuntimeGlobals = Readonly<Record<string, unknown>>;

/**
 * Whether code runs in a runtime recognised as a server (ADR 0004). All three
 * must hold:
 *
 * 1. there's no page: no `document`;
 * 2. there's no browser worker: `importScripts` isn't a function;
 * 3. the runtime is positively recognised: Node's or Bun's real `process`
 *    (`[object process]`, which a bundler's shim isn't), Deno (`Deno.build`),
 *    Vercel and Next.js Edge (`EdgeRuntime`), or Cloudflare Workers
 *    (`navigator.userAgent === "Cloudflare-Workers"`).
 *
 * Anything else, including a runtime it doesn't recognise, isn't a server.
 *
 * @param globals - The global scope to inspect.
 * @internal
 */
export function isRecognisedServer(globals: RuntimeGlobals = globalThis): boolean {
  if (globals["document"] !== undefined) {
    return false;
  }
  if (typeof globals["importScripts"] === "function") {
    return false;
  }
  const deno = globals["Deno"] as { readonly build?: unknown } | undefined;
  const navigator = globals["navigator"] as { readonly userAgent?: unknown } | undefined;
  return (
    Object.prototype.toString.call(globals["process"]) === "[object process]" ||
    (typeof deno === "object" && deno !== null && typeof deno.build === "object") ||
    globals["EdgeRuntime"] !== undefined ||
    navigator?.userAgent === "Cloudflare-Workers"
  );
}

/**
 * Throws `BROWSER_KEY_REFUSED` unless code runs on a recognised server, or the
 * host opted in to browser keys (ADR 0004). Adapters call it when they're
 * created and before every request.
 *
 * @param dangerouslyAllowBrowser - The host's explicit opt-in.
 * @param globals - The global scope to inspect.
 * @internal
 */
export function assertKeyMayBeUsed(
  dangerouslyAllowBrowser: boolean | undefined,
  globals: RuntimeGlobals = globalThis,
): void {
  if (dangerouslyAllowBrowser === true || isRecognisedServer(globals)) {
    return;
  }
  throw new AiError(
    "BROWSER_KEY_REFUSED",
    "This adapter holds an API key, and this doesn't look like a server, so it refuses to run: " +
      "in a browser, every visitor could read the key. Call the provider from your server with " +
      "createAiHandler, and use httpTransport in the browser. If users bring their own keys and " +
      "you understand the risk, pass dangerouslyAllowBrowser: true.",
  );
}

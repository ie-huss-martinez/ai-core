import { describe, expect, it } from "vitest";
import { isAiError } from "../errors/ai-error.js";
import { assertKeyMayBeUsed, isRecognisedServer } from "./server-runtime.js";

/** The globals of each runtime, as far as detection reads them (ADR 0004). */
const runtimes = {
  "Node (this test run)": globalThis,
  Bun: { process: globalThis.process, Bun: {} },
  Deno: { Deno: { build: { os: "linux" } }, navigator: { userAgent: "Deno/2.5.0" } },
  "Vercel and Next.js Edge": { EdgeRuntime: "edge-runtime" },
  "Cloudflare Workers": { navigator: { userAgent: "Cloudflare-Workers" } },
};

const notServers = {
  "a page": { document: {}, window: {}, navigator: { userAgent: "Mozilla/5.0" } },
  "a dedicated or module worker": {
    importScripts: () => undefined,
    navigator: { userAgent: "Mozilla/5.0" },
  },
  "jsdom in Node": { document: {}, process: globalThis.process },
  "a worker with a bundler's process shim": {
    importScripts: () => undefined,
    process: { env: { NODE_ENV: "production" } },
  },
  "a bundler's process shim alone": { process: { env: {}, browser: true } },
  "a runtime it doesn't recognise": { navigator: { userAgent: "SomeRuntime/1.0" } },
  "Workers with a document": { document: {}, navigator: { userAgent: "Cloudflare-Workers" } },
};

describe("isRecognisedServer (ADR 0004)", () => {
  it.each(Object.entries(runtimes))("recognises %s", (_, globals) => {
    expect(isRecognisedServer(globals)).toBe(true);
  });

  it.each(Object.entries(notServers))("doesn't treat %s as a server", (_, globals) => {
    expect(isRecognisedServer(globals)).toBe(false);
  });
});

describe("assertKeyMayBeUsed", () => {
  it("allows a recognised server", () => {
    expect(() => assertKeyMayBeUsed(undefined)).not.toThrow();
  });

  it("refuses anywhere else with BROWSER_KEY_REFUSED, explaining the opt-in", () => {
    let error: unknown;
    try {
      assertKeyMayBeUsed(undefined, notServers["a page"]);
    } catch (caught) {
      error = caught;
    }
    expect(isAiError(error, "BROWSER_KEY_REFUSED")).toBe(true);
    expect((error as Error).message).toContain("dangerouslyAllowBrowser: true");
  });

  it("allows anything with the host's explicit opt-in, and nothing less", () => {
    expect(() => assertKeyMayBeUsed(true, notServers["a page"])).not.toThrow();
    expect(() => assertKeyMayBeUsed(false, notServers["a page"])).toThrow();
  });
});

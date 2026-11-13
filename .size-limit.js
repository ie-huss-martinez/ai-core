/**
 * Size budgets per entry point (ADR 0015): the brotli size of each built
 * entry, with the shared chunks it loads. They measure the unminified files in
 * dist, an upper bound: applications ship less, because their bundler
 * minifies and drops what they don't import.
 *
 * These are starting ceilings. Each adapter is its own entry, so a host pays
 * only for the providers it uses, and the package has no runtime dependency
 * but sdk-core. The feature pull requests revisit these against real sizes.
 *
 * Adapters: revisited with the first one. The Anthropic adapter measures
 * 8.05 kB, unminified, with the stream parser, call guard and reader it
 * loads, which every adapter shares. 10 kB leaves room for the second and
 * third adapters without letting one grow unnoticed.
 *
 * Server handler: revisited with the handler. It measures 6.6 kB, unminified:
 * the handler itself is 3.9 kB, and the strict message decoder it loads is
 * 1.8 kB, which the browser transport will share. 8 kB leaves room for
 * fixes, not for a second feature.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * The built files an entry loads: the entry, and every chunk it imports,
 * directly or through other chunks. Counting only these, rather than every
 * shared chunk, keeps one entry's budget from paying for code that only
 * other entries load, such as the adapters' stream code in the core's.
 */
function loadedFiles(file) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path) || !existsSync(path)) {
      return;
    }
    seen.add(path);
    const code = readFileSync(path, "utf8");
    for (const [, specifier] of code.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.js)"/g)) {
      visit(normalize(join(dirname(path), specifier)));
    }
  };
  visit(join("dist", file));
  return [...seen];
}

const entry = (name, file, limit) => ({
  name: `${name}, with the shared code it loads`,
  path: loadedFiles(file),
  brotli: true,
  limit,
});

export default [
  entry("Core and browser transport (.)", "index.js", "8 kB"),
  entry("Server request handler (./server)", "server.js", "8 kB"),
  entry("Anthropic adapter (./anthropic)", "anthropic.js", "10 kB"),
  entry("Gemini adapter (./gemini)", "gemini.js", "10 kB"),
  entry(
    "OpenAI-compatible adapter and Kimi preset (./openai-compatible)",
    "openai-compatible.js",
    "10 kB",
  ),
  entry("Contract-test suite and fake provider (./testing)", "testing.js", "10 kB"),
];

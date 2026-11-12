/**
 * Size budgets per entry point (ADR 0015): the brotli size of each built
 * entry, with the shared chunks it loads. They measure the unminified files in
 * dist, an upper bound: applications ship less, because their bundler
 * minifies and drops what they don't import.
 *
 * These are starting ceilings. Each adapter is its own entry, so a host pays
 * only for the providers it uses, and the package has no runtime dependency
 * but sdk-core. The feature pull requests revisit these against real sizes.
 */
const entry = (name, file, limit) => ({
  name: `${name}, with the shared code it loads`,
  path: [`dist/${file}`, "dist/shared/*.js"],
  brotli: true,
  limit,
});

export default [
  entry("Core and browser transport (.)", "index.js", "8 kB"),
  entry("Server request handler (./server)", "server.js", "6 kB"),
  entry("Anthropic adapter (./anthropic)", "anthropic.js", "6 kB"),
  entry("Gemini adapter (./gemini)", "gemini.js", "6 kB"),
  entry(
    "OpenAI-compatible adapter and Kimi preset (./openai-compatible)",
    "openai-compatible.js",
    "6 kB",
  ),
  entry("Contract-test suite and fake provider (./testing)", "testing.js", "10 kB"),
];

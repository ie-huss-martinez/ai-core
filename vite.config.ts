import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const manifest = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/**
 * Dependencies and peer dependencies stay imports, never bundled: a page that
 * also uses other packages of the family then loads one copy of each.
 * Subpaths count too.
 */
export const externalPackages = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
];
const isExternal = (id: string): boolean =>
  externalPackages.some((name) => id === name || id.startsWith(`${name}/`));

/**
 * One built file per public entry point (ADR 0004). Each adapter has its own
 * entry, so a host bundles only the providers it uses.
 */
export const entries = {
  index: "src/index.ts",
  server: "src/server.ts",
  anthropic: "src/anthropic.ts",
  gemini: "src/gemini.ts",
  "openai-compatible": "src/openai-compatible.ts",
  testing: "src/testing.ts",
} as const;

// Library build: unminified ES modules with source maps, so that consumers'
// bundlers can tree-shake and minify them. There is no CSS: ai-core renders
// nothing.
export default defineConfig({
  build: {
    lib: {
      entry: entries,
      formats: ["es"],
    },
    target: "es2022",
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      external: isExternal,
      output: {
        // Code shared by several entries goes here, so the size budgets can
        // count it with each entry that loads it.
        chunkFileNames: "shared/[name]-[hash].js",
        // TSDoc reaches users through the .d.ts files and the source maps, so
        // the JavaScript keeps only legal and @__PURE__ annotation comments.
        comments: { legal: true, annotation: true, jsdoc: false },
      },
    },
  },
});

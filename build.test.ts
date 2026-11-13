import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Rolldown } from "vite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { entries, externalPackages } from "./vite.config.js";

/**
 * Builds the package in memory with its real Vite config, so these checks see
 * exactly what dist/ would contain without writing to it.
 */
async function buildInMemory(): Promise<Array<Rolldown.OutputChunk | Rolldown.OutputAsset>> {
  const result = await build({
    configFile: new URL("vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) => ("output" in output ? output.output : []));
}

const files = await buildInMemory();
const entryFiles = Object.keys(entries).map((name) => `${name}.js`);

describe("the built package", () => {
  it.each(entryFiles)("builds %s as a JavaScript entry", (fileName) => {
    const found = files.find((file) => file.fileName === fileName);
    expect(found?.type).toBe("chunk");
  });

  it("exports exactly the built entries and the format schemas, types first (ADR 0004)", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      exports: Record<string, string | { types: string; default: string }>;
    };
    const subpath = (name: string): string => (name === "index" ? "." : `./${name}`);
    const expected = Object.fromEntries(
      Object.keys(entries).map((name) => [
        subpath(name),
        { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` },
      ]),
    );
    expect(manifest.exports).toEqual({
      ...expected,
      // The JSON Schemas of ai-core's formats ship as they are (sdk-core ADR 0045).
      "./formats/*": "./formats/*",
      "./package.json": "./package.json",
    });
    for (const target of Object.values(manifest.exports)) {
      if (typeof target === "object") {
        expect(Object.keys(target)[0]).toBe("types");
      }
    }
  });

  it("emits no CSS and no client directive: ai-core renders nothing", () => {
    expect(files.filter((file) => file.fileName.endsWith(".css"))).toEqual([]);
    for (const file of files) {
      if (file.type === "chunk") {
        expect(file.code, file.fileName).not.toContain("use client");
      }
    }
  });

  it("imports sdk-core instead of bundling it", () => {
    expect(externalPackages).toContain("@hussmartinez/sdk-core");
    const index = files.find((file) => file.fileName === "index.js");
    expect(index?.type === "chunk" && index.code).toContain('from "@hussmartinez/sdk-core"');
    for (const file of files) {
      if (file.type === "chunk") {
        // A bundled sdk-core would bring its own copy of SdkError, and a page
        // using several packages of the family would load sdk-core twice.
        expect(file.code, file.fileName).not.toContain("class SdkError");
      }
    }
  });

  it("depends on no test framework, not even in ./testing (ADR 0002)", () => {
    for (const file of files) {
      if (file.type === "chunk") {
        expect(
          file.imports.filter((name) => /^(?:vitest|jest|@jest\/|node:test)/.test(name)),
        ).toEqual([]);
      }
    }
  });

  it("bundles no dependency and leaks no local paths", () => {
    for (const file of files) {
      if (file.type === "chunk") {
        for (const name of externalPackages) {
          expect(file.moduleIds.some((id) => id.includes(`/node_modules/${name}/`))).toBe(false);
        }
        expect(file.code, file.fileName).not.toContain(process.cwd());
      }
    }
  });
});

/**
 * Builds the package to a temporary folder inside the repository, so the
 * built files resolve their external imports from its node_modules, as they
 * would in an application.
 */
const temporaryBuild = (async () => {
  const parent = join(process.cwd(), "temp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "build-test-"));
  await build({
    configFile: new URL("vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    build: { outDir: directory, emptyOutDir: true },
  });
  return directory;
})();

afterAll(async () => {
  await rm(await temporaryBuild, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every way a module could reach the network on import (ADR 0035). */
function stubNetwork(): Array<ReturnType<typeof vi.fn>> {
  const stubs = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => {
    const stub = vi.fn();
    vi.stubGlobal(name, stub);
    return stub;
  });
  const sendBeacon = vi.fn();
  vi.stubGlobal("navigator", { ...globalThis.navigator, sendBeacon });
  return [...stubs, sendBeacon];
}

describe("importing on a server", () => {
  // The unit project runs in Node, without a DOM, as a server would.
  it.each(entryFiles)(
    "imports %s without browser APIs and without any request (ADR 0004, ADR 0035)",
    async (entry) => {
      expect(globalThis).not.toHaveProperty("window");
      expect(globalThis).not.toHaveProperty("document");
      const network = stubNetwork();
      const url = pathToFileURL(join(await temporaryBuild, entry)).href;
      await expect(import(url)).resolves.toBeTypeOf("object");
      for (const stub of network) {
        expect(stub).not.toHaveBeenCalled();
      }
    },
  );
});

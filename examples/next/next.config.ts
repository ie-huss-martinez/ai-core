import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The Content Security Policy the README documents for ai-core's browser
 * transport: `connect-src 'self'`, because the page talks only to its own
 * handler, and the provider is called from the server (ADR 0003, sdk-core
 * ADR 0035). The end-to-end suite fails on any violation.
 *
 * `'unsafe-inline'` scripts are only for Next.js's own inline bootstrap in
 * this example. A production application uses nonces instead.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  // The workspace root, so Next.js doesn't guess it from lockfiles.
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;

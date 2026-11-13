import { createAnthropic } from "@hussmartinez/ai-core/anthropic";
import { createAiHandler } from "@hussmartinez/ai-core/server";

// The handler streams, reads the request and holds a key: never cache it,
// and run it on Node.js, where the adapter recognises a server (ADR 0004).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const appOrigin = process.env["APP_ORIGIN"];
const baseURL = process.env["ANTHROPIC_BASE_URL"];

/**
 * The page's only endpoint. The key is read on the server for each request,
 * and never reaches the browser. The end-to-end suite points `baseURL` at a
 * local stand-in for Anthropic's API.
 */
export const POST = createAiHandler({
  provider: createAnthropic({
    apiKey: () => process.env["ANTHROPIC_API_KEY"] ?? "",
    model: "claude-sonnet-5-5",
    ...(baseURL ? { baseURL } : {}),
  }),
  // A second layer for browsers: the page's own origin only (ADR 0003).
  ...(appOrigin ? { allowedOrigins: [appOrigin] } : {}),
  prepare({ request }) {
    // A real application authenticates the user and rate-limits them here,
    // and returns a 401 or 429 Response to refuse. This example has no users,
    // so it only refuses requests that a page on another site sent.
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return new Response(null, { status: 403 });
    }
    // The server sets the model's instructions and budget, never the page.
    // Keep the system prompt the same for a whole conversation: volatile data
    // such as today's date belongs in messages.
    return {
      system: "You are a concise assistant in an example application.",
      maxOutputTokens: 1_000,
    };
  },
});

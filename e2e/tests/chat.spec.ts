import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  ANSWER_PIECES,
  API_KEY,
  APP_URL,
  PROVIDER_URL,
  type ProviderRecord,
  THINKING,
} from "../constants.ts";

/**
 * The whole path a host builds with ai-core: `httpTransport` in the page,
 * `createAiHandler` in a Next.js route handler, and the Anthropic adapter
 * calling a stand-in for Anthropic's API (ADR 0003, ADR 0004).
 */

const ANSWER = ANSWER_PIECES.join("");

interface Seen {
  readonly console: string[];
  readonly errors: string[];
  readonly foreignRequests: string[];
  readonly bodies: Promise<string>[];
}

/** Watches everything the browser sees: console, errors, requests and responses. */
function watch(page: Page): Seen {
  const seen: Seen = { console: [], errors: [], foreignRequests: [], bodies: [] };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      seen.console.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== APP_URL) {
      seen.foreignRequests.push(request.url());
    }
  });
  page.on("response", (response) => {
    seen.bodies.push(
      response
        .text()
        .then(async (body) => `${JSON.stringify(await response.allHeaders())}\n${body}`)
        .catch(() => ""),
    );
  });
  return seen;
}

async function providerLog(request: APIRequestContext): Promise<ProviderRecord[]> {
  return (await (await request.get(`${PROVIDER_URL}/__log`)).json()) as ProviderRecord[];
}

async function open(page: Page): Promise<void> {
  // Content Security Policy violations are collected before any script runs.
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = violations;
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await page.goto("/");
  await expect(page.locator("form[data-ready]")).toBeAttached();
}

async function ask(page: Page, message: string): Promise<void> {
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
}

const assistant = (page: Page) => page.locator('li[data-role="assistant"]');
// The example's error. Next.js adds a role="alert" route announcer of its own.
const failure = (page: Page) => page.locator('main [role="alert"]');

test.beforeEach(async ({ request }) => {
  await request.post(`${PROVIDER_URL}/__reset`);
});

test.afterEach(async ({ page }) => {
  const violations = await page.evaluate(
    () => (window as unknown as { cspViolations?: string[] }).cspViolations ?? [],
  );
  expect(violations, "Content Security Policy violations").toEqual([]);
});

test("streams an answer, with the model, prompt and budget the server chose", async ({
  page,
  request,
}) => {
  const seen = watch(page);
  await open(page);
  await ask(page, "Hi there");

  // The answer arrives in pieces: part of it shows before the rest.
  const streaming = page.locator("li[data-streaming]");
  await expect(streaming).toContainText(ANSWER_PIECES[0].trim());
  expect(await streaming.textContent()).not.toContain(ANSWER);
  await expect(assistant(page)).toHaveText(`Assistant: ${ANSWER}`);
  await expect(page.getByRole("status")).toHaveText("");

  const [call, ...others] = await providerLog(request);
  expect(others).toEqual([]);
  expect(call?.authorized).toBe(true);
  expect(call?.anthropicVersion).toBe("2026-10-21");
  expect(call?.body.model).toBe("claude-sonnet-5-5");
  expect(call?.body.max_tokens).toBe(1_000);
  expect(JSON.stringify(call?.body.system)).toContain("You are a concise assistant");
  expect(call?.body.messages).toHaveLength(1);
  expect(JSON.stringify(call?.body.messages)).toContain("Hi there");

  expect(seen.errors).toEqual([]);
  expect(seen.console).toEqual([]);
  expect(seen.foreignRequests).toEqual([]);
});

test("sends the provider's thinking back unchanged on the next turn", async ({ page, request }) => {
  await open(page);
  await ask(page, "Hi there");
  await expect(assistant(page)).toHaveText(`Assistant: ${ANSWER}`);
  await ask(page, "And again");
  await expect(assistant(page)).toHaveCount(2);
  await expect(assistant(page).nth(1)).toHaveText(`Assistant: ${ANSWER}`);

  const calls = await providerLog(request);
  expect(calls).toHaveLength(2);
  const replayed = calls[1]?.body.messages;
  expect(replayed?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  // The thinking block went to the page and came back exactly as received;
  // the handler's own context part never reached the provider.
  expect(replayed?.[1]?.content).toEqual([THINKING, { type: "text", text: ANSWER }]);
  expect(JSON.stringify(replayed)).not.toContain("ai-core");
  // The page never shows the thinking.
  await expect(page.getByText(THINKING.thinking)).toHaveCount(0);
});

test("keeps the API key on the server", async ({ page, request }) => {
  const seen = watch(page);
  await open(page);
  await ask(page, "Hi there");
  await expect(assistant(page)).toHaveText(`Assistant: ${ANSWER}`);
  await ask(page, "overloaded, please");
  await expect(failure(page)).toBeVisible();

  // The server used the key...
  expect((await providerLog(request)).every((call) => call.authorized)).toBe(true);
  // ...and nothing the browser received, page, scripts, stream or error,
  // contains it.
  const bodies = await Promise.all(seen.bodies);
  expect(bodies.length).toBeGreaterThan(3);
  for (const body of bodies) {
    expect(body).not.toContain(API_KEY);
  }
  expect(seen.foreignRequests).toEqual([]);
});

test("shows a provider's failure by its code, and recovers", async ({ page }) => {
  await open(page);
  await ask(page, "overloaded, please");
  await expect(failure(page)).toHaveText("The assistant is busy. Please try again in a moment.");
  await expect(assistant(page)).toHaveCount(0);

  await ask(page, "Hi there");
  await expect(failure(page)).toHaveCount(0);
  await expect(assistant(page)).toHaveText(`Assistant: ${ANSWER}`);
});

test("stopping cancels the call all the way to the provider", async ({ page, request }) => {
  await open(page);
  await ask(page, "a slow answer, please");
  await expect(page.locator("li[data-streaming]")).toContainText("piece 2.");
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByRole("status")).toHaveText("Stopped.");
  // An unfinished answer isn't kept in the conversation.
  await expect(assistant(page)).toHaveCount(0);
  // The browser's abort reached the handler, which aborted the provider's call.
  await expect
    .poll(async () => (await providerLog(request))[0]?.closedEarly, { timeout: 10_000 })
    .toBe(true);
});

test("is served with a Content Security Policy that allows only its own origin", async ({
  request,
}) => {
  const response = await request.get("/");
  const policy = response.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("default-src 'self'");
});

test("refuses a request from another site, before calling the provider", async ({ request }) => {
  const response = await request.post("/api/chat", {
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    data: {
      protocol: "ai-core/1",
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  expect(await providerLog(request)).toEqual([]);
});

test("has no accessibility violations, before and after an answer", async ({ page }) => {
  await open(page);
  const before = await new AxeBuilder({ page }).analyze();
  expect(before.violations).toEqual([]);
  await ask(page, "Hi there");
  await expect(assistant(page)).toHaveText(`Assistant: ${ANSWER}`);
  const after = await new AxeBuilder({ page }).analyze();
  expect(after.violations).toEqual([]);
});

/**
 * Shared by the stand-in provider, the Playwright configuration and the
 * tests. The key is a sentinel: the tests fail if the browser ever sees it.
 */
export const API_KEY = "sk-ant-e2e-sentinel-key-0123456789abcdef";
export const PROVIDER_PORT = 4411;
export const APP_PORT = 3300;
export const PROVIDER_URL = `http://localhost:${PROVIDER_PORT}`;
export const APP_URL = `http://localhost:${APP_PORT}`;

/** The thinking block the stand-in returns, which the next turn must send back unchanged. */
export const THINKING = {
  type: "thinking",
  thinking: "The user said hello. Answer briefly.",
  signature: "EqQBCgIYAhIMe2e-signature-0001",
} as const;

/** The answer's text, which the stand-in streams in pieces. */
export const ANSWER_PIECES = ["Hello ", "from ", "the ", "stand-in ", "provider", "."] as const;

/** What the stand-in recorded about one request. Never the key itself. */
export interface ProviderRecord {
  readonly authorized: boolean;
  readonly anthropicVersion: string | null;
  readonly body: {
    readonly model?: string;
    readonly system?: unknown;
    readonly max_tokens?: number;
    readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
  };
  /** Whether the client closed the connection before the stream ended. */
  closedEarly: boolean;
}

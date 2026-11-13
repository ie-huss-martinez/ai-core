import { createMessages } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { AiError, type AiErrorCode } from "../core/errors/ai-error.js";
import {
  requestLimitDefinitions,
  requestLimits,
  responseLimitDefinitions,
  responseLimits,
} from "../core/limits/ai-limits.js";
import { aiCoreMessages } from "./en.js";

// Listing every code here makes the type checker fail when a code is added
// to AiErrorCode without being listed, and the test fail when its text is
// missing from the catalogue.
const ALL_CODES: Record<AiErrorCode, true> = {
  UNKNOWN: true,
  ABORTED: true,
  TIMEOUT: true,
  WORKER_START_FAILED: true,
  WORKER_PROTOCOL_MISMATCH: true,
  WORKER_CRASHED: true,
  WORKER_TERMINATED: true,
  WORKER_METHOD_NOT_FOUND: true,
  WORKER_DATA_NOT_CLONEABLE: true,
  UNSUPPORTED_ENVIRONMENT: true,
  FILE_TOO_LARGE: true,
  TOO_MANY_FILES: true,
  DECODED_SIZE_TOO_LARGE: true,
  PROCESSING_TIME_EXCEEDED: true,
  INVALID_CONFIGURATION: true,
  INVALID_REQUEST: true,
  MISSING_API_KEY: true,
  BROWSER_KEY_REFUSED: true,
  METHOD_NOT_ALLOWED: true,
  UNSUPPORTED_MEDIA_TYPE: true,
  ORIGIN_NOT_ALLOWED: true,
  PROTOCOL_MISMATCH: true,
  CONTEXT_CHANGED: true,
  PREPARE_FAILED: true,
  REQUEST_TOO_LARGE: true,
  RESPONSE_TOO_LARGE: true,
  STREAM_TIMEOUT: true,
  STREAM_IDLE: true,
  STREAM_TRUNCATED: true,
  PROVIDER_RESPONSE_INVALID: true,
  PROVIDER_INVALID_REQUEST: true,
  PROVIDER_AUTHENTICATION: true,
  PROVIDER_BILLING: true,
  PROVIDER_PERMISSION: true,
  PROVIDER_NOT_FOUND: true,
  PROVIDER_REQUEST_TOO_LARGE: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_OVERLOADED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_ERROR: true,
  NETWORK_ERROR: true,
  SPEND_LIMIT_REACHED: true,
};

function violation(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the limit to be exceeded");
}

describe("aiCoreMessages", () => {
  it("has text for every AiError code and every limit's warning", () => {
    for (const code of Object.keys(ALL_CODES)) {
      expect(aiCoreMessages, code).toHaveProperty(`errors.${code}`);
    }
    for (const limit of [
      ...Object.keys(responseLimitDefinitions),
      ...Object.keys(requestLimitDefinitions),
    ]) {
      expect(aiCoreMessages, limit).toHaveProperty(`warnings.${limit}`);
    }
  });

  it("is a valid catalogue", () => {
    // createMessages throws on a malformed message in the package's own catalogue.
    expect(() => createMessages(aiCoreMessages)).not.toThrow();
  });

  it("describes a limit violation with its details", () => {
    const messages = createMessages(aiCoreMessages);
    const response = responseLimits.resolve();
    expect(messages.error(response.error("streamDuration", 900_001))).toBe(
      "The response took longer than 15 min, so it was stopped.",
    );
    expect(messages.error(violation(() => response.check("responseBytes", 20_000_000)))).toBe(
      "The response was over the 16 MB limit, so it was stopped.",
    );
    const request = requestLimits.resolve();
    expect(messages.error(violation(() => request.check("requestBytes", 9_500_000)))).toBe(
      "This message is 9.5 MB, which is over the 8 MB limit. Send less text or smaller images.",
    );
  });

  it("never shows an error's message, which may hold provider text", () => {
    const messages = createMessages(aiCoreMessages);
    expect(
      messages.error(
        new AiError("PROVIDER_RESPONSE_INVALID", "<script>from the provider</script>"),
      ),
    ).toBe("The assistant sent a response that couldn't be read. Please try again.");
  });
});

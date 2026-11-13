import { describe, expect, it } from "vitest";
import { isAiError } from "./ai-error.js";
import { classifyStatus, networkError, parseRetryAfter, providerError } from "./provider-errors.js";

describe("classifyStatus (ADR 0007)", () => {
  it.each([
    [400, "PROVIDER_INVALID_REQUEST", false],
    [401, "PROVIDER_AUTHENTICATION", false],
    [402, "PROVIDER_BILLING", false],
    [403, "PROVIDER_PERMISSION", false],
    [404, "PROVIDER_NOT_FOUND", false],
    [408, "PROVIDER_TIMEOUT", true],
    [413, "PROVIDER_REQUEST_TOO_LARGE", false],
    [429, "PROVIDER_RATE_LIMITED", true],
    [500, "PROVIDER_ERROR", true],
    [502, "PROVIDER_ERROR", true],
    [503, "PROVIDER_OVERLOADED", true],
    [504, "PROVIDER_TIMEOUT", true],
    [529, "PROVIDER_OVERLOADED", true],
    [418, "PROVIDER_ERROR", false],
  ] as const)("maps %i to %s, retryable: %s", (status, code, retryable) => {
    expect(classifyStatus(status)).toEqual([code, retryable]);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");

  it("reads whole seconds", () => {
    expect(parseRetryAfter("20", now)).toBe(20);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP date, rounding up, never negative", () => {
    expect(parseRetryAfter("Fri, 13 Nov 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Fri, 13 Nov 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("never invents a value", () => {
    for (const value of [null, undefined, "", "soon", "-5", "1.5", "20s"]) {
      expect(parseRetryAfter(value, now), String(value)).toBeUndefined();
    }
  });
});

describe("providerError", () => {
  it("keeps only the status, type, request ID, retryAfter and partial", () => {
    const error = providerError({
      status: 429,
      providerType: "rate_limit_error",
      requestId: "req_011CSHoEeqs5C35K2UUqR7Fy",
      retryAfter: 20,
      partial: false,
    });
    expect(isAiError(error, "PROVIDER_RATE_LIMITED")).toBe(true);
    expect(error.details).toEqual({
      retryable: true,
      status: 429,
      providerType: "rate_limit_error",
      requestId: "req_011CSHoEeqs5C35K2UUqR7Fy",
      retryAfter: 20,
    });
  });

  it("marks partial output, and takes the adapter's own decision", () => {
    const error = providerError({ status: 429, partial: true }, ["SPEND_LIMIT_REACHED", false]);
    expect(isAiError(error, "SPEND_LIMIT_REACHED")).toBe(true);
    expect(error.details).toEqual({ retryable: false, status: 429, partial: true });
  });

  it("leaves out provider values that aren't short and plain", () => {
    const error = providerError({
      status: 500,
      providerType: "<script>alert(1)</script>",
      requestId: "a prompt-like value with spaces",
    });
    expect(error.details).toEqual({ retryable: true, status: 500 });
  });
});

describe("networkError", () => {
  it("names only the method and the origin, with no cause", () => {
    const error = networkError("POST", "https://api.anthropic.com/v1/messages?secret=1");
    expect(isAiError(error, "NETWORK_ERROR")).toBe(true);
    expect(error.details).toEqual({
      retryable: true,
      method: "POST",
      origin: "https://api.anthropic.com",
    });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain("secret");
  });
});

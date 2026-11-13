import { describe, expect, it } from "vitest";
import { isAiError } from "../errors/ai-error.js";
import {
  requestLimitDefinitions,
  requestLimits,
  responseLimitDefinitions,
  responseLimits,
} from "./ai-limits.js";

function violation(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the limit to be exceeded");
}

describe("the response limits (ADR 0005)", () => {
  it("default to 16 MB, 15 minutes and 2 minutes idle, with warnings", () => {
    const { limits } = responseLimits.resolve();
    expect(limits.responseBytes).toEqual({ maximum: 16_000_000, warning: 8_000_000 });
    expect(limits.streamDuration).toEqual({ maximum: 900_000, warning: 600_000 });
    expect(limits.idleTime).toEqual({ maximum: 120_000, warning: Number.POSITIVE_INFINITY });
  });

  it("throw an AiError with the limit's code and details", () => {
    const policy = responseLimits.resolve();
    const error = violation(() => policy.check("responseBytes", 16_000_001));
    expect(isAiError(error, "RESPONSE_TOO_LARGE")).toBe(true);
    expect(error).toMatchObject({
      details: {
        limit: "responseBytes",
        maximum: 16_000_000,
        actual: 16_000_001,
        unit: "bytes",
      },
    });
    expect(isAiError(policy.error("streamDuration", 900_001), "STREAM_TIMEOUT")).toBe(true);
    expect(isAiError(policy.error("idleTime", 120_001), "STREAM_IDLE")).toBe(true);
  });

  it("warn from the warning threshold, and accept a host's settings", () => {
    const policy = responseLimits.resolve({
      streamDuration: { maximum: 1_800_000, warning: 1_200_000 },
    });
    expect(policy.check("responseBytes", 8_000_000)).toBe("warning");
    expect(policy.check("responseBytes", 7_999_999)).toBeUndefined();
    expect(policy.limits.streamDuration).toEqual({ maximum: 1_800_000, warning: 1_200_000 });
  });

  it("reject unknown names, including the handler's request limit", () => {
    expect(() => responseLimits.resolve({ requestBytes: 1 } as never)).toThrow(TypeError);
    expect(() => responseLimits.resolve({ maxFileSize: 1 } as never)).toThrow(TypeError);
  });
});

describe("the request limit (ADR 0005)", () => {
  it("defaults to 8 MB, with a warning at 4 MB", () => {
    expect(requestLimits.resolve().limits.requestBytes).toEqual({
      maximum: 8_000_000,
      warning: 4_000_000,
    });
  });

  it("throws REQUEST_TOO_LARGE, and rejects the response limits' names", () => {
    const policy = requestLimits.resolve();
    expect(
      isAiError(
        violation(() => policy.check("requestBytes", 8_000_001)),
        "REQUEST_TOO_LARGE",
      ),
    ).toBe(true);
    expect(() => requestLimits.resolve({ responseBytes: 1 } as never)).toThrow(TypeError);
  });
});

describe("the limit definitions", () => {
  it("have no overlapping names between requests and responses", () => {
    const response = Object.keys(responseLimitDefinitions);
    for (const name of Object.keys(requestLimitDefinitions)) {
      expect(response).not.toContain(name);
    }
  });
});

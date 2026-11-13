import { deserializeError, isSdkError, SdkError, serializeError } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { AiError, abortError, asAiError, isAiError, throwIfAborted } from "./ai-error.js";

describe("AiError", () => {
  it("carries a code, details and cause, as an SdkError", () => {
    const cause = new TypeError("fetch failed");
    const error = new AiError("STREAM_TRUNCATED", "The stream ended early.", {
      details: { retryable: true, partial: true },
      cause,
    });
    expect(error).toBeInstanceOf(SdkError);
    expect(error).toMatchObject({
      name: "AiError",
      code: "STREAM_TRUNCATED",
      details: { retryable: true, partial: true },
      cause,
    });
    expect(isSdkError(error, "STREAM_TRUNCATED")).toBe(true);
  });

  it("keeps its class, code and details across the wire protocol", () => {
    const original = new AiError("STREAM_IDLE", "No data for 2 minutes.", {
      details: { limit: "idleTime", maximum: 120_000, actual: 120_001, unit: "milliseconds" },
    });
    // The handler sends serializeError() output as JSON; the transport rebuilds it.
    const received = JSON.parse(JSON.stringify(serializeError(original)));
    const rebuilt = deserializeError(received, { errorClasses: { AiError } });
    expect(rebuilt).toBeInstanceOf(AiError);
    expect(isAiError(rebuilt, "STREAM_IDLE")).toBe(true);
    expect(rebuilt.details).toEqual(original.details);
  });
});

describe("isAiError", () => {
  it("recognises an AiError, and checks its code when given one", () => {
    const error = new AiError("CONTEXT_CHANGED", "The system prompt changed.");
    expect(isAiError(error)).toBe(true);
    expect(isAiError(error, "CONTEXT_CHANGED")).toBe(true);
    expect(isAiError(error, "INVALID_REQUEST")).toBe(false);
  });

  it("rejects other SDK errors and plain values", () => {
    expect(isAiError(new SdkError("ABORTED", "Stopped."))).toBe(false);
    expect(isAiError(new Error("CONTEXT_CHANGED"))).toBe(false);
    expect(isAiError({ name: "AiError", code: "CONTEXT_CHANGED", message: "forged" })).toBe(false);
    expect(isAiError(undefined)).toBe(false);
  });
});

describe("the error helpers", () => {
  it("adapts any failure into an AiError, keeping the original as cause", () => {
    const failure = new TypeError("network down");
    const adapted = asAiError(failure);
    expect(adapted).toBeInstanceOf(AiError);
    expect(adapted).toMatchObject({ code: "UNKNOWN", message: "The AI call failed." });
    expect(adapted.cause).toBe(failure);
    const own = new AiError("STREAM_TRUNCATED", "Ended early.");
    expect(asAiError(own)).toBe(own);
  });

  it("turns an aborted signal into ABORTED, and a timeout into TIMEOUT", () => {
    const controller = new AbortController();
    controller.abort();
    expect(abortError(controller.signal)).toMatchObject({ name: "AiError", code: "ABORTED" });
    expect(() => throwIfAborted(controller.signal)).toThrow(AiError);
    expect(() => throwIfAborted(undefined)).not.toThrow();
    const timedOut = new AbortController();
    timedOut.abort(new DOMException("Timed out", "TimeoutError"));
    expect(abortError(timedOut.signal)).toMatchObject({ code: "TIMEOUT" });
  });

  it("keeps a limit's error when it's the abort reason", () => {
    const limit = new AiError("STREAM_TIMEOUT", "Too long.");
    const controller = new AbortController();
    controller.abort(limit);
    expect(abortError(controller.signal)).toBe(limit);
  });
});

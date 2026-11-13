import { describe, expect, it, vi } from "vitest";
import { requestLimits } from "../core/limits/ai-limits.js";
import { readBody } from "./read-body.js";

/** A request without a body stream, as in Firefox, which has no Request.body. */
function withoutBodyStream(body: string): Request {
  const request = new Request("https://app.example.com/api/chat", { method: "POST", body });
  Object.defineProperty(request, "body", { value: undefined });
  return request;
}

describe("readBody", () => {
  it("reads a body that has no stream, as in Firefox", async () => {
    const policy = requestLimits.resolve();
    await expect(readBody(withoutBodyStream('{"a":1}'), policy, undefined)).resolves.toBe(
      '{"a":1}',
    );
  });

  it("applies the limit to a body that has no stream", async () => {
    const policy = requestLimits.resolve({ requestBytes: 4 });
    await expect(readBody(withoutBodyStream("12345"), policy, undefined)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      details: { actual: 5 },
    });
  });

  it("warns once for a body that has no stream", async () => {
    const onWarning = vi.fn();
    const policy = requestLimits.resolve({ requestBytes: { maximum: 100, warning: 2 } });
    await readBody(withoutBodyStream("12345"), policy, onWarning);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });
});

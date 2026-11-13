import { readFileSync } from "node:fs";
import { describeConformance, readConformance } from "@hussmartinez/sdk-config/testing/conformance";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { WireStream } from "../../src/adapters/http/stream.js";
import type { AiMessage } from "../../src/core/model/message.js";
import type { AiTool } from "../../src/core/model/provider.js";
import { decodeRequestBody, encodePart } from "../../src/core/protocol/wire.js";
import { canonicalJson, contextCanonicalJson, contextHash } from "../../src/server/context-hash.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The conformance vectors (sdk-core ADR 0045): the same files a port in
 * another language runs, checked here against ai-core. Their expected
 * values come from RFC 8785 itself and from an independent implementation,
 * never from this one.
 */

interface JcsInput {
  /** JSON text to parse, then canonicalise. */
  readonly jsonText?: string;
  /** The hex bits of one IEEE 754 double, as in RFC 8785 Appendix B. */
  readonly ieee754?: string;
  /** `"utf8-hex"` for the canonical form's UTF-8 bytes, in hex. */
  readonly output?: "utf8-hex";
}

function double(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describeConformance<JcsInput>(
  new URL("../../conformance/hm-ai-canonical-json.json", import.meta.url),
  (input) => {
    const value: unknown =
      input.ieee754 === undefined ? JSON.parse(input.jsonText ?? "") : double(input.ieee754);
    const canonical = canonicalJson(value);
    return input.output === "utf8-hex"
      ? Buffer.from(new TextEncoder().encode(canonical)).toString("hex")
      : canonical;
  },
);

interface HashInput {
  readonly system?: string;
  readonly tools?: readonly AiTool[];
}

describeConformance<HashInput>(
  new URL("../../conformance/hm-ai-context-hash.json", import.meta.url),
  async (input) => ({
    canonical: contextCanonicalJson(input.system, input.tools),
    sha256: await contextHash(input.system, input.tools),
  }),
);

// --- The ai-core/1 protocol (docs/formats/hm-ai-protocol.md) -------------

const encodeMessages = (messages: readonly AiMessage[]) =>
  messages.map((message) => ({ role: message.role, parts: message.parts.map(encodePart) }));

const REQUESTS = new URL("../../conformance/hm-ai-protocol-request.json", import.meta.url);
const EVENTS = new URL("../../conformance/hm-ai-protocol-events.json", import.meta.url);

describeConformance(REQUESTS, (input) => {
  const body = decodeRequestBody(input);
  return { protocol: body.protocol, messages: encodeMessages(body.messages) };
});

interface WireEventInput {
  readonly event: string;
  readonly data?: unknown;
  /** Raw data, for data that isn't JSON. */
  readonly dataText?: string;
}

function readEvents(input: readonly WireEventInput[]) {
  const stream = new WireStream();
  const events: unknown[] = [];
  for (const item of input) {
    const data = item.dataText ?? JSON.stringify(item.data);
    for (const event of stream.push({ event: item.event, data }, events.length > 0)) {
      events.push(event.type === "part" ? { type: "part", part: encodePart(event.part) } : event);
    }
  }
  return { events, finished: stream.finished };
}

describeConformance<readonly WireEventInput[]>(EVENTS, readEvents);

describe("the hm-ai-protocol schema and the readers accept the same", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(
    readFileSync(new URL("../../formats/hm-ai-protocol/v1.schema.json", import.meta.url), "utf8"),
  ) as { $id: string };
  ajv.addSchema(schema);
  const valid = (ref: string) =>
    ajv.getSchema(`${schema.$id}${ref}`) as (value: unknown) => boolean;
  const body = valid("");
  const eventSchemas: Record<string, (value: unknown) => boolean> = {
    start: valid("#/$defs/startEvent"),
    "text-delta": valid("#/$defs/textDeltaEvent"),
    "summary-delta": valid("#/$defs/summaryDeltaEvent"),
    part: valid("#/$defs/partEvent"),
    finish: valid("#/$defs/finishEvent"),
    error: valid("#/$defs/errorEvent"),
  };

  it.each(readConformance(REQUESTS).cases.map((testCase) => [testCase.name, testCase] as const))(
    "request: %s",
    (_, testCase) => {
      const refused = isObject(testCase.expected) && "error" in testCase.expected;
      expect(body(testCase.input)).toBe(!refused);
    },
  );

  /** Refusals that depend on the events' order, which a schema can't see. */
  const ORDER_ONLY = new Set(["missing-start", "duplicate-start"]);

  it.each(readConformance(EVENTS).cases.map((testCase) => [testCase.name, testCase] as const))(
    "events: %s",
    (_, testCase) => {
      const input = testCase.input as readonly WireEventInput[];
      const schemaAccepts = input.every((item) => {
        if (item.dataText !== undefined) {
          return false;
        }
        const check = eventSchemas[item.event];
        return check === undefined || check(item.data);
      });
      const error = (testCase.expected as { error?: { code: string; reason?: string } }).error;
      const malformed =
        error !== undefined &&
        !ORDER_ONLY.has(error.reason ?? "") &&
        (error.code === "PROVIDER_RESPONSE_INVALID" || error.code === "PROTOCOL_MISMATCH");
      expect(schemaAccepts).toBe(!malformed);
    },
  );

  // Every object of every accepted body, given one more field: both refuse it.
  // Opaque values (`data`, `input`) hold any JSON, so they're left alone.
  function* withExtraField(value: unknown, path: (string | number)[] = []): Generator<unknown> {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        yield* withExtraField(item, [...path, index]);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    yield path;
    for (const [key, item] of Object.entries(value)) {
      if (key !== "data" && key !== "input") {
        yield* withExtraField(item, [...path, key]);
      }
    }
  }

  const accepted = readConformance(REQUESTS).cases.filter(
    (testCase) => !(isObject(testCase.expected) && "error" in testCase.expected),
  );
  for (const testCase of accepted) {
    it(`refuses an extra field anywhere in: ${testCase.name}`, () => {
      for (const path of withExtraField(testCase.input)) {
        const copy = structuredClone(testCase.input) as Record<string, unknown>;
        let target: unknown = copy;
        for (const step of path as (string | number)[]) {
          target = (target as Record<string | number, unknown>)[step];
        }
        // An own property, as ADR 0045 warns: assignment could hit a setter.
        Object.defineProperty(target, "extraField", { value: 1, enumerable: true });
        expect(body(copy), JSON.stringify(path)).toBe(false);
        expect(() => decodeRequestBody(copy)).toThrowError(
          expect.objectContaining({
            details: expect.objectContaining({ reason: "unknown-field" }),
          }),
        );
      }
    });
  }
});

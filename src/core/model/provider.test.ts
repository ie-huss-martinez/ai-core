import { describe, expectTypeOf, it } from "vitest";
import type { AiMessage, AiPart } from "./message.js";
import type { AiEvent, AiProvider, AiRequest, AiResult } from "./provider.js";

/**
 * A port as an SDK would declare it on its own (sdk-core ADR 0035), with only
 * what that SDK needs and no import of ai-core: the shape of ADR 0035's
 * example.
 */
interface SdkPort {
  complete(
    request: {
      readonly messages: readonly {
        readonly role: "user" | "assistant";
        readonly parts: readonly unknown[];
      }[];
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly message: { readonly parts: readonly unknown[] } }>;
  stream(
    request: {
      readonly messages: readonly {
        readonly role: "user" | "assistant";
        readonly parts: readonly unknown[];
      }[];
    },
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<{ readonly type: string }>;
}

describe("the provider shape (ADR 0002)", () => {
  it("fits an SDK's own structurally typed port", () => {
    expectTypeOf<AiProvider>().toExtend<SdkPort>();
  });

  it("returns an assistant message", () => {
    expectTypeOf<AiResult["message"]["role"]>().toEqualTypeOf<"assistant">();
  });

  it("streams events that are discriminated by type", () => {
    expectTypeOf<AiEvent["type"]>().toEqualTypeOf<
      "text-delta" | "summary-delta" | "part" | "finish"
    >();
  });

  it("offers only auto and none as tool choices", () => {
    expectTypeOf<NonNullable<AiRequest["toolChoice"]>>().toEqualTypeOf<"auto" | "none">();
  });

  it("has no sampling parameters in the common request", () => {
    expectTypeOf<AiRequest>().not.toHaveProperty("temperature");
    expectTypeOf<AiRequest>().not.toHaveProperty("topP");
  });
});

describe("the message model (ADR 0001)", () => {
  it("has exactly the five part types", () => {
    expectTypeOf<AiPart["type"]>().toEqualTypeOf<
      "text" | "image" | "tool-call" | "tool-result" | "provider-state"
    >();
  });

  it("has user and assistant roles only: the system prompt is a request field", () => {
    expectTypeOf<AiMessage["role"]>().toEqualTypeOf<"user" | "assistant">();
  });
});

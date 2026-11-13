import { describeConformance } from "@hussmartinez/sdk-config/testing/conformance";
import type { AiTool } from "../../src/core/model/provider.js";
import { canonicalJson, contextCanonicalJson, contextHash } from "../../src/server/context-hash.js";

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

/**
 * Encodes bytes as base64, without Node's `Buffer`, so it works in browsers,
 * Node and Workers runtimes alike. Images go to providers this way, as bytes,
 * never as URLs (ADR 0001).
 *
 * @internal
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunks keep String.fromCharCode's argument list well under engines' limits.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** Standard base64 with padding, and nothing else: no whitespace, no URL alphabet. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes standard, padded base64, as {@link toBase64} produces it, without
 * Node's `Buffer`. Returns `undefined` for anything else, such as whitespace
 * or the URL-safe alphabet, which `atob` would partly accept.
 *
 * @internal
 */
export function fromBase64(text: string): Uint8Array | undefined {
  if (!BASE64.test(text)) {
    return undefined;
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

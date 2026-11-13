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

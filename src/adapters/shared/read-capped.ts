/** The most of an error body ai-core reads: enough for its JSON, never a whole stream. */
const ERROR_BODY_BYTES = 64 * 1024;

/**
 * Reads at most 64 KB of a failed response's body as text, then cancels the
 * rest, so an error body can't be used to exhaust memory. A cut-off body
 * simply fails to parse as JSON.
 *
 * @internal
 */
export async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_BYTES));
}

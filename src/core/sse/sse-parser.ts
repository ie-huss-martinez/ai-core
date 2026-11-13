/**
 * One server-sent event: its type, its data, and the last event ID seen.
 *
 * @internal
 */
export interface SseEvent {
  /** The `event:` field, or `"message"` when the event has none. */
  readonly event: string;
  /** The `data:` lines, joined with newlines. */
  readonly data: string;
  /** The last `id:` seen in the stream, if any. */
  readonly id?: string;
}

/**
 * An incremental parser for `text/event-stream` bodies, following the
 * WHATWG HTML standard's rules for interpreting an event stream (ADR 0005):
 *
 * - lines end in CRLF, LF or CR, and a CR at the end of a chunk waits for the
 *   next chunk, in case it's half of a CRLF;
 * - a leading byte order mark is ignored;
 * - lines starting with `:` are comments, and are ignored;
 * - `field: value` drops one space after the colon, and a line without a
 *   colon is a field with an empty value;
 * - `data:` lines are joined with newlines, `event:` sets the type, `id:`
 *   sets the last event ID unless it contains NULL, and other fields are
 *   ignored;
 * - a blank line dispatches the event, unless it has no data;
 * - an unfinished event at the end of the stream is discarded.
 *
 * It parses text. Decoding bytes, and limiting their number, is the caller's
 * job ({@link readSseEvents}).
 *
 * @internal
 */
export class SseParser {
  #buffer = "";
  #started = false;
  #data = "";
  #hasData = false;
  #type = "";
  #lastId: string | undefined;

  /**
   * Parses the next piece of the stream.
   *
   * @param text - Decoded text, in order. It may split lines and characters'
   *   line terminators anywhere.
   * @returns The events completed by this piece.
   */
  push(text: string): SseEvent[] {
    let chunk = text;
    if (!this.#started && chunk.length > 0) {
      this.#started = true;
      if (chunk.charCodeAt(0) === 0xfeff) {
        chunk = chunk.slice(1);
      }
    }
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    let start = 0;
    // One line terminator: CRLF, LF or CR. Local, so no state is shared.
    const lineEnd = /\r\n|\n|\r/g;
    for (let match = lineEnd.exec(this.#buffer); match; match = lineEnd.exec(this.#buffer)) {
      // A CR at the very end may be the first half of a CRLF: wait for more.
      if (match[0] === "\r" && match.index === this.#buffer.length - 1) {
        break;
      }
      const event = this.#line(this.#buffer.slice(start, match.index));
      if (event) {
        events.push(event);
      }
      start = match.index + match[0].length;
    }
    this.#buffer = this.#buffer.slice(start);
    return events;
  }

  /**
   * Ends the stream. A pending CR still ends its line, which can be the
   * blank line that dispatches an event. An event without its closing blank
   * line is discarded, as the standard requires.
   *
   * @returns The event dispatched by a pending CR, if any.
   */
  finish(): SseEvent[] {
    const pending = this.#buffer.endsWith("\r") ? this.#line(this.#buffer.slice(0, -1)) : undefined;
    this.#buffer = "";
    this.#data = "";
    this.#hasData = false;
    this.#type = "";
    return pending ? [pending] : [];
  }

  #line(line: string): SseEvent | undefined {
    if (line === "") {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.#type = value;
        break;
      case "data":
        this.#data += this.#hasData ? `\n${value}` : value;
        this.#hasData = true;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.#lastId = value;
        }
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return undefined;
  }

  #dispatch(): SseEvent | undefined {
    const hasData = this.#hasData;
    const event: SseEvent = {
      event: this.#type === "" ? "message" : this.#type,
      data: this.#data,
      ...(this.#lastId === undefined ? {} : { id: this.#lastId }),
    };
    this.#data = "";
    this.#hasData = false;
    this.#type = "";
    return hasData ? event : undefined;
  }
}

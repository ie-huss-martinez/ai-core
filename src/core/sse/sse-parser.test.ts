import { describe, expect, it } from "vitest";
import { type SseEvent, SseParser } from "./sse-parser.js";

function parse(...chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  return [...events, ...parser.finish()];
}

/**
 * A stream in the shape Anthropic documents (ADR 0005): named events, a
 * ping, a comment, CRLF and LF line ends, and multi-byte text.
 */
const STREAM = [
  ": keep-alive comment",
  "event: message_start",
  'data: {"type":"message_start"}',
  "",
  "event: ping",
  'data: {"type": "ping"}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"text":"Grüße, 世界 👋"}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\r\n");

describe("SseParser", () => {
  it("dispatches named events with their data", () => {
    expect(parse(STREAM).map(({ event }) => event)).toEqual([
      "message_start",
      "ping",
      "content_block_delta",
      "message_stop",
    ]);
    expect(parse(STREAM)[2]?.data).toBe(
      '{"type":"content_block_delta","delta":{"text":"Grüße, 世界 👋"}}',
    );
  });

  it('defaults the type to "message", and joins data lines with newlines', () => {
    expect(parse("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("accepts CRLF, LF and CR line ends, mixed", () => {
    expect(parse("data: a\r\n\r\ndata: b\n\ndata: c\r\r")).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
      { event: "message", data: "c" },
    ]);
  });

  it("drops exactly one space after the colon", () => {
    expect(parse("data:a\n\ndata: a\n\ndata:  a\n\n").map(({ data }) => data)).toEqual([
      "a",
      "a",
      " a",
    ]);
  });

  it("treats a line without a colon as a field with an empty value", () => {
    expect(parse("data\n\n")).toEqual([{ event: "message", data: "" }]);
  });

  it("ignores comments, unknown fields and retry", () => {
    expect(parse(": comment\nretry: 1000\nfoo: bar\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  it("dispatches nothing for an event without data, and resets its type", () => {
    expect(parse("event: ping\n\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("keeps the last event ID, unless it contains NULL", () => {
    expect(parse("id: 1\ndata: a\n\nid: 2\0\ndata: b\n\n")).toEqual([
      { event: "message", data: "a", id: "1" },
      { event: "message", data: "b", id: "1" },
    ]);
  });

  it("ignores a leading byte order mark", () => {
    expect(parse("﻿data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("discards an unfinished event at the end of the stream", () => {
    expect(parse("data: complete\n\ndata: cut off")).toEqual([
      { event: "message", data: "complete" },
    ]);
    expect(parse("data: no blank line\n")).toEqual([]);
  });

  it("waits for the next chunk when a chunk ends in CR", () => {
    // "\r" then "\n" is one CRLF, not two line ends that would dispatch early.
    expect(parse("data: a\r", "\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

describe("SseParser across chunk boundaries (ADR 0005)", () => {
  const whole = parse(STREAM);

  it("gives the same events wherever the text is split", () => {
    for (let at = 0; at <= STREAM.length; at += 1) {
      expect(parse(STREAM.slice(0, at), STREAM.slice(at)), `split at ${at}`).toEqual(whole);
    }
  });

  it("gives the same events one character at a time", () => {
    expect(parse(...STREAM)).toEqual(whole);
  });

  it("gives the same events when the bytes are split anywhere, inside characters too", () => {
    const bytes = new TextEncoder().encode(STREAM);
    for (let at = 0; at <= bytes.length; at += 1) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts = [
        decoder.decode(bytes.subarray(0, at), { stream: true }),
        decoder.decode(bytes.subarray(at), { stream: true }),
        decoder.decode(),
      ];
      expect(parse(...parts), `byte split at ${at}`).toEqual(whole);
    }
  });
});

#!/usr/bin/env python3
"""Generates ai-core's server-sent events framing vectors (sdk-core ADR 0045).

Writes conformance/hm-ai-sse-framing.json: how a byte stream of
text/event-stream becomes events, as both of ai-core's readers see it, the
adapters' and the browser transport's. Each case's expected events are
written by hand below, from the WHATWG HTML standard's rules for
interpreting an event stream
(https://html.spec.whatwg.org/multipage/server-sent-events.html), and never
from ai-core. This script only splits each case's bytes into chunks, in the
ways that matter: whole, at chosen byte offsets, at every offset, or one
byte at a time, so the vectors cover splits inside line terminators and
inside UTF-8 characters.

Run it by hand, from the repository root, with Python 3.9 or later and only
its standard library, then `pnpm lint --write` to format the file:

    python3 scripts/generate-sse-vectors.py

It's never run in CI: the vectors are checked in, and pnpm verify runs them.
"""
import base64
import json
import pathlib

OUT = pathlib.Path("conformance/hm-ai-sse-framing.json")


def ev(data, event="message", id=None):
    result = {"event": event, "data": data}
    if id is not None:
        result["id"] = id
    return result


def refused(reason):
    return {"error": {"code": "PROVIDER_RESPONSE_INVALID", "reason": reason}}


def b(text):
    return text.encode("utf-8") if isinstance(text, str) else text


# (name, bytes, expected events or a refusal, splits)
# splits: [] whole only; a list of offsets, each its own case; "every" for
# every offset; "bytes" for one byte per chunk.
CASES = [
    ("one event, LF line ends", "event: ping\ndata: {}\n\n", [ev("{}", "ping")], "every"),
    ("CRLF line ends", "event: a\r\ndata: 1\r\n\r\n", [ev("1", "a")], "every"),
    ("CR line ends", "event: a\rdata: 1\r\r", [ev("1", "a")], "every"),
    ("mixed line ends", "data: 1\r\n\ndata: 2\r\rdata: 3\n\r\n", [ev("1"), ev("2"), ev("3")], "every"),
    ("a CR at the end of a chunk, then LF, is one line end", "data: a\r\n\r\n", [ev("a")], [8, 9]),
    ("a CR at the end of a chunk, then another line, is a line end", "data: a\rdata: b\r\r", [ev("a\nb")], [8]),
    ("a CR at the very end of the stream still ends its line", "data: a\r\r", [ev("a")], [8]),
    ("a type without data dispatches nothing, and resets the type", "event: a\n\ndata: 1\n\n", [ev("1")], []),
    ("several data lines are joined with LF", "data: a\ndata: b\ndata:\n\n", [ev("a\nb\n")], []),
    ("one space after the colon is dropped, and only one", "data:x\n\ndata:  y\n\n", [ev("x"), ev(" y")], []),
    ("a line without a colon is a field with an empty value", "data\n\n", [ev("")], []),
    ("comments, retry and unknown fields are ignored", ": ping\nretry: 10\nfoo: bar\ndata: 1\n\n", [ev("1")], []),
    ("a lone colon line is a comment", ":\ndata: 1\n\n", [ev("1")], []),
    ("the last ID stays with later events", "id: 7\ndata: a\n\ndata: b\n\n", [ev("a", id="7"), ev("b", id="7")], []),
    ("an ID with NULL is ignored", "id: 1\ndata: a\n\nid: 2\u00003\ndata: b\n\n", [ev("a", id="1"), ev("b", id="1")], []),
    ("an empty ID resets it", "id: 1\ndata: a\n\nid\ndata: b\n\n", [ev("a", id="1"), ev("b", id="")], []),
    ("an event type keeps its trailing spaces", "event: a  \ndata: 1\n\n", [ev("1", "a  ")], []),
    ("an unfinished event at the end is discarded", "data: a\n\ndata: b\n", [ev("a")], []),
    ("an empty stream has no events", "", [], []),
    ("a leading byte order mark is ignored", "﻿data: 1\n\n", [ev("1")], [1, 2, 3]),
    ("a byte order mark after the start is data", "data: ﻿x\n\n", [ev("﻿x")], []),
    ("multi-byte characters, split anywhere", "data: é日\U0001F600\n\n", [ev("é日\U0001F600")], "every"),
    ("line and paragraph separators are data, not line ends", "data: a b c\n\n", [ev("a b c")], []),
    ("JSON data with escaped line breaks stays on one line", 'data: {"text":"a\\nb"}\n\n', [ev('{"text":"a\\nb"}')], []),
    ("one byte per chunk", "event: part\r\ndata: {\"t\":\"é\"}\r\n\r\n", [ev('{"t":"é"}', "part")], "bytes"),
    ("invalid UTF-8 is refused", b"data: \xff\n\n", refused("invalid-utf8"), []),
    ("an overlong encoding is refused", b"data: \xc0\x80\n\n", refused("invalid-utf8"), []),
    ("an encoded surrogate is refused", b"data: \xed\xa0\x80\n\n", refused("invalid-utf8"), []),
    ("a stream that ends inside a character is refused", b"data: \xe6\x97", refused("truncated-utf8"), []),
]


def chunked(data, offsets):
    pieces, last = [], 0
    for offset in offsets:
        pieces.append(data[last:offset])
        last = offset
    pieces.append(data[last:])
    return [base64.b64encode(piece).decode("ascii") for piece in pieces]


cases = []
for name, text, expected, splits in CASES:
    data = b(text)
    expected = expected if isinstance(expected, dict) else {"events": expected}
    cases.append({"name": name, "input": {"chunks": chunked(data, [])}, "expected": expected})
    if splits == "every":
        offsets = [[n] for n in range(1, len(data))]
    elif splits == "bytes":
        offsets = [list(range(1, len(data)))]
    else:
        offsets = [[n] for n in splits]
    for split in offsets:
        label = "one byte per chunk" if splits == "bytes" else f"split at byte {split[0]}"
        if splits == "bytes":
            cases[-1]["name"] = f"{name}, whole"
        cases.append({"name": f"{name}, {label}", "input": {"chunks": chunked(data, split)}, "expected": expected})

doc = {
    "format": "hm-conformance",
    "version": 1,
    "subject": "hm-ai-sse-framing",
    "description": "How text/event-stream bytes become events, as ai-core's readers see them (docs/formats/hm-ai-protocol.md, Framing). input.chunks are the body's chunks in order, each as base64. expected.events are the events dispatched, each with its type in event, its data, and the last ID when one was set, or the rejection's code and reason. The expected events are written by hand from the WHATWG rules; scripts/generate-sse-vectors.py only splits the bytes.",
    "cases": cases,
}
OUT.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
print(len(cases))

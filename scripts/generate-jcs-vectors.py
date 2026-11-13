#!/usr/bin/env python3
"""Generates ai-core's JCS conformance vectors (sdk-core ADR 0045).

Writes conformance/hm-ai-canonical-json.json and
conformance/hm-ai-context-hash.json. Their expected values never come from
ai-core:

- the RFC cases are RFC 8785's own samples, read from the RFC's text, with
  assertions that each sample appears there verbatim, and that the section
  3.2.4 bytes are the UTF-8 of the section 3.2.3 canonical form;
- the context-hash cases come from the small canonicaliser below, written
  independently of ai-core's, which sorts keys by UTF-16 code units.

Run it by hand, from the repository root, with Python 3.9 or later and only
its standard library:

    python3 scripts/generate-jcs-vectors.py [--rfc rfc8785.txt]

Without --rfc, it downloads https://www.rfc-editor.org/rfc/rfc8785.txt. It's
never run in CI: the vectors are checked in, and pnpm verify runs them.
Then run `pnpm lint --write`, which formats the files as the repository does.
Regenerating gives identical files unless a case is added or changed.
"""
import argparse
import hashlib
import json
import pathlib
import re
import urllib.request

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--rfc", help="a local copy of rfc8785.txt")
parser.add_argument("--out", default="conformance", help="the output directory")
args = parser.parse_args()
out = pathlib.Path(args.out)
if args.rfc:
    rfc = pathlib.Path(args.rfc).read_text(encoding="utf-8")
else:
    with urllib.request.urlopen("https://www.rfc-editor.org/rfc/rfc8785.txt") as response:
        rfc = response.read().decode("utf-8")

# --- RFC 8785 samples, verbatim from the RFC text -------------------------
sample_text = (
    '{\n'
    '  "numbers": [333333333.33333329, 1E30, 4.50,\n'
    '              2e-3, 0.000000000000000000000000001],\n'
    '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n'
    '  "literals": [null, true, false]\n'
    '}'
)
# Check the sample against the RFC's own lines (ignoring indentation).
for line in ['"numbers": [333333333.33333329, 1E30, 4.50,', '2e-3, 0.000000000000000000000000001],',
             '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",', '"literals": [null, true, false]']:
    assert line in rfc, line
# Section 3.2.3's canonical form, printed with a line wrap "for display purposes only".
canonical_323 = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
assert '{"literals":[null,true,false],"numbers":[333333333.3333333,' in rfc
assert '1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}' in rfc
# Section 3.2.4's UTF-8 bytes of that canonical form.
m = re.search(r"following bytes, here shown in hexadecimal notation:\n(.*?)\n\n4\.", rfc, re.S)
hex_324 = "".join(
    token
    for line in m.group(1).splitlines()
    if re.fullmatch(r"\s*([0-9a-f]{2} ?)+\s*", line)
    for token in line.split()
)
assert bytes.fromhex(hex_324).decode("utf-8") == canonical_323, "3.2.4 bytes must be 3.2.3's canonical form"

sorting_text = (
    '{\n'
    '  "\\u20ac": "Euro Sign",\n'
    '  "\\r": "Carriage Return",\n'
    '  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n'
    '  "1": "One",\n'
    '  "\\ud83d\\ude00": "Emoji: Grinning Face",\n'
    '  "\\u0080": "Control",\n'
    '  "\\u00f6": "Latin Small Letter O With Diaeresis"\n'
    '}'
)
for line in sorting_text.splitlines()[1:-1]:
    assert line.strip() in rfc, line
order = ["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign",
         "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"]
keys = {"Carriage Return": "\\r", "One": "1", "Control": "\u0080", "Latin Small Letter O With Diaeresis": "ö",
        "Euro Sign": "€", "Emoji: Grinning Face": "\U0001F600", "Hebrew Letter Dalet With Dagesh": "דּ"}
canonical_sorting = "{" + ",".join(f'"{keys[v]}":"{v}"' for v in order) + "}"

table = re.findall(r"\| ([0-9a-f]{16}) \| (\S*)\s+\|\s*([^|]*?)\s*\|", rfc)
assert len(table) == 26, len(table)

jcs_cases = [
    {"name": "RFC 8785 3.2.2 and 3.2.3: the sample, parsed and canonicalised",
     "input": {"jsonText": sample_text}, "expected": canonical_323},
    {"name": "RFC 8785 3.2.4: the sample's canonical form as UTF-8 bytes",
     "input": {"jsonText": sample_text, "output": "utf8-hex"}, "expected": hex_324},
    {"name": "RFC 8785 3.2.3: property names sorted by UTF-16 code units",
     "input": {"jsonText": sorting_text}, "expected": canonical_sorting},
    {"name": "RFC 8785 3.2.3: \"\", \"a\", \"aa\", \"ab\" in that order",
     "input": {"jsonText": '{"ab":4,"aa":3,"a":2,"":1}'}, "expected": '{"":1,"a":2,"aa":3,"ab":4}'},
]
for ieee, text, comment in table:
    label = comment.split("(")[0].strip() or "sample"
    name = f"RFC 8785 Appendix B: {ieee} ({label})"
    if text:
        jcs_cases.append({"name": name, "input": {"ieee754": ieee}, "expected": text})
    else:
        jcs_cases.append({"name": f"{name} is refused", "input": {"ieee754": ieee},
                          "expected": {"error": {"code": "PREPARE_FAILED", "reason": "non-json-settings"}}})
jcs_cases.append({"name": "RFC 8785 3.2.2.2: a lone surrogate, U+DEAD, is refused",
                  "input": {"jsonText": '"\\udead"'},
                  "expected": {"error": {"code": "PREPARE_FAILED", "reason": "non-json-settings"}}})
jcs_cases.append({"name": "a lone surrogate in a property name is refused",
                  "input": {"jsonText": '{"\\ud800":1}'},
                  "expected": {"error": {"code": "PREPARE_FAILED", "reason": "non-json-settings"}}})

jcs = {"format": "hm-conformance", "version": 1, "subject": "hm-ai-canonical-json",
       "description": "The JSON Canonicalization Scheme (RFC 8785) as ai-core implements it for the context hash (docs/formats/hm-ai-context-hash.md). input is jsonText, JSON text to parse and canonicalise, or ieee754, the hex bits of one double. expected is the canonical JSON text, its UTF-8 bytes in hex when output is utf8-hex, or the rejection. The RFC cases are its own samples, verbatim.",
       "cases": jcs_cases}

# --- the context hash, with an independent canonicaliser -----------------
def jcs_py(v):
    if v is None: return "null"
    if v is True: return "true"
    if v is False: return "false"
    if isinstance(v, int): return str(v)
    if isinstance(v, float):
        r = repr(v)
        assert r in ("0.5",), r  # only floats whose ECMAScript and Python forms agree
        return r
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list): return "[" + ",".join(jcs_py(x) for x in v) + "]"
    keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs_py(v[k]) for k in keys) + "}"

def hashed(name, inp):
    tools = [{k: t[k] for k in ("name", "description", "inputSchema") if k in t} for t in inp.get("tools", [])]
    canon = jcs_py({"system": inp.get("system"), "tools": tools})
    return {"name": name, "input": inp,
            "expected": {"canonical": canon, "sha256": hashlib.sha256(canon.encode("utf-8")).hexdigest()}}

look = {"name": "look", "description": "Looks something up.",
        "inputSchema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string", "maxLength": 200}}}}
other = {"name": "other", "inputSchema": {"type": "object"}}
refused = {"error": {"code": "PREPARE_FAILED", "reason": "non-json-settings"}}
hash_cases = [
    hashed("no system prompt and no tools", {}),
    hashed("an empty system prompt, which differs from none", {"system": ""}),
    hashed("a system prompt with escapes, control characters and non-ASCII text",
           {"system": "Be brief.\n\t\"Quote\" \\ café 日本 \U0001F600 \u0007  "}),
    hashed("an empty list of tools, the same as none", {"tools": []}),
    hashed("tools in order, with keys sorted at every level", {"system": "Be brief.", "tools": [look, other]}),
    hashed("the same tools in the other order give another hash", {"system": "Be brief.", "tools": [other, look]}),
    hashed("a tool without a description", {"tools": [other]}),
    hashed("hostile keys are ordinary keys",
           {"tools": [{"name": "keys", "inputSchema": {"type": "object", "properties": {
               "__proto__": {"type": "string"}, "constructor": {"type": "number"}, "toString": {"type": "boolean"}}}}]}),
    hashed("keys are sorted by UTF-16 code units, not code points",
           {"tools": [{"name": "unicode", "inputSchema": {"דּ": 1, "\U0001F600": 2, "ö": 3, "z": 4}}]}),
    hashed("numbers as ECMAScript writes them", {"tools": [{"name": "n", "inputSchema": {"minimum": 0, "maximum": 100, "multipleOf": 0.5}}]}),
    {"name": "a system prompt with a lone surrogate is refused", "input": {"system": "\ud800"}, "expected": refused},
    {"name": "a tool schema key with a lone surrogate is refused",
     "input": {"tools": [{"name": "bad", "inputSchema": {"\udc00": 1}}]}, "expected": refused},
]
# The two orders must differ, and the empty list must equal none.
assert hash_cases[4]["expected"]["sha256"] != hash_cases[5]["expected"]["sha256"]
assert hash_cases[0]["expected"] == hash_cases[3]["expected"]
hashfile = {"format": "hm-conformance", "version": 1, "subject": "hm-ai-context-hash",
            "description": "The context hash (docs/formats/hm-ai-context-hash.md): input is the system prompt and tools that prepare returned, and expected is their canonical JSON and its SHA-256, or the rejection. The expected values come from an implementation independent of ai-core's.",
            "cases": hash_cases}

for name, doc in [("hm-ai-canonical-json.json", jcs), ("hm-ai-context-hash.json", hashfile)]:
    (out / name).write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
print(len(jcs_cases), len(hash_cases))

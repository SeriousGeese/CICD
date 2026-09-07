#!/usr/bin/env python3
"""Extract structured fixes JSON from an LLM API response file.

Usage: extract-fixes.py <llm_response_file>

The LLM response file should contain the full JSON response from the
API (choices[0].message.content). This script extracts the embedded
JSON fixes object.
"""
import sys
import json
import re


def as_fixes_dict(parsed):
    """Coerce a parsed JSON value to a fixes dict, or None if it isn't one.

    The caller pipes the result through `jq 'has("fixes")'`, which errors on a
    non-object — so returning a bare array/string here used to short-circuit
    the later strategies (including the plain-text "clean review" fallback)
    and reject the whole tier. A bare list of fix objects is common LLM
    formatting drift; wrap it instead of discarding the response.
    """
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, list) and all(isinstance(x, dict) for x in parsed):
        return {"fixes": parsed}
    return None


def extract_fixes(llm_response: dict) -> dict:
    """Extract the fixes JSON from an LLM response dict."""
    try:
        content = llm_response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return {}

    if not content:
        return {}

    # Strategy 1: Extract from ```json ... ``` code blocks
    m = re.search(r"```json\n?(.*?)\n?```", content, re.DOTALL)
    if m:
        raw = m.group(1).strip()
        try:
            result = as_fixes_dict(json.loads(raw))
            if result is not None:
                return result
        except json.JSONDecodeError:
            pass

    # Strategy 2: Try parsing the entire response as JSON
    try:
        result = as_fixes_dict(json.loads(content))
        if result is not None:
            return result
    except json.JSONDecodeError:
        pass

    # Strategy 3: Find any JSON object with a "fixes" key
    m = re.search(r"\{.*\"fixes\".*\}", content, re.DOTALL)
    if m:
        raw = m.group(0).strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass

    # Strategy 4: scan for embedded JSON objects with raw_decode (linear per
    # candidate brace, unlike re-parsing every prefix length)
    decoder = json.JSONDecoder()
    idx = content.find("{")
    while idx != -1:
        try:
            parsed, _ = decoder.raw_decode(content, idx)
            if isinstance(parsed, dict) and "fixes" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass
        idx = content.find("{", idx + 1)

    # Strategy 5: fallback — no JSON found but content is non-empty.
    # The LLM responded with plain text ("Good job!", "LGTM", etc.) which is a
    # valid "no fixes needed" review. Return an empty fixes array so the caller
    # can distinguish "reviewed and clean" from "extractor completely failed".
    if content.strip():
        return {"fixes": [], "summary": content.strip()[:500]}

    return {}


def main():
    if len(sys.argv) < 2:
        print("{}")
        return

    path = sys.argv[1]
    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError, IOError):
        print("{}")
        return

    result = extract_fixes(data)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
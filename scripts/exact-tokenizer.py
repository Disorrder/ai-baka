# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "tiktoken==0.14.0",
# ]
# ///
"""Trusted exact-token JSON protocol for ai-baka.

Invocation (argv, without a shell):

    uv run --quiet --script scripts/exact-tokenizer.py

stdin is exactly one JSON object: ``{"model":"...","texts":["..."]}``.
On success stdout is exactly one JSON object: ``{"counts":[...]}``.

The first invocation may need network access twice: uv resolves/downloads the
pinned Python dependency into its cache, and tiktoken may download the selected
encoding vocabulary into its own cache. Subsequent invocations reuse both
caches; ``uv run --offline`` can then enforce offline dependency resolution.

Errors never echo model or text content. There is deliberately no encoding
fallback: an unknown model makes ``tiktoken.encoding_for_model`` fail closed.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
from dataclasses import dataclass
from typing import NoReturn

import tiktoken


PROTOCOL_ID = "ai-baka-exact-tokenizer"
PROTOCOL_VERSION = 1
SCRIPT_VERSION = 1
TIKTOKEN_VERSION = "0.14.0"
MAX_BATCH_SIZE = 1_000


@dataclass(frozen=True, slots=True)
class ProtocolError(Exception):
    code: str


def fail(code: str, exit_code: int) -> NoReturn:
    """Emit only a stable non-content error marker."""

    sys.stderr.write(f"{PROTOCOL_ID}:error:{code}\n")
    raise SystemExit(exit_code)


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("duplicate-key")
        result[key] = value
    return result


def reject_non_json_constant(_value: str) -> NoReturn:
    raise ProtocolError("invalid-json")


def parse_request(raw: bytes) -> tuple[str, list[str]]:
    if not raw:
        raise ProtocolError("empty-input")
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProtocolError("invalid-utf8") from error
    try:
        request = json.loads(
            source,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_non_json_constant,
        )
    except ProtocolError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ProtocolError("invalid-json") from error

    if type(request) is not dict:
        raise ProtocolError("request-not-object")
    if set(request) != {"model", "texts"}:
        raise ProtocolError("invalid-fields")

    model = request["model"]
    texts = request["texts"]
    if type(model) is not str or not model or model != model.strip():
        raise ProtocolError("invalid-model")
    if any(ord(character) < 0x20 for character in model):
        raise ProtocolError("invalid-model")
    if type(texts) is not list:
        raise ProtocolError("texts-not-array")
    if len(texts) > MAX_BATCH_SIZE:
        raise ProtocolError("batch-too-large")
    if any(type(text) is not str for text in texts):
        raise ProtocolError("text-not-string")
    return model, texts


def resolve_encoding(model: str) -> tiktoken.Encoding:
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError as error:
        # No get_encoding/model-prefix guess: the requested model must be one
        # tiktoken 0.14.0 explicitly knows how to resolve.
        raise ProtocolError("unknown-model") from error
    except Exception as error:
        raise ProtocolError("encoding-resolution-failed") from error


def count(model: str, texts: list[str]) -> list[int]:
    encoding = resolve_encoding(model)
    try:
        # Embedding input is ordinary text. Special-looking substrings must be
        # tokenized as text, not interpreted as injected control tokens.
        return [len(encoding.encode(text, disallowed_special=())) for text in texts]
    except Exception as error:
        raise ProtocolError("tokenization-failed") from error


def version_payload() -> dict[str, object]:
    installed = importlib.metadata.version("tiktoken")
    if installed != TIKTOKEN_VERSION:
        raise ProtocolError("dependency-version-mismatch")
    return {
        "id": PROTOCOL_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "scriptVersion": SCRIPT_VERSION,
        "package": {"name": "tiktoken", "version": installed},
        "resolver": "encoding_for_model",
    }


def write_json(payload: object) -> None:
    sys.stdout.write(
        json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n"
    )


def main(argv: list[str]) -> int:
    try:
        if argv == ["--version"]:
            write_json(version_payload())
            return 0
        if argv:
            raise ProtocolError("invalid-arguments")
        # Verify the PEP 723 pin at runtime too: execution is fail-closed even
        # if a non-uv runner supplies a different tiktoken installation.
        version_payload()
        model, texts = parse_request(sys.stdin.buffer.read())
        write_json({"counts": count(model, texts)})
        return 0
    except ProtocolError as error:
        fail(error.code, 65)
    except KeyboardInterrupt:
        fail("interrupted", 130)
    except Exception:
        # Never serialize exception details: they can contain input content.
        fail("internal-error", 70)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

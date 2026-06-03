"""Extract deterministic page chunks from a PDF into an atomic JSON artifact."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import pymupdf


MAX_CHUNK_CHARS = 1200


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _chunks(text: str) -> list[str]:
    return [text[offset : offset + MAX_CHUNK_CHARS] for offset in range(0, len(text), MAX_CHUNK_CHARS)]


def parse_pdf(source: Path) -> list[dict[str, object]]:
    paper_id = hashlib.sha256(source.read_bytes()).hexdigest()
    chunks: list[dict[str, object]] = []
    with pymupdf.open(source) as document:
        for page_number, page in enumerate(document, start=1):
            text = _normalize(page.get_text())
            for ordinal, chunk_text in enumerate(_chunks(text), start=1):
                chunks.append(
                    {
                        "paperId": paper_id,
                        "chunkId": f"p{page_number}-c{ordinal}",
                        "page": page_number,
                        "text": chunk_text,
                    }
                )
    return chunks


def write_json_atomic(output: Path, payload: object) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, ensure_ascii=False)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, output)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main(arguments: list[str]) -> int:
    if len(arguments) != 2:
        print("usage: python parse_pdf.py <source.pdf> <output.json>", file=sys.stderr)
        return 2

    source, output = map(Path, arguments)
    try:
        write_json_atomic(output, parse_pdf(source))
    except Exception as error:
        print(f"failed to parse PDF: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

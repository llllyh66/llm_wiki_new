#!/usr/bin/env python3
"""Small, stdout-safe bridge for the optional knowledgestack excel-parser."""

from __future__ import annotations

import json
import sys
import contextlib
import io
from pathlib import Path


def main() -> int:
    request = json.load(sys.stdin)
    from excel_parser.pipeline import parse_workbook

    captured_stdout = io.StringIO()
    with contextlib.redirect_stdout(captured_stdout):
        result = parse_workbook(
            path=Path(request["input_path"]),
            filename=request.get("filename"),
            max_cells_per_sheet=int(request.get("max_cells_per_sheet", 250000)),
            max_chunk_tokens=int(request.get("max_chunk_tokens", 700)),
        )
    if captured_stdout.getvalue():
        print(captured_stdout.getvalue(), file=sys.stderr, end="")
    payload = result.to_json()
    output_path = Path(request["output_path"])
    output_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"ok": True, "output_path": str(output_path)}, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}, ensure_ascii=False, separators=(",", ":")))
        raise

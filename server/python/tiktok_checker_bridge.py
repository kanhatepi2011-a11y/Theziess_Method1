#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import json
import sys
from dataclasses import asdict

from tiktok_checker import CheckerError, process_source


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "code": "MISSING_SOURCE", "error": "Missing TikTok URL."}))
        return 2

    source = sys.argv[1]
    try:
        # tiktok_checker prints progress. Keep stdout clean so Node can parse JSON.
        with contextlib.redirect_stdout(sys.stderr):
            report = process_source(source)
        payload = asdict(report)
        payload["resolution"] = report.resolution
        print(json.dumps({"ok": True, "report": payload}, ensure_ascii=False))
        return 0
    except CheckerError as exc:
        print(json.dumps({"ok": False, "code": "PYTHON_CHECKER_ERROR", "error": str(exc)}, ensure_ascii=False))
        return 3
    except Exception as exc:
        print(json.dumps({"ok": False, "code": "PYTHON_CHECKER_FAILED", "error": str(exc)}, ensure_ascii=False))
        return 4


if __name__ == "__main__":
    raise SystemExit(main())

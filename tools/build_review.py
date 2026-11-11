#!/usr/bin/env python3
"""Build a self-contained review bundle of the AICS app.

Usage: python3 tools/build_review.py OUT_DIR

The bundle is the app as it ships, adapted for sandboxed preview hosts
(e.g. a claude.ai Artifact): the document skeleton is removed (the host adds
its own), the title is shortened, and the service worker is not registered
because sandboxed frames refuse service workers. Supporting files are copied
alongside so the in-app file viewer can load them.
"""
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [
    "shield/shield.js", "robots.txt", "ai.txt", "llms.txt",
    ".well-known/tdmrep.json", "sw.js", "_headers", "edge/worker.js",
    "app/app.css", "app/store.js", "app/billing.js", "app/legal.js", "app/app.js",
]


def build_page(html: str) -> str:
    for pat in (r"<!DOCTYPE html>\s*", r"<html[^>]*>\s*", r"<head>\s*", r"</head>\s*",
                r"<body>\s*", r"</body>\s*", r"</html>\s*",
                r'<meta charset="UTF-8">\s*', r'<meta name="viewport"[^>]*>\s*'):
        html = re.sub(pat, "", html, count=1, flags=re.I)
    html = re.sub(r"<title>.*?</title>", "<title>AI Copyright Shield</title>", html, count=1)
    html = html.replace('        data-sw="sw.js"></script>', "></script>")
    html = html.replace("<style>", "<style>\n:root{color-scheme:dark}", 1)
    return html


def main(out: str) -> None:
    out_dir = pathlib.Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    page = build_page((ROOT / "index.html").read_text(encoding="utf-8"))
    (out_dir / "index.html").write_text(page, encoding="utf-8")
    for f in FILES:
        dst = out_dir / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / f, dst)
    print(f"review build written to {out_dir} ({len(page):,} bytes page + {len(FILES)} files)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

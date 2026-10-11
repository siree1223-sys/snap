"""Builds the deployable Snap Diary site into dist/snap-diary/.

- copies snap-diary/ (minus development-only files)
- stamps sw.js with a content hash so each release is one atomic offline cache
- checks that the service worker's SHELL list matches the shipped files

Usage (repo root, Python 3.9+):  python3 scripts/build-diary.py
"""
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "snap-diary"
OUT = ROOT / "dist" / "snap-diary"
SKIP = {"package.json", "README.md"}
SHELL_DIRS = ("js", "css", "icons")


def fail(message):
    print(f"build-diary: {message}", file=sys.stderr)
    sys.exit(1)


def main():
    files = sorted(p for p in SRC.rglob("*") if p.is_file() and p.name not in SKIP and not p.name.startswith("."))
    digest = hashlib.sha256()
    for path in files:
        digest.update(str(path.relative_to(SRC)).encode())
        digest.update(path.read_bytes())
    build = digest.hexdigest()[:12]

    sw = (SRC / "sw.js").read_text(encoding="utf-8")
    listed = set(re.findall(r'"\./([^"]*)"', sw.split("const SHELL = [", 1)[1].split("];", 1)[0]))
    listed.discard("")
    shipped = {str(p.relative_to(SRC)) for p in files if p.parts[len(SRC.parts)] in SHELL_DIRS}
    shipped |= {"index.html", "manifest.webmanifest", "config.js"}
    if listed != shipped:
        fail(f"sw.js SHELL mismatch. missing: {sorted(shipped - listed)} extra: {sorted(listed - shipped)}")
    if '"__BUILD__"' not in sw:
        fail("sw.js has no __BUILD__ placeholder")

    if OUT.exists():
        shutil.rmtree(OUT)
    for path in files:
        target = OUT / path.relative_to(SRC)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    (OUT / "sw.js").write_text(sw.replace('"__BUILD__"', f'"{build}"'), encoding="utf-8")
    (OUT / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    print(f"built {len(files)} files into {OUT.relative_to(ROOT)} (build {build})")


if __name__ == "__main__":
    main()

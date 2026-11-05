#!/usr/bin/env python3
"""Build the Windows self-extracting installer only (no RPM/deb tooling needed).

Usage:
  ./build.sh --cross
  python3 packaging/build-crx.py
  python3 packaging/build-windows.py
"""
from __future__ import annotations

import shutil

import build


def main() -> int:
    if not (build.DIST / "chrome" / "manifest.json").is_file():
        raise SystemExit("Нет dist/chrome. Запустите ./build.sh --cross")
    if not build.go_binary():
        raise SystemExit("Go не найден. Установите Go 1.27+ или задайте GO=/path/to/go.")

    build.BUILD.mkdir(parents=True, exist_ok=True)
    build.RELEASE.mkdir(parents=True, exist_ok=True)

    for arch in ("amd64", "arm64"):
        print(f"=== windows {arch} ===")
        payload = build.make_payload("windows", arch)
        installer = build.build_installer("windows", arch, payload)
        out = build.RELEASE / f"EXA-Switch-Setup-windows-{arch}.exe"
        build.append_payload(installer, payload, out)
        print("  ->", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

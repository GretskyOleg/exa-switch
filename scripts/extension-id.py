#!/usr/bin/env python3
"""Print the Chrome extension ID derived from the manifest "key" field."""
import base64
import hashlib
import json
import pathlib
import sys


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    manifest = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "extension" / "manifest.chrome.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    key = data.get("key")
    if not key:
        print("manifest has no key", file=sys.stderr)
        return 1
    der = base64.b64decode(key)
    digest = hashlib.sha256(der).digest()[:16]
    ext_id = "".join(
        chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 0x0F)) for byte in digest
    )
    print(ext_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

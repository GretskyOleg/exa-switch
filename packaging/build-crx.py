#!/usr/bin/env python3
"""Build a signed CRX3 package for Chrome/Chromium/Edge/Brave/Vivaldi.

The signing key lives in packaging/.keys/chrome.pem. Its public key is written
into extension/manifest.chrome.json, so the unpacked extension ID, the CRX ID
and native-messaging allowed_origins always match.

Usage:
  ./build.sh --no-helper          # refresh dist/chrome after manifest changes
  python3 packaging/build-crx.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

import build

KEY = build.ROOT / "packaging" / ".keys" / "chrome.pem"
PUB_PEM = build.ROOT / "packaging" / ".keys" / "chrome.pub.pem"
OUT = build.RELEASE / "exa-switch-chrome.crx"


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, **kwargs)


def public_der() -> bytes:
    if not KEY.is_file():
        raise SystemExit(f"Нет ключа {KEY}. Сгенерируйте: openssl genrsa -out {KEY} 2048")
    result = run(["openssl", "rsa", "-in", str(KEY), "-pubout", "-outform", "DER"])
    return result.stdout


def public_pem() -> bytes:
    return run(["openssl", "rsa", "-in", str(KEY), "-pubout"]).stdout


def ext_id(der: bytes) -> str:
    digest = hashlib.sha256(der).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0x0F)) for b in digest)


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def field_bytes(field: int, data: bytes) -> bytes:
    return varint((field << 3) | 2) + varint(len(data)) + data


def sync_manifest(der: bytes) -> None:
    manifest = build.ROOT / "extension" / "manifest.chrome.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["key"] = base64.b64encode(der).decode("ascii")
    manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def check_constants(identifier: str) -> None:
    checks = [
        ("helper/api.go", f'const chromeExtensionID = "{identifier}"'),
        ("packaging/installer/main.go", f'chromeID       = "{identifier}"'),
    ]
    for rel, needle in checks:
        text = (build.ROOT / rel).read_text(encoding="utf-8")
        if needle not in text:
            raise SystemExit(
                f"Chrome ID {identifier} не совпадает с константой в {rel}.\n"
                f"Обновите её вручную или пересоберите helper/installer."
            )


def main() -> int:
    if not shutil.which("openssl"):
        raise SystemExit("Нужен openssl")
    chrome_dir = build.DIST / "chrome"
    if not (chrome_dir / "manifest.json").is_file():
        raise SystemExit("Нет dist/chrome. Сначала запустите ./build.sh --no-helper")

    der = public_der()
    identifier = ext_id(der)
    sync_manifest(der)
    check_constants(identifier)
    if not (chrome_dir / "manifest.json").is_file():
        raise SystemExit("Нет dist/chrome/manifest.json")

    # The manifest key may have just changed; make sure dist/chrome matches.
    dist_manifest = json.loads((chrome_dir / "manifest.json").read_text(encoding="utf-8"))
    if dist_manifest.get("key") != base64.b64encode(der).decode("ascii"):
        run([str(build.ROOT / "build.sh"), "--no-helper"])

    build.RELEASE.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = pathlib.Path(tmp)
        zip_path = tmpdir / "extension.zip"
        build.zip_root(chrome_dir, zip_path)
        zip_bytes = zip_path.read_bytes()

        crx_id = hashlib.sha256(der).digest()[:16]
        signed_header_data = field_bytes(1, crx_id)
        data_to_sign = (
            b"CRX3 SignedData\x00"
            + struct.pack("<I", len(signed_header_data))
            + signed_header_data
            + zip_bytes
        )
        data_file = tmpdir / "signed-data.bin"
        sig_file = tmpdir / "signature.bin"
        data_file.write_bytes(data_to_sign)
        run(["openssl", "dgst", "-sha256", "-sign", str(KEY), "-out", str(sig_file), str(data_file)])
        signature = sig_file.read_bytes()

        if not PUB_PEM.exists():
            PUB_PEM.write_bytes(public_pem())
            PUB_PEM.chmod(0o600)
        verify = run(
            ["openssl", "dgst", "-sha256", "-verify", str(PUB_PEM), "-signature", str(sig_file), str(data_file)]
        )
        if b"Verified OK" not in verify.stdout:
            raise SystemExit("Подпись CRX не прошла проверку")

        proof = field_bytes(1, der) + field_bytes(2, signature)
        header = field_bytes(2, proof) + field_bytes(10000, signed_header_data)
        crx = b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_bytes
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_bytes(crx)
        (build.RELEASE / "chrome-id.txt").write_text(identifier + "\n", encoding="utf-8")

    print(f"CRX ID: {identifier}")
    print(f"CRX:    {OUT}")
    print(f"Size:   {OUT.stat().st_size / 1024 / 1024:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

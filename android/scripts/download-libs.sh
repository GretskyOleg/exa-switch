#!/usr/bin/env bash
# Download the prebuilt native cores used by the EXA Android app.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBS="$ROOT/app/libs"
mkdir -p "$LIBS"

LIBV2RAY_TAG="v26.10.31"
HEV_TAG="2.19.3"

if [ ! -f "$LIBS/libv2ray.aar" ]; then
  echo "→ libv2ray.aar ($LIBV2RAY_TAG)"
  curl -fL --retry 3 -o "$LIBS/libv2ray.aar" \
    "https://github.com/2dust/AndroidLibXrayLite/releases/download/${LIBV2RAY_TAG}/libv2ray.aar"
fi

if [ ! -f "$LIBS/hev-socks5-tunnel.aar" ]; then
  echo "→ hev-socks5-tunnel.aar ($HEV_TAG)"
  curl -fL --retry 3 -o "$LIBS/hev-socks5-tunnel.aar" \
    "https://github.com/heiher/hev-socks5-tunnel/releases/download/${HEV_TAG}/hev-socks5-tunnel.aar"
fi

ls -lh "$LIBS"/*.aar

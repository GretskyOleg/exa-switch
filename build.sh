#!/usr/bin/env bash
# Build the Xray Switch helper and assemble unpacked extensions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${VERSION:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/extension/manifest.chrome.json")}"
GO_BIN="${GO:-go}"
CROSS=0
BUILD_HELPER=1
BUILD_EXTENSION=1

for arg in "$@"; do
  case "$arg" in
    --cross) CROSS=1 ;;
    --no-helper) BUILD_HELPER=0 ;;
    --no-extension) BUILD_EXTENSION=0 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./build.sh [--cross] [--no-helper] [--no-extension]

  --cross         build helper for linux/windows/macos (amd64 + arm64)
  --no-helper     assemble only the extensions
  --no-extension  build only helper binaries

Environment:
  GO=/path/to/go  override the Go compiler
  VERSION=x.y.z   override the version written into the helper
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$ROOT/dist/helper"

build_helper() {
  local goos="$1" goarch="$2" out="$3" ext=""
  if [ "$goos" = "windows" ]; then ext=".exe"; fi
  echo "  → $out${ext} (${goos}/${goarch})"
  (
    cd "$ROOT/helper"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      "$GO_BIN" build -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.version=$VERSION" \
      -o "$ROOT/dist/helper/${out}${ext}" .
  )
}

if [ "$BUILD_HELPER" = "1" ]; then
  if ! command -v "$GO_BIN" >/dev/null 2>&1; then
    echo "Go не найден. Установите Go 1.27+ или задайте GO=/path/to/go." >&2
    echo "Готовые бинарники можно положить в dist/helper/ вручную." >&2
    exit 1
  fi
  echo "Building helper v$VERSION"
  build_helper "$("$GO_BIN" env GOOS)" "$("$GO_BIN" env GOARCH)" "xray-switch-helper"
  if [ "$CROSS" = "1" ]; then
    for target in linux/amd64 linux/arm64 windows/amd64 windows/arm64 darwin/amd64 darwin/arm64; do
      os="${target%/*}"
      arch="${target#*/}"
      build_helper "$os" "$arch" "xray-switch-helper-${os}-${arch}"
    done
  fi
fi

if [ "$BUILD_EXTENSION" = "1" ]; then
  echo "Assembling extensions"
  rm -rf "$ROOT/dist/chrome" "$ROOT/dist/firefox"
  mkdir -p "$ROOT/dist/chrome" "$ROOT/dist/firefox"

  cp -R "$ROOT/extension/." "$ROOT/dist/chrome/"
  rm -f "$ROOT/dist/chrome/manifest.chrome.json" "$ROOT/dist/chrome/manifest.firefox.json"
  cp "$ROOT/extension/manifest.chrome.json" "$ROOT/dist/chrome/manifest.json"

  cp -R "$ROOT/extension/." "$ROOT/dist/firefox/"
  rm -f "$ROOT/dist/firefox/manifest.chrome.json" "$ROOT/dist/firefox/manifest.firefox.json"
  cp "$ROOT/extension/manifest.firefox.json" "$ROOT/dist/firefox/manifest.json"

  python3 "$ROOT/scripts/extension-id.py" > "$ROOT/dist/chrome-id.txt"
  echo "Chrome extension ID: $(cat "$ROOT/dist/chrome-id.txt")"
fi

echo
echo "Готово."
echo "  Chrome:  dist/chrome"
echo "  Firefox: dist/firefox"
if [ "$BUILD_HELPER" = "1" ]; then
  echo "  Helper:  dist/helper/"
fi

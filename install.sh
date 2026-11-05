#!/usr/bin/env bash
# Install the Xray Switch helper + native messaging manifests for Chrome/Chromium/Firefox.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.oleg.xray_switch"
FIREFOX_ID="xray-switch@oleg.dev"
START=1

for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install.sh [--no-start]

Installs the helper to the user data directory and registers native messaging
for Chrome, Chromium, Brave, Edge, Vivaldi and Firefox.

  --no-start   do not start the helper after installation
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "Не запускайте install.sh через sudo: native messaging ставится в профиль пользователя." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Нужен python3 (для генерации JSON и ID расширения)." >&2
  exit 1
fi

UNAME="$(uname -s)"
case "$UNAME" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    echo "Для Windows используйте install.ps1. Для $UNAME установка не поддерживается." >&2
    exit 1
    ;;
esac

MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Неизвестная архитектура: $MACHINE" >&2; exit 1 ;;
esac

if [ "$OS" = "linux" ]; then
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/xray-switch"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/xray-switch"
else
  DATA_DIR="$HOME/Library/Application Support/xray-switch"
  CONFIG_DIR="$HOME/Library/Application Support/xray-switch"
fi
BIN="$DATA_DIR/xray-switch-helper"

# Pick a prebuilt binary, otherwise build the host binary.
SRC="$ROOT/dist/helper/xray-switch-helper-${OS}-${ARCH}"
if [ ! -f "$SRC" ] && [ "$OS" = "$(uname -s | tr '[:upper:]' '[:lower:]')" ] && [ "$ARCH" = "$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" ]; then
  SRC="$ROOT/dist/helper/xray-switch-helper"
fi
if [ ! -f "$SRC" ]; then
  echo "Не найден бинарник helper'а для ${OS}/${ARCH}." >&2
  echo "Соберите его:   ./build.sh --cross" >&2
  echo "Нужен Go 1.27+ (или положите готовый файл в dist/helper/)." >&2
  exit 1
fi

echo "Устанавливаю helper..."
mkdir -p "$DATA_DIR"
install -m 0755 "$SRC" "$BIN.new"
mv -f "$BIN.new" "$BIN"

# Stop a daemon that is still running from the previous binary.
"$BIN" stop >/dev/null 2>&1 || true

CHROME_ID="$(cat "$ROOT/dist/chrome-id.txt" 2>/dev/null || python3 "$ROOT/scripts/extension-id.py")"
[ -n "$CHROME_ID" ] || { echo "Не удалось определить Chrome extension ID" >&2; exit 1; }

write_manifest() {
  local dir="$1"
  local kind="$2"
  mkdir -p "$dir"
  python3 - "$BIN" "$CHROME_ID" "$FIREFOX_ID" "$HOST_NAME" "$kind" "$dir/$HOST_NAME.json" <<'PY'
import json, sys
exe, chrome_id, firefox_id, name, kind, out = sys.argv[1:7]
data = {
    "name": name,
    "description": "Xray Switch local helper (xray-core)",
    "path": exe,
    "type": "stdio",
}
if kind == "chrome":
    data["allowed_origins"] = ["chrome-extension://%s/" % chrome_id]
else:
    data["allowed_extensions"] = [firefox_id]
with open(out, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
PY
  echo "  ✓ $dir"
}

SYSTEMD_UNIT=0
if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/xray-switch.service" <<EOF
[Unit]
Description=EXA Switch helper (xray-core)
After=network.target

[Service]
Type=simple
ExecStart="$BIN" daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  SYSTEMD_UNIT=1
  echo "Устанавливаю systemd-службу: $UNIT_DIR/xray-switch.service"
fi

echo "Регистрирую native messaging..."
if [ "$OS" = "linux" ]; then
  CHROME_DIRS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/vivaldi/NativeMessagingHosts"
  )
  FIREFOX_DIRS=(
    "$HOME/.mozilla/native-messaging-hosts"
    "$HOME/.librewolf/native-messaging-hosts"
  )
else
  CHROME_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
  )
  FIREFOX_DIRS=(
    "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  )
fi

for dir in "${CHROME_DIRS[@]}"; do
  write_manifest "$dir" "chrome"
done
for dir in "${FIREFOX_DIRS[@]}"; do
  write_manifest "$dir" "firefox"
done

echo
echo "Native host: $HOST_NAME"
echo "Chrome ID:   $CHROME_ID"
echo "Firefox ID:  $FIREFOX_ID"
echo "Helper:      $BIN"

# ---- browser extensions (best effort, per-user) -------------------------
CRX_SRC="$ROOT/dist/release/exa-switch-chrome.crx"
if [ -f "$CRX_SRC" ]; then
  install -m 0644 "$CRX_SRC" "$DATA_DIR/exa-switch.crx"
  if [ "$OS" = "linux" ]; then
    CHROME_CFG_DIRS=(
      "$HOME/.config/google-chrome"
      "$HOME/.config/google-chrome-beta"
      "$HOME/.config/chromium"
      "$HOME/.config/BraveSoftware/Brave-Browser"
      "$HOME/.config/microsoft-edge"
      "$HOME/.config/vivaldi"
    )
  else
    CHROME_CFG_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome"
      "$HOME/Library/Application Support/Google/Chrome Canary"
      "$HOME/Library/Application Support/Chromium"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
      "$HOME/Library/Application Support/Microsoft Edge"
      "$HOME/Library/Application Support/Vivaldi"
    )
  fi
  for dir in "${CHROME_CFG_DIRS[@]}"; do
    if [ -d "$dir" ]; then
      mkdir -p "$dir/External Extensions"
      printf '{"external_crx": "%s", "external_version": "%s"}\n' \
        "$DATA_DIR/exa-switch.crx" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/extension/manifest.chrome.json")" \
        > "$dir/External Extensions/$CHROME_ID.json"
    fi
  done
  echo "Chrome/Chromium/Edge/Brave: CRX установится при следующем запуске."
fi

FF_XPI="$ROOT/dist/release/exa-switch-firefox-signed.xpi"
if [ -f "$FF_XPI" ]; then
  if [ "$OS" = "linux" ]; then
    FF_ROOT_DIRS=("$HOME/.config/mozilla/firefox" "$HOME/.mozilla/firefox")
  else
    FF_ROOT_DIRS=("$HOME/Library/Application Support/Firefox/Profiles")
  fi
  for root in "${FF_ROOT_DIRS[@]}"; do
    [ -d "$root" ] || continue
    for prof in "$root"/*/; do
      [ -d "$prof" ] || continue
      [ -f "${prof}prefs.js" ] || [ -f "${prof}times.json" ] || continue
      mkdir -p "${prof}extensions"
      install -m 0644 "$FF_XPI" "${prof}extensions/$FIREFOX_ID.xpi"
      if ! grep -q 'extensions.autoDisableScopes' "${prof}user.js" 2>/dev/null; then
        printf 'user_pref("extensions.autoDisableScopes", 0);\n' >> "${prof}user.js"
      fi
    done
  done
  echo "Firefox: XPI установлен в профиль (перезапустите браузер)."
fi

if [ "$START" = "1" ]; then
  echo
  if [ "$SYSTEMD_UNIT" = "1" ]; then
    echo "Запускаю helper через systemd..."
    if systemctl --user enable --now xray-switch.service 2>/dev/null; then
      sleep 0.3
      if OUT="$("$BIN" status 2>&1)"; then
        echo "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ✓ helper online, API :%s" % d["apiPort"])' 2>/dev/null || echo "  ✓ $OUT"
      else
        echo "  ! service запущен, но helper не отвечает" >&2
        echo "  journalctl --user -u xray-switch -n 50" >&2
      fi
    else
      echo "  ! не удалось запустить xray-switch.service" >&2
    fi
  else
    echo "Запускаю helper..."
    if OUT="$("$BIN" ensure 2>&1)"; then
      echo "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ✓ helper online, API :%s" % d["daemon"]["port"])' 2>/dev/null || echo "  ✓ $OUT"
    else
      echo "  ! helper не запустился: $OUT" >&2
      echo "  Смотрите лог: $CONFIG_DIR/daemon.log" >&2
    fi
  fi
elif [ "$SYSTEMD_UNIT" = "1" ]; then
  systemctl --user enable xray-switch.service 2>/dev/null || true
fi

cat <<EOF

Дальше:
  Chrome/Chromium/Brave/Edge:
    1. chrome://extensions → включите Developer mode
    2. Load unpacked → выберите  $ROOT/dist/chrome
    3. Перезапустите браузер (важно для native messaging)

  Firefox:
    1. about:debugging#/runtime/this-firefox
    2. Load Temporary Add-on → $ROOT/dist/firefox/manifest.json
    (постоянная установка требует подписи; для разработки можно использовать
     Developer Edition с xpinstall.signatures.required=false)

  Если helper не находится — перезапустите браузер и нажмите
  «Перезапустить helper» на странице настроек расширения.
EOF

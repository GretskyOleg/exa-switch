#!/usr/bin/env bash
# Remove the Xray Switch helper and native messaging manifests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.oleg.xray_switch"
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help)
      echo "Usage: ./uninstall.sh [--purge]"
      echo "  --purge   also remove helper config, logs and the token"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/xray-switch"
    CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/xray-switch"
    DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/vivaldi/NativeMessagingHosts"
      "$HOME/.mozilla/native-messaging-hosts"
      "$HOME/.librewolf/native-messaging-hosts"
    )
    ;;
  Darwin)
    DATA_DIR="$HOME/Library/Application Support/xray-switch"
    CONFIG_DIR="$HOME/Library/Application Support/xray-switch"
    DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
      "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Используйте Remove-Item/реестр вручную на $UNAME." >&2
    exit 1
    ;;
esac

if [ "$UNAME" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if [ -f "$UNIT_DIR/xray-switch.service" ]; then
    echo "Удаляю systemd-службу..."
    systemctl --user disable --now xray-switch.service >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/xray-switch.service"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
fi

if [ -x "$DATA_DIR/xray-switch-helper" ]; then
  "$DATA_DIR/xray-switch-helper" stop >/dev/null 2>&1 || true
fi

echo "Удаляю native messaging manifests..."
for dir in "${DIRS[@]}"; do
  rm -f "$dir/$HOST_NAME.json"
done

echo "Удаляю helper..."
rm -f "$DATA_DIR/xray-switch-helper"
rmdir "$DATA_DIR" 2>/dev/null || true

if [ "$PURGE" = "1" ]; then
  echo "Удаляю конфиг и логи..."
  rm -rf "$CONFIG_DIR"
fi

echo "Готово."
echo "Расширение из браузера удалите вручную: chrome://extensions или about:addons."

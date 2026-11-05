#!/usr/bin/env python3
"""Build the Arch/CachyOS package (pacman .pkg.tar.zst) for EXA Switch.

Reuses the Linux staging layout from packaging/build.py. Requires `makepkg`
and `fakeroot` (both are part of base-devel on Arch).

Usage:
  python3 packaging/build-arch.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import build


INSTALL_SCRIPT = r"""_xs_user_home() {
  getent passwd "$1" | cut -d: -f6
}

_xs_run_user() {
  _u="$1"; shift
  _uid=$(id -u "$_u")
  runuser -u "$_u" -- env XDG_RUNTIME_DIR="/run/user/$_uid" "$@"
}

_xs_policy_set() {
  mkdir -p /etc/firefox/policies
  _src=/usr/share/xray-switch/firefox-policies.json
  _dst=/etc/firefox/policies/policies.json
  [ -f "$_src" ] || return 0
  if [ ! -f "$_dst" ]; then
    cp "$_src" "$_dst"
    echo "  Firefox policy установлена: Extensions.Install + Locked"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import json
import pathlib
p = pathlib.Path("/etc/firefox/policies/policies.json")
try:
    data = json.loads(p.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)
pol = data.setdefault("policies", {})
es = pol.get("ExtensionSettings")
if isinstance(es, dict):
    es.pop("xray-switch@oleg.dev", None)
    if not es:
        pol.pop("ExtensionSettings", None)
ext = pol.setdefault("Extensions", {})
install = ext.get("Install")
if not isinstance(install, list):
    install = []
prefix = "file:///usr/share/xray-switch/exa-switch"
install = [u for u in install if not (isinstance(u, str) and u.startswith(prefix) and u.endswith(".xpi"))]
url = "__XPI_URL__"
if url not in install:
    install.append(url)
ext["Install"] = install
locked = ext.get("Locked")
if not isinstance(locked, list):
    locked = []
if "xray-switch@oleg.dev" not in locked:
    locked.append("xray-switch@oleg.dev")
ext["Locked"] = locked
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
    echo "  политика Extensions.Install + Locked добавлена в policies.json"
  else
    echo "  ! /etc/firefox/policies/policies.json уже есть — добавьте вручную:"
    echo "    Extensions.Install: __XPI_URL__"
    echo "    Extensions.Locked:  xray-switch@oleg.dev"
  fi
}

_xs_setup() {
  _xs_policy_set
  # Older packages installed an app-global XPI; Firefox treats it as a
  # sideload and auto-disables it. The policy now installs from
  # /usr/share/xray-switch/exa-switch-<version>.xpi, so drop the legacy copies.
  for _d in /usr/lib64/firefox/browser/extensions /usr/lib/firefox/browser/extensions /usr/lib/firefox-esr/browser/extensions; do
    rm -f "$_d/xray-switch@oleg.dev.xpi"
  done

  _u="${SUDO_USER:-}"
  if [ -n "$_u" ] && [ "$_u" != "root" ] && id -u "$_u" >/dev/null 2>&1; then
    _home=$(_xs_user_home "$_u")
    _uid=$(id -u "$_u")

    if [ -x "$_home/.local/share/xray-switch/xray-switch-helper" ]; then
      _xs_run_user "$_u" "$_home/.local/share/xray-switch/xray-switch-helper" stop >/dev/null 2>&1 || true
    fi
    # Stop a daemon spawned by native messaging outside systemd, otherwise the
    # packaged service cannot take the flock.
    _xs_run_user "$_u" /usr/bin/xray-switch-helper stop >/dev/null 2>&1 || true

    if [ -f "$_home/.config/systemd/user/xray-switch.service" ]; then
      _xs_run_user "$_u" systemctl --user disable --now xray-switch.service >/dev/null 2>&1 || true
      rm -f "$_home/.config/systemd/user/xray-switch.service"
      rm -f "$_home/.config/systemd/user/default.target.wants/xray-switch.service"
    fi
    if [ -x "$_home/.local/share/xray-switch/xray-switch-helper" ]; then
      rm -rf "$_home/.local/share/xray-switch"
    fi
    # Old install.sh wrote per-user native messaging manifests pointing at the
    # now-removed helper. Firefox/Chrome prefer them over the system manifests
    # and then report "Helper не доступен".
    for _f in \
      "$_home/.mozilla/native-messaging-hosts/com.oleg.xray_switch.json" \
      "$_home/.librewolf/native-messaging-hosts/com.oleg.xray_switch.json" \
      "$_home/.config/google-chrome/NativeMessagingHosts/com.oleg.xray_switch.json" \
      "$_home/.config/google-chrome-beta/NativeMessagingHosts/com.oleg.xray_switch.json" \
      "$_home/.config/chromium/NativeMessagingHosts/com.oleg.xray_switch.json" \
      "$_home/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.oleg.xray_switch.json" \
      "$_home/.config/microsoft-edge/NativeMessagingHosts/com.oleg.xray_switch.json" \
      "$_home/.config/vivaldi/NativeMessagingHosts/com.oleg.xray_switch.json"; do
      if [ -f "$_f" ] && grep -q '.local/share/xray-switch' "$_f" 2>/dev/null; then
        rm -f "$_f"
      fi
    done
    # NOTE: do not delete ~/.config/mozilla/firefox/*/extensions/xray-switch@oleg.dev.xpi:
    # the Extensions.Install policy stores its copy there. Only the app-global
    # copies above are legacy and must be removed.
    # Drop the sideload workaround written by scripts/sign-firefox.py: the
    # packaged policy install does not need it.
    for _f in "$_home"/.config/mozilla/firefox/*/user.js; do
      [ -f "$_f" ] || continue
      if [ "$(cat "$_f")" = 'user_pref("extensions.autoDisableScopes", 0);' ]; then
        rm -f "$_f"
      fi
    done

    # Chrome/Chromium/Edge/Brave/Vivaldi: external CRX, installed by the
    # browser on its next start (Chrome may show a one-time prompt).
    _id="__CHROME_ID__"
    _crx="/usr/share/xray-switch/exa-switch.crx"
    if [ -f "$_crx" ]; then
      for _root in \
        "$_home/.config/google-chrome" \
        "$_home/.config/google-chrome-beta" \
        "$_home/.config/chromium" \
        "$_home/.config/BraveSoftware/Brave-Browser" \
        "$_home/.config/microsoft-edge" \
        "$_home/.config/vivaldi"; do
        if [ -d "$_root" ]; then
          mkdir -p "$_root/External Extensions"
          printf '{"external_crx": "%s", "external_version": "%s"}\n' "$_crx" "__APP_VERSION__" > "$_root/External Extensions/$_id.json"
          chown "$_u":"$(id -gn "$_u")" "$_root/External Extensions" "$_root/External Extensions/$_id.json" 2>/dev/null || true
        fi
      done
    fi

    if [ -d "/run/user/$_uid" ]; then
      _xs_run_user "$_u" systemctl --user daemon-reload >/dev/null 2>&1 || true
      _xs_run_user "$_u" systemctl --user enable --now xray-switch.service >/dev/null 2>&1 || true
      _xs_run_user "$_u" systemctl --user restart xray-switch.service >/dev/null 2>&1 || true
      echo "  helper запущен как user-служба для $_u"
      echo "  расширение EXA Switch появится после перезапуска Firefox"
    else
      echo "  служба включена и запустится при следующем входе в систему"
    fi
  else
    echo "  служба включена для всех пользователей (systemd user)"
  fi
}

post_install() { _xs_setup; }
post_upgrade() { _xs_setup; }

pre_remove() {
  _u="${SUDO_USER:-}"
  if [ -n "$_u" ] && [ "$_u" != "root" ] && id -u "$_u" >/dev/null 2>&1 && [ -d "/run/user/$(id -u "$_u")" ]; then
    _xs_run_user "$_u" systemctl --user disable --now xray-switch.service >/dev/null 2>&1 || true
  fi
  pkill -f '/opt/xray-switch/xray-switch-helper' >/dev/null 2>&1 || true
}

_xs_policy_remove() {
  _dst=/etc/firefox/policies/policies.json
  [ -f "$_dst" ] || return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import json
import pathlib
p = pathlib.Path("/etc/firefox/policies/policies.json")
try:
    data = json.loads(p.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)
pol = data.get("policies", {})
es = pol.get("ExtensionSettings")
if isinstance(es, dict):
    es.pop("xray-switch@oleg.dev", None)
    if not es:
        pol.pop("ExtensionSettings", None)
ext = pol.get("Extensions")
if isinstance(ext, dict):
    install = ext.get("Install")
    if isinstance(install, list):
        prefix = "file:///usr/share/xray-switch/exa-switch"
        install = [u for u in install if not (isinstance(u, str) and u.startswith(prefix) and u.endswith(".xpi"))]
        if install:
            ext["Install"] = install
        else:
            ext.pop("Install", None)
    locked = ext.get("Locked")
    if isinstance(locked, list):
        locked = [x for x in locked if x != "xray-switch@oleg.dev"]
        if locked:
            ext["Locked"] = locked
        else:
            ext.pop("Locked", None)
    if not ext:
        pol.pop("Extensions", None)
if not pol:
    p.unlink()
else:
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  fi
}

post_remove() {
  _xs_policy_remove
  _id="__CHROME_ID__"
  _u="${SUDO_USER:-}"
  if [ -n "$_u" ] && [ "$_u" != "root" ] && id -u "$_u" >/dev/null 2>&1; then
    _home=$(_xs_user_home "$_u")
    for _root in \
      "$_home/.config/google-chrome" \
      "$_home/.config/google-chrome-beta" \
      "$_home/.config/chromium" \
      "$_home/.config/BraveSoftware/Brave-Browser" \
      "$_home/.config/microsoft-edge" \
      "$_home/.config/vivaldi"; do
      rm -f "$_root/External Extensions/$_id.json"
    done
  fi
  for _d in /usr/lib64/firefox/browser/extensions /usr/lib/firefox/browser/extensions /usr/lib/firefox-esr/browser/extensions; do
    rm -f "$_d/xray-switch@oleg.dev.xpi"
  done
  _u="${SUDO_USER:-}"
  if [ -n "$_u" ] && [ "$_u" != "root" ] && id -u "$_u" >/dev/null 2>&1; then
    _home=$(_xs_user_home "$_u")
    for _d in "$_home"/.config/mozilla/firefox/*/extensions; do
      [ -d "$_d" ] && rm -f "$_d/xray-switch@oleg.dev.xpi"
    done
  fi
  echo "Конфиг и токен остались в ~/.config/xray-switch (удалите вручную при необходимости)."
}
"""


def main() -> int:
    if not shutil.which("makepkg") or not shutil.which("fakeroot"):
        raise SystemExit("Нужны makepkg и fakeroot (пакет base-devel).")

    build.BUILD.mkdir(parents=True, exist_ok=True)
    build.RELEASE.mkdir(parents=True, exist_ok=True)

    if not (build.DIST / "firefox" / "manifest.json").is_file():
        subprocess.run([str(build.ROOT / "build.sh"), "--no-helper"], check=True)

    stage = build.stage_linux_package("linux", "amd64")
    # Arch has /usr/lib64 -> lib; shipping usr/lib64/* would replace that
    # symlink and break the filesystem layout.
    shutil.rmtree(stage / "usr" / "lib64", ignore_errors=True)
    work = build.BUILD / "arch-pkg"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    pkgbuild = f"""pkgname=exa-switch
pkgver={build.version()}
pkgrel=1
pkgdesc="EXA Switch - per-site VLESS/Reality proxy (browser extension + xray-core helper)"
arch=('x86_64')
url="https://example.invalid/exa-switch"
license=('MIT')
depends=('glibc' 'ca-certificates' 'python')
optdepends=('firefox: автоматическая установка расширения')
options=('!strip' '!debug' '!emptydirs')
install=exa-switch.install
source=()

package() {{
  cp -a "{stage}/." "$pkgdir/"
}}
"""
    (work / "PKGBUILD").write_text(pkgbuild, encoding="utf-8")
    xpi_url = f"file:///usr/share/xray-switch/exa-switch-{build.version()}.xpi"
    install_script = INSTALL_SCRIPT.replace("__XPI_URL__", xpi_url)
    install_script = install_script.replace("__CHROME_ID__", build.chrome_id())
    install_script = install_script.replace("__APP_VERSION__", build.version())
    (work / "exa-switch.install").write_text(install_script, encoding="utf-8")

    env = dict(os.environ)
    env["LC_ALL"] = "C"
    subprocess.run(
        ["makepkg", "--nodeps", "--noconfirm", "--cleanbuild", "--force"],
        cwd=work,
        check=True,
        env=env,
    )

    packages = sorted(work.glob("exa-switch-*.pkg.tar.zst"))
    if not packages:
        raise SystemExit("makepkg не создал пакет")
    out = build.RELEASE / packages[-1].name
    shutil.copy2(packages[-1], out)
    print("  ->", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

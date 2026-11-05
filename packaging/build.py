#!/usr/bin/env python3
"""Build EXA Switch installers: Windows .exe, Linux .deb/.rpm, macOS .app.zip."""
from __future__ import annotations

import gzip
import hashlib
import html
import json
import os
import shlex
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
BUILD = ROOT / "packaging" / ".build"
RELEASE = DIST / "release"
SIGNED_XPI = RELEASE / "exa-switch-firefox-signed.xpi"
PAYLOAD_MAGIC = b"XSWPAY01"
HOST_NAME = "com.oleg.xray_switch"
FIREFOX_ID = "xray-switch@oleg.dev"

TARGETS = [
    ("linux", "amd64"),
    ("linux", "arm64"),
    ("windows", "amd64"),
    ("windows", "arm64"),
    ("darwin", "amd64"),
    ("darwin", "arm64"),
]

DEB_ARCH = {"amd64": "amd64", "arm64": "arm64"}
RPM_ARCH = {"amd64": "x86_64", "arm64": "aarch64"}


def version() -> str:
    manifest = json.loads((ROOT / "extension" / "manifest.chrome.json").read_text(encoding="utf-8"))
    return manifest["version"]


def chrome_id() -> str:
    path = DIST / "chrome-id.txt"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    import base64
    manifest = json.loads((ROOT / "extension" / "manifest.chrome.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).digest()[:16]
    return "".join(chr(97 + (b >> 4)) + chr(97 + (b & 15)) for b in digest)


def run(cmd, cwd=None, env=None, shell=False):
    print("  $", " ".join(cmd) if isinstance(cmd, list) else cmd)
    subprocess.run(cmd, cwd=cwd, env=env, shell=shell, check=True)


def helper_source(os_name: str, arch: str) -> Path:
    suffix = ".exe" if os_name == "windows" else ""
    path = DIST / "helper" / f"xray-switch-helper-{os_name}-{arch}{suffix}"
    if not path.exists():
        raise SystemExit(
            f"Missing {path}. Run ./build.sh --cross first (Go 1.27+ required)."
        )
    return path


def helper_name(os_name: str) -> str:
    return "xray-switch-helper.exe" if os_name == "windows" else "xray-switch-helper"


def copy_tree(src: Path, dst: Path):
    if not src.exists():
        raise SystemExit(f"Missing {src}. Run ./build.sh first.")
    shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True)


def zip_root(src: Path, out: Path, prefix: str = ""):
    out.parent.mkdir(parents=True, exist_ok=True)
    prefix = prefix.rstrip("/")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(src.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(src).as_posix()
            if prefix:
                rel = prefix + "/" + rel
            mode = stat.S_IMODE(path.stat().st_mode)
            info = zipfile.ZipInfo(rel)
            info.create_system = 3
            info.date_time = time.localtime(path.stat().st_mtime)[:6]
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((stat.S_IFREG | mode) & 0xFFFF) << 16
            zf.writestr(info, path.read_bytes())


def make_payload(target_os: str, arch: str) -> Path:
    name = f"{target_os}-{arch}"
    payload = BUILD / f"payload-{name}"
    shutil.rmtree(payload, ignore_errors=True)
    (payload / "helper").mkdir(parents=True)
    shutil.copy2(helper_source(target_os, arch), payload / "helper" / helper_name(target_os))

    copy_tree(DIST / "chrome", payload / "extension" / "chrome")
    copy_tree(DIST / "firefox", payload / "extension" / "firefox")
    copy_tree(ROOT / "branding", payload / "branding")
    if SIGNED_XPI.is_file():
        shutil.copy2(SIGNED_XPI, payload / "exa-switch-firefox-signed.xpi")
    crx = RELEASE / "exa-switch-chrome.crx"
    if crx.is_file():
        shutil.copy2(crx, payload / "exa-switch-chrome.crx")
    shutil.copy2(ROOT / "packaging" / "setup.html.tmpl", payload / "setup.html")
    shutil.copy2(ROOT / "packaging" / "README-INSTALL.txt", payload / "README-INSTALL.txt")
    shutil.copy2(ROOT / "LICENSE", payload / "LICENSE")
    shutil.copy2(ROOT / "THIRD_PARTY.md", payload / "THIRD_PARTY.md")

    zip_path = BUILD / f"payload-{name}.zip"
    zip_root(payload, zip_path)
    return zip_path


def go_binary() -> str:
    return os.environ.get("GO") or shutil.which("go") or ""


def build_installer(target_os: str, arch: str, payload_zip: Path) -> Path:
    go = go_binary()
    if not go:
        raise SystemExit("Go compiler not found. Set GO=/path/to/go.")
    out = BUILD / f"installer-{target_os}-{arch}"
    ext = ".exe" if target_os == "windows" else ""
    out = out.with_suffix(ext) if ext else out
    env = os.environ.copy()
    env.update({"GOOS": target_os, "GOARCH": arch, "CGO_ENABLED": "0"})
    run(
        [
            go, "build", "-trimpath", "-buildvcs=false",
            "-ldflags", "-s -w", "-o", str(out), ".",
        ],
        cwd=ROOT / "packaging" / "installer",
        env=env,
    )
    return out


def append_payload(binary: Path, payload_zip: Path, out: Path):
    data = binary.read_bytes()
    payload = payload_zip.read_bytes()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data + payload + struct.pack("<Q", len(payload)) + PAYLOAD_MAGIC)
    out.chmod(0o755)


def render_setup(data_dir: str, helper: str, chrome_dir: str, firefox_dir: str, platform: str) -> str:
    text = (ROOT / "packaging" / "setup.html.tmpl").read_text(encoding="utf-8")
    replacements = {
        "{{VERSION}}": version(),
        "{{PLATFORM}}": platform,
        "{{DATA_DIR}}": html.escape(data_dir),
        "{{HELPER}}": html.escape(helper),
        "{{CHROME_DIR}}": html.escape(chrome_dir),
        "{{FIREFOX_DIR}}": html.escape(firefox_dir),
        "{{CHROME_ID}}": chrome_id(),
        "{{FIREFOX_ID}}": FIREFOX_ID,
        "{{GENERATED_AT}}": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


def manifest(kind: str, helper: str) -> str:
    if kind == "chrome":
        data = {
            "name": HOST_NAME,
            "description": "EXA Switch local helper (xray-core)",
            "path": helper,
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{chrome_id()}/"],
        }
    else:
        data = {
            "name": HOST_NAME,
            "description": "EXA Switch local helper (xray-core)",
            "path": helper,
            "type": "stdio",
            "allowed_extensions": [FIREFOX_ID],
        }
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def write_file(path: Path, text: str, mode: int = 0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)


def firefox_policy_install_sh() -> str:
    return f"""POLICY=/etc/firefox/policies/policies.json
SRC=/usr/share/xray-switch/firefox-policies.json
if [ -f "$SRC" ]; then
  mkdir -p /etc/firefox/policies
  if [ ! -f "$POLICY" ]; then
    cp "$SRC" "$POLICY"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$POLICY" <<'PY'
import json, sys
p = sys.argv[1]
try:
    data = json.load(open(p, encoding="utf-8"))
except Exception:
    raise SystemExit(0)
pol = data.setdefault("policies", {{}})
ext = pol.setdefault("Extensions", {{}})
inst = ext.get("Install")
if not isinstance(inst, list):
    inst = []
prefix = "file:///usr/share/xray-switch/exa-switch"
inst = [u for u in inst if not (isinstance(u, str) and u.startswith(prefix) and u.endswith(".xpi"))]
inst.append("file:///usr/share/xray-switch/exa-switch-{version()}.xpi")
ext["Install"] = inst
locked = ext.get("Locked")
if not isinstance(locked, list):
    locked = []
if "xray-switch@oleg.dev" not in locked:
    locked.append("xray-switch@oleg.dev")
ext["Locked"] = locked
open(p, "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\\n")
PY
  fi
fi
"""


def firefox_policy_remove_sh() -> str:
    return """POLICY=/etc/firefox/policies/policies.json
if [ -f "$POLICY" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$POLICY" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    data = json.load(open(p, encoding="utf-8"))
except Exception:
    raise SystemExit(0)
pol = data.get("policies", {})
ext = pol.get("Extensions")
if isinstance(ext, dict):
    prefix = "file:///usr/share/xray-switch/exa-switch"
    inst = ext.get("Install")
    if isinstance(inst, list):
        inst = [u for u in inst if not (isinstance(u, str) and u.startswith(prefix) and u.endswith(".xpi"))]
        if inst:
            ext["Install"] = inst
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
    os.unlink(p)
else:
    open(p, "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\\n")
PY
fi
"""


def stage_linux_package(target_os: str, arch: str) -> Path:
    stage = BUILD / f"stage-linux-{arch}"
    shutil.rmtree(stage, ignore_errors=True)
    app_dir = stage / "opt" / "xray-switch"
    app_dir.mkdir(parents=True)
    helper = app_dir / "xray-switch-helper"
    shutil.copy2(helper_source(target_os, arch), helper)
    helper.chmod(0o755)
    copy_tree(DIST / "chrome", app_dir / "extension" / "chrome")
    copy_tree(DIST / "firefox", app_dir / "extension" / "firefox")
    copy_tree(ROOT / "branding", app_dir / "branding")
    helper_path = "/opt/xray-switch/xray-switch-helper"
    write_file(app_dir / "setup.html", render_setup(
        "/opt/xray-switch", helper_path,
        "/opt/xray-switch/extension/chrome",
        "/opt/xray-switch/extension/firefox",
        "Linux",
    ))
    shutil.copy2(ROOT / "packaging" / "README-INSTALL.txt", app_dir / "README-INSTALL.txt")
    shutil.copy2(ROOT / "LICENSE", app_dir / "LICENSE")
    shutil.copy2(ROOT / "THIRD_PARTY.md", app_dir / "THIRD_PARTY.md")

    setup_script = """#!/usr/bin/env bash
set -e
HELPER=/opt/xray-switch/xray-switch-helper
if [ -x "$HELPER" ]; then
  "$HELPER" ensure >/dev/null 2>&1 || true
fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open /opt/xray-switch/setup.html >/dev/null 2>&1 || true
else
  echo "Open /opt/xray-switch/setup.html"
fi
"""
    write_file(stage / "usr" / "bin" / "xray-switch-setup", setup_script, 0o755)
    browsers_script = ROOT / "scripts" / "xray-switch-browsers"
    if browsers_script.is_file():
        browsers_dst = stage / "usr" / "bin" / "xray-switch-browsers"
        shutil.copy2(browsers_script, browsers_dst)
        browsers_dst.chmod(0o755)
    helper_link = stage / "usr" / "bin" / "xray-switch-helper"
    if helper_link.is_symlink() or helper_link.exists():
        helper_link.unlink()
    helper_link.symlink_to("/opt/xray-switch/xray-switch-helper")

    desktop = """[Desktop Entry]
Type=Application
Version=1.0
Name=EXA Switch Setup
Comment=Finish EXA Switch browser setup
Exec=xray-switch-setup
Icon=exa-switch
Terminal=false
Categories=Network;Security;
StartupNotify=false
"""
    write_file(stage / "usr" / "share" / "applications" / "exa-switch-setup.desktop", desktop)
    icon_dst = stage / "usr" / "share" / "icons" / "hicolor" / "128x128" / "apps" / "exa-switch.png"
    icon_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DIST / "chrome" / "icons" / "icon128.png", icon_dst)

    write_file(stage / "usr" / "share" / "doc" / "exa-switch" / "README-INSTALL.txt",
               (ROOT / "packaging" / "README-INSTALL.txt").read_text(encoding="utf-8"))
    shutil.copy2(ROOT / "LICENSE", stage / "usr" / "share" / "doc" / "exa-switch" / "LICENSE")
    shutil.copy2(ROOT / "THIRD_PARTY.md", stage / "usr" / "share" / "doc" / "exa-switch" / "THIRD_PARTY.md")

    chrome_dirs = [
        "etc/opt/chrome/native-messaging-hosts",
        "etc/chromium/native-messaging-hosts",
        "etc/brave/native-messaging-hosts",
        "etc/opt/edge/native-messaging-hosts",
        "etc/vivaldi/native-messaging-hosts",
    ]
    for rel in chrome_dirs:
        write_file(stage / rel / f"{HOST_NAME}.json", manifest("chrome", helper_path))
    for rel in ["usr/lib/mozilla/native-messaging-hosts", "usr/lib64/mozilla/native-messaging-hosts"]:
        write_file(stage / rel / f"{HOST_NAME}.json", manifest("firefox", helper_path))

    # --- managed install: systemd user service + signed Firefox add-on -----
    unit = """[Unit]
Description=EXA Switch helper (xray-core)
After=network.target
Documentation=file:///usr/share/doc/exa-switch/INSTALL-LINUX.md

[Service]
Type=simple
ExecStart=/opt/xray-switch/xray-switch-helper daemon
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=default.target
"""
    write_file(stage / "usr" / "lib" / "systemd" / "user" / "xray-switch.service", unit)
    wants = stage / "etc" / "systemd" / "user" / "default.target.wants"
    wants.mkdir(parents=True, exist_ok=True)
    link = wants / "xray-switch.service"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to("/usr/lib/systemd/user/xray-switch.service")

    if SIGNED_XPI.is_file():
        share = stage / "usr" / "share" / "xray-switch"
        share.mkdir(parents=True, exist_ok=True)
        xpi_name = f"exa-switch-{version()}.xpi"
        shutil.copy2(SIGNED_XPI, share / xpi_name)
        # Stable alias for docs and manual installation.
        shutil.copy2(SIGNED_XPI, share / "exa-switch.xpi")
        # Use the Extensions policy (Install + Locked) rather than an app-global
        # XPI: Firefox treats app-global copies as sideloads and auto-disables
        # them, while the policy install activates and locks the extension.
        # The versioned file name also makes Firefox re-run the Install policy
        # on upgrades and after a reinstall.
        policy = {
            "policies": {
                "Extensions": {
                    "Install": [f"file:///usr/share/xray-switch/{xpi_name}"],
                    "Locked": [FIREFOX_ID],
                }
            }
        }
        write_file(
            share / "firefox-policies.json",
            json.dumps(policy, indent=2, ensure_ascii=False) + "\n",
        )
        crx = RELEASE / "exa-switch-chrome.crx"
        if crx.is_file():
            shutil.copy2(crx, share / "exa-switch.crx")
        else:
            print(
                "  ! dist/release/exa-switch-chrome.crx не найден: "
                "Chrome-семейство не будет установлено пакетом",
                file=sys.stderr,
            )
    else:
        print(
            "  ! dist/release/exa-switch-firefox-signed.xpi не найден: "
            "Firefox-расширение не будет установлено пакетом",
            file=sys.stderr,
        )

    docs_src = ROOT / "docs"
    if docs_src.is_dir():
        for doc in sorted(docs_src.glob("*.md")):
            write_file(stage / "usr" / "share" / "doc" / "exa-switch" / doc.name,
                       doc.read_text(encoding="utf-8"))
        images_src = docs_src / "images"
        if images_src.is_dir():
            shutil.copytree(
                images_src,
                stage / "usr" / "share" / "doc" / "exa-switch" / "images",
                dirs_exist_ok=True,
            )

    return stage


def tar_add_tree(tf: tarfile.TarFile, stage: Path):
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        files.sort()
        rel = os.path.relpath(root, stage)
        arc_root = "./" if rel == "." else "./" + rel.replace(os.sep, "/")
        info = tf.gettarinfo(root, arcname=arc_root)
        info.mode = 0o755
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        tf.addfile(info)
        for filename in files:
            full = Path(root) / filename
            arc = ("./" + os.path.relpath(full, stage)).replace(os.sep, "/")
            info = tf.gettarinfo(full, arcname=arc)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            if full.is_symlink():
                tf.addfile(info)
                continue
            with open(full, "rb") as fh:
                tf.addfile(info, fh)


def make_deb(arch: str, stage: Path) -> Path:
    deb_arch = DEB_ARCH[arch]
    work = BUILD / f"deb-{arch}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    total = 0
    md5_lines = []
    for root, dirs, files in os.walk(stage):
        for filename in files:
            full = Path(root) / filename
            total += full.stat().st_size
            rel = os.path.relpath(full, stage).replace(os.sep, "/")
            md5_lines.append(f"{hashlib.md5(full.read_bytes()).hexdigest()}  {rel}")

    control = f"""Package: exa-switch
Version: {version()}
Section: net
Priority: optional
Architecture: {deb_arch}
Maintainer: EXA Switch <exa@example.invalid>
Installed-Size: {max(1, total // 1024)}
Depends: python3
Recommends: ca-certificates, xdg-utils
Description: EXA Switch - per-site VLESS proxy
 Browser extension and local xray-core helper. Proxies only the sites
 you choose, using a SwitchyOmega-like rules engine.
"""
    (work / "debian-binary").write_text("2.0\n", encoding="ascii")
    (work / "control").write_text(control, encoding="utf-8")
    postinst = (
        "#!/bin/sh\nset -e\n"
        + firefox_policy_install_sh()
        + "echo \"EXA Switch installed.\"\n"
        + "echo \"Firefox: extension installed via policy; restart Firefox.\"\n"
        + "echo \"Chrome-family: run 'xray-switch-browsers install all' (or a list).\"\n"
    )
    (work / "postinst").write_text(postinst, encoding="utf-8")
    (work / "postinst").chmod(0o755)
    postrm = "#!/bin/sh\nset -e\n" + firefox_policy_remove_sh()
    (work / "postrm").write_text(postrm, encoding="utf-8")
    (work / "postrm").chmod(0o755)
    (work / "md5sums").write_text("\n".join(md5_lines) + "\n", encoding="utf-8")

    with tarfile.open(work / "control.tar.gz", "w:gz", format=tarfile.PAX_FORMAT) as tf:
        for name in ("control", "postinst", "postrm", "md5sums"):
            info = tf.gettarinfo(str(work / name), arcname="./" + name)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            with open(work / name, "rb") as fh:
                tf.addfile(info, fh)
    with tarfile.open(work / "data.tar.gz", "w:gz", format=tarfile.PAX_FORMAT) as tf:
        tar_add_tree(tf, stage)

    out = RELEASE / f"exa-switch_{version()}_{deb_arch}.deb"
    run(["ar", "rc", str(out), "debian-binary", "control.tar.gz", "data.tar.gz"], cwd=work)
    return out


def ensure_rpmbuild() -> tuple[list[str], str | None]:
    custom = os.environ.get("RPMBUILD")
    if custom:
        return [custom], os.environ.get("RPM_CONFIGDIR")
    found = shutil.which("rpmbuild")
    if found:
        return [found], os.environ.get("RPM_CONFIGDIR")

    root = BUILD / "rpmbuild-root"
    binary = root / "usr" / "bin" / "rpmbuild"
    config = BUILD / "rpm-config"
    if not binary.exists():
        if not shutil.which("dnf") or not shutil.which("rpm2cpio") or not shutil.which("cpio"):
            raise SystemExit("rpmbuild is missing. Install rpm-build (dnf/apt) or set RPMBUILD.")
        dl = BUILD / "rpmdl"
        dl.mkdir(parents=True, exist_ok=True)
        run(["dnf", "download", "--destdir", str(dl), "rpm-build"])
        rpms = sorted(dl.glob("rpm-build-*.rpm"))
        if not rpms:
            raise SystemExit("dnf download rpm-build did not produce an RPM")
        root.mkdir(parents=True, exist_ok=True)
        run(f"rpm2cpio {shlex.quote(str(rpms[-1]))} | cpio -idm", cwd=root, shell=True)
    if not config.exists():
        shutil.copytree("/usr/lib/rpm", config)
        extra = root / "usr" / "lib" / "rpm"
        if extra.exists():
            shutil.copytree(extra, config, dirs_exist_ok=True)
    return [str(binary)], str(config)


def make_rpm(arch: str, stage: Path) -> Path:
    rpm_arch = RPM_ARCH[arch]
    rpmbuild, config_dir = ensure_rpmbuild()
    top = BUILD / f"rpm-{arch}"
    shutil.rmtree(top, ignore_errors=True)
    for sub in ("BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"):
        (top / sub).mkdir(parents=True, exist_ok=True)

    files = []
    for root, dirs, filenames in os.walk(stage):
        dirs.sort()
        filenames.sort()
        rel = os.path.relpath(root, stage).replace(os.sep, "/")
        if rel != ".":
            files.append(f"%dir %attr(0755,root,root) /{rel}")
        for filename in filenames:
            full = Path(root) / filename
            mode = stat.S_IMODE(full.stat().st_mode)
            path = f"/{os.path.relpath(full, stage).replace(os.sep, '/')}"
            prefix = "%config(noreplace) " if "/native-messaging-hosts/" in path else ""
            files.append(f"{prefix}%attr({mode:04o},root,root) {path}")

    spec = f"""Name:           exa-switch
Version:        {version()}
Release:        1
Summary:        EXA Switch - per-site VLESS proxy
License:        MIT
URL:            https://github.com/
Requires:       ca-certificates
Requires:       xdg-utils
Requires:       python3

%description
EXA Switch is a browser extension plus a local xray-core helper.
It proxies only the sites selected by the user, with a
SwitchyOmega-like rules engine.

%install
rm -rf %{{buildroot}}
mkdir -p %{{buildroot}}
cp -a "{stage}/." %{{buildroot}}/

%files
{chr(10).join(files)}

%post
{firefox_policy_install_sh()}
echo "EXA Switch installed."
echo "Firefox: extension installed via policy; restart Firefox."
echo "Chrome-family: run 'xray-switch-browsers install all' (or a list)."

%postun
{firefox_policy_remove_sh()}
"""
    spec_path = top / "SPECS" / "exa-switch.spec"
    spec_path.write_text(spec, encoding="utf-8")
    env = os.environ.copy()
    if config_dir:
        env["RPM_CONFIGDIR"] = config_dir
    run(
        rpmbuild + ["-bb", "--target", rpm_arch, "--define", f"_topdir {top}", str(spec_path)],
        env=env,
    )
    rpms = sorted((top / "RPMS").rglob("*.rpm"))
    if not rpms:
        raise SystemExit("rpmbuild produced no RPM")
    out = RELEASE / f"exa-switch-{version()}-1.{rpm_arch}.rpm"
    shutil.copy2(rpms[-1], out)
    return out


def make_macos_app(arch: str, installer: Path, payload_zip: Path) -> Path:
    app = BUILD / "EXA Switch Setup.app"
    shutil.rmtree(app, ignore_errors=True)
    macos = app / "Contents" / "MacOS"
    resources = app / "Contents" / "Resources"
    macos.mkdir(parents=True)
    resources.mkdir(parents=True)
    shutil.copy2(installer, macos / "EXA-Switch-Setup")
    (macos / "EXA-Switch-Setup").chmod(0o755)
    shutil.copy2(payload_zip, resources / "payload.zip")
    shutil.copy2(ROOT / "packaging" / "README-INSTALL.txt", resources / "README-INSTALL.txt")
    icon = ROOT / "branding" / "icon.icns"
    if icon.exists():
        shutil.copy2(icon, resources / "icon.icns")
    (app / "Contents" / "PkgInfo").write_text("APPL????", encoding="ascii")

    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>EXA Switch Setup</string>
  <key>CFBundleDisplayName</key><string>EXA Switch Setup</string>
  <key>CFBundleIdentifier</key><string>dev.exa.switch.setup</string>
  <key>CFBundleVersion</key><string>{version()}</string>
  <key>CFBundleShortVersionString</key><string>{version()}</string>
  <key>CFBundleExecutable</key><string>EXA-Switch-Setup</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""
    (app / "Contents" / "Info.plist").write_text(plist, encoding="utf-8")
    out = RELEASE / f"EXA-Switch-Setup-macos-{arch}.zip"
    zip_root(app, out, prefix=app.name)
    return out


def browser_packages():
    zip_root(DIST / "chrome", RELEASE / "exa-switch-chrome.zip")
    zip_root(DIST / "firefox", RELEASE / "exa-switch-firefox.xpi")


def write_release_readme():
    text = f"""# EXA Switch {version()} // installers

<p><img src="branding/logo.png" alt="EXA Switch" width="320"></p>

## Что выбрать

| ОС | Файл | Как ставить |
|---|---|---|
| Windows 10/11 x64 | `EXA-Switch-Setup-windows-amd64.exe` | запустить, двойной клик |
| Windows 11 ARM | `EXA-Switch-Setup-windows-arm64.exe` | запустить |
| Linux x86_64 | `exa-switch_{version()}_amd64.deb` | `sudo apt install ./exa-switch_{version()}_amd64.deb` |
| Linux x86_64 (Fedora) | `exa-switch-{version()}-1.x86_64.rpm` | `sudo dnf install ./exa-switch-{version()}-1.x86_64.rpm` |
| Linux x86_64 portable | `EXA-Switch-Setup-linux-amd64` | `chmod +x` и запустить, без root |
| Linux ARM64 | `.deb` / `.rpm` / portable `arm64` | аналогично |
| macOS Apple Silicon | `EXA-Switch-Setup-macos-arm64.zip` | распаковать, запустить `EXA Switch Setup.app` |
| macOS Intel | `EXA-Switch-Setup-macos-amd64.zip` | распаковать, запустить приложение |

Установщики ставят helper, native messaging и распаковывают расширение.
Chrome/Firefox по политике безопасности не разрешают молча поставить
расширение из локальной папки — останется один шаг в браузере, установщик
откроет страницу с точными путями.

## Chrome / Chromium / Edge / Brave

1. `chrome://extensions` → Developer mode.
2. Load unpacked → папка, которую покажет установщик.
3. Расширение останется после перезапуска.

## Firefox

1. `about:debugging#/runtime/this-firefox`.
2. Load Temporary Add-on → `manifest.json` из папки расширения.
3. Temporary Add-on исчезает после перезапуска. Для постоянной установки
   нужен подписанный XPI (AMO) или Developer Edition/Nightly.

## macOS

Приложение не подписано Apple Developer ID. Если Gatekeeper блокирует:
правый клик по `EXA Switch Setup.app` → **Open** → **Open**.
Или: `xattr -dr com.apple.quarantine "EXA Switch Setup.app"`.

## Windows

SmartScreen может предупредить, потому что `.exe` не подписан.
Нажми **More info** → **Run anyway**.

## Проверка

В настройках расширения есть кнопка «Проверить» — HTTPS-запрос через туннель.
Статус helper: `xray-switch-helper status` (Linux/macOS) или
`%LOCALAPPDATA%\\xray-switch\\xray-switch-helper.exe status` (Windows).

## Удаление

- Windows: `EXA-Switch-Setup-...exe --uninstall` (или Параметры → Приложения).
- Linux: `sudo apt remove exa-switch` / `sudo dnf remove exa-switch`;
  portable: запустить с `--uninstall`.
- macOS: запустить `EXA Switch Setup.app` с `--uninstall` через терминал
  или удалить `~/Library/Application Support/xray-switch` и manifests вручную.

EXA // EBANEX // SECURE TUNNEL
"""
    (RELEASE / "README-INSTALL.md").write_text(text, encoding="utf-8")


def write_checksums():
    lines = []
    for path in sorted(RELEASE.iterdir()):
        if path.is_file() and path.name != "SHA256SUMS":
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            lines.append(f"{digest}  {path.name}")
    (RELEASE / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    RELEASE.mkdir(parents=True, exist_ok=True)
    for path in RELEASE.iterdir():
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    # Always assemble the latest extension (branding, manifests, UI).
    run([str(ROOT / "build.sh"), "--no-helper"])

    for target_os, arch in TARGETS:
        name = f"{target_os}-{arch}"
        print(f"\n=== {name} ===")
        payload = make_payload(target_os, arch)
        installer = build_installer(target_os, arch, payload)

        if target_os in ("windows", "linux"):
            suffix = ".exe" if target_os == "windows" else ""
            out = RELEASE / f"EXA-Switch-Setup-{target_os}-{arch}{suffix}"
            append_payload(installer, payload, out)
            print("  ->", out.name)
        elif target_os == "darwin":
            out = make_macos_app(arch, installer, payload)
            print("  ->", out.name)

    for arch in ("amd64", "arm64"):
        print(f"\n=== linux packages {arch} ===")
        stage = stage_linux_package("linux", arch)
        deb = make_deb(arch, stage)
        print("  ->", deb.name)
        rpm = make_rpm(arch, stage)
        print("  ->", rpm.name)

    print("\n=== browser packages ===")
    browser_packages()
    shutil.copytree(ROOT / "branding", RELEASE / "branding", dirs_exist_ok=True)
    write_release_readme()
    write_checksums()

    print("\nRelease:", RELEASE)
    for path in sorted(RELEASE.iterdir()):
        if path.is_file():
            print(f"  {path.name:55} {path.stat().st_size/1024/1024:6.1f} MB")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Sign a Firefox XPI with the addons.mozilla.org submission API (v5).

The result is a Mozilla-signed XPI that installs permanently in release Firefox.
Only the Python standard library is required.

Credentials are read, in order, from:
  --api-key / --api-secret
  $AMO_API_KEY / $AMO_API_SECRET
  ~/.config/amo/credentials  (KEY=VALUE lines)

Usage:
  scripts/sign-firefox.py                                  # sign dist/release/exa-switch-firefox.xpi
  scripts/sign-firefox.py --install                        # ...and copy it into the default Firefox profile
  scripts/sign-firefox.py --channel unlisted --out /tmp/xray.xpi

Get API credentials here: https://addons.mozilla.org/developers/addon/api/key/
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API_BASE = "https://addons.mozilla.org/api/v5/"
DEFAULT_XPI = "dist/release/exa-switch-firefox.xpi"
DEFAULT_OUT = "dist/release/exa-switch-firefox-signed.xpi"
STATE_FILE = pathlib.Path.home() / ".cache" / "xray-switch" / "amo-addon.json"
CREDENTIALS_FILE = pathlib.Path.home() / ".config" / "amo" / "credentials"


# --------------------------------------------------------------------------- http
def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(api_key: str, api_secret: str, ttl: int = 60) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(
        json.dumps(
            {"iss": api_key, "jti": secrets.token_hex(16), "iat": now, "exp": now + ttl},
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}"
    signature = hmac.new(api_secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(signature)}"


def request(
    method: str,
    path: str,
    *,
    api_key: str | None = None,
    api_secret: str | None = None,
    data: bytes | None = None,
    content_type: str | None = None,
    timeout: int = 120,
) -> tuple[int, dict]:
    url = API_BASE + path.lstrip("/")
    headers = {"Accept": "application/json", "User-Agent": "xray-switch-sign/1.0"}
    if content_type:
        headers["Content-Type"] = content_type
    if api_key and api_secret:
        # AMO expects the "JWT" scheme, not "Bearer".
        headers["Authorization"] = "JWT " + make_jwt(api_key, api_secret)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"detail": raw.decode("utf-8", "replace")}
        return exc.code, payload
    except urllib.error.URLError as exc:
        raise SystemExit(f"Сетевая ошибка: {exc.reason}") from exc


def multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = "----xrayswitch" + secrets.token_hex(12)
    body = bytearray()
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for name, (filename, blob, ctype) in files.items():
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'
        ).encode()
        body += blob + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


# --------------------------------------------------------------------------- helpers
def read_credentials(args: argparse.Namespace) -> tuple[str, str]:
    key = args.api_key or os.environ.get("AMO_API_KEY")
    secret = args.api_secret or os.environ.get("AMO_API_SECRET")
    if (not key or not secret) and CREDENTIALS_FILE.is_file():
        values: dict[str, str] = {}
        for line in CREDENTIALS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip().strip('"').strip("'")
        key = key or values.get("AMO_API_KEY")
        secret = secret or values.get("AMO_API_SECRET")
    if not key or not secret:
        raise SystemExit(
            "Нет API-ключей AMO.\n"
            "Создайте их: https://addons.mozilla.org/developers/addon/api/key/\n"
            f"и положите в {CREDENTIALS_FILE}:\n"
            "  AMO_API_KEY=user:12345678:123\n"
            "  AMO_API_SECRET=...\n"
            "или передайте --api-key/--api-secret."
        )
    return key, secret


def xpi_manifest(path: pathlib.Path) -> dict:
    try:
        with zipfile.ZipFile(path) as zf:
            return json.loads(zf.read("manifest.json"))
    except (KeyError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        raise SystemExit(f"Не удалось прочитать manifest.json из {path}: {exc}") from exc


def verify_signed_xpi(path: pathlib.Path) -> None:
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
    except zipfile.BadZipFile as exc:
        raise SystemExit(f"Скачанный файл не является XPI: {exc}") from exc
    if "META-INF/mozilla.rsa" not in names or "META-INF/cose.sig" not in names:
        raise SystemExit(
            "Скачанный XPI не подписан Mozilla (нет META-INF/mozilla.rsa). "
            "AMO ещё не закончил подпись — повторите позже."
        )


def addon_guid(manifest: dict) -> str:
    gecko = manifest.get("browser_specific_settings", {}).get("gecko") or manifest.get(
        "applications", {}
    ).get("gecko", {})
    guid = gecko.get("id")
    if not guid:
        raise SystemExit("В manifest.json нет browser_specific_settings.gecko.id — AMO не сможет подписать.")
    return guid


def load_state() -> dict:
    if STATE_FILE.is_file():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def print_validation(upload: dict, key: str, secret: str) -> None:
    print("Валидация не прошла:", file=sys.stderr)
    message = upload.get("message")
    if message:
        print(f"  {message}", file=sys.stderr)
    errors = (upload.get("validation") or {}).get("errors") if isinstance(upload.get("validation"), dict) else None
    if errors:
        print(f"  ошибок: {errors}", file=sys.stderr)
    url = upload.get("validation_url")
    if url:
        status, report = request("GET", url, api_key=key, api_secret=secret)
        if status == 200:
            for item in report.get("errors", []) + report.get("warnings", []):
                if isinstance(item, dict):
                    print(f"  - {item.get('message')}", file=sys.stderr)
                else:
                    print(f"  - {item}", file=sys.stderr)
        else:
            print(f"  отчёт: {url}", file=sys.stderr)


def poll_upload(uuid: str, key: str, secret: str, timeout: int) -> dict:
    deadline = time.time() + timeout
    while True:
        status, upload = request("GET", f"addons/upload/{uuid}/", api_key=key, api_secret=secret)
        if status != 200:
            raise SystemExit(f"Не удалось проверить загрузку ({status}): {upload}")
        if upload.get("processed"):
            return upload
        if time.time() > deadline:
            raise SystemExit(f"Валидация не завершилась за {timeout}s; попробуйте позже.")
        print("  … валидация", flush=True)
        time.sleep(5)


def find_addon_id(guid: str, key: str, secret: str) -> int | str | None:
    query = urllib.parse.urlencode({"q": guid, "app": "firefox", "page_size": 50})
    status, data = request("GET", f"addons/search/?{query}", api_key=key, api_secret=secret)
    if status != 200:
        return None
    for item in data.get("results", []):
        if item.get("guid", "").lower() == guid.lower():
            return item.get("id") or item.get("slug")
        if item.get("slug", "").lower() == guid.lower():
            return item.get("id") or item.get("slug")
    return None


def signed_file_url(addon: dict, want_version: str) -> str | None:
    """Return the signed XPI URL for want_version.

    For self-distributed (unlisted) add-ons AMO exposes the signed file in
    ``latest_unlisted_version``; ``current_version`` stays empty because the
    add-on is never publicly listed.
    """
    for field in ("latest_unlisted_version", "current_version"):
        version = addon.get(field) or {}
        if not isinstance(version, dict) or version.get("version") != want_version:
            continue
        file_info = version.get("file") or {}
        url = file_info.get("url")
        # AMO exposes an upload URL before signing completes. Only a "public"
        # file is the Mozilla-signed XPI.
        if url and file_info.get("status") == "public":
            return url
    return None


def wait_for_signed(
    addon_id: int | str, want_version: str, key: str, secret: str, timeout: int
) -> tuple[str, dict]:
    deadline = time.time() + timeout
    last_note = 0.0
    while True:
        status, addon = request("GET", f"addons/addon/{addon_id}/", api_key=key, api_secret=secret)
        if status != 200:
            raise SystemExit(f"Не удалось получить карточку дополнения ({status}): {addon}")
        url = signed_file_url(addon, want_version)
        if url:
            return url, addon
        if time.time() > deadline:
            slug = addon.get("slug") or addon_id
            raise SystemExit(
                "Версия ещё не подписана (возможно, отправлена на ручную проверку).\n"
                f"Статус: https://addons.mozilla.org/developers/addon/{slug}/versions/"
            )
        if time.time() - last_note > 30:
            print("  … ожидание подписи", flush=True)
            last_note = time.time()
        time.sleep(5)


def parse_ini(text: str) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1]
            sections.setdefault(current, {})
            continue
        if current is not None and "=" in line:
            name, value = line.split("=", 1)
            sections[current][name.strip()] = value.strip()
    return sections


def default_firefox_profile() -> pathlib.Path:
    for root in (
        pathlib.Path.home() / ".config" / "mozilla" / "firefox",
        pathlib.Path.home() / ".mozilla" / "firefox",
    ):
        ini = root / "profiles.ini"
        if not ini.is_file():
            continue
        sections = parse_ini(ini.read_text(encoding="utf-8"))
        default = next(
            (sec.get("Default") for name, sec in sections.items() if name.startswith("Install") and sec.get("Default")),
            None,
        )
        if not default:
            profile0 = next((sec for name, sec in sections.items() if name.startswith("Profile")), {})
            default = profile0.get("Path")
        if not default:
            continue
        for name, sec in sections.items():
            if name.startswith("Profile") and sec.get("Path") == default:
                path = pathlib.Path(sec["Path"])
                return path if sec.get("IsRelative", "1") != "1" else root / path
        return root / default
    raise SystemExit("Не нашёл профиль Firefox. Укажите --profile.")


def install_into_profile(xpi: pathlib.Path, guid: str, profile: pathlib.Path) -> pathlib.Path:
    target_dir = profile / "extensions"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{guid}.xpi"
    shutil.copyfile(xpi, target)

    # Sideloaded extensions are disabled by default; allow the signed XPI in the
    # profile to be enabled automatically on startup.
    user_js = profile / "user.js"
    pref = 'user_pref("extensions.autoDisableScopes", 0);'
    text = user_js.read_text(encoding="utf-8") if user_js.is_file() else ""
    if "extensions.autoDisableScopes" not in text:
        with user_js.open("a", encoding="utf-8") as fh:
            if text and not text.endswith("\n"):
                fh.write("\n")
            fh.write(pref + "\n")
    return target


# --------------------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser(description="Подписать Firefox XPI на addons.mozilla.org (unlisted).")
    parser.add_argument("xpi", nargs="?", default=DEFAULT_XPI, help=f"путь к XPI (по умолчанию {DEFAULT_XPI})")
    parser.add_argument("--channel", default="unlisted", choices=["unlisted"], help="канал AMO (только unlisted)")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"куда сохранить подписанный XPI (по умолчанию {DEFAULT_OUT})")
    parser.add_argument("--timeout", type=int, default=600, help="сколько секунд ждать валидации/подписи")
    parser.add_argument("--api-key", help="AMO JWT issuer (иначе env/файл)")
    parser.add_argument("--api-secret", help="AMO JWT secret (иначе env/файл)")
    parser.add_argument("--addon-id", help="id/slug уже существующего дополнения (для обновления версии)")
    parser.add_argument("--install", action="store_true", help="скопировать подписанный XPI в профиль Firefox")
    parser.add_argument("--profile", help="путь к профилю Firefox для --install")
    parser.add_argument("--dry-run", action="store_true", help="ничего не отправлять, только проверить входные данные")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    xpi = pathlib.Path(args.xpi)
    if not xpi.is_absolute():
        xpi = root / xpi
    if not xpi.is_file():
        raise SystemExit(f"XPI не найден: {xpi}")

    manifest = xpi_manifest(xpi)
    guid = addon_guid(manifest)
    out = pathlib.Path(args.out)
    if not out.is_absolute():
        out = root / out

    key, secret = read_credentials(args)
    print(f"XPI:    {xpi}")
    print(f"ID:     {guid} v{manifest.get('version')}")
    print(f"Канал:  {args.channel}")
    make_jwt(key, secret)  # проверяем, что ключи вообще годятся для HMAC

    if args.dry_run:
        print("dry-run: ключи прочитаны, XPI валиден, запросы не отправлялись.")
        return 0

    state = load_state()
    print("Загружаю XPI на AMO…")
    body, content_type = multipart(
        {"channel": args.channel},
        {"upload": (xpi.name, xpi.read_bytes(), "application/x-xpinstall")},
    )
    status, upload = request(
        "POST", "addons/upload/", api_key=key, api_secret=secret, data=body, content_type=content_type
    )
    if status not in (200, 201, 202):
        raise SystemExit(f"Загрузка отклонена ({status}): {upload}")
    uuid = upload.get("uuid")
    if not uuid:
        raise SystemExit(f"AMO не вернул uuid: {upload}")

    upload = poll_upload(uuid, key, secret, args.timeout)
    if not upload.get("valid"):
        print_validation(upload, key, secret)
        return 1
    print("  ✓ валидация пройдена")

    want = str(manifest.get("version"))
    addon_id = args.addon_id or state.get("addon_id")

    def load_addon(aid):
        if not aid:
            return None
        status, data = request("GET", f"addons/addon/{aid}/", api_key=key, api_secret=secret)
        return data if status == 200 else None

    addon = load_addon(addon_id)
    if addon is None:
        print("Создаю карточку дополнения…")
        status, created_addon = request(
            "POST",
            "addons/addon/",
            api_key=key,
            api_secret=secret,
            data=json.dumps({"version": {"upload": uuid}}).encode(),
            content_type="application/json",
        )
        if status in (200, 201):
            addon_id = created_addon.get("id") or created_addon.get("slug")
            state.update({"addon_id": addon_id, "slug": created_addon.get("slug"), "guid": guid})
            save_state(state)
            print(f"  ✓ создано дополнение: {created_addon.get('slug') or addon_id}")
        else:
            addon_id = args.addon_id or find_addon_id(guid, key, secret) or state.get("addon_id")
            if not addon_id:
                raise SystemExit(f"Не удалось создать дополнение ({status}): {created_addon}")
        addon = load_addon(addon_id)

    if addon is not None and signed_file_url(addon, want) is None:
        print(f"Добавляю версию {want} к дополнению {addon_id}…")
        status, version = request(
            "POST",
            f"addons/addon/{addon_id}/versions/",
            api_key=key,
            api_secret=secret,
            data=json.dumps({"upload": uuid}).encode(),
            content_type="application/json",
        )
        if status == 409:
            print("  версия уже существует, продолжаю")
        elif status not in (200, 201, 202):
            raise SystemExit(f"Не удалось добавить версию ({status}): {version}")
        else:
            state.update({"addon_id": addon_id, "guid": guid})
            save_state(state)

    url, addon = wait_for_signed(addon_id, want, key, secret, args.timeout)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Скачиваю подписанный XPI: {url}")
    # Файлы self-distributed (unlisted) дополнений отдаются только с JWT.
    req = urllib.request.Request(url, headers={"Authorization": "JWT " + make_jwt(key, secret)})
    with urllib.request.urlopen(req, timeout=180) as resp, out.open("wb") as fh:
        shutil.copyfileobj(resp, fh)
    verify_signed_xpi(out)
    print(f"  ✓ {out}")

    if args.install:
        profile = pathlib.Path(args.profile).expanduser() if args.profile else default_firefox_profile()
        target = install_into_profile(out, guid, profile)
        print(f"  ✓ установлено в профиль: {target}")
        print("    Перезапустите Firefox — расширение появится само.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

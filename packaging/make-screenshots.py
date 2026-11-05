#!/usr/bin/env python3
"""Render the QUICKSTART screenshots with headless Firefox.

The extension pages are the real HTML/CSS from extension/, with a small mock
script that fills sample data (no extension APIs needed). The installer image
is a stylized Windows Terminal mock of the real Go installer output.

Usage:
  python3 packaging/make-screenshots.py
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
OUT = ROOT / "docs" / "images"


def strip_scripts(html: str) -> str:
    lines = []
    for line in html.splitlines():
        if line.strip().startswith("<script"):
            continue
        lines.append(line)
    return "\n".join(lines)


def options_html() -> str:
    html = strip_scripts((EXT / "options.html").read_text(encoding="utf-8"))
    head = (
        f'<head>\n<base href="file://{EXT}/">\n'
        '<style>.panel.active{animation:none!important;opacity:1!important;}</style>'
    )
    html = html.replace("<head>", head, 1)
    mock = """
<script>
(function () {
  function q(id) { return document.getElementById(id); }
  q("statusDot").className = "dot on";
  q("statusText").textContent = "Подключено · Основной";
  q("version").textContent = "v0.1.2";
  q("profileCount").textContent = "2";
  q("rulesCount").textContent = "2";
  q("subsCount").textContent = "1";
  var welcome = q("welcomeCard"); if (welcome) welcome.classList.add("hidden");

  var profiles = q("profilesList");
  profiles.innerHTML = "";
  var rows = [
    ["🟢 Основной", "de.example.com:443 · example.com", ["reality", "tcp", "42 мс"], true],
    ["Резерв", "nl.example.net:443 · example.net", ["tls", "ws", "87 мс"], false]
  ];
  rows.forEach(function (row) {
    var el = document.createElement("div");
    el.className = "profile-row" + (row[3] ? " active" : "");
    el.innerHTML = '<input class="profile-radio" type="radio" name="activeProfile"' + (row[3] ? " checked" : "") + '>'
      + '<div class="profile-main"><div class="profile-name">' + row[0] + '</div>'
      + '<div class="profile-sub">' + row[1] + '</div>'
      + '<div class="badges"><span class="badge ' + (row[2][0] === "reality" ? "reality" : "tls") + '">' + row[2][0] + '</span>'
      + '<span class="badge net">' + row[2][1] + '</span><span class="badge reality">' + row[2][2] + '</span></div></div>'
      + '<button class="btn-del" type="button">Удалить</button>';
    profiles.appendChild(el);
  });

  var rules = q("rulesList");
  rules.innerHTML = "";
  [["example.com", "прокси", "proxy"], ["*.example.net", "напрямую", "direct"]].forEach(function (r) {
    var el = document.createElement("div");
    el.className = "rule-row";
    el.innerHTML = '<div class="rule-pattern">' + r[0] + '</div>'
      + '<span class="rule-action ' + r[2] + '">' + r[1] + '</span>'
      + '<button class="btn-del" type="button">Удалить</button>';
    rules.appendChild(el);
  });

  var subs = q("subsList");
  subs.innerHTML = "";
  var sub = document.createElement("div");
  sub.className = "sub-row";
  sub.innerHTML = '<div class="sub-main"><div class="sub-url">https://sub.example.com/subscription.txt</div>'
    + '<div class="sub-meta">Профилей: 2 · обновлено: 05.11.2026, 20:45:12</div></div>'
    + '<div class="sub-actions"><select><option>6 ч</option></select>'
    + '<button class="btn ghost small" type="button">Обновить</button>'
    + '<button class="btn-del" type="button">Удалить</button></div>';
  subs.appendChild(sub);

  q("importText").value = "vless://11111111-2222-3333-4444-555555555555@de.example.com:443?security=reality&sni=example.com&fp=chrome&pbk=abcDEF123&sid=1a2b&type=tcp&flow=xtls-rprx-vision#Основной";
  var result = q("importResult");
  result.classList.remove("hidden");
  result.textContent = "Добавлено: 1 · проверка туннеля: 42 мс";

  q("helperPill").textContent = "работает";
  q("helperPill").className = "pill on";
  q("helperState").textContent = "online";
  q("coreState").textContent = "running";
  q("profileState").textContent = "🟢 Основной";
  q("socksState").textContent = "127.0.0.1:41291";
  q("httpState").textContent = "127.0.0.1:35059";
  q("versionState").textContent = "0.1.2";
  q("pidState").textContent = "82992";
  q("uptimeState").textContent = "2 ч 14 мин";
  q("logsPre").textContent = "[20:45:01] info: ядро запущено: Основной (SOCKS :41291, HTTP :35059)\\n[20:45:02] info: health-check OK · 42 мс\\n[20:45:12] info: подписка обновлена: +2 профиля";
})();
</script>
"""
    return html.replace("</body>", mock + "\n</body>")


def popup_html() -> str:
    html = strip_scripts((EXT / "popup.html").read_text(encoding="utf-8"))
    html = html.replace("<head>", f'<head>\n<base href="file://{EXT}/">', 1)
    mock = """
<script>
(function () {
  function q(id) { return document.getElementById(id); }
  q("version").textContent = "VLESS CONTROL // v0.1.2";
  q("statusDot").className = "dot on";
  q("statusTitle").textContent = "Подключено";
  q("statusSub").textContent = "Основной · SOCKS :41291";
  q("power").textContent = "Выкл";
  q("power").classList.add("is-on");
  document.querySelectorAll("#modeSeg button").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-mode") === "auto");
  });
  q("modeHint").textContent = "прокси только по правилам";
  var sel = q("profileSelect");
  sel.innerHTML = '<option selected>🟢 Основной</option><option>Резерв</option>';
  sel.disabled = false;
  q("profileMeta").textContent = "de.example.com:443 · reality / tcp";
  q("connectBtn").textContent = "Отключить";
  q("connectBtn").classList.add("is-stop");
  q("siteHost").textContent = "example.com";
  q("siteVerdict").textContent = "прокси";
  q("siteVerdict").className = "pill proxy";
  q("siteRule").textContent = "правило: example.com → прокси";
  document.querySelectorAll("[data-site]").forEach(function (b) {
    b.disabled = false;
    b.classList.toggle("active", b.getAttribute("data-site") === "proxy");
  });
  q("helperLine").textContent = "helper: online · SOCKS :41291 · v0.1.2";
})();
</script>
"""
    return html.replace("</body>", mock + "\n</body>")


INSTALLER = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(900px 500px at 20% 0%, #1b2735, #05070b 70%);
    font-family: "Inter", "Segoe UI", system-ui, sans-serif; }
  .window { width: 900px; border-radius: 12px; overflow: hidden;
    box-shadow: 0 30px 90px rgba(0,0,0,.65); border: 1px solid #2a3646; }
  .title { height: 38px; display: flex; align-items: center; gap: 10px;
    padding: 0 14px; background: #1b1f27; color: #cfd8e6; font-size: 12px; }
  .tab { padding: 6px 12px; border-radius: 7px 7px 0 0; background: #0c0f14;
    color: #e7eef8; font-weight: 600; }
  .dots { margin-left: auto; color: #6b7788; letter-spacing: 3px; }
  .term { background: #0c0f14; color: #d7e0ec; padding: 24px 26px 30px;
    font-family: "Cascadia Mono", "JetBrains Mono", "Consolas", monospace;
    font-size: 15px; line-height: 1.75; white-space: pre-wrap; }
  .prompt { color: #7dd3fc; }
  .ok { color: #34d399; }
  .muted { color: #8b98a9; }
  .cursor { display: inline-block; width: 9px; height: 18px; background: #d7e0ec;
    vertical-align: -3px; animation: none; }
</style></head>
<body><div class="window">
  <div class="title"><span class="tab">EXA Switch Setup</span><span class="muted">— Windows Terminal</span><span class="dots">— □ ×</span></div>
  <div class="term"><span class="prompt">C:\\Users\\user&gt;</span> EXA-Switch-Setup-windows-amd64.exe

EXA Switch Setup

Обнаружены браузеры:
  1) Firefox
  2) Google Chrome
  3) Microsoft Edge

Куда установить расширение? [1,2 / all / none] (Enter = Firefox, если есть): 1

  <span class="ok">✓</span> helper установлен и добавлен в автозагрузку
  <span class="ok">✓</span> расширение Firefox установлено
  Extensions:  Firefox

<span class="muted">Готово. Перезапустите Firefox и добавьте vless:// в настройках.</span>
<span class="prompt">C:\\Users\\user&gt;</span> <span class="cursor"></span></div>
</div></body></html>
"""


def render(html: str, name: str, width: int, height: int, profile: pathlib.Path) -> pathlib.Path:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="xs-shot-"))
    page = tmp / f"{name}.html"
    page.write_text(html, encoding="utf-8")
    out = OUT / f"{name}.png"
    subprocess.run(
        [
            "firefox", "--headless", "--no-remote", "--profile", str(profile),
            "--screenshot", str(out), f"--window-size={width},{height}", page.as_uri(),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=45,
    )
    shutil.rmtree(tmp, ignore_errors=True)
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    profile = pathlib.Path(tempfile.mkdtemp(prefix="xs-shot-profile-"))
    try:
        render(options_html(), "options-import", 1280, 1120, profile)
        render(popup_html(), "popup-site", 420, 760, profile)
        render(INSTALLER, "installer-browser-picker", 960, 560, profile)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    for path in sorted(OUT.glob("*.png")):
        print(path, path.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

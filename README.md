<p align="center"><img src="branding/logo.png" alt="EXA Switch" width="360"></p>

# EXA Switch

**EXA Switch** — браузерное расширение (Chrome / Chromium / Edge / Brave / Firefox) + локальный helper с **xray-core**.
Вставляете VLESS-конфиги, выбираете сайты — и только они идут через туннель. Остальное открывается напрямую.

> **EXA // EBANEX // SECURE TUNNEL**
>
> Это не «proxy-расширение, которое само умеет VLESS». Браузер физически не умеет открывать VLESS-соединение и не может быть SOCKS-сервером. Поэтому расширение управляет браузером, а настоящий туннель держит локальный helper с xray-core. Снаружи это выглядит как Proxy SwitchyOmega: оранжевый/зелёный badge, правила по сайтам, режимы «Авто» и «Всё».

## Документация

- [docs/OVERVIEW.md](docs/OVERVIEW.md) — что это, зачем нужно, архитектура, где хранятся данные, ограничения.
- [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md) — установка пакета (Arch/CachyOS), где появляется расширение, служба, обновление, удаление.
- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) — установка на Windows 10/11, автозапуск, Firefox и Chrome/Edge/Brave/Vivaldi.
- [docs/SECURITY.md](docs/SECURITY.md) — модель угроз, аудит безопасности, исправления и остаточные риски.

---

## Что умеет

- VLESS: **Reality**, **TLS**, **WS**, **gRPC**, **XHTTP**, **HTTPUpgrade**, **KCP**, `xtls-rprx-vision`.
- Импорт одной или нескольких ссылок `vless://` и base64-подписок.
- Профили с переключением на лету.
- Правила сайтов: `example.com`, `*.example.com`, `*google*`, «напрямую», «прокси».
- Режимы:
  - **Выкл** — весь трафик напрямую, ядро останавливается.
  - **Авто** — прокси только для сайтов с правилом `proxy`.
  - **Всё** — прокси для всего, кроме правил `direct`.
- Быстрое переключение текущего сайта из popup и контекстного меню.
- Локальный SOCKS5 + HTTP на `127.0.0.1` (только для этого браузера).
- Проверка туннеля, логи ядра, перезапуск helper'а.
- Экспорт/импорт настроек.
- Chrome: PAC-скрипт. Firefox: нативный `proxy.onRequest` (правила применяются сразу, без PAC).
- Linux, Windows, macOS (helper собирается под все три ОС).

---

## Как это устроено

```
┌──────────────────────────────┐        native messaging (один раз)        ┌──────────────────────────────┐
│  Расширение                  │  ───────────────────────────────────────▶  │  xray-switch-helper          │
│  • профили / правила         │                                            │  • держит xray-core в процессе│
│  • popup / options           │        HTTP API + Bearer token             │  • SOCKS5 / HTTP на loopback │
│  • PAC (Chrome)              │  ◀──────────────────────────────────────▶  │  • health, logs, restart     │
│  • proxy.onRequest (Firefox) │            127.0.0.1:<random>              └──────────────┬───────────────┘
└──────────────┬───────────────┘                                                           │
               │ chrome.proxy / browser.proxy                                              │ VLESS / Reality
               ▼                                                                           ▼
        Браузерный трафик  ───────────────────────────────────────────────────────▶  ваш VLESS-сервер
```

Почему так:

1. `chrome.proxy` умеет только «отправь запрос на TCP-прокси» — ему нужен реальный SOCKS/HTTP endpoint.
2. Endpoint даёт helper. Он запускает xray-core **внутри себя** (без отдельного бинарника xray).
3. Native messaging используется только для автозапуска helper'а и передачи токена. Дальше helper живёт отдельным демоном и переживает перезапуск браузера.
4. Chrome получает PAC-скрипт с правилами. Firefox получает per-request правило через `proxy.onRequest` и `proxyDNS: true`.

Токен и порт helper'а лежат в `~/.config/xray-switch/daemon.json` (Linux) с правами `0600`.
API слушает только `127.0.0.1`, проверяет `Host`, `Origin` и Bearer-токен.

---

## Установщики (готовые файлы)

Всё лежит в `dist/release/`:

| ОС | Файл | Как ставить |
|---|---|---|
| Windows 10/11 x64 | `EXA-Switch-Setup-windows-amd64.exe` | запустить `.exe` |
| Windows 11 ARM | `EXA-Switch-Setup-windows-arm64.exe` | запустить `.exe` |
| Linux x86_64 (Debian/Ubuntu) | `exa-switch_0.1.0_amd64.deb` | `sudo apt install ./exa-switch_0.1.0_amd64.deb` |
| Linux x86_64 (Fedora/RHEL) | `exa-switch-0.1.0-1.x86_64.rpm` | `sudo dnf install ./exa-switch-0.1.0-1.x86_64.rpm` |
| Linux x86_64 (Arch/CachyOS) | `exa-switch-0.1.1-1-x86_64.pkg.tar.zst` | `sudo pacman -U ./exa-switch-0.1.1-1-x86_64.pkg.tar.zst` |
| Linux x86_64 portable | `EXA-Switch-Setup-linux-amd64` | `chmod +x` и запустить (без root) |
| Linux ARM64 | `.deb` / `.rpm` / `EXA-Switch-Setup-linux-arm64` | аналогично |
| macOS Apple Silicon | `EXA-Switch-Setup-macos-arm64.zip` | распаковать и запустить `EXA Switch Setup.app` |
| macOS Intel | `EXA-Switch-Setup-macos-amd64.zip` | распаковать и запустить приложение |

Установщики ставят helper, native messaging, автозапуск и расширения.
**Firefox** получает подписанный XPI автоматически (Linux — через policy
`Extensions.Install` + `Locked`, Windows — в профиль + `user.js`).
**Chrome/Chromium/Edge/Brave/Vivaldi** получают подписанный CRX как external
extension и ставятся при следующем запуске браузера (Chrome может показать
один запрос подтверждения). Если external extension не сработал — остаётся
ручной `Load unpacked`, установщик откроет страницу с точными путями.

- **Chrome / Chromium / Edge / Brave:** automatic CRX / `chrome://extensions` → Developer mode → Load unpacked → папка из setup-страницы.
- **Firefox:** automatic signed XPI; для разработки также `about:debugging#/runtime/this-firefox` → Load Temporary Add-on.

Windows-установщик **спрашивает, в какие браузеры ставить расширение**
(Firefox по Enter; `1,2` / `all` / `none`). Для silent-установки:
`--browsers=firefox`, `--browsers=chrome,edge`, `--all-browsers`, `--no-browsers`.
Подробнее — [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md).

Браузерные архивы отдельно:

```
dist/release/exa-switch-chrome.zip
dist/release/exa-switch-firefox.xpi
```

Собрать установщики:

```bash
./build.sh --cross          # helper под linux/windows/macos, amd64 + arm64
python3 packaging/build.py  # .exe / .deb / .rpm / .app.zip + SHA256SUMS
```

`packaging/build.py` сам подтянет `rpm-build` через `dnf download`, если `rpmbuild` нет в PATH. Для `.deb` используется `ar` + `tar`, без `dpkg-deb`.

---

## Быстрый старт из исходников

### 1. Собрать

Нужен **Go 1.27+** (только для сборки helper'а) и `python3`.

```bash
cd xray-switch
./build.sh --cross      # helper для linux/windows/macos + расширения
# или только под текущую ОС:
./build.sh
```

Готовые файлы:

```
dist/chrome/                  ← unpacked Chrome-расширение
dist/firefox/                 ← Firefox-расширение
dist/helper/                  ← бинарники helper'а (linux/windows/macos, amd64/arm64)
dist/chrome-id.txt            ← стабильный ID Chrome-расширения
```

### 2. Установить helper

**Linux / macOS:**

```bash
./install.sh
```

Скрипт:
- копирует helper в `~/.local/share/xray-switch/` (macOS: `~/Library/Application Support/xray-switch/`);
- на Linux с systemd ставит user-службу `xray-switch.service` (автозапуск при входе, `systemctl --user status xray-switch`);
- прописывает native messaging для Chrome, Chromium, Brave, Edge, Vivaldi и Firefox;
- останавливает старый helper и запускает новый.

**Windows** (PowerShell, обычный пользователь, **не** Administrator):

```powershell
.\install.ps1
```

Скрипт копирует `.exe` в `%LOCALAPPDATA%\xray-switch`, пишет манифесты и ключи реестра `HKCU`.

> Не запускайте `install.sh` через `sudo`: native messaging ставится в профиль пользователя.

### 3. Загрузить расширение

**Chrome / Chromium / Brave / Edge:**

1. `chrome://extensions` → включить **Developer mode**.
2. **Load unpacked** → выбрать `dist/chrome`.
3. Перезапустить браузер (Chrome подхватывает новый native host только при старте).

**Firefox:**

1. `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → `dist/firefox/manifest.json`.

> В пакете Arch/CachyOS расширение уже подписано и ставится автоматически
> (`/usr/lib/firefox/browser/extensions/`). Этот шаг нужен только для запуска
> из исходников без пакета.

Временное дополнение исчезнет после перезапуска Firefox. Для постоянной установки нужна подпись (AMO) либо Developer Edition/Nightly с `xpinstall.signatures.required = false`.

### 4. Добавить VLESS

1. Открыть настройки расширения (шестерёнка в popup).
2. Вставить ссылку:

```
vless://uuid@server:443?encryption=none&security=reality&sni=example.com&fp=chrome&pbk=...&sid=...&type=tcp&flow=xtls-rprx-vision#Мой сервер
```

3. Нажать **Импортировать**. Для подписки можно вставить `https://...` — расширение попросит доступ к домену и загрузит base64-список.
4. Выбрать активный профиль, режим **Авто**.
5. Добавить сайты в «Правилах» или открыть сайт и нажать **Прокси** в popup.

После смены правил новые соединения применяются сразу. Старые keep-alive соединения могут жить до перезагрузки страницы — это нормально для браузерного прокси.

---

## Подпись Firefox-расширения (AMO)

Release-Firefox ставит только подписанные дополнения, поэтому `.xpi` нужно один раз подписать в Mozilla. Ключи API берутся здесь: <https://addons.mozilla.org/developers/addon/api/key/>.

```bash
mkdir -p ~/.config/amo && chmod 700 ~/.config/amo
cat > ~/.config/amo/credentials <<'EOF'
AMO_API_KEY=user:12345678:123
AMO_API_SECRET=...
EOF
chmod 600 ~/.config/amo/credentials

./scripts/sign-firefox.py --install
```

Скрипт загружает `dist/release/exa-switch-firefox.xpi` как **unlisted** (self-distribution), ждёт валидацию, скачивает подписанный файл в `dist/release/exa-switch-firefox-signed.xpi` и с `--install` копирует его в `extensions/` профиля Firefox, добавляя `extensions.autoDisableScopes=0` в `user.js` (иначе Firefox выключает sideload-расширения). После перезапуска браузера расширение появляется само.

Только Python 3, без Node и внешних пакетов. Повторная подпись новой версии — та же команда (не забудьте поднять `version` в манифесте).

## Правила

| Шаблон | Что означает |
|---|---|
| `example.com` | сам домен и все поддомены |
| `*.example.com` | только поддомены, без самого `example.com` |
| `*google*` | glob по всему хосту |
| `*` | все сайты |

- Более специфичное правило побеждает.
- При равенстве приоритет у **direct** (чтобы исключения работали предсказуемо).
- Локальные адреса (`localhost`, `*.local`, `10.*`, `192.168.*`, `172.16-31.*`, `127.*`, `::1`) всегда идут напрямую и не проксируются.
- `example.com` в режиме **Авто** — прокси; в режиме **Всё** — исключение (напрямую).

В popup для текущего сайта есть три кнопки: **Прокси**, **Напрямую**, **Сброс**. Они создают/удаляют точное правило для хоста. Контекстное меню страницы делает то же самое.

---

## Ограничения (честно)

- **Только VLESS.** VMess/Trojan/Shadowsocks в подписках пропускаются с сообщением. Добавить их можно в `extension/lib/vless.js` + `background.js` (парсер и профиль).
- **Нет WebRTC/UDP и трафика других приложений.** Это браузерный прокси, а не системный VPN. QUIC/HTTP3 браузер может пускать через TCP fallback; UDP-ассоциации у SOCKS выключены.
- **Chrome — только PAC и только по хосту.** Правила по путям URL, заголовкам и т.п. не поддерживаются. Firefox использует `proxy.onRequest` и тоже матчит по хосту.
- **Полный JSON-конфиг xray не импортируется.** Поддерживаются VLESS-ссылки; из них генерируется outbound.
- **`allowInsecure` больше не работает** в xray 26.x (удалён после 2026-06-01). Ссылки с `allowInsecure=1` импортируются, но флаг игнорируется — нужен валидный сертификат или `pcs=`/`vcn=`.
- **Транспорты `h2` и `quic` удалены в xray 26.x** — используйте `type=xhttp` (H2/H3).
- **KCP header/seed** удалены в xray 26.x; KCP работает без них.
- **Legacy XTLS** (`xtls-rprx-direct`, `xtls-rprx-splice`) не поддерживается; нужен `xtls-rprx-vision`.
- **DNS для адреса VLESS-сервера** резолвится системным DNS (домен сервера, не целевые сайты). Целевые домены уходят на сервер через SOCKS/HTTP.
- **Flatpak/Snap браузеры** могут не видеть native host. Ставьте браузер из репозитория или используйте Chrome/Chromium из tar/deb/rpm.
- **Windows/macOS бинарники** собраны кросс-компиляцией и не проходили живой тест на этих ОС. Логика кроссплатформенная, но если что-то пойдёт не так — смотрите `daemon.log`.

---

## Если что-то не работает

### «Helper не установлен»

1. Убедитесь, что `install.sh` / `install.ps1` выполнен **без sudo**.
2. Проверьте манифест:
   - Chrome Linux: `~/.config/google-chrome/NativeMessagingHosts/com.oleg.xray_switch.json`
   - Chromium Linux: `~/.config/chromium/NativeMessagingHosts/com.oleg.xray_switch.json`
   - Firefox Linux: `~/.mozilla/native-messaging-hosts/com.oleg.xray_switch.json`
3. В манифесте `path` должен указывать на существующий исполняемый файл.
4. Перезапустите браузер.
5. Если Chrome запущен с кастомным `--user-data-dir`, положите манифест в `<user-data-dir>/NativeMessagingHosts/`.
6. Chrome ID расширения должен совпадать с `allowed_origins` в манифесте (`dist/chrome-id.txt`).

### «Helper не отвечает»

```bash
~/.local/share/xray-switch/xray-switch-helper status
~/.local/share/xray-switch/xray-switch-helper stop
~/.local/share/xray-switch/xray-switch-helper ensure
tail -50 ~/.config/xray-switch/daemon.log
```

Порты helper'а:

```bash
ss -ltnp | grep xray-switch
```

### Страницы с прокси падают с `ERR_PROXY_CONNECTION_FAILED`

Ядро не запущено или конфиг невалиден. Откройте **Helper и логи** в настройках:
- статус ядра;
- последняя ошибка;
- кнопка **Проверить** (делает HTTPS-запрос через SOCKS);
- лог xray.

Пока helper недоступен, включённый режим работает **fail-closed**: сайты из правил не открываются, а не уходят напрямую. Если native host на месте, расширение попытается автоматически перезапустить helper и восстановить туннель.

### После смены профиля сайт всё ещё открывается по-старому

Перезагрузите страницу. Chrome держит старые keep-alive соединения.

### Ошибка `'pacScript.data' supports only ASCII code`

Это баг старой версии; в текущей PAC принудительно ASCII, IDN-домены конвертируются в Punycode. Если видите — обновите расширение (`./build.sh`).

---

## Разработка

### Структура

```
xray-switch/
├── build.sh                 сборка helper + dist/chrome + dist/firefox
├── install.sh               Linux/macOS installer
├── install.ps1              Windows installer
├── uninstall.sh             удаление (Linux/macOS)
├── docs/                    OVERVIEW / INSTALL-LINUX / SECURITY
├── packaging/               .deb / .rpm / .exe / .app / pacman-пакет
│   └── build-arch.py        сборка exa-switch-*.pkg.tar.zst (Arch/CachyOS)
├── helper/                  Go-хелпер с xray-core
│   ├── main.go              daemon | ensure | native | stop | status | version
│   ├── daemon.go            lifecycle, порты, flock, сигналы
│   ├── api.go               HTTP API, CORS, Host guard, token auth
│   ├── core.go              запуск xray-core, конфиг, логи
│   ├── ensure.go            автозапуск демона, stop/status
│   ├── health.go            SOCKS5 + TLS + HTTP health-check
│   ├── native.go            native messaging framing
│   └── ring.go              ring-буфер логов
├── extension/
│   ├── manifest.chrome.json
│   ├── manifest.firefox.json
│   ├── background.js        SW/event page, синхронизация, сообщения
│   ├── lib/vless.js         парсер vless:// и подписок
│   ├── lib/rules.js         движок правил
│   ├── lib/pac.js           генератор PAC (ES5)
│   ├── lib/api.js           клиент helper'а + native messaging
│   ├── popup.*              компактный UI
│   └── options.*            профили/правила/логи
├── tests/                   Node-тесты + smoke helper'а
└── dist/                    результат сборки (не коммитить)
```

### Тесты

```bash
# Node 20+, helper уже собран в dist/helper/
./tests/run.sh
```

Или вручную:

```bash
node --test tests/run-tests.mjs
node --test tests/background.test.mjs
HELPER_BIN=$PWD/dist/helper/xray-switch-helper node --test tests/helper-smoke.mjs
```

Что проверяется:
- парсинг Reality/TLS/WS/gRPC/XHTTP/HTTPUpgrade/KCP/IPv6/подписок;
- специфичность правил и совпадение с сгенерированным PAC;
- PAC только ASCII, IDN → Punycode;
- background: импорт, старт/стоп ядра, режимы, правила, экспорт/импорт, подписки, ошибки helper'а;
- Firefox `proxy.onRequest`;
- helper: запуск xray с outbound'ами всех поддерживаемых транспортов, health, логи.

Полные браузерные smoke-тесты (Chrome/Chromium через Playwright и Firefox через Selenium) выполнялись при разработке отдельно; в репозиторий они не включены, чтобы не тащить тяжёлые зависимости. Они проверяли: загрузку расширения, native messaging, запуск ядра, установку PAC/`proxy.onRequest`, per-site маршрутизацию и fail-closed при остановке helper'а.

### API helper'а

Все endpoint'ы требуют `Authorization: Bearer <token>` (кроме preflight).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/ping` | жив ли helper |
| GET | `/api/status` | состояние ядра, порты, uptime, ошибки |
| POST | `/api/start` | `{id,name,outbound}` — запустить ядро |
| POST | `/api/stop` | остановить ядро |
| GET | `/api/health?target=https://...` | HTTPS-запрос через SOCKS |
| GET | `/api/logs?limit=200` | последние логи |
| POST | `/api/shutdown` | остановить демон |

Токен: `~/.config/xray-switch/daemon.json` (Linux), `~/Library/Application Support/xray-switch/` (macOS), `%APPDATA%\xray-switch\` (Windows).

### Версия xray-core

Helper собирается с `github.com/xtls/xray-core` на коммите релиза **26.10.31** (pseudo-version `v1.260327.1-0.20261031132019-a4a3dff5b20c`). Обновление:

```bash
cd helper
go get github.com/xtls/xray-core@<commit>
go mod tidy
```

---

## Безопасность

- Helper слушает только loopback и требует случайный 256-битный токен.
- CORS разрешён только `chrome-extension://` и `moz-extension://`; `Host` проверяется (защита от DNS rebinding).
- Native messaging разрешён только ID этого расширения.
- Профили и UUID хранятся в `chrome.storage.local` и никуда не отправляются.
- Подписка скачивается только по кнопке и только после разрешения на домен.
- Экспорт настроек содержит VLESS-ссылки/UUID — не публикуйте файл.
- Helper работает с правами пользователя; xray-core не требует root.
- SOCKS/HTTP-порты helper'а без пароля (PAC не умеет авторизацию). Любой процесс этого пользователя может найти порт и использовать ваш туннель; на многопользовательской машине учитывайте это.

---

## Удаление

**Linux/macOS:**

```bash
./uninstall.sh          # убрать helper и native manifests
./uninstall.sh --purge  # плюс конфиг/логи/токен
```

**Windows:**

```powershell
.\install.ps1 -Uninstall
.\install.ps1 -Uninstall -Purge
```

Расширение удалите в браузере: `chrome://extensions` или `about:addons`.

---

## Лицензия

Код расширения и helper'а — MIT (см. `LICENSE`).
xray-core — MPL-2.0, см. `THIRD_PARTY.md`.

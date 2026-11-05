# Установка EXA Switch на Windows

Поддерживаются Windows 10/11 x64 и ARM64. Установщик работает **от обычного
пользователя**, без прав администратора.

## Что ставится

| Что | Куда |
|---|---|
| Helper + xray-core | `%LOCALAPPDATA%\xray-switch\xray-switch-helper.exe` |
| Автозапуск | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `XraySwitchHelper` |
| Native messaging (Chrome/Chromium/Edge/Brave/Vivaldi) | `HKCU\Software\<browser>\NativeMessagingHosts\com.oleg.xray_switch` |
| Native messaging (Firefox) | `HKCU\Software\Mozilla\NativeMessagingHosts\com.oleg.xray_switch` |
| Firefox-расширение | подписанный XPI в `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\extensions\` |
| Chrome-семейство | `exa-switch.crx` + `HKCU\Software\<browser>\Extensions\<id>` (external extension) |
| Настройка Chrome | `%LOCALAPPDATA%\xray-switch\setup.html` |
| Логи/токен | `%APPDATA%\xray-switch\` |

## Выбор браузеров

При обычном (интерактивном) запуске установщик сам находит браузеры и
спрашивает, куда ставить расширение:

```
Обнаружены браузеры:
  1) Firefox
  2) Google Chrome
  3) Microsoft Edge

Куда установить расширение? [1,2 / all / none] (Enter = Firefox, если есть):
```

- `1,2` — номера браузеров;
- `firefox,chrome` — имена;
- `all` — все найденные;
- `none` — не ставить расширение (только helper/native messaging);
- **Enter** — Firefox, если он найден; иначе все найденные.

Для silent-установки:

```powershell
.\EXA-Switch-Setup-windows-amd64.exe --silent --browsers=firefox
.\EXA-Switch-Setup-windows-amd64.exe --silent --browsers=chrome,edge
.\EXA-Switch-Setup-windows-amd64.exe --silent --all-browsers
.\EXA-Switch-Setup-windows-amd64.exe --silent --no-browsers
```

`install.ps1` понимает то же самое:

```powershell
.\install.ps1 -Browsers firefox
.\install.ps1 -Browsers chrome,edge
.\install.ps1 -AllBrowsers
.\install.ps1 -NoBrowsers
```

При переустановке выбор применяется заново: интеграция с браузерами, которые
не выбраны, удаляется (CRX-ключи в реестре и XPI из профилей Firefox).

## Установка

### Вариант 1 — готовый `.exe`

```powershell
.\EXA-Switch-Setup-windows-amd64.exe
```

или для ARM64:

```powershell
.\EXA-Switch-Setup-windows-arm64.exe
```

SmartScreen может предупредить (инсталлятор не подписан код-сертификатом):
**More info → Run anyway**.

### Вариант 2 — из исходников

```powershell
git clone <repo>
cd xray-switch
.\build.sh --cross          # или готовые бинарники в dist\helper\
python3 packaging\build-crx.py
.\install.ps1
```

## Где появляется расширение

### Firefox

1. `about:addons` → **Расширения** → **EXA Switch — VLESS по сайтам**.
2. На панели: иконка **пазла** → **EXA Switch** → закрепить.
3. Клик по иконке → popup.

После установки **перезапустите Firefox**.

### Chrome / Chromium / Edge / Brave / Vivaldi

Установщик кладёт подписанный CRX и прописывает external extension в
`HKCU`. Браузер поставит расширение при следующем запуске. Chrome/Edge могут
показать **один** запрос подтверждения («расширение установлено внешней
программой») — разрешите его.

Если расширение не появилось:

1. `chrome://extensions` → **Developer mode**.
2. **Load unpacked** → `%LOCALAPPDATA%\xray-switch\extension\chrome`.
3. Перезапустить браузер.

> В отличие от Firefox, Chrome не позволяет полностью молча поставить
> локальное расширение. External CRX — максимально близкий к «поставил и
> забыл» вариант без публикации в Chrome Web Store.

## Автозапуск и служба

Автозапуск — через `HKCU\...\Run` (не Windows-служба: helper работает с
правами пользователя и не требует admin). Проверка:

```powershell
& "$env:LOCALAPPDATA\xray-switch\xray-switch-helper.exe" status
& "$env:LOCALAPPDATA\xray-switch\xray-switch-helper.exe" stop
& "$env:LOCALAPPDATA\xray-switch\xray-switch-helper.exe" ensure
```

Логи:

```powershell
notepad "$env:APPDATA\xray-switch\daemon.log"
```

Если helper не отвечает, перезапустите браузер: native messaging
подхватывается при старте.

## Первый запуск

1. Откройте настройки расширения (шестерёнка в popup).
2. Вставьте `vless://...` → **Импортировать**.
3. Выберите профиль и режим **Авто**.
4. Откройте сайт → popup → **Прокси**.

## Удаление

```powershell
.\install.ps1 -Uninstall
# или
.\EXA-Switch-Setup-windows-amd64.exe --uninstall
```

С `-Purge` / `--purge` удаляется и `%APPDATA%\xray-switch` (токен, логи).

## Ограничения

- Windows-бинарники собраны кросс-компиляцией и не проходили живой тест на
  реальной Windows-машине. Если что-то пошло не так — смотрите
  `%APPDATA%\xray-switch\daemon.log` и `installer.log`.
- Chrome-семейство ставится как **external extension**; пользователь всё равно
  может его отключить. Для жёсткого `force_install` нужна политика
  `ExtensionInstallForcelist` с HTTPS-update URL (публикация в Web Store или
  свой сервер обновлений).
- Для Firefox без прав администратора используется sideload подписанного XPI
  (`extensions.autoDisableScopes=0`). С правами администратора можно
  использовать `distribution/policies.json` с `Extensions.Install` + `Locked`.

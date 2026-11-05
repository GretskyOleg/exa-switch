# Установка EXA Switch на Linux (Arch / CachyOS)

Пакет ставит **всё сразу**:

- helper с xray-core;
- systemd user-службу (автозапуск при входе);
- native messaging для Firefox/Chrome/Chromium/Brave/Edge/Vivaldi;
- **подписанное** расширение Firefox — оно появляется автоматически;
- страницу `xray-switch-setup` для Chrome (там расширение ставится вручную).

## 1. Установка пакета

```bash
sudo pacman -U ./exa-switch-0.1.2-1-x86_64.pkg.tar.zst
```

После установки:

- helper запускается как user-служба для пользователя, который вызвал `sudo`
  (`SUDO_USER`), либо включится при следующем входе;
- расширение уже лежит в `/usr/lib/firefox/browser/extensions/`;
- старый per-user helper (`~/.local/share/xray-switch`) и старый sideload-XPI
  удаляются автоматически.

> Если Firefox был запущен во время установки — **перезапустите его**.

Firefox ставится автоматически (policy). Chrome/Chromium/Edge/Brave/Vivaldi —
**по выбору**: `xray-switch-browsers install chrome,edge` (подробнее ниже).

## 2. Где появляется расширение

### Firefox

1. **`about:addons` → Расширения** — там будет **EXA Switch — VLESS по сайтам**.
   Оно уже включено (подписано Mozilla, установлено как app-global).
2. На панели: иконка **пазла** («Расширения») → **EXA Switch**.
   Правый клик по иконке → **Закрепить на панели**, чтобы она была всегда под рукой.
3. Клик по иконке открывает popup: статус, режим, профиль, кнопки
   **Прокси / Напрямую / Сброс** для текущего сайта.

Если Firefox не видит расширение: проверьте, что XPI и policy на месте:

```bash
ls -l /usr/share/xray-switch/exa-switch.xpi
cat /etc/firefox/policies/policies.json
```

и перезапустите браузер.

Расширение ставится политикой **`Extensions.Install` + `Extensions.Locked`**
в `/etc/firefox/policies/policies.json` (XPI лежит в
`/usr/share/xray-switch/exa-switch-<version>.xpi`). Поэтому в `about:addons`
кнопки «Отключить/Удалить» для него недоступны — это сделано специально, чтобы
прокси-настройки нельзя было случайно снести. Удаляется вместе с пакетом
(`sudo pacman -R exa-switch`); `post_remove` убирает и policy-запись.

### Chrome / Chromium / Brave / Edge

Пакет кладёт подписанный **CRX** в `/usr/share/xray-switch/exa-switch.crx`, но
не ставит его в браузеры автоматически. Выберите браузеры сами:

```bash
xray-switch-browsers list                 # что найдено и где
xray-switch-browsers install chrome,edge  # поставить в выбранные
xray-switch-browsers install all          # во все найденные
xray-switch-browsers remove chrome        # убрать
```

Это per-user настройка: пишется `~/.config/<browser>/External Extensions/<id>.json`.
После выбора **перезапустите браузер**; Chrome/Edge могут показать один запрос
подтверждения. Firefox этой командой не управляется — он ставится policy пакета.

Если external extension не сработал — откройте страницу настройки:

```bash
xray-switch-setup
```

или вручную:

1. `chrome://extensions` → включить **Developer mode**.
2. **Load unpacked** → `/opt/xray-switch/extension/chrome`.
3. Перезапустить браузер (native messaging подхватывается при старте).

## 3. Служба helper'а

```bash
systemctl --user status xray-switch      # состояние
systemctl --user restart xray-switch     # перезапуск
systemctl --user stop xray-switch        # остановить
journalctl --user -u xray-switch -f      # логи
xray-switch-helper status                # JSON-статус через API
```

Служба работает **от вашего пользователя**, не от root, и слушает только
`127.0.0.1`. Включена через `/etc/systemd/user/default.target.wants/`, поэтому
стартует при входе в систему.

## 4. Первый запуск

1. Откройте настройки расширения (шестерёнка в popup).
2. Вставьте VLESS-ссылку:

   ```
   vless://uuid@server:443?encryption=none&security=reality&sni=example.com&fp=chrome&pbk=...&sid=...&type=tcp&flow=xtls-rprx-vision#Мой сервер
   ```

3. Нажмите **Импортировать**. Для подписки можно вставить `https://...` —
   расширение попросит доступ к домену.
4. Выберите профиль и режим **Авто**.
5. Добавьте сайты в «Правилах» или откройте сайт и нажмите **Прокси** в popup.

Проверка туннеля — кнопка **Проверить** в настройках (делает HTTPS-запрос через SOCKS).

## 5. Что установлено и где

| Путь | Назначение |
|---|---|
| `/opt/xray-switch/xray-switch-helper` | helper с xray-core |
| `/usr/bin/xray-switch-helper` | symlink для CLI |
| `/usr/bin/xray-switch-browsers` | выбор браузеров для Chrome-family |
| `/usr/bin/xray-switch-setup` | открывает страницу настройки Chrome |
| `/usr/lib/systemd/user/xray-switch.service` | user-служба |
| `/etc/systemd/user/default.target.wants/xray-switch.service` | автозапуск |
| `/usr/lib/firefox/browser/extensions/xray-switch@oleg.dev.xpi` | подписанное расширение Firefox |
| `/usr/share/xray-switch/exa-switch-<version>.xpi` | подписанный XPI для policy |
| `/usr/share/xray-switch/exa-switch.xpi` | тот же XPI (стабильное имя для ручной установки) |
| `/usr/share/doc/exa-switch/` | эта документация, лицензии |
| `/etc/{opt/chrome,chromium,brave,opt/edge,vivaldi}/native-messaging-hosts/` | native host для Chromium-браузеров |
| `/usr/lib/mozilla/native-messaging-hosts/` | native host для Firefox |

## 6. Обновление

1. Поднимите `version` в `extension/manifest.chrome.json` и `manifest.firefox.json`.
2. Пересоберите helper (если менялся Go-код) и расширения:

   ```bash
   ./build.sh --no-helper
   ```

3. Подпишите Firefox-XPI (нужны ключи AMO, см. README):

   ```bash
   ./scripts/sign-firefox.py
   ```

4. Соберите пакет:

   ```bash
   python3 packaging/build-arch.py
   sudo pacman -U dist/release/exa-switch-*.pkg.tar.zst
   ```

## 7. Удаление

```bash
sudo pacman -R exa-switch
```

Конфиг, токен и профили остаются в `~/.config/xray-switch` и в профиле Firefox.
Для полной очистки:

```bash
rm -rf ~/.config/xray-switch
# расширение: about:addons → EXA Switch → Удалить (если нужно)
```

## 8. Если что-то не работает

**«Helper не установлен» / «Helper не отвечает»**

```bash
systemctl --user status xray-switch
journalctl --user -u xray-switch -n 50
```

Проверьте native host:

```bash
cat /usr/lib/mozilla/native-messaging-hosts/com.oleg.xray_switch.json
```

`path` должен указывать на существующий `/opt/xray-switch/xray-switch-helper`.

**«Helper не доступен» после перехода со старого `install.sh`**

Старый установщик писал user-level manifests в `~/.mozilla/...` и
`~/.config/...`, которые указывали на `~/.local/share/xray-switch/xray-switch-helper`.
Пакет удаляет их автоматически при установке/обновлении. Если ошибка осталась —
проверьте, что таких файлов нет:

```bash
find ~/.mozilla ~/.config -name 'com.oleg.xray_switch.json'
```

Они не должны ссылаться на `~/.local/share/xray-switch/`. Рабочий системный
manifest — `/usr/lib/mozilla/native-messaging-hosts/com.oleg.xray_switch.json`.

**Страницы с прокси падают с `ERR_PROXY_CONNECTION_FAILED`**

Ядро не запущено или профиль невалиден. Откройте **Helper и логи** в настройках:
статус ядра, последняя ошибка, кнопка **Проверить**, лог xray. Пока helper
недоступен, включённый режим работает **fail-closed**: сайты из правил не
открываются, а не уходят напрямую.

**После смены профиля сайт открывается по-старому**

Перезагрузите страницу — браузер держит старые keep-alive соединения.

# Документация EXA Switch

- **[OVERVIEW.md](OVERVIEW.md)** — что это, зачем нужно, как устроено, где хранятся
  данные и какие есть ограничения.
- **[INSTALL-LINUX.md](INSTALL-LINUX.md)** — установка пакета на Arch/CachyOS,
  где появляется расширение, управление службой, обновление и удаление.
- **[INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)** — установка на Windows 10/11,
  автозапуск, Firefox/Chrome/Edge/Brave/Vivaldi, удаление.
- **[SECURITY.md](SECURITY.md)** — модель угроз, результаты аудита, исправления
  и остаточные риски.

Коротко:

```bash
sudo pacman -U exa-switch-0.1.1-1-x86_64.pkg.tar.zst
# перезапустить Firefox
# about:addons → EXA Switch (уже включено)
# настройки → вставить vless:// → Импортировать → режим «Авто»
```

Служба helper'а:

```bash
systemctl --user status xray-switch
journalctl --user -u xray-switch -f
```

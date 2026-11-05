# EXA — Android VPN client

Нативный Android-клиент **EXA** в фирменном стиле: тёмный интерфейс, красный
акцент, логотип EXA. Весь системный трафик идёт через **VLESS/Reality**:
`VpnService` → `hev-socks5-tunnel` → локальный SOCKS5 → **xray-core** → сервер.

## Что уже есть

- Импорт `vless://` (одна или несколько ссылок) и base64-подписок.
- Импорт HTTPS-подписки по URL (лимит 2 МБ, без редиректов).
- Профили: выбор, удаление, хранение на устройстве.
- Подключение/отключение системного VPN, foreground-уведомление.
- Автоподключение при загрузке Android (если VPN уже разрешён).
- Логи xray/core/VPN, версия Xray.
- Тёмная тема EXA, иконка и hero-графика из брендинга.

## Сборка

Нужны: JDK 21, Android SDK (platform 35, build-tools 35.0.0), Gradle 8.10+.
Минимальная версия Android — **10 (API 29)** (требование hev-socks5-tunnel).

```bash
cd android
./scripts/download-libs.sh      # libv2ray.aar + hev-socks5-tunnel.aar
./gradlew assembleDebug         # debug APK
# или release (нужен keystore.properties, см. ниже)
./gradlew assembleRelease
```

APK:

```
app/build/outputs/apk/debug/app-debug.apk
app/build/outputs/apk/release/app-release.apk
```

`local.properties` с `sdk.dir=...` создаётся локально и не коммитится.

### Release-подпись

```bash
keytool -genkeypair -v -keystore keystore/exa-release.jks \
  -alias exa -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass '...' -keypass '...' -dname "CN=EXA, O=EXA, C=RU"

cat > keystore.properties <<'EOF'
storeFile=keystore/exa-release.jks
storePassword=...
keyAlias=exa
keyPassword=...
EOF
```

`keystore.properties` и `keystore/` в `.gitignore`. Без них release собирается
debug-ключом (только для тестов).

## Архитектура

```
MainActivity (Compose)
  └─ VpnController ── VpnService.prepare ── ExaVpnService
                                              ├─ VpnService.Builder → TUN fd
                                              ├─ XrayBridge → Libv2ray.startLoop(config, 0)
                                              │    └─ SOCKS5 127.0.0.1:2080
                                              └─ HevTunnel → TProxyStartService(hev.yaml, fd)
                                                   └─ TUN ⇄ SOCKS5 ⇄ xray ⇄ VLESS
```

- `Libv2ray` — AndroidLibXrayLite (xray-core через gomobile).
- `hev-socks5-tunnel` — TUN-to-SOCKS5 (TCP + UDP).
- Приложение исключено из VPN (`addDisallowedApplication`), чтобы upstream
  xray не заворачивался сам в себя.

## Ограничения MVP

- Только VLESS (Reality/TLS/WS/gRPC/XHTTP/HTTPUpgrade/KCP).
- Нет per-app split tunneling и своего DNS-резолвера.
- Нет автообновления подписок (только импорт по кнопке).
- Нет проверки задержки профилей.
- Release APK подписан локальным ключом; храни его для обновлений.

## Безопасность

- Подписки только HTTPS, лимит 2 МБ, без редиректов.
- Профили и ссылки хранятся локально в SharedPreferences.
- Нет аналитики и сетевых запросов, кроме выбранной подписки и VLESS-сервера.
- Приложение не логирует UUID/ссылки; в логах только события core/VPN.

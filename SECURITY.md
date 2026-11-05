# Security Policy

EXA Switch is a local browser proxy: the helper listens only on loopback and
the extension never sends profiles, UUIDs or rules to a third party.

Please **do not** paste `vless://` links, UUIDs, `daemon.json` or API keys into
public issues. For a report, the useful data is:

- helper and extension version;
- OS and browser;
- reproduction steps;
- `journalctl --user -u xray-switch` or `%APPDATA%\xray-switch\daemon.log`
  with tokens and links removed.

The full threat model and the audit results are in
[docs/SECURITY.md](docs/SECURITY.md).

## Secrets in this repository

- `packaging/.keys/` contains the Chrome CRX signing key and is gitignored.
- AMO credentials live in `~/.config/amo/credentials` and are never committed.
- `dist/` and `packaging/.build/` are build artifacts and are gitignored.

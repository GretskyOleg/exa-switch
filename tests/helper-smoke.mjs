import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.env.HELPER_BIN || path.join(root, "dist/helper/xray-switch-helper");
const available = fs.existsSync(bin);

function loadXS() {
  const sandbox = {
    console, URL, URLSearchParams, TextDecoder, TextEncoder, atob, btoa,
    crypto: globalThis.crypto, setTimeout, clearTimeout, fetch: globalThis.fetch
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["extension/lib/util.js", "extension/lib/vless.js"]) {
    const file = path.join(root, rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  }
  return sandbox.XS;
}

const PBK = "hrDhgHl88kLhvSft-EKzUWPpj7b6lCTgtRq7A6yRInE";
const UUID = "11111111-2222-3333-4444-555555555555";

const LINKS = [
  `vless://${UUID}@127.0.0.1:443?security=reality&sni=example.com&fp=chrome&pbk=${PBK}&sid=ab&type=tcp&flow=xtls-rprx-vision#Reality`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=ws&path=%2Fws&host=example.com#WS`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=xhttp&path=%2Fx&host=example.com&mode=auto#XHTTP`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=xhttp&path=%2Fx&host=example.com&mode=packet-up&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#XHTTPExtra`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=grpc&serviceName=svc#gRPC`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=httpupgrade&path=%2Fup&host=example.com#HTTPUpgrade`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=kcp&headerType=none&seed=test#KCP`,
  `vless://${UUID}@127.0.0.1:443?security=tls&sni=example.com&type=ws&path=%2Fws&allowInsecure=1#InsecureIgnored`
];

test("helper daemon accepts generated VLESS outbounds", { skip: !available && "helper binary not built" }, async () => {
  const XS = loadXS();
  // Never touch the user's running helper: use an isolated config dir so the
  // test's /api/shutdown cannot stop the systemd service.
  const testConfig = fs.mkdtempSync(path.join(os.tmpdir(), "xray-switch-test-"));
  const env = { ...process.env, XDG_CONFIG_HOME: testConfig };
  const ensured = spawnSync(bin, ["ensure"], { encoding: "utf8", timeout: 20000, env });
  assert.equal(ensured.status, 0, ensured.stderr || ensured.stdout);
  const info = JSON.parse(ensured.stdout.trim());
  assert.equal(info.ok, true, info.error);
  assert.ok(info.daemon.port > 0);

  const base = `http://127.0.0.1:${info.daemon.port}`;
  const headers = {
    "Authorization": "Bearer " + info.daemon.token,
    "Content-Type": "application/json"
  };

  async function api(method, endpoint, body) {
    const res = await fetch(base + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    return { status: res.status, data };
  }

  try {
    await api("POST", "/api/stop", {});

    assert.equal(XS.vless.parse(`vless://${UUID}@127.0.0.1:443?security=none&type=quic#QUIC`).ok, false);
    assert.equal(XS.vless.parse(`vless://${UUID}@127.0.0.1:443?security=tls&type=h2#H2`).ok, false);
    assert.equal(XS.vless.parse(`vless://${UUID}@127.0.0.1:443?security=tls&flow=xtls-rprx-direct#Legacy`).ok, false);

    for (const link of LINKS) {
      const parsed = XS.vless.parse(link);
      assert.equal(parsed.ok, true, parsed.error);
      const started = await api("POST", "/api/start", {
        id: parsed.meta.name,
        name: parsed.meta.name,
        outbound: parsed.outbound
      });
      assert.equal(started.status, 200, `${parsed.meta.name}: ${JSON.stringify(started.data)}`);
      assert.equal(started.data.running, true, parsed.meta.name);
      assert.ok(started.data.socksPort > 0);
    }

    // The helper must refuse to run anything but a VLESS client outbound,
    // even if an API token leaks to a local process.
    for (const evil of [
      { protocol: "freedom", settings: {} },
      { protocol: "dokodemo-door", settings: { address: "127.0.0.1", port: 22 } },
      { protocol: "vless", settings: { vnext: [] } }
    ]) {
      const rejected = await api("POST", "/api/start", { id: "evil", name: "evil", outbound: evil });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
      assert.equal(rejected.data.running, undefined);
    }

    const logs = await api("GET", "/api/logs?limit=20");
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.data.logs) && logs.data.logs.length > 0);

    const stopped = await api("POST", "/api/stop", {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.running, false);
  } finally {
    await api("POST", "/api/shutdown", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(testConfig, { recursive: true, force: true });
  }
});

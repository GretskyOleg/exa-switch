import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "t".repeat(64);
const UUID = "11111111-2222-3333-4444-555555555555";

function response(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  };
}

function createEnv(options = {}) {
  const storage = {};
  const listeners = {};
  const calls = { proxySet: [], proxyClear: 0, badges: [], native: 0, starts: 0, stops: 0 };
  let activeTab = { id: 7, url: "https://example.com/page", title: "Example" };

  const helper = {
    online: true,
    failEnsure: false,
    info: { port: 5555, token: TOKEN, pid: 42, version: "0.1.0", startedAt: new Date().toISOString() },
    status: {
      ok: true, service: "xray-switch", version: "0.1.0", pid: 42,
      running: false, name: "", profileId: "", socksPort: 1111, httpPort: 2222,
      apiPort: 5555, uptimeSec: 1, lastError: ""
    }
  };

  async function mockFetch(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.hostname === "sub.example") {
      const body = [
        `vless://22222222-3333-4444-5555-666666666666@sub.example.com:443?security=tls&type=ws&path=%2Fsub#FromSub`
      ].join("\n");
      return response(200, Buffer.from(body, "utf8").toString("base64"));
    }
    if (!helper.online) throw new Error("Failed to fetch");
    const auth = options.headers ? (options.headers.Authorization || options.headers.authorization) : "";
    if (auth !== "Bearer " + TOKEN) return response(401, { ok: false, error: "unauthorized" });

    switch (parsed.pathname) {
      case "/api/ping":
        return response(200, { ok: true, service: "xray-switch" });
      case "/api/status":
        return response(200, helper.status);
      case "/api/start": {
        const body = JSON.parse(options.body || "{}");
        calls.starts++;
        helper.status = {
          ...helper.status,
          running: true,
          name: body.name || "",
          profileId: body.id || "",
          lastError: ""
        };
        return response(200, helper.status);
      }
      case "/api/stop":
        calls.stops++;
        helper.status = { ...helper.status, running: false, name: "", profileId: "", lastError: "" };
        return response(200, helper.status);
      case "/api/health":
        return response(200, { ok: true, target: "https://example.com", latencyMs: 12 });
      case "/api/logs":
        return response(200, { ok: true, logs: [{ time: new Date().toISOString(), level: "info", message: "test" }] });
      case "/api/shutdown":
        helper.online = false;
        return response(200, { ok: true });
      default:
        return response(404, { ok: false, error: "not found" });
    }
  }

  const chrome = {
    storage: {
      local: {
        get(defaults) {
          const out = {};
          for (const key of Object.keys(defaults || {})) {
            out[key] = storage[key] !== undefined ? storage[key] : defaults[key];
          }
          return Promise.resolve(out);
        },
        set(values) {
          Object.assign(storage, values);
          return Promise.resolve();
        }
      }
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.message = fn; } },
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } },
      sendNativeMessage(host, msg) {
        calls.native++;
        if (helper.failEnsure) return Promise.reject(new Error("Specified native messaging host not found."));
        return Promise.resolve({ ok: true, daemon: helper.info });
      },
      openOptionsPage() {},
      getManifest() { return { version: "0.1.0" }; },
      getURL(p) { return "chrome-extension://test/" + p; }
    },
    alarms: {
      get() { return Promise.resolve(null); },
      create() {},
      onAlarm: { addListener(fn) { listeners.alarm = fn; } }
    },
    contextMenus: {
      removeAll() { return Promise.resolve(); },
      create() {},
      onClicked: { addListener(fn) { listeners.contextMenu = fn; } }
    },
    action: {
      setBadgeText(value) { calls.badges.push(value.text); },
      setBadgeBackgroundColor() {}
    },
    proxy: {
      settings: {
        set(value) { calls.proxySet.push(value); return Promise.resolve(); },
        clear() { calls.proxyClear++; return Promise.resolve(); }
      },
      onProxyError: { addListener(fn) { listeners.proxyError = fn; } }
    },
    tabs: {
      query() { return Promise.resolve([activeTab]); },
      reload() {}
    },
    permissions: {
      contains() { return Promise.resolve(true); },
      request() { return Promise.resolve(true); }
    }
  };

  if (options.firefox) {
    chrome.runtime.getBrowserInfo = () => Promise.resolve({ name: "Firefox" });
    chrome.proxy.onRequest = {
      addListener(fn) { listeners.proxyRequest = fn; }
    };
  }

  const sandbox = {
    chrome,
    fetch: mockFetch,
    AbortController,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    console
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    "extension/lib/util.js",
    "extension/lib/vless.js",
    "extension/lib/rules.js",
    "extension/lib/pac.js",
    "extension/lib/api.js",
    "extension/background.js"
  ]) {
    const full = path.join(root, file);
    vm.runInContext(fs.readFileSync(full, "utf8"), sandbox, { filename: full });
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("background message timeout")), 15000);
      listeners.message(message, {}, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  return {
    sandbox, chrome, helper, storage, calls, send, listeners,
    setActiveTab(url) { activeTab = { id: 7, url, title: "Test" }; }
  };
}

const LINK = `vless://${UUID}@example.com:443?security=tls&sni=example.com&type=ws&path=%2Fws&host=example.com#Example`;

test("background: initial state, profile import, PAC and rules", async () => {
  const env = createEnv();
  await new Promise((r) => setTimeout(r, 20));

  const initial = await env.send({ type: "state" });
  assert.equal(initial.ok, true, initial.error);
  assert.equal(initial.settings.mode, "auto");
  assert.equal(initial.settings.profiles.length, 0);
  assert.equal(initial.status.running, false);
  assert.equal(env.calls.native >= 1, true);

  const added = await env.send({ type: "addProfiles", text: LINK });
  assert.equal(added.ok, true, added.error);
  assert.equal(added.importResult.added, 1);
  assert.equal(env.storage.profiles.length, 1);
  assert.ok(env.storage.activeProfileId);
  assert.equal(env.helper.status.running, true);
  assert.equal(env.calls.starts, 1);
  assert.ok(env.calls.proxySet.length > 0);
  const pac = env.calls.proxySet[env.calls.proxySet.length - 1].value.pacScript.data;
  assert.match(pac, /SOCKS5 127\.0\.0\.1:1111/);
  assert.match(pac, /XS_MODE = "auto"/);

  const site = await env.send({ type: "setSiteAction", host: "example.com", action: "proxy" });
  assert.equal(site.ok, true, site.error);
  assert.equal(env.storage.rules.length, 1);
  assert.equal(site.decision.proxy, true);

  env.setActiveTab("https://ads.example.com/");
  await env.send({ type: "setSiteAction", host: "ads.example.com", action: "direct" });
  const direct = await env.send({ type: "state" });
  assert.equal(direct.decision.proxy, false);

  env.setActiveTab("https://unrelated.net/");
  const auto = await env.send({ type: "state" });
  assert.equal(auto.decision.proxy, false);

  const global = await env.send({ type: "setMode", mode: "global" });
  assert.equal(global.settings.mode, "global");
  const globalPac = env.calls.proxySet[env.calls.proxySet.length - 1].value.pacScript.data;
  assert.match(globalPac, /XS_MODE = "global"/);
  assert.equal(global.decision.proxy, true);
});

test("background: disconnect, connect and delete profile", async () => {
  const env = createEnv();
  await new Promise((r) => setTimeout(r, 20));
  await env.send({ type: "addProfiles", text: LINK });

  const off = await env.send({ type: "disconnect" });
  assert.equal(off.ok, true, off.error);
  assert.equal(env.storage.paused, true);
  assert.equal(env.helper.status.running, false);
  assert.equal(off.status.running, false);
  assert.equal(env.calls.badges[env.calls.badges.length - 1], "OFF");

  const on = await env.send({ type: "connect" });
  assert.equal(on.ok, true, on.error);
  assert.equal(env.storage.paused, false);
  assert.equal(env.helper.status.running, true);
  assert.equal(on.status.running, true);

  const profileId = env.storage.activeProfileId;
  const deleted = await env.send({ type: "deleteProfile", id: profileId });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(env.storage.profiles.length, 0);
  assert.equal(env.storage.activeProfileId, null);
  assert.equal(env.helper.status.running, false);
});

test("background: mode off clears proxy; export/import round-trips", async () => {
  const env = createEnv();
  await new Promise((r) => setTimeout(r, 20));
  await env.send({ type: "addProfiles", text: LINK });

  const exported = await env.send({ type: "exportSettings" });
  assert.equal(exported.ok, true, exported.error);
  assert.equal(exported.data.settings.profiles.length, 1);

  const off = await env.send({ type: "setMode", mode: "off" });
  assert.equal(off.settings.mode, "off");
  assert.ok(env.calls.proxyClear > 0);
  assert.equal(env.calls.badges[env.calls.badges.length - 1], "OFF");

  const imported = await env.send({ type: "importSettings", data: exported.data });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.imported, 1);
  assert.equal(env.storage.mode, "auto");
  assert.equal(env.storage.profiles.length, 1);
});

test("background: subscription import", async () => {
  const env = createEnv();
  await new Promise((r) => setTimeout(r, 20));
  const result = await env.send({ type: "fetchSubscription", url: "https://sub.example/sub" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.importResult.added, 1);
  assert.equal(env.storage.profiles.length, 1);
  assert.equal(env.storage.profiles[0].sourceUrl, "https://sub.example/sub");
});

test("background: missing native host is reported and proxy is cleared", async () => {
  const env = createEnv();
  env.helper.online = false;
  env.helper.failEnsure = true;
  await new Promise((r) => setTimeout(r, 20));

  const state = await env.send({ type: "state" });
  assert.equal(state.ok, true, state.error);
  assert.match(state.helperError, /Helper не установлен/);
  assert.equal(state.status, null);
  assert.ok(env.calls.proxyClear > 0);
  assert.equal(env.calls.badges[env.calls.badges.length - 1], "!");
});

test("firefox: proxy.onRequest follows rules and persisted port", async () => {
  const env = createEnv({ firefox: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(typeof env.listeners.proxyRequest, "function");

  await env.send({ type: "addProfiles", text: LINK });
  assert.equal(env.storage.proxyPort, 1111);
  assert.equal(env.calls.proxySet.length, 0, "Firefox must not use PAC settings");

  async function proxyFor(url) {
    return JSON.parse(JSON.stringify(await env.listeners.proxyRequest({ url })));
  }

  assert.equal((await proxyFor("https://unrelated.net/")).type, "direct");
  assert.equal((await proxyFor("http://localhost/")).type, "direct");

  await env.send({ type: "addRule", pattern: "example.com", action: "proxy" });
  assert.deepEqual(await proxyFor("https://www.example.com/"), {
    type: "socks", host: "127.0.0.1", port: 1111, proxyDNS: true
  });
  assert.equal((await proxyFor("https://unrelated.net/")).type, "direct");

  await env.send({ type: "setMode", mode: "global" });
  assert.equal((await proxyFor("https://unrelated.net/")).type, "socks");

  await env.send({ type: "setMode", mode: "off" });
  assert.equal((await proxyFor("https://unrelated.net/")).type, "direct");

  await env.send({ type: "setMode", mode: "auto" });
  await env.send({ type: "disconnect" });
  assert.equal((await proxyFor("https://www.example.com/")).type, "direct");

  // No active profile => never proxy, even if mode and port are still set.
  await env.chrome.storage.local.set({ paused: false, activeProfileId: null });
  assert.equal((await proxyFor("https://www.example.com/")).type, "direct");
});

test("background: fail-closed when helper disappears with an active profile", async () => {
  const env = createEnv();
  await new Promise((r) => setTimeout(r, 20));
  await env.send({ type: "addProfiles", text: LINK });
  assert.ok(env.calls.proxySet.length > 0);

  const clearsBefore = env.calls.proxyClear;
  const setsBefore = env.calls.proxySet.length;

  env.helper.online = false;
  env.helper.failEnsure = true;
  await env.chrome.storage.local.set({ helperInfo: null });

  const state = await env.send({ type: "state" });
  assert.equal(state.ok, true, state.error);
  assert.match(state.helperError, /Helper не установлен/);
  assert.equal(state.status, null);
  assert.equal(env.calls.proxyClear, clearsBefore, "PAC must stay fail-closed with an active profile");
  assert.equal(env.calls.proxySet.length, setsBefore + 1, "PAC must be re-applied with the persisted port");
  const pac = env.calls.proxySet[env.calls.proxySet.length - 1].value.pacScript.data;
  assert.match(pac, /SOCKS5 127\.0\.0\.1:1111/);
  assert.equal(env.calls.badges[env.calls.badges.length - 1], "!");
});

test("background: getLogs and health endpoints", async () => {
  const env = createEnv();
  await new Promise((r) => setTimeout(r, 20));
  const logs = await env.send({ type: "getLogs", limit: 10 });
  assert.equal(logs.ok, true);
  assert.equal(logs.logs.length, 1);

  const health = await env.send({ type: "health" });
  assert.equal(health.ok, true);
  assert.equal(health.health.ok, true);
  assert.equal(health.health.latencyMs, 12);
});

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sandboxWith(files) {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    fetch: globalThis.fetch
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    const full = path.join(root, file);
    vm.runInContext(fs.readFileSync(full, "utf8"), sandbox, { filename: full });
  }
  return sandbox;
}

test("Chrome manifest key produces the expected stable extension id", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.chrome.json"), "utf8"));
  const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
  assert.equal(id, "bdbbepgnedpgfieoimcbbbigkkkcfhpl");
});

test("Firefox manifest has a stable add-on id", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.firefox.json"), "utf8"));
  assert.equal(manifest.browser_specific_settings.gecko.id, "xray-switch@oleg.dev");
  assert.ok(manifest.background.scripts.includes("background.js"));
});

const XS = sandboxWith(["extension/lib/util.js", "extension/lib/vless.js"]).XS;

test("VLESS Reality + Vision link parses", () => {
  const link = "vless://11111111-2222-3333-4444-555555555555@203.0.113.10:443?encryption=none&security=reality&sni=www.example.com&fp=chrome&pbk=abcDEF123&sid=1a2b&spx=%2F&type=tcp&flow=xtls-rprx-vision#Test%20Reality";
  const parsed = XS.vless.parse(link);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.meta.name, "Test Reality");
  assert.equal(parsed.meta.security, "reality");
  assert.equal(parsed.outbound.protocol, "vless");
  const vnext = parsed.outbound.settings.vnext[0];
  assert.equal(vnext.address, "203.0.113.10");
  assert.equal(vnext.port, 443);
  assert.equal(vnext.users[0].id, "11111111-2222-3333-4444-555555555555");
  assert.equal(vnext.users[0].flow, "xtls-rprx-vision");
  assert.equal(parsed.outbound.streamSettings.network, "tcp");
  assert.equal(parsed.outbound.streamSettings.realitySettings.serverName, "www.example.com");
  assert.equal(parsed.outbound.streamSettings.realitySettings.publicKey, "abcDEF123");
  assert.equal(parsed.outbound.streamSettings.realitySettings.shortId, "1a2b");
});

test("VLESS WS + TLS + ALPN + Host header parses", () => {
  const link = "vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&sni=cdn.example.com&alpn=h2%2Chttp%2F1.1&type=ws&path=%2Fws%3Fed%3D2048&host=cdn.example.com&fp=chrome#WS";
  const parsed = XS.vless.parse(link);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.meta.network, "ws");
  assert.equal(parsed.outbound.streamSettings.wsSettings.path, "/ws?ed=2048");
  assert.equal(parsed.outbound.streamSettings.wsSettings.host, "cdn.example.com");
  assert.equal(parsed.outbound.streamSettings.tlsSettings.serverName, "cdn.example.com");
  assert.equal(parsed.outbound.streamSettings.tlsSettings.alpn.join(","), "h2,http/1.1");
});

test("removed xray 26.x features are rejected or ignored", () => {
  const insecure = XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&type=ws&allowInsecure=1#x");
  assert.equal(insecure.ok, true, insecure.error);
  assert.equal(insecure.outbound.streamSettings.tlsSettings.allowInsecure, undefined);
  assert.ok(insecure.meta.warnings.length > 0);

  assert.equal(XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&type=h2#x").ok, false);
  assert.equal(XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=none&type=quic#x").ok, false);
  assert.equal(XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&flow=xtls-rprx-direct#x").ok, false);
});

test("VLESS XHTTP + extra parses", () => {
  const link = "vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&type=xhttp&path=%2Fx&host=example.com&mode=packet-up&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#XHTTP";
  const parsed = XS.vless.parse(link);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.outbound.streamSettings.xhttpSettings.mode, "packet-up");
  assert.equal(parsed.outbound.streamSettings.xhttpSettings.xPaddingBytes, "100-1000");
});

test("VLESS gRPC and HTTPUpgrade parse", () => {
  const grpc = XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&type=grpc&serviceName=svc&mode=multi#gRPC");
  assert.equal(grpc.ok, true, grpc.error);
  assert.equal(grpc.outbound.streamSettings.grpcSettings.serviceName, "svc");
  assert.equal(grpc.outbound.streamSettings.grpcSettings.multiMode, true);

  const hu = XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=tls&type=httpupgrade&path=%2Fup&host=example.com#HU");
  assert.equal(hu.ok, true, hu.error);
  assert.equal(hu.outbound.streamSettings.httpupgradeSettings.path, "/up");
  assert.equal(hu.outbound.streamSettings.httpupgradeSettings.host, "example.com");
});

test("IPv6 server address is unwrapped", () => {
  const parsed = XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@[2001:db8::1]:443?security=tls#v6");
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.outbound.settings.vnext[0].address, "2001:db8::1");
});

test("Reality without pbk is rejected", () => {
  const parsed = XS.vless.parse("vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.com:443?security=reality#bad");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /pbk/i);
});

test("Non-VLESS links are rejected", () => {
  const parsed = XS.vless.parse("vmess://abc");
  assert.equal(parsed.ok, false);
});

test("Base64 subscription with two links is decoded", () => {
  const a = "vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@one.example.com:443?security=tls#One";
  const b = "vless://11111111-2222-3333-4444-555555555555@two.example.com:443?security=reality&pbk=key&sni=two.example.com#Two";
  const encoded = Buffer.from(a + "\n" + b, "utf8").toString("base64");
  const wrapped = encoded.match(/.{1,40}/g).join("\n");
  const many = XS.vless.parseMany(wrapped);
  assert.equal(many.items.length, 2);
  assert.equal(many.items[0].meta.name, "One");
  assert.equal(many.items[1].meta.name, "Two");
});

const rulesSandbox = sandboxWith(["extension/lib/util.js", "extension/lib/rules.js", "extension/lib/pac.js"]);
const RULES = rulesSandbox.XS;

const RULE_SET = [
  { id: "1", pattern: "example.com", action: "proxy" },
  { id: "2", pattern: "ads.example.com", action: "direct" },
  { id: "3", pattern: "*.cdn.example.com", action: "proxy" },
  { id: "4", pattern: "*google*", action: "proxy" },
  { id: "5", pattern: "direct.example.com", action: "direct" }
];

const CASES = [
  ["example.com", true],
  ["www.example.com", true],
  ["ads.example.com", false],
  ["x.ads.example.com", false],
  ["cdn.example.com", true],
  ["a.cdn.example.com", true],
  ["google.com", true],
  ["www.google.co.uk", true],
  ["direct.example.com", false],
  ["other.example.com", true],
  ["unrelated.net", false],
  ["localhost", false],
  ["192.168.1.10", false],
  ["[::1]", false],
  ["singlelabel", false]
];

test("rules engine: auto mode and specificity", () => {
  for (const [host, expected] of CASES) {
    const decision = RULES.rules.decide({
      mode: "auto", rules: RULE_SET, host, bypassLocal: true
    });
    assert.equal(decision.proxy, expected, `${host}: ${JSON.stringify(decision)}`);
  }
});

test("rules engine: a more specific wildcard beats a parent suffix", () => {
  const set = [
    { id: "a", pattern: "example.com", action: "proxy" },
    { id: "b", pattern: "*.cdn.example.com", action: "direct" }
  ];
  assert.equal(RULES.rules.decide({ mode: "auto", rules: set, host: "a.cdn.example.com" }).proxy, false);
  assert.equal(RULES.rules.decide({ mode: "auto", rules: set, host: "cdn.example.com" }).proxy, true);
  assert.equal(RULES.rules.decide({ mode: "auto", rules: set, host: "www.example.com" }).proxy, true);
});

test("rules engine: global mode and direct exceptions", () => {
  const globalCases = [
    ["unrelated.net", true],
    ["direct.example.com", false],
    ["ads.example.com", false],
    ["localhost", false],
    ["10.0.0.1", false]
  ];
  for (const [host, expected] of globalCases) {
    const decision = RULES.rules.decide({
      mode: "global", rules: RULE_SET, host, bypassLocal: true
    });
    assert.equal(decision.proxy, expected, `${host}: ${JSON.stringify(decision)}`);
  }
});

test("rules engine: off mode is always direct", () => {
  for (const [host] of CASES) {
    const decision = RULES.rules.decide({ mode: "off", rules: RULE_SET, host, bypassLocal: false });
    assert.equal(decision.proxy, false);
  }
});

test("generated PAC is ES5 and matches the rules engine", () => {
  const pac = RULES.pac.build({
    mode: "auto",
    rules: RULE_SET,
    bypassLocal: true,
    socksPort: 1111,
    httpPort: 2222
  });
  assert.equal(/=>|\bconst\b|\blet\b|`/.test(pac), false, "PAC contains non-ES5 syntax");

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(pac, sandbox);
  const find = sandbox.FindProxyForURL;

  for (const [host, expected] of CASES) {
    const result = find("https://" + host + "/", host);
    const proxied = /^SOCKS5 /.test(result) && result.includes("127.0.0.1:1111");
    assert.equal(proxied, expected, `${host} -> ${result}`);
  }
});

test("generated PAC respects global mode and bypassLocal=false", () => {
  const pac = RULES.pac.build({
    mode: "global",
    rules: RULE_SET,
    bypassLocal: false,
    socksPort: 3333,
    httpPort: 4444
  });
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(pac, sandbox);
  const find = sandbox.FindProxyForURL;
  assert.match(find("https://unrelated.net/", "unrelated.net"), /^SOCKS5 127\.0\.0\.1:3333/);
  assert.match(find("https://localhost/", "localhost"), /^SOCKS5/);
});

test("rule patterns accept pasted URLs and normalize", () => {
  assert.equal(RULES.rules.normalizePattern("https://Example.COM/path?q=1"), "example.com");
  assert.equal(RULES.rules.normalizePattern("*.Example.com."), "*.example.com");
  assert.equal(RULES.rules.normalizePattern("  "), "");
});

test("PAC is ASCII-only and IDN rules become Punycode", () => {
  assert.equal(RULES.rules.normalizePattern("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  assert.equal(RULES.rules.normalizePattern("*.пример.рф"), "*.xn--e1afmkfd.xn--p1ai");
  const pac = RULES.pac.build({
    mode: "auto", rules: [{ pattern: "пример.рф", action: "proxy" }],
    bypassLocal: true, socksPort: 1111, httpPort: 2222
  });
  assert.equal(/[^\x00-\x7F]/.test(pac), false);
  assert.match(pac, /xn--e1afmkfd\.xn--p1ai/);
});

test("PAC builder refuses a missing SOCKS port", () => {
  assert.throws(() => RULES.pac.build({ mode: "auto", rules: [], socksPort: 0 }), /SOCKS/);
});

test("manifest files and icons exist", () => {
  for (const file of [
    "extension/manifest.chrome.json",
    "extension/manifest.firefox.json",
    "extension/icons/icon16.png",
    "extension/icons/icon32.png",
    "extension/icons/icon48.png",
    "extension/icons/icon128.png",
    "extension/popup.html",
    "extension/options.html",
    "extension/background.js"
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});

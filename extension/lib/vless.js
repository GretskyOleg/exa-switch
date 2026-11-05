/* Xray Switch — VLESS URI parser and subscription decoder. */
(function () {
  "use strict";

  var root = typeof globalThis !== "undefined" ? globalThis : self;
  var XS = (root.XS = root.XS || {});

  var MAX_LINK = 8192;
  var MAX_PATH = 1024;

  function clean(value, max) {
    var s = String(value == null ? "" : value);
    if (s.length > max) s = s.slice(0, max);
    return s.replace(/[\u0000-\u001f\u007f]/g, "");
  }

  function first(params, names, fallback) {
    for (var i = 0; i < names.length; i++) {
      var v = params.get(names[i]);
      if (v !== null && v !== "") return v;
    }
    return fallback;
  }

  function boolParam(value, fallback) {
    if (value == null || value === "") return !!fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
  }

  function splitAlpn(value) {
    if (!value) return undefined;
    var list = String(value).split(",").map(function (s) {
      return clean(s.trim(), 32);
    }).filter(Boolean).slice(0, 8);
    return list.length ? list : undefined;
  }

  function asNumber(value, fallback) {
    var n = parseInt(value, 10);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function clampNumber(value, fallback, min, max) {
    var n = asNumber(value, fallback);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /** Keep only flat, bounded values. Prevents injecting arbitrary nested JSON
   *  into xray's stream settings through the `extra` link parameter. */
  function sanitizeExtra(value) {
    if (!value || String(value).length > 4096) return null;
    var parsed;
    try { parsed = JSON.parse(String(value)); } catch (_) { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    var out = {};
    var count = 0;
    Object.keys(parsed).forEach(function (key) {
      if (count >= 20 || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) return;
      var v = parsed[key];
      if (typeof v === "string") {
        out[key] = clean(v, 256);
      } else if (typeof v === "number" && isFinite(v)) {
        out[key] = v;
      } else if (typeof v === "boolean") {
        out[key] = v;
      } else {
        return;
      }
      count++;
    });
    return count ? out : null;
  }

  function b64ToBytes(input) {
    var s = String(input || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = root.atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
  }

  function maybeBase64(text) {
    var cleanText = String(text || "").trim();
    if (!cleanText || cleanText.indexOf("://") !== -1) return cleanText;
    if (!/^[A-Za-z0-9+/=_\-\s]+$/.test(cleanText)) return cleanText;
    try {
      var decoded = decodeUtf8(b64ToBytes(cleanText));
      if (decoded && decoded.indexOf("://") !== -1) return decoded;
    } catch (_) {}
    return cleanText;
  }

  function parseVless(link) {
    var raw = String(link || "").trim();
    if (raw.length > MAX_LINK) {
      return { ok: false, error: "Ссылка слишком длинная" };
    }
    if (!/^vless:\/\//i.test(raw)) {
      return { ok: false, error: "Это не VLESS-ссылка" };
    }

    var url;
    try {
      url = new URL(raw);
    } catch (_) {
      return { ok: false, error: "Не удалось разобрать ссылку" };
    }

    var id = "";
    try { id = decodeURIComponent(url.username || ""); } catch (_) { id = url.username || ""; }
    id = clean(id, 64);
    if (!id) return { ok: false, error: "В ссылке нет UUID" };
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return { ok: false, error: "Некорректный UUID в ссылке" };
    }

    var address = (url.hostname || "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
    address = clean(address, 255);
    if (!address) return { ok: false, error: "В ссылке нет адреса сервера" };
    if (/[\s/\\@?#]/.test(address)) {
      return { ok: false, error: "Некорректный адрес сервера" };
    }

    var params = url.searchParams;
    var network = (first(params, ["type", "network"], "tcp") || "tcp").toLowerCase();
    if (network === "raw") network = "tcp";
    if (network === "websocket") network = "ws";
    if (network === "splithttp") network = "xhttp";
    if (network === "mkcp") network = "kcp";
    if (network === "h2" || network === "http") network = "h2";

    var security = (first(params, ["security"], "none") || "none").toLowerCase();
    if (security === "xtls") security = "tls";
    if (["none", "tls", "reality"].indexOf(security) === -1) {
      return { ok: false, error: "Неизвестный тип security: " + clean(security, 32) };
    }

    var port = clampNumber(url.port, security === "none" ? 80 : 443, 1, 65535);
    var sni = clean(first(params, ["sni", "peer", "serverName"], address), 255) || address;
    var fingerprint = clean(first(params, ["fp", "fingerprint"], ""), 32);
    var flow = clean(first(params, ["flow"], ""), 32);
    var encryption = clean(first(params, ["encryption"], "none"), 32) || "none";
    var allowInsecure = boolParam(first(params, ["allowInsecure", "insecure", "allow_insecure"], ""), false);
    if (/^xtls-rprx-(direct|splice)$/i.test(flow)) {
      return { ok: false, error: "Legacy XTLS flow удалён в xray 26.x — нужен xtls-rprx-vision" };
    }

    var stream = { network: network, security: security };
    var warnings = [];

    if (security === "tls") {
      stream.tlsSettings = { serverName: sni };
      if (allowInsecure) {
        warnings.push("allowInsecure больше не поддерживается xray 26.x и проигнорирован");
      }
      if (fingerprint) stream.tlsSettings.fingerprint = fingerprint;
      var alpn = splitAlpn(first(params, ["alpn"], ""));
      if (alpn) stream.tlsSettings.alpn = alpn;
      var pcs = clean(first(params, ["pcs", "pinnedPeerCertSha256"], ""), 128);
      if (pcs) stream.tlsSettings.pinnedPeerCertSha256 = pcs;
      var vcn = clean(first(params, ["vcn", "verifyPeerCertByName"], ""), 255);
      if (vcn) stream.tlsSettings.verifyPeerCertByName = vcn;
    } else if (security === "reality") {
      var pbk = clean(first(params, ["pbk", "publicKey"], ""), 128);
      if (!pbk) return { ok: false, error: "Reality-ссылка без публичного ключа (pbk)" };
      stream.realitySettings = {
        serverName: sni,
        fingerprint: fingerprint || "chrome",
        publicKey: pbk,
        shortId: clean(first(params, ["sid", "shortId"], ""), 64) || "",
        spiderX: clean(first(params, ["spx", "spiderX"], "/"), 255) || "/"
      };
      var pqv = clean(first(params, ["pqv", "mldsa65Verify"], ""), 256);
      if (pqv) stream.realitySettings.mldsa65Verify = pqv;
    }

    var path = clean(first(params, ["path"], ""), MAX_PATH);
    var hostHeader = clean(first(params, ["host"], ""), 255);
    var headerType = (clean(first(params, ["headerType"], "none"), 16) || "none").toLowerCase();
    if (headerType !== "none" && headerType !== "http") headerType = "none";

    if (network === "ws") {
      stream.wsSettings = { path: path || "/" };
      if (hostHeader) stream.wsSettings.host = hostHeader;
    } else if (network === "httpupgrade") {
      stream.httpupgradeSettings = { path: path || "/" };
      if (hostHeader) stream.httpupgradeSettings.host = hostHeader;
    } else if (network === "xhttp") {
      stream.xhttpSettings = {
        path: path || "/",
        mode: clean(first(params, ["mode"], "auto"), 32) || "auto"
      };
      if (hostHeader) stream.xhttpSettings.host = hostHeader;
      var extraObj = sanitizeExtra(first(params, ["extra"], ""));
      if (extraObj) {
        Object.keys(extraObj).forEach(function (k) { stream.xhttpSettings[k] = extraObj[k]; });
      }
    } else if (network === "grpc") {
      stream.grpcSettings = {
        serviceName: clean(first(params, ["serviceName"], ""), 255) || ""
      };
      var grpcAuthority = clean(first(params, ["authority"], hostHeader || ""), 255);
      if (grpcAuthority) stream.grpcSettings.authority = grpcAuthority;
      if ((first(params, ["mode"], "") || "").toLowerCase() === "multi") {
        stream.grpcSettings.multiMode = true;
      }
    } else if (network === "h2") {
      return { ok: false, error: "Транспорт HTTP/2 удалён в xray 26.x — используйте type=xhttp" };
    } else if (network === "tcp") {
      if (headerType === "http") {
        stream.tcpSettings = {
          header: {
            type: "http",
            request: {
              path: [path || "/"],
              headers: hostHeader ? { Host: [hostHeader] } : {}
            }
          }
        };
      }
    } else if (network === "kcp") {
      if ((headerType && headerType !== "none") || first(params, ["seed"], "")) {
        warnings.push("KCP header/seed удалены в xray 26.x и проигнорированы");
      }
      stream.kcpSettings = {
        mtu: clampNumber(first(params, ["mtu"], ""), 1350, 576, 1500),
        tti: clampNumber(first(params, ["tti"], ""), 50, 10, 255),
        uplinkCapacity: clampNumber(first(params, ["uplinkCapacity"], ""), 5, 0, 1000),
        downlinkCapacity: clampNumber(first(params, ["downlinkCapacity"], ""), 20, 0, 1000),
        congestion: boolParam(first(params, ["congestion"], ""), false),
        readBufferSize: clampNumber(first(params, ["readBufferSize"], ""), 2, 0, 64),
        writeBufferSize: clampNumber(first(params, ["writeBufferSize"], ""), 2, 0, 64)
      };
    } else if (network === "quic") {
      return { ok: false, error: "Транспорт QUIC удалён в xray 26.x — используйте type=xhttp с h3" };
    } else {
      return { ok: false, error: "Неподдерживаемый транспорт: " + clean(network, 32) };
    }

    var user = { id: id, encryption: encryption };
    if (flow) user.flow = flow;
    var packetEncoding = clean(first(params, ["packetEncoding"], ""), 32);
    if (packetEncoding) user.packetEncoding = packetEncoding;

    var outbound = {
      tag: "proxy",
      protocol: "vless",
      settings: {
        vnext: [{
          address: address,
          port: port,
          users: [user]
        }]
      },
      streamSettings: stream
    };

    var name = "";
    if (url.hash) {
      try { name = decodeURIComponent(url.hash.slice(1)); } catch (_) { name = url.hash.slice(1); }
    }
    name = clean((name || "").trim(), 80) || (address + ":" + port);

    return {
      ok: true,
      outbound: outbound,
      meta: {
        name: name,
        address: address,
        port: port,
        security: security,
        network: network,
        sni: sni,
        flow: flow || "",
        warnings: warnings
      }
    };
  }

  function parseSubscription(text) {
    var decoded = maybeBase64(text);
    var lines = decoded.split(/\r?\n/);
    var links = [];
    var skipped = 0;
    var errors = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === "#" || line.indexOf("//") === 0) continue;
      if (/^vless:\/\//i.test(line)) {
        if (line.length > MAX_LINK) {
          errors.push("Пропущена слишком длинная VLESS-ссылка");
          skipped++;
          continue;
        }
        links.push(line);
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        skipped++;
        errors.push("Пропущен неподдерживаемый протокол: " + clean(line.split("://")[0], 32));
      }
    }
    return { links: links, skipped: skipped, errors: errors };
  }

  function parseMany(text) {
    var sub = parseSubscription(text);
    var items = [];
    var errors = sub.errors.slice();
    for (var i = 0; i < sub.links.length; i++) {
      var parsed = parseVless(sub.links[i]);
      if (parsed.ok) {
        parsed.link = sub.links[i];
        items.push(parsed);
      } else {
        errors.push(parsed.error);
      }
    }
    return { items: items, skipped: sub.skipped, errors: errors };
  }

  XS.vless = {
    MAX_LINK: MAX_LINK,
    parse: parseVless,
    parseMany: parseMany,
    parseSubscription: parseSubscription,
    b64ToBytes: b64ToBytes,
    decodeUtf8: decodeUtf8
  };
})();

/* Xray Switch — generates an ES5 PAC script for Chrome/Chromium. */
(function () {
  "use strict";

  var root = typeof globalThis !== "undefined" ? globalThis : self;
  var XS = (root.XS = root.XS || {});

  var BODY = [
    "function xsNorm(h) {",
    "  h = String(h || '').toLowerCase();",
    "  if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') h = h.substring(1, h.length - 1);",
    "  if (h.charAt(h.length - 1) === '.') h = h.substring(0, h.length - 1);",
    "  return h;",
    "}",
    "function xsLocal(h) {",
    "  if (!h) return true;",
    "  if (h === 'localhost' || h === 'localhost.localdomain') return true;",
    "  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;",
    "  if (h.indexOf('.') === -1) return true;",
    "  if (/\\.(localhost|local|localdomain|internal|home\\.arpa|lan)$/.test(h)) return true;",
    "  if (/^127\\./.test(h)) return true;",
    "  if (/^10\\./.test(h)) return true;",
    "  if (/^192\\.168\\./.test(h)) return true;",
    "  if (/^169\\.254\\./.test(h)) return true;",
    "  if (/^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(h)) return true;",
    "  if (/^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\./.test(h)) return true;",
    "  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;",
    "  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;",
    "  return false;",
    "}",
    "function xsGlob(p, h) {",
    "  var parts = p.split('*');",
    "  var idx = 0;",
    "  for (var i = 0; i < parts.length; i++) {",
    "    var part = parts[i];",
    "    if (!part) continue;",
    "    var at = h.indexOf(part, idx);",
    "    if (at === -1) return false;",
    "    if (i === 0 && p.charAt(0) !== '*' && at !== 0) return false;",
    "    idx = at + part.length;",
    "  }",
    "  if (p.charAt(p.length - 1) !== '*' && idx !== h.length) return false;",
    "  return true;",
    "}",
    "function xsScore(p, h) {",
    "  p = xsNorm(p);",
    "  if (!p) return 0;",
    "  if (p === '*') return 1;",
    "  if (p.indexOf('*') === -1) {",
    "    var pLabels = p.split('.').length;",
    "    if (h === p) return 1000000 + pLabels * 1000 + p.length;",
    "    if (h.length > p.length && h.substring(h.length - p.length - 1) === '.' + p) return 100000 + pLabels * 1000 + p.length;",
    "    return 0;",
    "  }",
    "  if (p.substring(0, 2) === '*.' && p.length > 2) {",
    "    var base = p.substring(2);",
    "    if (h.length > base.length && h.substring(h.length - base.length - 1) === '.' + base) return 100000 + (base.split('.').length + 1) * 1000 + base.length;",
    "    return 0;",
    "  }",
    "  return xsGlob(p, h) ? 10000 + p.length : 0;",
    "}",
    "function FindProxyForURL(url, host) {",
    "  host = xsNorm(host);",
    "  if (!host) return 'DIRECT';",
    "  if (XS_BYPASS_LOCAL && xsLocal(host)) return 'DIRECT';",
    "  var best = null;",
    "  var bestScore = 0;",
    "  for (var i = 0; i < XS_RULES.length; i++) {",
    "    var rule = XS_RULES[i];",
    "    var score = xsScore(rule[0], host);",
    "    if (!score) continue;",
    "    if (score > bestScore) { best = rule; bestScore = score; }",
    "    else if (score === bestScore && best && rule[1] === 'direct' && best[1] !== 'direct') best = rule;",
    "  }",
    "  if (best) return best[1] === 'proxy' ? XS_PROXY : 'DIRECT';",
    "  return XS_MODE === 'global' ? XS_PROXY : 'DIRECT';",
    "}"
  ].join("\n");

  function buildPac(opts) {
    var socksPort = parseInt(opts && opts.socksPort, 10);
    var httpPort = parseInt(opts && opts.httpPort, 10);
    if (!socksPort || socksPort < 1 || socksPort > 65535) {
      throw new Error("Некорректный SOCKS-порт helper'а");
    }
    if (!httpPort || httpPort < 1 || httpPort > 65535) {
      httpPort = socksPort;
    }

    var rules = XS.rules.sanitize(opts.rules).map(function (r) {
      return [r.pattern, r.action];
    });

    var proxy = "SOCKS5 127.0.0.1:" + socksPort + "; PROXY 127.0.0.1:" + httpPort;
    var mode = opts.mode === "global" ? "global" : "auto";
    var lines = [
      "/* EXA Switch PAC - generated " + new Date().toISOString() + " */",
      "var XS_MODE = " + JSON.stringify(mode) + ";",
      "var XS_BYPASS_LOCAL = " + (opts.bypassLocal !== false ? "true" : "false") + ";",
      "var XS_PROXY = " + JSON.stringify(proxy) + ";",
      "var XS_RULES = " + JSON.stringify(rules) + ";",
      BODY
    ];
    var pac = lines.join("\n");
    if (/[^\x00-\x7F]/.test(pac)) {
      throw new Error("PAC содержит не-ASCII символы; укажите домен в Punycode");
    }
    return pac;
  }

  XS.pac = { build: buildPac };
})();

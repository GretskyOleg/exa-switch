/* Xray Switch — per-site rules engine (used by the background and Firefox proxy.onRequest). */
(function () {
  "use strict";

  var root = typeof globalThis !== "undefined" ? globalThis : self;
  var XS = (root.XS = root.XS || {});

  function normalizePattern(pattern) {
    var p = String(pattern || "").trim().toLowerCase();
    if (!p) return "";
    if (p.indexOf("://") !== -1) {
      try { p = new URL(p).hostname || p; } catch (_) {}
    }
    p = p.replace(/^\[|\]$/g, "").replace(/\/.*$/, "").replace(/\.$/, "");

    // Chrome PAC requires ASCII/Punycode. Convert IDN labels when possible.
    if (/[^\x00-\x7F]/.test(p)) {
      try {
        if (p.indexOf("*") === -1) {
          p = new URL("http://" + p).hostname;
        } else {
          p = p.split(".").map(function (label) {
            if (!label || label.indexOf("*") !== -1) return label;
            return new URL("http://" + label).hostname;
          }).join(".");
        }
      } catch (_) {}
    }
    // Patterns are host globs only: no userinfo, paths, queries, spaces or
    // control characters. This also keeps the generated PAC script safe.
    if (!p || p.length > 255) return "";
    if (/[\u0000-\u0020\u007f]/.test(p)) return "";
    if (/[@?#%\\]/.test(p)) return "";
    return p;
  }

  function isLocalHost(host) {
    var h = XS.normalizeHost(host);
    if (!h) return true;
    if (h === "localhost" || h === "localhost.localdomain") return true;
    if (h === "0.0.0.0" || h === "::1" || h === "::") return true;
    if (h.indexOf(".") === -1) return true; // single-label intranet host
    if (/\.(localhost|local|localdomain|internal|home\.arpa|lan)$/.test(h)) return true;

    if (/^127\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(h)) return true;

    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    return false;
  }

  function globToRegExp(pattern) {
    var parts = pattern.split("*").map(XS.escapeRegExp);
    return new RegExp("^" + parts.join(".*") + "$");
  }

  function labels(value) {
    return value ? value.split(".").length : 0;
  }

  /** Returns 0 when the pattern does not match, otherwise a specificity score. */
  function scorePattern(pattern, host) {
    var p = normalizePattern(pattern);
    if (!p) return 0;
    if (p === "*") return 1;

    if (p.indexOf("*") === -1) {
      if (host === p) return 1000000 + labels(p) * 1000 + p.length;
      if (host.length > p.length && host.slice(-(p.length + 1)) === "." + p) {
        return 100000 + labels(p) * 1000 + p.length;
      }
      return 0;
    }

    if (p.slice(0, 2) === "*.") {
      var base = p.slice(2);
      if (base && host.length > base.length && host.slice(-(base.length + 1)) === "." + base) {
        return 100000 + (labels(base) + 1) * 1000 + base.length;
      }
      return 0;
    }

    try {
      if (globToRegExp(p).test(host)) return 10000 + p.length;
    } catch (_) {}
    return 0;
  }

  /** Find the most specific matching rule. On equal specificity, "direct" wins. */
  function bestRule(rules, host) {
    var best = null;
    var bestScore = 0;
    var list = Array.isArray(rules) ? rules : [];

    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule || (rule.action !== "proxy" && rule.action !== "direct")) continue;
      var score = scorePattern(rule.pattern, host);
      if (!score) continue;

      if (score > bestScore) {
        best = rule;
        bestScore = score;
      } else if (score === bestScore && best && rule.action === "direct" && best.action !== "direct") {
        best = rule;
      }
    }

    return { rule: best, score: bestScore };
  }

  /**
   * mode: "off" | "auto" | "global"
   * auto   -> direct by default, rules with action=proxy enable the proxy.
   * global -> proxy by default, rules with action=direct bypass it.
   */
  function decide(opts) {
    var mode = opts && opts.mode ? opts.mode : "auto";
    var rules = opts && opts.rules ? opts.rules : [];
    var host = XS.normalizeHost(opts && opts.host);
    var bypassLocal = !opts || opts.bypassLocal !== false;

    if (mode === "off") return { proxy: false, reason: "off", rule: null };
    if (!host) return { proxy: false, reason: "empty", rule: null };

    if (bypassLocal && isLocalHost(host)) {
      return { proxy: false, reason: "local", rule: null };
    }

    var found = bestRule(rules, host);
    if (found.rule) {
      return {
        proxy: found.rule.action === "proxy",
        reason: "rule",
        rule: found.rule,
        score: found.score
      };
    }

    return {
      proxy: mode === "global",
      reason: "default",
      rule: null
    };
  }

  function sanitizeRules(rules) {
    var out = [];
    var seen = {};
    var list = Array.isArray(rules) ? rules : [];
    for (var i = 0; i < list.length && out.length < 1000; i++) {
      var pattern = normalizePattern(list[i] && list[i].pattern);
      var action = list[i] && list[i].action;
      if (!pattern || (action !== "proxy" && action !== "direct")) continue;
      if (pattern.length > 255) continue;
      if (/[^\x00-\x7F]/.test(pattern)) continue;
      var key = action + "|" + pattern;
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ pattern: pattern, action: action });
    }
    return out;
  }

  XS.rules = {
    decide: decide,
    bestRule: bestRule,
    scorePattern: scorePattern,
    normalizePattern: normalizePattern,
    isLocalHost: isLocalHost,
    sanitize: sanitizeRules,
    globToRegExp: globToRegExp
  };
})();

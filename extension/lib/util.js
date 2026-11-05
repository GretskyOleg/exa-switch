/* Xray Switch — shared helpers. Classic script: works in Chrome SW and Firefox event page. */
(function () {
  "use strict";

  var root = typeof globalThis !== "undefined" ? globalThis : self;
  var XS = (root.XS = root.XS || {});
  var api = root.browser || root.chrome;

  XS.browser = api;
  XS.isFirefox = !!(api && api.runtime && api.runtime.getBrowserInfo);
  XS.NATIVE_HOST = "com.oleg.xray_switch";

  XS.sleep = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };

  XS.uid = function () {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === "function") {
        return root.crypto.randomUUID();
      }
    } catch (_) {}
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  };

  XS.now = function () { return Date.now(); };

  XS.escapeHtml = function (value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  XS.escapeRegExp = function (value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  /** Lowercase host, strip IPv6 brackets and a trailing dot. */
  XS.normalizeHost = function (host) {
    var h = String(host || "").trim().toLowerCase();
    if (h.charAt(0) === "[" && h.charAt(h.length - 1) === "]") {
      h = h.slice(1, -1);
    }
    if (h.charAt(h.length - 1) === ".") h = h.slice(0, -1);
    return h;
  };

  XS.hostFromUrl = function (url) {
    try {
      return XS.normalizeHost(new URL(url).hostname);
    } catch (_) {
      return "";
    }
  };

  /** Origin pattern suitable for chrome.permissions.request(). */
  XS.originPattern = function (url) {
    try {
      var u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.protocol + "//" + u.hostname + "/*";
    } catch (_) {
      return null;
    }
  };

  XS.fmtDuration = function (seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return s + " с";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " мин";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " ч " + (m % 60) + " мин";
    return Math.floor(h / 24) + " д " + (h % 24) + " ч";
  };

  XS.fmtTime = function (value) {
    try {
      return new Date(value).toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    } catch (_) {
      return String(value);
    }
  };

  XS.errorText = function (err) {
    if (!err) return "Неизвестная ошибка";
    var text = err.message || String(err);
    if (/native messaging host not found|No such native application/i.test(text)) {
      return "Helper не установлен. Запустите install.sh и перезапустите браузер.";
    }
    if (/Failed to fetch|NetworkError|Could not connect|Network request failed/i.test(text)) {
      return "Helper не отвечает на 127.0.0.1. Проверьте, что он запущен.";
    }
    return text;
  };

  XS.storageGet = function (defaults) {
    return Promise.resolve(api.storage.local.get(defaults || {}));
  };

  XS.storageSet = function (values) {
    return Promise.resolve(api.storage.local.set(values || {}));
  };

  XS.runtimeVersion = function () {
    try { return api.runtime.getManifest().version; } catch (_) { return ""; }
  };

  XS.openOptions = function (hash) {
    var url = api.runtime.getURL("options.html") + (hash ? "#" + hash : "");
    if (hash || !api.runtime.openOptionsPage) {
      api.tabs.create({ url: url });
      return;
    }
    api.runtime.openOptionsPage();
  };

  XS.debounce = function (fn, ms) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  };

  XS.bytesToBase64 = function (bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return root.btoa(binary);
  };
})();

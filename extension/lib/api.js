/* Xray Switch — client for the local helper daemon (127.0.0.1) and native messaging. */
(function () {
  "use strict";

  var root = typeof globalThis !== "undefined" ? globalThis : self;
  var XS = (root.XS = root.XS || {});
  var api = XS.browser;

  var DEFAULT_TIMEOUT = 15000;
  var NATIVE_TIMEOUT = 15000;

  function isInfo(value) {
    return !!(
      value &&
      typeof value.port === "number" &&
      value.port > 0 &&
      value.port < 65536 &&
      typeof value.token === "string" &&
      value.token.length >= 16
    );
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(message || "Таймаут ожидания helper'а"));
      }, ms);
      Promise.resolve(promise).then(
        function (value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function nativeEnsure() {
    if (!api || !api.runtime || !api.runtime.sendNativeMessage) {
      return Promise.reject(new Error("API nativeMessaging недоступен"));
    }
    var call = api.runtime.sendNativeMessage(XS.NATIVE_HOST, { cmd: "ensure" });
    return withTimeout(call, NATIVE_TIMEOUT, "Helper не ответил. Перезапустите браузер после install.sh.")
      .then(function (resp) {
        if (!resp || !resp.ok) {
          throw new Error((resp && resp.error) || "Helper вернул ошибку");
        }
        var info = resp.daemon || resp.info || resp;
        if (!isInfo(info)) throw new Error("Helper вернул некорректные данные");
        return info;
      });
  }

  function httpJson(info, path, options) {
    options = options || {};
    if (typeof path !== "string" || !/^\/api\/[a-z]+(?:\?|$)/.test(path)) {
      return Promise.reject(new Error("Некорректный путь API helper'а"));
    }
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timeout = options.timeout || DEFAULT_TIMEOUT;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeout) : null;

    var headers = { "Authorization": "Bearer " + info.token };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    var request = fetch("http://127.0.0.1:" + info.port + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller ? controller.signal : undefined,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (_) {}
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || ("Helper HTTP " + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });

    return withTimeout(request, timeout + 1000, "Helper не ответил за " + Math.round(timeout / 1000) + " с");
  }

  function ping(info) {
    if (!isInfo(info)) return Promise.resolve(false);
    return httpJson(info, "/api/ping", { timeout: 1800 })
      .then(function (data) { return !!(data && data.ok && data.service === "xray-switch"); })
      .catch(function () { return false; });
  }

  function ensure(force) {
    return XS.storageGet({ helperInfo: null }).then(function (stored) {
      var cached = stored.helperInfo;
      if (!force && isInfo(cached)) {
        return ping(cached).then(function (alive) {
          if (alive) return cached;
          return nativeEnsure().then(remember);
        });
      }
      return nativeEnsure().then(remember);
    });
  }

  function remember(info) {
    return XS.storageSet({ helperInfo: info }).then(function () { return info; });
  }

  function request(method, path, body, retry) {
    var canRetry = retry !== false;
    return ensure(false).then(function (info) {
      return httpJson(info, path, { method: method, body: body }).catch(function (err) {
        var networkError = !err.status || err.status === 401 || err.status === 403;
        if (!canRetry || !networkError) throw err;
        return ensure(true).then(function (fresh) {
          return httpJson(fresh, path, { method: method, body: body });
        });
      });
    });
  }

  function status() {
    return request("GET", "/api/status");
  }

  function start(id, name, outbound) {
    return request("POST", "/api/start", { id: id || "", name: name || "", outbound: outbound });
  }

  function stop() {
    return request("POST", "/api/stop", {});
  }

  function health(target) {
    var query = target ? "?target=" + encodeURIComponent(target) : "";
    return request("GET", "/api/health" + query, undefined, false);
  }

  function logs(limit) {
    return request("GET", "/api/logs?limit=" + encodeURIComponent(limit || 200), undefined, false);
  }

  function shutdown() {
    return request("POST", "/api/shutdown", {}, false);
  }

  function resetCache() {
    return XS.storageSet({ helperInfo: null });
  }

  XS.api = {
    ensure: ensure,
    ping: ping,
    status: status,
    start: start,
    stop: stop,
    health: health,
    logs: logs,
    shutdown: shutdown,
    resetCache: resetCache,
    isInfo: isInfo
  };
})();

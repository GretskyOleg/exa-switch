/* Xray Switch — popup controller. */
(function () {
  "use strict";

  var XS = globalThis.XS;
  var api = XS.browser;
  var state = null;
  var busy = false;
  var toastTimer = null;
  var refreshTimer = null;

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }

  function send(msg) {
    return api.runtime.sendMessage(msg).then(function (res) {
      if (!res) throw new Error("Background не ответил");
      if (res.ok === false) throw new Error(res.error || "Ошибка");
      return res;
    });
  }

  function toast(text, isError) {
    var el = $("toast");
    if (!el) return;
    el.textContent = text;
    el.className = "toast" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 4500);
  }

  function fallbackState(error) {
    return {
      ok: true,
      settings: state && state.settings ? state.settings : {
        mode: "off", paused: false, profiles: [], rules: [], activeProfileId: null,
        autoConnect: true, bypassLocal: true
      },
      status: null,
      helperError: XS.errorText(error),
      coreError: "",
      proxyError: "",
      decision: { proxy: false, reason: "empty" },
      tab: null
    };
  }

  function render(res) {
    state = res;
    var s = res.settings;
    var st = res.status;
    var mode = s.mode;
    var paused = !!s.paused;
    var running = !!(st && st.running);
    var active = null;
    for (var i = 0; i < s.profiles.length; i++) {
      if (s.profiles[i].id === s.activeProfileId) { active = s.profiles[i]; break; }
    }

    setText("version", "VLESS CONTROL // v" + (XS.runtimeVersion() || "0.1.0"));

    var modeButtons = document.querySelectorAll("#modeSeg button");
    for (var m = 0; m < modeButtons.length; m++) {
      modeButtons[m].classList.toggle("active", modeButtons[m].getAttribute("data-mode") === mode);
    }
    setText("modeHint",
      mode === "off" ? "прокси не используется" :
      mode === "auto" ? "прокси только по правилам" :
      "прокси для всего, кроме исключений"
    );

    var power = $("power");
    power.textContent = mode === "off" ? "Вкл" : "Выкл";
    power.classList.toggle("is-on", mode !== "off" && !paused && running);

    var title = "Проверка…";
    var sub = "";
    var dotCls = "";
    if (mode === "off") {
      title = "Выключено";
      sub = "трафик идёт напрямую";
    } else if (paused) {
      title = "Пауза";
      sub = "нажмите «Подключить»";
      dotCls = "warn";
    } else if (res.helperError) {
      title = "Helper недоступен";
      sub = res.helperError;
      dotCls = "err";
    } else if (res.coreError) {
      title = "Ошибка ядра";
      sub = res.coreError;
      dotCls = "err";
    } else if (running) {
      title = "Подключено";
      sub = (st.name || (active && active.name) || "профиль") + (st.socksPort ? " · SOCKS :" + st.socksPort : "");
      dotCls = "on";
    } else if (active) {
      title = "Не подключено";
      sub = "ядро остановлено";
      dotCls = "warn";
    } else {
      title = "Нет профиля";
      sub = "добавьте VLESS-ссылку";
      dotCls = "warn";
    }
    setText("statusTitle", title);
    setText("statusSub", sub);
    $("statusDot").className = "dot " + dotCls;

    var banner = $("banner");
    var bannerText = $("bannerText");
    var bannerBtn = $("bannerBtn");
    var showBanner = false;
    var bText = "";
    var bAction = "helper";
    var bErr = false;
    if (res.helperError) {
      showBanner = true;
      bText = "Helper не запущен. Установите его через install.sh и перезапустите браузер.";
      bAction = "helper";
      bErr = true;
    } else if (!s.profiles.length) {
      showBanner = true;
      bText = "Добавьте VLESS-профиль, чтобы включить туннель.";
      bAction = "profiles";
    } else if (res.coreError) {
      showBanner = true;
      bText = res.coreError;
      bAction = "helper";
      bErr = true;
    }
    if (showBanner) {
      banner.classList.remove("hidden");
      banner.classList.toggle("err", bErr);
      bannerText.textContent = bText;
      bannerBtn.textContent = bAction === "profiles" ? "Добавить" : "Как установить";
      banner.setAttribute("data-action", bAction);
    } else {
      banner.classList.add("hidden");
    }

    var sel = $("profileSelect");
    sel.textContent = "";
    if (!s.profiles.length) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "— нет профилей —";
      sel.appendChild(empty);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (var p = 0; p < s.profiles.length; p++) {
        var opt = document.createElement("option");
        opt.value = s.profiles[p].id;
        opt.textContent = s.profiles[p].name;
        if (s.profiles[p].id === s.activeProfileId) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    if (active) {
      var meta = active.meta || {};
      setText("profileMeta",
        (meta.address || "") + ":" + (meta.port || "") + " · " +
        (meta.security || "none") + " / " + (meta.network || "tcp")
      );
    } else {
      setText("profileMeta", "VLESS / Reality / WS / gRPC");
    }

    var connect = $("connectBtn");
    var same = running && (!st.profileId || st.profileId === s.activeProfileId);
    connect.textContent = same ? "Отключить" : "Подключить";
    connect.classList.toggle("is-stop", same);
    connect.disabled = !active && !same;

    var host = res.tab && res.tab.host ? res.tab.host : "";
    var decision = res.decision || { proxy: false, reason: "empty" };
    setText("siteHost", host || "—");

    var pill = $("siteVerdict");
    var verdict = "—";
    var pillCls = "";
    if (host) {
      if (decision.reason === "off") {
        verdict = "выкл";
      } else if (decision.reason === "local") {
        verdict = "локально";
        pillCls = "local";
      } else if (decision.proxy) {
        verdict = "прокси";
        pillCls = "proxy";
      } else {
        verdict = "напрямую";
        pillCls = "direct";
      }
    }
    pill.textContent = verdict;
    pill.className = "pill " + pillCls;

    var ruleText = "";
    if (decision.rule) {
      ruleText = "правило: " + decision.rule.pattern + " → " + (decision.rule.action === "proxy" ? "прокси" : "напрямую");
    } else if (decision.reason === "local") {
      ruleText = "локальные адреса всегда напрямую";
    } else if (decision.reason === "default") {
      ruleText = mode === "global" ? "по умолчанию через прокси" : mode === "auto" ? "по умолчанию напрямую" : "";
    }
    setText("siteRule", ruleText);

    var siteButtons = document.querySelectorAll("[data-site]");
    var siteUsable = !!(host && res.tab && /^https?:/i.test(res.tab.url || "") && mode !== "off");
    for (var b = 0; b < siteButtons.length; b++) {
      var btn = siteButtons[b];
      var actName = btn.getAttribute("data-site");
      btn.disabled = !siteUsable;
      var isActive = !!(decision.rule && decision.rule.pattern === host && (
        (actName === "proxy" && decision.rule.action === "proxy") ||
        (actName === "direct" && decision.rule.action === "direct")
      ));
      btn.classList.toggle("active", isActive);
    }

    var line = "helper: ";
    if (res.helperError) line += "не найден";
    else if (st) line += "online" + (st.socksPort ? " · SOCKS :" + st.socksPort : "") + (st.version ? " · v" + st.version : "");
    else line += "—";
    setText("helperLine", line);
  }

  function refresh() {
    if (busy) return Promise.resolve();
    busy = true;
    return send({ type: "state" }).then(render).catch(function (err) {
      render(fallbackState(err));
    }).finally(function () {
      busy = false;
    });
  }

  function act(fn) {
    if (busy) return Promise.resolve();
    busy = true;
    return fn().then(function (res) {
      if (res) render(res);
    }).catch(function (err) {
      toast(XS.errorText(err), true);
    }).finally(function () {
      busy = false;
    });
  }

  function bind() {
    $("openOptions").addEventListener("click", function () { XS.openOptions(); });
    $("openOptions2").addEventListener("click", function (e) { e.preventDefault(); XS.openOptions(); });
    $("addProfile").addEventListener("click", function () { XS.openOptions("profiles"); });

    $("modeSeg").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-mode]") : null;
      if (!btn) return;
      act(function () { return send({ type: "setMode", mode: btn.getAttribute("data-mode") }); });
    });

    $("power").addEventListener("click", function () {
      act(function () { return send({ type: "togglePower" }); });
    });

    $("profileSelect").addEventListener("change", function (e) {
      var id = e.target.value;
      if (!id) return;
      act(function () { return send({ type: "setActiveProfile", id: id }); });
    });

    $("connectBtn").addEventListener("click", function () {
      var running = !!(state && state.status && state.status.running);
      var same = running && state.status && (!state.status.profileId || state.status.profileId === state.settings.activeProfileId);
      act(function () { return send({ type: same ? "disconnect" : "connect" }); });
    });

    $("healthBtn").addEventListener("click", function () {
      if (busy) return;
      busy = true;
      var btn = $("healthBtn");
      var old = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Проверка…";
      send({ type: "health" }).then(function (res) {
        var h = res.health;
        if (h && h.ok) toast("Туннель работает · " + Math.round(h.latencyMs || 0) + " мс");
        else toast((h && h.error) || "Проверка не удалась", true);
      }).catch(function (err) {
        toast(XS.errorText(err), true);
      }).finally(function () {
        busy = false;
        btn.disabled = false;
        btn.textContent = old;
      });
    });

    document.querySelectorAll("[data-site]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!state || !state.tab || !state.tab.host) return;
        var action = btn.getAttribute("data-site");
        var host = state.tab.host;
        var tabId = state.tab.id;
        var tabUrl = state.tab.url || "";
        act(function () {
          return send({ type: "setSiteAction", host: host, action: action }).then(function (res) {
            if (tabId && /^https?:/i.test(tabUrl)) {
              try { api.tabs.reload(tabId); } catch (_) {}
            }
            return res;
          });
        });
      });
    });

    $("bannerBtn").addEventListener("click", function () {
      var action = $("banner").getAttribute("data-action");
      XS.openOptions(action === "profiles" ? "profiles" : "helper");
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    refresh();
    refreshTimer = setInterval(function () {
      if (!document.hidden) refresh();
    }, 4000);
  });

  window.addEventListener("unload", function () {
    if (refreshTimer) clearInterval(refreshTimer);
  });
})();

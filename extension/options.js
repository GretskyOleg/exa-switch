/* Xray Switch — options page controller. */
(function () {
  "use strict";

  var XS = globalThis.XS;
  var api = XS.browser;
  var current = null;
  var testResults = {};
  var toastTimer = null;
  var logsTimer = null;
  var logsBusy = false;
  var activeTab = "profiles";

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function send(msg) {
    return api.runtime.sendMessage(msg).then(function (res) {
      if (!res) throw new Error("Background не ответил");
      if (res.ok === false) throw new Error(res.error || "Ошибка");
      return res;
    });
  }

  function toast(text, isError) {
    var el = $("toast");
    el.textContent = text;
    el.className = "toast" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 5000);
  }

  /* ------------------------------------------------------------------ tabs */

  function showTab(name) {
    if (["profiles", "rules", "helper", "about"].indexOf(name) === -1) name = "profiles";
    activeTab = name;
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.toggle("active", p.getAttribute("data-panel") === name);
    });
    try { history.replaceState(null, "", "#" + name); } catch (_) {}
    if (name === "helper") {
      refreshLogs();
      startLogsTimer();
    } else {
      stopLogsTimer();
    }
  }

  /* ---------------------------------------------------------------- render */

  function renderHeader(res) {
    var s = res.settings;
    var dot = $("statusDot");
    var text = "Выключено";
    var cls = "";
    if (s.mode === "off") {
      text = "Выключено — трафик напрямую";
    } else if (s.paused) {
      text = "Пауза — нажмите «Подключить»";
      cls = "warn";
    } else if (res.helperError) {
      text = "Helper недоступен";
      cls = "err";
    } else if (res.coreError) {
      text = "Ошибка ядра";
      cls = "err";
    } else if (res.status && res.status.running) {
      text = "Подключено" + (res.status.name ? " · " + res.status.name : "");
      cls = "on";
    } else if (s.activeProfileId) {
      text = "Не подключено";
      cls = "warn";
    } else {
      text = "Нет профиля — добавьте VLESS-ссылку";
      cls = "warn";
    }
    dot.className = "dot " + cls;
    setText("statusText", text);
    setText("version", "v" + (XS.runtimeVersion() || "0.1.0"));
  }

  function renderProfiles(s) {
    setText("profileCount", s.profiles.length);
    var welcome = $("welcomeCard");
    if (welcome) welcome.classList.toggle("hidden", s.profiles.length > 0);
    var list = $("profilesList");
    clear(list);

    if (!s.profiles.length) {
      var empty = el("div", "empty");
      empty.appendChild(document.createTextNode("Пока нет профилей. Вставьте ссылку "));
      empty.appendChild(el("code", "", "vless://"));
      empty.appendChild(document.createTextNode(" выше и нажмите «Импортировать»."));
      list.appendChild(empty);
      return;
    }

    s.profiles.forEach(function (p) {
      var meta = p.meta || {};
      var active = p.id === s.activeProfileId;

      var row = el("div", "profile-row" + (active ? " active" : ""));
      var radio = document.createElement("input");
      radio.className = "profile-radio";
      radio.type = "radio";
      radio.name = "activeProfile";
      radio.value = p.id;
      radio.checked = active;

      var main = el("div", "profile-main");
      main.appendChild(el("div", "profile-name", p.name));
      main.appendChild(el("div", "profile-sub",
        (meta.address || "?") + ":" + (meta.port || "?") + " · " + (meta.sni || "")));

      var badges = el("div", "badges");
      badges.appendChild(el("span",
        "badge " + (meta.security === "reality" ? "reality" : meta.security === "tls" ? "tls" : ""),
        meta.security || "none"));
      badges.appendChild(el("span", "badge net", meta.network || "tcp"));
      if (p.sourceUrl) badges.appendChild(el("span", "badge", "подписка"));
      var tr = testResults[p.id];
      if (tr) {
        badges.appendChild(el("span", "badge " + (tr.ok ? "reality" : ""),
          tr.ok ? (Math.round(tr.latencyMs || 0) + " мс") : "ошибка"));
      }
      main.appendChild(badges);

      var del = el("button", "btn-del", "Удалить");
      del.type = "button";
      del.setAttribute("data-del", p.id);

      row.appendChild(radio);
      row.appendChild(main);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function renderRules(s) {
    setText("rulesCount", s.rules.length);
    document.querySelectorAll("#rulesMode button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === s.mode);
    });

    var list = $("rulesList");
    clear(list);
    if (!s.rules.length) {
      list.appendChild(el("div", "empty",
        "Правил нет. В режиме «Авто» весь трафик идёт напрямую; в режиме «Всё» — через прокси."));
      return;
    }
    s.rules.forEach(function (r) {
      var row = el("div", "rule-row");
      row.appendChild(el("div", "rule-pattern", r.pattern));
      row.appendChild(el("span", "rule-action " + r.action, r.action === "proxy" ? "прокси" : "напрямую"));
      var del = el("button", "btn-del", "Удалить");
      del.type = "button";
      del.setAttribute("data-del-rule", r.id);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function renderHelper(res) {
    var st = res.status;
    var pill = $("helperPill");
    if (st) {
      pill.textContent = st.running ? "работает" : "online · ядро остановлено";
      pill.className = "pill " + (st.running ? "on" : "warn");
    } else if (res.helperError) {
      pill.textContent = "offline";
      pill.className = "pill err";
    } else {
      pill.textContent = "—";
      pill.className = "pill";
    }

    setText("helperState", st ? "online" : "offline");
    setText("coreState", st && st.running ? "running" : "stopped");
    setText("profileState", st && (st.name || st.profileId) ? (st.name || st.profileId) : "—");
    setText("socksState", st && st.socksPort ? "127.0.0.1:" + st.socksPort : "—");
    setText("httpState", st && st.httpPort ? "127.0.0.1:" + st.httpPort : "—");
    setText("versionState", st && st.version ? st.version : "—");
    setText("pidState", st && st.pid ? String(st.pid) : "—");
    setText("uptimeState", st && st.uptimeSec != null ? XS.fmtDuration(st.uptimeSec) : "—");

    var box = $("helperError");
    var msg = res.helperError || res.coreError || res.proxyError || "";
    box.classList.toggle("hidden", !msg);
    box.textContent = msg;

    var install = $("installCard");
    install.classList.toggle("hidden", false);
    install.style.borderColor = res.helperError ? "rgba(239,68,68,.35)" : "";
  }

  function subIntervalLabel(min) {
    if (min < 60) return min + " мин";
    if (min < 1440) return Math.round(min / 60) + " ч";
    return Math.round(min / 1440) + " д";
  }

  function renderSubscriptions(s) {
    var subs = Array.isArray(s.subscriptions) ? s.subscriptions : [];
    setText("subsCount", subs.length);
    var list = $("subsList");
    clear(list);
    if (!subs.length) {
      list.appendChild(el("div", "empty",
        "Подписок нет. Вставьте URL подписки в поле выше и нажмите «Импортировать»."));
      return;
    }
    subs.forEach(function (sub) {
      var row = el("div", "sub-row");
      var main = el("div", "sub-main");
      main.appendChild(el("div", "sub-url", sub.url));
      var metaText = "Профилей: " + (sub.profileCount || 0) +
        " · обновлено: " + (sub.lastFetched ? XS.fmtTime(sub.lastFetched) : "ещё нет");
      var meta = el("div", "sub-meta" + (sub.lastError ? " err" : ""),
        sub.lastError ? ("Ошибка: " + sub.lastError) : metaText);
      main.appendChild(meta);
      row.appendChild(main);

      var actions = el("div", "sub-actions");
      var select = document.createElement("select");
      select.setAttribute("data-sub-interval", sub.id);
      select.title = "Интервал автообновления";
      [30, 60, 180, 360, 720, 1440, 10080].forEach(function (min) {
        var option = document.createElement("option");
        option.value = String(min);
        option.textContent = subIntervalLabel(min);
        option.selected = sub.intervalMin === min;
        select.appendChild(option);
      });
      actions.appendChild(select);

      var refresh = el("button", "btn ghost small", "Обновить");
      refresh.type = "button";
      refresh.setAttribute("data-sub-refresh", sub.id);
      actions.appendChild(refresh);

      var del = el("button", "btn-del", "Удалить");
      del.type = "button";
      del.setAttribute("data-sub-del", sub.id);
      actions.appendChild(del);

      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function render(res) {
    if (!res || !res.settings) return;
    current = res;
    renderHeader(res);
    renderProfiles(res.settings);
    renderRules(res.settings);
    renderSubscriptions(res.settings);
    renderHelper(res);
  }

  function refresh() {
    return send({ type: "state" }).then(render).catch(function (err) {
      toast(XS.errorText(err), true);
    });
  }

  /* --------------------------------------------------------------- profiles */

  function showImportResult(result, isError) {
    var box = $("importResult");
    clear(box);
    box.classList.remove("hidden");
    box.classList.toggle("err", !!isError);
    if (!result) {
      box.textContent = "Ничего не импортировано.";
      return;
    }

    var summary = document.createElement("div");
    summary.appendChild(document.createTextNode("Добавлено: "));
    summary.appendChild(el("b", "", String(result.added || 0)));
    summary.appendChild(document.createTextNode(" · пропущено: " + (result.skipped || 0)));
    box.appendChild(summary);

    var errors = result.errors || [];
    if (errors.length) {
      var ul = el("ul");
      errors.slice(0, 6).forEach(function (message) {
        ul.appendChild(el("li", "", message));
      });
      box.appendChild(ul);
    }

    var warnings = result.warnings || [];
    if (warnings.length) {
      var warning = el("div", "warn");
      warning.appendChild(document.createTextNode("Предупреждения:"));
      var wul = el("ul");
      warnings.slice(0, 6).forEach(function (message) {
        wul.appendChild(el("li", "", message));
      });
      warning.appendChild(wul);
      box.appendChild(warning);
    }
  }

  function autoCheckTunnel() {
    toast("Проверяем туннель…");
    return send({ type: "connect" }).then(function (res) {
      render(res);
      return send({ type: "health" });
    }).then(function (res) {
      var h = res.health || {};
      if (h.ok) {
        toast("Туннель работает · " + Math.round(h.latencyMs || 0) + " мс");
      } else {
        toast("Профиль добавлен, но проверка не удалась: " + (h.error || "нет ответа"), true);
      }
    }).catch(function (err) {
      toast("Профиль добавлен, но подключиться не удалось: " + XS.errorText(err), true);
    });
  }

  function importConfig() {
    var text = $("importText").value.trim();
    if (!text) {
      toast("Вставьте VLESS-ссылку или URL подписки", true);
      return;
    }

    var isUrl = /^https?:\/\/\S+$/i.test(text);
    var pattern = isUrl ? XS.originPattern(text) : null;
    var permission = Promise.resolve(true);
    if (isUrl && pattern && api.permissions && api.permissions.request && !XS.isFirefox) {
      // Must be started synchronously from the click handler.
      // Firefox always has <all_urls> for proxy.onRequest, so it needs no request.
      try {
        permission = Promise.resolve(api.permissions.request({ origins: [pattern] }));
      } catch (err) {
        toast("Не удалось запросить доступ к " + pattern, true);
        return;
      }
    }

    var btn = $("importBtn");
    btn.disabled = true;
    btn.textContent = "Импорт…";

    permission.then(function (granted) {
      if (!granted) throw new Error("Без разрешения на домен подписка не загрузится");
      return isUrl
        ? send({ type: "fetchSubscription", url: text })
        : send({ type: "addProfiles", text: text });
    }).then(function (res) {
      render(res);
      showImportResult(res.importResult, !(res.importResult && res.importResult.added));
      if (res.importResult && res.importResult.added) {
        $("importText").value = "";
        toast("Импортировано профилей: " + res.importResult.added);
        if ($("autoCheck") && $("autoCheck").checked) autoCheckTunnel();
      } else {
        toast("Новых профилей нет", true);
      }
    }).catch(function (err) {
      showImportResult({ added: 0, skipped: 0, errors: [XS.errorText(err)] }, true);
      toast(XS.errorText(err), true);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "Импортировать";
    });
  }

  /* ------------------------------------------------------------------ rules */

  function addRule() {
    var pattern = XS.rules.normalizePattern($("rulePattern").value);
    if (!pattern) {
      toast("Введите домен или шаблон", true);
      return;
    }
    if (pattern.length > 255) {
      toast("Шаблон слишком длинный", true);
      return;
    }
    var action = $("ruleAction").value;
    send({ type: "addRule", pattern: pattern, action: action }).then(function (res) {
      render(res);
      $("rulePattern").value = "";
      toast(action === "proxy" ? "Сайт будет проксироваться" : "Сайт будет открываться напрямую");
    }).catch(function (err) { toast(XS.errorText(err), true); });
  }

  /* ----------------------------------------------------------------- helper */

  function startLogsTimer() {
    stopLogsTimer();
    logsTimer = setInterval(function () {
      if (document.hidden || activeTab !== "helper") return;
      refreshLogs();
    }, 3500);
  }

  function stopLogsTimer() {
    if (logsTimer) clearInterval(logsTimer);
    logsTimer = null;
  }

  function refreshLogs() {
    if (logsBusy) return Promise.resolve();
    logsBusy = true;
    var pre = $("logsPre");
    var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    return send({ type: "getLogs", limit: 300 }).then(function (res) {
      var logs = res.logs || [];
      if (!logs.length) {
        pre.textContent = "Логи появятся после запуска ядра.";
        return;
      }
      pre.textContent = logs.map(function (l) {
        return "[" + XS.fmtTime(l.time) + "] " + (l.level || "info") + ": " + (l.message || "");
      }).join("\n");
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }).catch(function (err) {
      pre.textContent = "Не удалось получить логи: " + XS.errorText(err);
    }).finally(function () {
      logsBusy = false;
    });
  }

  function checkHealth() {
    var btn = $("healthBtn");
    var target = ($("healthTarget").value.trim() || "https://www.gstatic.com/generate_204").slice(0, 2048);
    var box = $("healthResult");
    box.classList.remove("hidden");
    box.classList.remove("err");
    box.textContent = "Проверяем туннель…";
    btn.disabled = true;
    send({ type: "health", target: target }).then(function (res) {
      var h = res.health || {};
      if (h.ok) {
        box.classList.remove("err");
        box.textContent = "Туннель работает · " + Math.round(h.latencyMs || 0) + " мс · " + (h.target || target);
      } else {
        box.classList.add("err");
        box.textContent = "Не удалось: " + (h.error || "неизвестная ошибка");
      }
    }).catch(function (err) {
      box.classList.add("err");
      box.textContent = XS.errorText(err);
    }).finally(function () {
      btn.disabled = false;
    });
  }

  /* ---------------------------------------------------------------- settings */

  function exportSettings() {
    send({ type: "exportSettings" }).then(function (res) {
      var blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "xray-switch-settings.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast("Настройки экспортированы");
    }).catch(function (err) { toast(XS.errorText(err), true); });
  }

  function importSettingsFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result || "")); }
      catch (_) { toast("Это не JSON-файл", true); return; }
      if (!confirm("Импорт заменит текущие профили и правила. Продолжить?")) return;
      send({ type: "importSettings", data: data }).then(function (res) {
        render(res);
        toast("Импортировано профилей: " + (res.imported || 0));
      }).catch(function (err) { toast(XS.errorText(err), true); });
    };
    reader.readAsText(file);
  }

  /* --------------------------------------------------------------- listeners */

  function testAllProfiles() {
    var btn = $("testProfilesBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Проверяем…";
    }
    testResults = {};
    toast("Проверяем профили по очереди…");
    send({ type: "testProfiles" }).then(function (res) {
      var results = (res.testResult && res.testResult.results) || [];
      results.forEach(function (r) { testResults[r.id] = r; });
      render(res);
      var ok = results.filter(function (r) { return r.ok; }).length;
      toast("Работают " + ok + " из " + results.length + " профилей");
    }).catch(function (err) {
      toast(XS.errorText(err), true);
    }).finally(function () {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Проверить все";
      }
    });
  }

  function downloadDiagnostics() {
    var btn = $("downloadDiagBtn");
    if (btn) btn.disabled = true;
    send({ type: "diagnostics" }).then(function (res) {
      var blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "exa-switch-diagnostics-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast("Диагностика сохранена (без UUID и токенов)");
    }).catch(function (err) {
      toast(XS.errorText(err), true);
    }).finally(function () {
      if (btn) btn.disabled = false;
    });
  }

  function bind() {
    document.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () { showTab(btn.getAttribute("data-tab")); });
    });

    window.addEventListener("hashchange", function () {
      showTab(location.hash.replace("#", "") || "profiles");
    });

    $("importBtn").addEventListener("click", importConfig);
    $("importText").addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") importConfig();
    });

    $("profilesList").addEventListener("change", function (e) {
      if (e.target && e.target.name === "activeProfile") {
        send({ type: "setActiveProfile", id: e.target.value }).then(render).catch(function (err) {
          toast(XS.errorText(err), true);
        });
      }
    });
    $("profilesList").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-del]") : null;
      if (!btn) return;
      if (!confirm("Удалить этот профиль?")) return;
      send({ type: "deleteProfile", id: btn.getAttribute("data-del") }).then(render).catch(function (err) {
        toast(XS.errorText(err), true);
      });
    });

    $("testProfilesBtn").addEventListener("click", testAllProfiles);

    $("rulesMode").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-mode]") : null;
      if (!btn) return;
      send({ type: "setMode", mode: btn.getAttribute("data-mode") }).then(render).catch(function (err) {
        toast(XS.errorText(err), true);
      });
    });

    $("addRuleBtn").addEventListener("click", addRule);
    $("rulePattern").addEventListener("keydown", function (e) {
      if (e.key === "Enter") addRule();
    });

    $("rulesList").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-del-rule]") : null;
      if (!btn) return;
      send({ type: "deleteRule", id: btn.getAttribute("data-del-rule") }).then(render).catch(function (err) {
        toast(XS.errorText(err), true);
      });
    });

    $("subsList").addEventListener("click", function (e) {
      var refresh = e.target.closest ? e.target.closest("[data-sub-refresh]") : null;
      if (refresh) {
        send({ type: "refreshSubscription", id: refresh.getAttribute("data-sub-refresh") }).then(function (res) {
          render(res);
          var rr = res.refreshResult || {};
          toast("Подписка обновлена: +" + (rr.added || 0) + " профилей");
        }).catch(function (err) {
          toast(XS.errorText(err), true);
        });
        return;
      }
      var del = e.target.closest ? e.target.closest("[data-sub-del]") : null;
      if (del) {
        if (!confirm("Удалить подписку и все её профили?")) return;
        send({ type: "deleteSubscription", id: del.getAttribute("data-sub-del") }).then(function (res) {
          render(res);
          toast("Подписка удалена");
        }).catch(function (err) {
          toast(XS.errorText(err), true);
        });
      }
    });

    $("subsList").addEventListener("change", function (e) {
      var id = e.target && e.target.getAttribute("data-sub-interval");
      if (!id) return;
      send({
        type: "setSubscriptionInterval",
        id: id,
        intervalMin: parseInt(e.target.value, 10)
      }).then(render).catch(function (err) {
        toast(XS.errorText(err), true);
      });
    });

    $("clearRulesBtn").addEventListener("click", function () {
      if (!confirm("Удалить все правила сайтов?")) return;
      send({ type: "clearRules" }).then(render).catch(function (err) { toast(XS.errorText(err), true); });
    });

    $("restartHelperBtn").addEventListener("click", function () {
      if (!confirm("Перезапустить helper? Текущее соединение прервётся.")) return;
      var btn = $("restartHelperBtn");
      btn.disabled = true;
      btn.textContent = "Перезапуск…";
      send({ type: "restartHelper" }).then(function (res) {
        render(res);
        toast("Helper перезапущен");
        refreshLogs();
      }).catch(function (err) {
        toast(XS.errorText(err), true);
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = "Перезапустить helper";
      });
    });

    $("stopCoreBtn").addEventListener("click", function () {
      send({ type: "disconnect" }).then(function (res) {
        render(res);
        toast("Ядро остановлено");
      }).catch(function (err) { toast(XS.errorText(err), true); });
    });

    $("refreshHelperBtn").addEventListener("click", function () {
      refresh().then(refreshLogs);
    });

    $("healthBtn").addEventListener("click", checkHealth);
    $("healthTarget").addEventListener("keydown", function (e) {
      if (e.key === "Enter") checkHealth();
    });

    $("refreshLogsBtn").addEventListener("click", refreshLogs);
    $("copyLogsBtn").addEventListener("click", function () {
      navigator.clipboard.writeText($("logsPre").textContent).then(function () {
        toast("Логи скопированы");
      }).catch(function () { toast("Не удалось скопировать", true); });
    });

    $("downloadDiagBtn").addEventListener("click", downloadDiagnostics);

    $("copyInstallBtn").addEventListener("click", function () {
      navigator.clipboard.writeText("./install.sh").then(function () {
        toast("Команда скопирована");
      }).catch(function () { toast("Не удалось скопировать", true); });
    });

    $("exportAllBtn").addEventListener("click", function () {
      if (!confirm("В экспорте будут VLESS-ссылки и UUID. Не публикуйте файл. Продолжить?")) return;
      exportSettings();
    });

    $("importAllFile").addEventListener("change", function (e) {
      importSettingsFile(e.target.files && e.target.files[0]);
      e.target.value = "";
    });

    $("clearCacheBtn").addEventListener("click", function () {
      send({ type: "clearHelperCache" }).then(function (res) {
        render(res);
        toast("Кэш helper'а сброшен");
      }).catch(function (err) { toast(XS.errorText(err), true); });
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        refresh();
        if (activeTab === "helper") refreshLogs();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    setText("nativeName", XS.NATIVE_HOST);
    $("healthTarget").value = "https://www.gstatic.com/generate_204";
    showTab(location.hash.replace("#", "") || "profiles");
    refresh();
  });
})();

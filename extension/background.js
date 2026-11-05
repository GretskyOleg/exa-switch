/* Xray Switch — background service worker (Chrome) / event page (Firefox). */
(function () {
  "use strict";

  // Chrome loads only this file as a service worker. Firefox loads the lib files
  // listed in manifest.background.scripts before this file, where importScripts
  // is not available.
  if (typeof importScripts === "function" && !globalThis.XS) {
    importScripts("lib/util.js", "lib/vless.js", "lib/rules.js", "lib/pac.js", "lib/api.js");
  }

  var XS = globalThis.XS;
  var api = XS.browser;

  var DEFAULTS = {
    schema: 1,
    mode: "auto",
    lastMode: "auto",
    paused: false,
    autoConnect: true,
    bypassLocal: true,
    profiles: [],
    activeProfileId: null,
    rules: [],
    proxyPort: 0,
    httpPort: 0,
    helperInfo: null
  };

  var state = {
    status: null,
    helperError: "",
    coreError: "",
    proxyError: "",
    syncing: null
  };

  var firefoxCache = { at: 0, settings: null };

  /* ---------------------------------------------------------------- storage */

  var MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;

  function isProfile(p) {
    return !!(
      p &&
      typeof p.id === "string" && p.id.length > 0 && p.id.length <= 80 &&
      typeof p.name === "string" && p.name.length <= 80 &&
      typeof p.link === "string" && p.link.length > 0 && p.link.length <= XS.vless.MAX_LINK &&
      p.outbound && typeof p.outbound === "object"
    );
  }

  /** Rebuild a profile from its VLESS link so that imported JSON can never
   *  inject an arbitrary xray outbound into the helper. */
  function sanitizeProfile(p) {
    if (!p || typeof p !== "object") return null;
    var link = typeof p.link === "string" ? p.link.trim() : "";
    if (!link || link.length > XS.vless.MAX_LINK) return null;
    var parsed = XS.vless.parse(link);
    if (!parsed || !parsed.ok) return null;
    var id = typeof p.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(p.id) ? p.id : XS.uid();
    var name = String(p.name == null ? "" : p.name).trim().slice(0, 80) || parsed.meta.name || "VLESS";
    var sourceUrl = typeof p.sourceUrl === "string" ? p.sourceUrl.slice(0, 2048) : "";
    return {
      id: id,
      name: name,
      link: link,
      outbound: parsed.outbound,
      meta: parsed.meta,
      sourceUrl: sourceUrl,
      createdAt: Number(p.createdAt) || Date.now()
    };
  }

  function outboundForProfile(p) {
    if (!p || typeof p.link !== "string") {
      throw new Error("Профиль без VLESS-ссылки — импортируйте его заново");
    }
    var parsed = XS.vless.parse(p.link);
    if (!parsed.ok) throw new Error(parsed.error || "Некорректная VLESS-ссылка");
    return parsed.outbound;
  }

  function normalizeRules(rules) {
    var map = {};
    var list = Array.isArray(rules) ? rules : [];
    for (var i = 0; i < list.length && Object.keys(map).length < 1000; i++) {
      var pattern = XS.rules.normalizePattern(list[i] && list[i].pattern);
      var action = list[i] && list[i].action;
      if (!pattern || pattern.length > 255) continue;
      if (action !== "proxy" && action !== "direct") continue;
      map[pattern] = {
        id: (list[i] && list[i].id) || XS.uid(),
        pattern: pattern,
        action: action
      };
    }
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function getSettings() {
    return XS.storageGet(DEFAULTS).then(function (s) {
      if (["off", "auto", "global"].indexOf(s.mode) === -1) s.mode = "auto";
      if (["off", "auto", "global"].indexOf(s.lastMode) === -1) s.lastMode = "auto";
      s.profiles = (Array.isArray(s.profiles) ? s.profiles : []).filter(isProfile).slice(0, 500);
      s.rules = normalizeRules(s.rules);
      if (s.activeProfileId && !s.profiles.some(function (p) { return p.id === s.activeProfileId; })) {
        s.activeProfileId = null;
      }
      s.autoConnect = s.autoConnect !== false;
      s.bypassLocal = s.bypassLocal !== false;
      s.paused = s.paused === true;
      s.proxyPort = Math.min(65535, Math.max(0, parseInt(s.proxyPort, 10) || 0));
      s.httpPort = Math.min(65535, Math.max(0, parseInt(s.httpPort, 10) || 0));
      return s;
    });
  }

  function saveSettings(patch) {
    return getSettings().then(function (current) {
      var next = Object.assign({}, current, patch || {});
      if (patch && patch.rules) next.rules = normalizeRules(patch.rules);
      if (patch && patch.profiles) {
        next.profiles = patch.profiles.map(sanitizeProfile).filter(Boolean).slice(0, 500);
      }
      if (next.activeProfileId && !next.profiles.some(function (p) { return p.id === next.activeProfileId; })) {
        next.activeProfileId = null;
      }
      if (["off", "auto", "global"].indexOf(next.mode) === -1) next.mode = "auto";
      return XS.storageSet(next).then(function () {
        firefoxCache.at = 0;
        return next;
      });
    });
  }

  function activeProfile(s) {
    if (!s.activeProfileId) return null;
    for (var i = 0; i < s.profiles.length; i++) {
      if (s.profiles[i].id === s.activeProfileId) return s.profiles[i];
    }
    return null;
  }

  function publicSettings(s) {
    return {
      mode: s.mode,
      lastMode: s.lastMode,
      paused: s.paused,
      autoConnect: s.autoConnect,
      bypassLocal: s.bypassLocal,
      profiles: s.profiles,
      activeProfileId: s.activeProfileId,
      rules: s.rules,
      proxyPort: s.proxyPort,
      httpPort: s.httpPort
    };
  }

  /* ----------------------------------------------------------- proxy wiring */

  function applyProxy(s, status) {
    var active = activeProfile(s);
    var socksPort = status && status.socksPort ? status.socksPort : s.proxyPort;
    var httpPort = status && status.httpPort ? status.httpPort : s.httpPort;
    var coreReady = status ? !!status.running : socksPort > 0; // unknown helper = fail closed
    var enabled = !!(
      s.mode !== "off" &&
      !s.paused &&
      active &&
      socksPort &&
      (coreReady || s.autoConnect)
    );

    firefoxCache.at = 0;

    if (XS.isFirefox) {
      // Firefox uses proxy.onRequest, which reads settings from storage.
      return Promise.resolve();
    }

    if (!enabled) {
      return Promise.resolve(api.proxy.settings.clear({ scope: "regular" })).catch(function () {});
    }

    var pac;
    try {
      pac = XS.pac.build({
        mode: s.mode,
        rules: s.rules,
        bypassLocal: s.bypassLocal,
        socksPort: socksPort,
        httpPort: httpPort
      });
    } catch (err) {
      return Promise.reject(err);
    }

    return Promise.resolve(api.proxy.settings.set({
      value: {
        mode: "pac_script",
        pacScript: { data: pac, mandatory: false }
      },
      scope: "regular"
    }));
  }

  function updateBadge(s, status, error) {
    var text = "OFF";
    var color = "#64748b";
    if (s.mode !== "off" && !s.paused) {
      if (error) {
        text = "!";
        color = "#ef4444";
      } else if (status && status.running) {
        text = "ON";
        color = "#10b981";
      } else {
        text = "…";
        color = "#f59e0b";
      }
    }
    try {
      api.action.setBadgeBackgroundColor({ color: color });
      api.action.setBadgeText({ text: text });
    } catch (_) {}
  }

  /* ---------------------------------------------------------------- syncing */

  function syncAll(opts) {
    if (state.syncing) return state.syncing;
    state.syncing = doSync(opts || {}).finally(function () {
      state.syncing = null;
    });
    return state.syncing;
  }

  async function doSync(opts) {
    var s = await getSettings();
    state.proxyError = "";

    if (s.mode === "off" || s.paused) {
      state.helperError = "";
      state.coreError = "";
      await applyProxy(s, null);
      updateBadge(s, null, "");
      return;
    }

    var status = null;
    try {
      await XS.api.ensure(false);
      status = await XS.api.status();

      var active = activeProfile(s);
      if (active) {
        var wrongProfile = status.running && status.profileId && status.profileId !== active.id;
        if (wrongProfile) {
          try {
            status = await XS.api.start(active.id, active.name, outboundForProfile(active));
          } catch (err) {
            state.coreError = XS.errorText(err);
          }
        } else if (!status.running && opts.startIfNeeded && s.autoConnect) {
          try {
            status = await XS.api.start(active.id, active.name, outboundForProfile(active));
            state.coreError = "";
          } catch (err) {
            state.coreError = XS.errorText(err);
          }
        }
      } else if (status.running) {
        status = await XS.api.stop();
      }

      state.status = status;
      state.helperError = "";

      if (status && status.socksPort && (status.socksPort !== s.proxyPort || status.httpPort !== s.httpPort)) {
        s = await saveSettings({ proxyPort: status.socksPort, httpPort: status.httpPort });
      }

      try {
        await applyProxy(s, status);
      } catch (proxyErr) {
        state.proxyError = XS.errorText(proxyErr);
      }
      updateBadge(s, status, state.coreError || state.proxyError);
    } catch (err) {
      // Fail closed: keep the persisted helper port in the PAC/listener instead of
      // silently sending proxied sites direct when the helper disappears.
      state.helperError = XS.errorText(err);
      state.status = null;
      state.coreError = "";
      await applyProxy(s, null);
      updateBadge(s, null, state.helperError);
    }
  }

  /* ---------------------------------------------------------------- helpers */

  async function activeTab() {
    try {
      var tabs = await api.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (_) {
      return null;
    }
  }

  async function snapshot() {
    var s = await getSettings();
    var tab = await activeTab();
    var host = tab && tab.url ? XS.hostFromUrl(tab.url) : "";
    var decision = XS.rules.decide({
      mode: s.mode,
      rules: s.rules,
      host: host,
      bypassLocal: s.bypassLocal
    });

    return {
      ok: true,
      settings: publicSettings(s),
      status: state.status,
      helperError: state.helperError,
      coreError: state.coreError,
      proxyError: state.proxyError,
      helperOnline: !!state.status,
      tab: tab ? { id: tab.id, url: tab.url, title: tab.title || "", host: host } : null,
      decision: decision,
      effectiveProxy: !!(decision.proxy && s.mode !== "off" && !s.paused),
      nativeHost: XS.NATIVE_HOST
    };
  }

  function uniqueName(base, used) {
    var name = String(base || "VLESS").trim().slice(0, 80) || "VLESS";
    if (!used[name]) return name;
    for (var i = 2; i < 1000; i++) {
      var candidate = name + " (" + i + ")";
      if (!used[candidate]) return candidate;
    }
    return name + " " + Date.now();
  }

  function profileKey(p) {
    if (p.link) return "link:" + p.link;
    try {
      var v = p.outbound.settings.vnext[0];
      return "out:" + v.address + ":" + v.port + ":" + v.users[0].id;
    } catch (_) {
      return "json:" + JSON.stringify(p.outbound).slice(0, 500);
    }
  }

  async function importProfiles(text, sourceUrl) {
    var parsed = XS.vless.parseMany(text);
    var s = await getSettings();
    var usedNames = {};
    var usedKeys = {};
    s.profiles.forEach(function (p) {
      usedNames[p.name] = true;
      usedKeys[profileKey(p)] = true;
    });

    var added = [];
    var skipped = parsed.skipped;
    var errors = parsed.errors.slice();
    var warnings = [];

    for (var i = 0; i < parsed.items.length; i++) {
      var item = parsed.items[i];
      var key = "link:" + item.link;
      if (usedKeys[key]) {
        skipped++;
        continue;
      }
      if (s.profiles.length + added.length >= 500) {
        errors.push("Достигнут лимит 500 профилей");
        break;
      }
      var name = uniqueName(item.meta.name, usedNames);
      var profile = sanitizeProfile({
        id: XS.uid(),
        name: name,
        link: item.link,
        outbound: item.outbound,
        meta: item.meta,
        sourceUrl: sourceUrl || "",
        createdAt: Date.now()
      });
      if (!profile) {
        errors.push("Пропущена некорректная VLESS-ссылка");
        continue;
      }
      usedNames[name] = true;
      usedKeys[key] = true;
      added.push(profile);
      if (item.meta && item.meta.warnings && item.meta.warnings.length) {
        item.meta.warnings.forEach(function (warning) {
          warnings.push(name + ": " + warning);
        });
      }
    }

    if (added.length) {
      var patch = { profiles: s.profiles.concat(added) };
      if (!s.activeProfileId) patch.activeProfileId = added[0].id;
      s = await saveSettings(patch);
    }

    return {
      added: added.length,
      skipped: skipped,
      errors: errors.slice(0, 12),
      warnings: warnings.slice(0, 12),
      activeProfileId: s.activeProfileId
    };
  }

  async function readLimitedText(res, limit) {
    var declared = 0;
    if (res.headers && typeof res.headers.get === "function") {
      declared = parseInt(res.headers.get("content-length") || "0", 10);
    }
    if (declared > limit) {
      try { if (res.body) await res.body.cancel(); } catch (_) {}
      throw new Error("Подписка слишком большая ( > 2 МБ)");
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      var fallback = await res.text();
      if (fallback.length > limit) throw new Error("Подписка слишком большая ( > 2 МБ)");
      return fallback;
    }
    var reader = res.body.getReader();
    var chunks = [];
    var total = 0;
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > limit) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error("Подписка слишком большая ( > 2 МБ)");
      }
      chunks.push(step.value);
    }
    var bytes = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      bytes.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return XS.vless.decodeUtf8(bytes);
  }

  async function fetchSubscription(rawUrl) {
    var url = String(rawUrl || "").trim();
    if (url.length > 4096) throw new Error("Слишком длинный URL подписки");
    var pattern = XS.originPattern(url);
    if (!pattern) throw new Error("Нужен http(s)-адрес подписки");
    var allowed = await api.permissions.contains({ origins: [pattern] });
    if (!allowed) {
      throw new Error("Нет разрешения на загрузку с " + pattern + ". Разрешите доступ и повторите.");
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;
    var res;
    try {
      res = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller ? controller.signal : undefined,
        headers: { "Accept": "text/plain, */*" }
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error("Подписка вернула HTTP " + res.status);
    var text = await readLimitedText(res, MAX_SUBSCRIPTION_BYTES);
    if (!text.trim()) throw new Error("Подписка пустая");
    var result = await importProfiles(text, url);
    if (!result.added && !result.skipped) {
      throw new Error("В подписке не найдено VLESS-ссылок");
    }
    return result;
  }

  /* --------------------------------------------------------------- messages */

  async function handleMessage(msg) {
    msg = msg || {};
    var type = msg.type;

    if (type === "state") {
      await syncAll({ startIfNeeded: true });
      return snapshot();
    }

    if (type === "setMode") {
      var mode = msg.mode;
      if (["off", "auto", "global"].indexOf(mode) === -1) throw new Error("Неизвестный режим");
      var s = await getSettings();
      if (mode === "off") {
        s = await saveSettings({
          mode: "off",
          lastMode: s.mode === "off" ? s.lastMode : s.mode,
          paused: false
        });
        await applyProxy(s, null);
        updateBadge(s, null, "");
        if (s.autoConnect) {
          try { state.status = await XS.api.stop(); } catch (_) {}
        }
      } else {
        s = await saveSettings({ mode: mode, lastMode: mode, paused: false });
        state.coreError = "";
        await syncAll({ startIfNeeded: true });
      }
      return snapshot();
    }

    if (type === "togglePower") {
      var cur = await getSettings();
      return handleMessage({ type: "setMode", mode: cur.mode === "off" ? cur.lastMode : "off" });
    }

    if (type === "connect") {
      var cs = await getSettings();
      var profile = activeProfile(cs);
      if (!profile) throw new Error("Сначала добавьте VLESS-профиль");
      if (cs.mode === "off") cs = await saveSettings({ mode: cs.lastMode, lastMode: cs.lastMode });
      cs = await saveSettings({ paused: false });
      state.coreError = "";
      state.helperError = "";
      try {
        var st = await XS.api.start(profile.id, profile.name, outboundForProfile(profile));
        state.status = st;
        if (st && st.socksPort) cs = await saveSettings({ proxyPort: st.socksPort, httpPort: st.httpPort });
        await applyProxy(cs, st);
        updateBadge(cs, st, "");
      } catch (err) {
        if (err && err.status) state.coreError = XS.errorText(err);
        else {
          state.helperError = XS.errorText(err);
          state.status = null;
        }
        await applyProxy(cs, state.status);
        updateBadge(cs, state.status, state.helperError || state.coreError);
        throw err;
      }
      return snapshot();
    }

    if (type === "disconnect") {
      var ds = await getSettings();
      ds = await saveSettings({ paused: true });
      try { state.status = await XS.api.stop(); } catch (_) {}
      state.coreError = "";
      await applyProxy(ds, state.status);
      updateBadge(ds, state.status, "");
      return snapshot();
    }

    if (type === "setActiveProfile") {
      var ps = await getSettings();
      if (msg.id && !ps.profiles.some(function (p) { return p.id === msg.id; })) {
        throw new Error("Профиль не найден");
      }
      ps = await saveSettings({ activeProfileId: msg.id || null, paused: false });
      state.coreError = "";
      if (ps.mode !== "off") await syncAll({ startIfNeeded: true });
      return snapshot();
    }

    if (type === "addProfiles") {
      var importText = String(msg.text || "");
      if (importText.length > MAX_SUBSCRIPTION_BYTES) throw new Error("Слишком большой текст импорта");
      var result = await importProfiles(importText, String(msg.sourceUrl || "").slice(0, 2048));
      var as = await getSettings();
      if (as.mode !== "off" && result.added) await syncAll({ startIfNeeded: true });
      return Object.assign({}, await snapshot(), { importResult: result });
    }

    if (type === "fetchSubscription") {
      var sub = await fetchSubscription(String(msg.url || ""));
      var ss = await getSettings();
      if (ss.mode !== "off" && sub.added) await syncAll({ startIfNeeded: true });
      return Object.assign({}, await snapshot(), { importResult: sub });
    }

    if (type === "deleteProfile") {
      var dels = await getSettings();
      var target = dels.profiles.filter(function (p) { return p.id === msg.id; })[0];
      var wasActive = dels.activeProfileId === msg.id;
      var profiles = dels.profiles.filter(function (p) { return p.id !== msg.id; });
      dels = await saveSettings({
        profiles: profiles,
        activeProfileId: wasActive ? null : dels.activeProfileId
      });
      if (wasActive && state.status && state.status.running) {
        try { state.status = await XS.api.stop(); } catch (_) {}
      }
      await applyProxy(dels, state.status);
      updateBadge(dels, state.status, "");
      return snapshot();
    }

    if (type === "addRule") {
      var pattern = XS.rules.normalizePattern(msg.pattern);
      if (!pattern) throw new Error("Пустой шаблон");
      if (pattern.length > 255) throw new Error("Шаблон слишком длинный");
      if (/[^\x00-\x7F]/.test(pattern)) throw new Error("Домен нужно указать в Punycode");
      if (msg.action !== "proxy" && msg.action !== "direct") throw new Error("Неизвестное действие");
      var rs = await getSettings();
      var rules = rs.rules.filter(function (r) { return r.pattern !== pattern; });
      rules.unshift({ id: XS.uid(), pattern: pattern, action: msg.action });
      rs = await saveSettings({ rules: rules });
      await applyProxy(rs, state.status);
      return snapshot();
    }

    if (type === "deleteRule") {
      var dr = await getSettings();
      dr = await saveSettings({ rules: dr.rules.filter(function (r) { return r.id !== msg.id; }) });
      await applyProxy(dr, state.status);
      return snapshot();
    }

    if (type === "clearRules") {
      var cr = await saveSettings({ rules: [] });
      await applyProxy(cr, state.status);
      return snapshot();
    }

    if (type === "setSiteAction") {
      var host = XS.rules.normalizePattern(msg.host);
      if (!host) throw new Error("Не удалось определить сайт");
      if (["proxy", "direct", "reset"].indexOf(msg.action) === -1) throw new Error("Неизвестное действие");
      var site = await getSettings();
      var kept = site.rules.filter(function (r) {
        return r.pattern !== host && r.pattern !== "*." + host;
      });
      if (msg.action !== "reset") {
        kept.unshift({ id: XS.uid(), pattern: host, action: msg.action });
      }
      site = await saveSettings({ rules: kept });
      await applyProxy(site, state.status);
      return snapshot();
    }

    if (type === "setPreferences") {
      var pref = {};
      if (typeof msg.autoConnect === "boolean") pref.autoConnect = msg.autoConnect;
      if (typeof msg.bypassLocal === "boolean") pref.bypassLocal = msg.bypassLocal;
      var pr = await saveSettings(pref);
      await applyProxy(pr, state.status);
      if (pr.mode !== "off" && !pr.paused && pref.autoConnect !== false) {
        await syncAll({ startIfNeeded: true });
      }
      return snapshot();
    }

    if (type === "ensureHelper") {
      await XS.api.ensure(true);
      await syncAll({ startIfNeeded: true });
      return snapshot();
    }

    if (type === "restartHelper") {
      try { await XS.api.shutdown(); } catch (_) {}
      await XS.sleep(800);
      await XS.api.ensure(true);
      await syncAll({ startIfNeeded: true });
      return snapshot();
    }

    if (type === "getLogs") {
      var logLimit = Math.min(1000, Math.max(1, parseInt(msg.limit, 10) || 200));
      var logs = await XS.api.logs(logLimit);
      return { ok: true, logs: (logs && logs.logs) || [] };
    }

    if (type === "health") {
      var target = String(msg.target || "").trim().slice(0, 2048);
      if (target && !/^https?:\/\/[^\s]+$/i.test(target)) throw new Error("Нужен http(s)-URL");
      var health = await XS.api.health(target);
      return { ok: true, health: health };
    }

    if (type === "exportSettings") {
      var ex = await getSettings();
      return {
        ok: true,
        data: {
          app: "xray-switch",
          version: 1,
          exportedAt: new Date().toISOString(),
          settings: publicSettings(ex)
        }
      };
    }

    if (type === "importSettings") {
      var data = msg.data || {};
      var incoming = data.settings || data;
      var current = await getSettings();
      var importedProfiles = (Array.isArray(incoming.profiles) ? incoming.profiles : [])
        .map(sanitizeProfile).filter(Boolean).slice(0, 500);
      var importedRules = normalizeRules(incoming.rules);
      var nextMode = ["off", "auto", "global"].indexOf(incoming.mode) !== -1 ? incoming.mode : current.mode;
      var nextActive = incoming.activeProfileId && importedProfiles.some(function (p) { return p.id === incoming.activeProfileId; })
        ? incoming.activeProfileId
        : (importedProfiles[0] ? importedProfiles[0].id : null);
      var imp = await saveSettings({
        mode: nextMode,
        lastMode: ["off", "auto", "global"].indexOf(incoming.lastMode) !== -1 ? incoming.lastMode : nextMode,
        paused: false,
        autoConnect: incoming.autoConnect !== false,
        bypassLocal: incoming.bypassLocal !== false,
        profiles: importedProfiles,
        rules: importedRules,
        activeProfileId: nextActive
      });
      await syncAll({ startIfNeeded: true });
      return Object.assign({}, await snapshot(), { imported: importedProfiles.length });
    }

    if (type === "clearHelperCache") {
      await XS.api.resetCache();
      state.status = null;
      state.helperError = "";
      return snapshot();
    }

    throw new Error("Неизвестная команда: " + type);
  }

  /* --------------------------------------------------------------- listeners */

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // Only our own pages may drive the background. onMessageExternal is not
    // registered, so other extensions/websites cannot reach this handler, but
    // keep the explicit check as defence in depth.
    if (sender && sender.id && api.runtime.id && sender.id !== api.runtime.id) {
      return false;
    }
    handleMessage(msg, sender).then(function (result) {
      sendResponse(result || { ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: XS.errorText(err) });
    });
    return true;
  });

  async function createMenus() {
    try {
      if (api.contextMenus.removeAll) await api.contextMenus.removeAll();
      api.contextMenus.create({ id: "xs-proxy", title: "EXA Switch: проксировать этот сайт", contexts: ["page"] });
      api.contextMenus.create({ id: "xs-direct", title: "EXA Switch: открыть напрямую", contexts: ["page"] });
      api.contextMenus.create({ id: "xs-reset", title: "EXA Switch: сбросить правило сайта", contexts: ["page"] });
    } catch (_) {}
  }

  function ensureAlarm() {
    try {
      Promise.resolve(api.alarms.get("xs-sync")).then(function (alarm) {
        if (!alarm) api.alarms.create("xs-sync", { periodInMinutes: 1 });
      }).catch(function () {
        api.alarms.create("xs-sync", { periodInMinutes: 1 });
      });
    } catch (_) {
      try { api.alarms.create("xs-sync", { periodInMinutes: 1 }); } catch (__) {}
    }
  }

  api.runtime.onInstalled.addListener(function (details) {
    ensureAlarm();
    createMenus();
    if (details && details.reason === "install") {
      getSettings().then(function (s) {
        return XS.storageSet(Object.assign({}, DEFAULTS, s));
      }).then(function () {
        if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
      }).catch(function () {});
    }
    syncAll({ startIfNeeded: true });
  });

  api.runtime.onStartup.addListener(function () {
    ensureAlarm();
    syncAll({ startIfNeeded: true });
  });

  api.alarms.onAlarm.addListener(function (alarm) {
    if (alarm && alarm.name === "xs-sync") syncAll({ startIfNeeded: true });
  });

  if (api.contextMenus && api.contextMenus.onClicked) {
    api.contextMenus.onClicked.addListener(function (info, tab) {
      var url = info.pageUrl || (tab && tab.url) || "";
      var host = XS.hostFromUrl(url);
      if (!host) return;
      var action = info.menuItemId === "xs-proxy" ? "proxy" : info.menuItemId === "xs-direct" ? "direct" : "reset";
      handleMessage({ type: "setSiteAction", host: host, action: action }).then(function () {
        if (tab && tab.id) api.tabs.reload(tab.id);
      }).catch(function () {});
    });
  }

  if (api.proxy && api.proxy.onProxyError) {
    api.proxy.onProxyError.addListener(function (details) {
      state.proxyError = (details && details.details) || "Ошибка прокси";
      updateBadge({ mode: "auto", paused: false }, state.status, state.proxyError);
      setTimeout(function () { syncAll({ startIfNeeded: true }); }, 1500);
    });
  }

  /* Firefox: per-request proxy. State is re-read from storage so it survives event-page suspension. */
  if (XS.isFirefox && api.proxy && api.proxy.onRequest) {
    async function settingsForRequest() {
      var now = Date.now();
      if (firefoxCache.settings && now - firefoxCache.at < 5000) return firefoxCache.settings;
      var s = await getSettings();
      firefoxCache.settings = s;
      firefoxCache.at = now;
      return s;
    }

    api.proxy.onRequest.addListener(function (details) {
      return settingsForRequest().then(function (s) {
        if (!s || s.mode === "off" || s.paused || !s.proxyPort || !s.activeProfileId) {
          return { type: "direct" };
        }
        var host = XS.hostFromUrl(details.url);
        var decision = XS.rules.decide({
          mode: s.mode,
          rules: s.rules,
          host: host,
          bypassLocal: s.bypassLocal
        });
        if (!decision.proxy) return { type: "direct" };
        return { type: "socks", host: "127.0.0.1", port: s.proxyPort, proxyDNS: true };
      }).catch(function () {
        return { type: "direct" };
      });
    }, { urls: ["<all_urls>"] });
  }

  ensureAlarm();
})();

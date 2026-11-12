// ==UserScript==
// @name         FC Price Watch
// @namespace    local.fc.price-watch
// @version      2.68.0
// @description  FC Price Watch met FUT.GG-PC-prijzen, PC-instapdoel, duidelijke zoekwaarschuwingen, handmatige live EA-BIN-scan met conservatieve limieten, stock-lijsten en QR-overdracht naar je telefoon.
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.easports.com/*ultimate-team/web-app*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @connect      ntfy.sh
// @connect      r2.fut.gg
// @connect      www.fut.gg
// @connect      fodder.gg
// @connect      www.futbin.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js
// @updateURL    https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/price-watch.user.js
// @downloadURL  https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/price-watch.user.js
// ==/UserScript==

function priceWatchMain(SCRIPT_VERSION) {
  "use strict";

  // UI language: English by default, Dutch with the NL/EN button (saved with the Flip settings, pt_flip_v1.lang).
  // L(dutch, english) picks the text; texts built once when a screen opens follow after reopening it.
  let uiLangCache = null;
  function uiLang() {
    if (uiLangCache == null) {
      try {
        const saved = JSON.parse(localStorage.getItem("pt_flip_v1") || "null");
        uiLangCache = saved && saved.lang === "nl" ? "nl" : "en";
      } catch (_) {
        uiLangCache = "en";
      }
    }
    return uiLangCache;
  }
  function L(nl, en) {
    return uiLang() === "nl" ? nl : en;
  }

  const APP_GUARD = "__fcPriceWatch";
  if (window[APP_GUARD]) return;
  window[APP_GUARD] = true;
  document.documentElement.setAttribute("data-pt-price-watch", SCRIPT_VERSION || "1");
  const IS_PHONE = window.innerWidth <= 700;

  // --- EA log: passive record of what goes wrong (no requests of our own) ---------------------------
  // Every bid request with its answer, every failed EA request (status + start of the answer), EA's own
  // pop-up messages and each (re)load of the web app, so a "bid failed, restart the app" can be traced.
  // Stays in this browser (localStorage), last 80 entries; shown with Ctrl+Shift+D.
  const EA_LOG_KEY = "pt_ea_log_v1";
  const EA_LOG_MAX = 200;

  function eaLog(entry) {
    try {
      const list = JSON.parse(localStorage.getItem(EA_LOG_KEY) || "[]");
      list.push({ t: Date.now(), ...entry });
      localStorage.setItem(EA_LOG_KEY, JSON.stringify(list.slice(-EA_LOG_MAX)));
    } catch (_) {
      // Logging must never get in the way.
    }
  }

  function eaLogLines(count) {
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(EA_LOG_KEY) || "[]");
    } catch (_) {
      list = [];
    }
    return list.slice(-count).map(entry => {
      const time = new Date(entry.t).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      if (entry.kind === "http") return `${time}  ${entry.method} ${entry.path} → ${entry.status || L("geen antwoord", "no response")} (${entry.ms} ms)${entry.text ? `  ${entry.text}` : ""}`;
      if (entry.kind === "melding") return L(`${time}  EA-melding: ${entry.text}`, `${time}  EA notice: ${entry.text}`);
      return `${time}  ${entry.text || entry.kind}`;
    });
  }

  eaLog({ kind: "load", text: L(`web app (her)geladen · Price Watch ${SCRIPT_VERSION || ""}`, `web app (re)loaded · Price Watch ${SCRIPT_VERSION || ""}`) });

  // "ok" | "unsure" (EA logged in again without a reload) | "blocked" (a bid got 461).
  let sessionState = "ok";
  let sessionAuths = 0;
  let sessionAuthAt = 0; // last successful POST /ut/auth (page load or EA's silent re-login)

  // Reload, and open Transfer Targets again once the web app is back.
  const RETURN_KEY = "pt_return_targets";
  function reloadToTargets() {
    try {
      sessionStorage.setItem(RETURN_KEY, String(Date.now()));
    } catch (_) {
      // Then you open it yourself.
    }
    window.location.reload();
  }
  let session401At = 0;
  let sessionBar = null;

  function setSessionState(state, text) {
    sessionState = state;
    try {
      if (state === "ok") {
        if (sessionBar) sessionBar.remove();
        sessionBar = null;
        return;
      }
      if (!document.body) return;
      if (!sessionBar) {
        sessionBar = document.createElement("div");
        sessionBar.className = "pt-session-bar";
        const label = document.createElement("span");
        const reload = document.createElement("button");
        reload.type = "button";
        reload.textContent = L("⟳ Nu herladen", "⟳ Reload now");
        reload.addEventListener("click", reloadToTargets);
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "✕";
        close.title = "Verbergen";
        close.addEventListener("click", () => { if (sessionBar) sessionBar.remove(); sessionBar = null; });
        sessionBar.append(label, reload, close);
        document.body.appendChild(sessionBar);
      }
      sessionBar.classList.toggle("pt-session-blocked", state === "blocked");
      sessionBar.firstChild.textContent = text;
    } catch (_) {
      // Only a warning.
    }
  }

  function noteEaResponse(path, method, status) {
    const bid = /\/bid$/.test(path);
    if (status === 401) {
      session401At = Date.now();
      eaLog({ kind: "sessie", text: L("⚠ EA: sessie verlopen/overgenomen (401) — ergens anders ingelogd? (telefoon-app, game, ander tabblad)", "⚠ EA: session expired/taken over (401) — logged in somewhere else? (phone app, game, another tab)") });
    }
    if (/\/ut\/auth/.test(path) && status >= 200 && status < 300) {
      sessionAuths++;
      sessionAuthAt = Date.now();
      if (sessionAuths > 1 || Date.now() - session401At < 60 * 1000) {
        eaLog({ kind: "sessie", text: L(`EA logde opnieuw in zonder herladen (${sessionAuths - 1}× deze keer)`, `EA logged in again without a reload (${sessionAuths - 1}× this time)`) });
        setSessionState("unsure", L("⚠ EA heeft je sessie stil vernieuwd. Bieden kan nu geweigerd worden (461). Herlaad nu, vóór je laatste-seconden-bod.", "⚠ EA silently renewed your session. Bidding may now be rejected (461). Reload now, before your last-seconds bid."));
      }
    }
    if (bid && status === 461) {
      setSessionState("blocked", L("⛔ EA weigert biedingen in deze sessie (461). Opnieuw bieden heeft geen zin: herlaad nu.", "⛔ EA is rejecting bids in this session (461). Bidding again is pointless: reload now."));
    } else if (bid && status >= 200 && status < 300 && sessionState !== "ok") {
      setSessionState("ok");
      showToastSafe(L("✅ Bod gelukt: bieden werkt weer in deze sessie.", "✅ Bid succeeded: bidding works again in this session."));
    }
  }

  function showToastSafe(text) {
    try {
      showToast(text, true);
    } catch (_) {
      // Toast not ready yet.
    }
  }

  (function installEaRequestLog() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.open.__ptLog) return;
    const open = proto.open;
    const send = proto.send;
    const openLogged = function (method, url) {
      this.__ptReq = { method: String(method || "").toUpperCase(), url: String(url || "") };
      return open.apply(this, arguments);
    };
    openLogged.__ptLog = true;
    proto.open = openLogged;
    proto.send = function () {
      const req = this.__ptReq;
      if (req && /\/ut\/(game|auth)/.test(req.url)) {
        const started = Date.now();
        this.addEventListener("loadend", () => {
          try {
            const path = req.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0].replace(/\d{5,}/g, "#");
            const bid = /\/bid$/.test(path);
            const watch = /\/watchlist/.test(path) && req.method !== "GET";
            const bad = !(this.status >= 200 && this.status < 300);
            noteEaResponse(path, req.method, this.status);
            if (!bid && !watch && !bad && !/\/auth/.test(path)) return;
            let text = "";
            if (bad) {
              try {
                text = typeof this.responseText === "string" ? this.responseText : "";
              } catch (_) {
                try { text = JSON.stringify(this.response); } catch (__) { text = ""; }
              }
            }
            eaLog({ kind: "http", method: req.method, path, status: this.status, ms: Date.now() - started, text: String(text || "").replace(/\s+/g, " ").slice(0, 200) });
          } catch (_) {
            // Never interfere with EA's request.
          }
        });
      }
      return send.apply(this, arguments);
    };
  })();

  // EA's own messages at the top of the screen.
  function installNotificationLog() {
    const notification = typeof services !== "undefined" && services.Notification;
    if (!notification || typeof notification.queue !== "function" || notification.queue.__ptLog) return;
    const original = notification.queue;
    const wrapped = function (args) {
      try {
        const first = Array.isArray(args) ? args[0] : args;
        const text = typeof first === "string" ? first : first && (first.message || first.text) || JSON.stringify(first);
        eaLog({ kind: "melding", text: String(text || "").slice(0, 200) });
      } catch (_) {
        // Only a log.
      }
      return original.apply(this, arguments);
    };
    wrapped.__ptLog = true;
    notification.queue = wrapped;
  }

  // A transfer code opened from the QR code (…/web-app/#pw=PW1.…). Read it before the app touches the URL.
  const TRANSFER_PARAM = /[#&?]pw=(PW1\.[\w-]+)/;
  const pendingTransfer = (String(location.href).match(TRANSFER_PARAM) || [])[1] || null;
  if (pendingTransfer) {
    try {
      sessionStorage.setItem("pt_transfer_pending", pendingTransfer);
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_) {
      // Imported from memory below.
    }
  }

  const WATCH_KEY = "pt_watch_v1";
  const SORT_KEY = "pt_watch_sort_v1";
  const MIGRATED_KEY = "pt_watch_migrated_v1";
  const STOCK_KEY = "pt_stock_v1";
  const RUN_KEY = "pt_stock_run_v1";
  const OLD_TARGETS_KEY = "pt_price_tracker_targets_v2";
  const STYLE_ID = "pt-watch-style";
  const TAB_TAG = 97;
  const NEAR_PERCENT = 3;
  const GENIE_REFRESH_MS = 5 * 60 * 1000;
  const GENIE_TIMEOUT_MS = 15 * 1000;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const priceFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

  function parsePrice(value) {
    const digits = String(value || "").replace(/[^\d]/g, "");
    if (!digits) return null;
    const number = Number(digits);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function rarityName(rarity) {
    try {
      const name = services.Localization.localize(`item.raretype${rarity}`);
      return name && !name.startsWith("*") ? name : `Rarity ${rarity}`;
    } catch {
      return `Rarity ${rarity}`;
    }
  }

  function playerNameFor(definitionId, fallback) {
    try {
      const data = repositories.Item.getStaticDataByDefId(definitionId & 0xFFFFFF);
      if (data) return data.commonName || data.lastName || fallback;
    } catch (_) {
      // Static data not loaded yet.
    }
    return fallback || String(definitionId);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      // Try the fallback below.
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(area);
      area.select();
      const success = document.execCommand("copy");
      area.remove();
      return success;
    } catch (_) {
      return false;
    }
  }

  function flashButton(button, icon, ok, title, resetIcon, resetTitle) {
    button.textContent = icon;
    button.title = title;
    button.classList.toggle("pt-ok", ok);
    button.classList.toggle("pt-error", !ok);
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = resetIcon;
      button.title = resetTitle;
      button.classList.remove("pt-ok", "pt-error");
    }, ok ? 1200 : 3000);
  }

  // ---------------------------------------------------------------------------
  // Watch list storage
  // ---------------------------------------------------------------------------
  // Entry: { definitionId, name, rating, rarity, target, addedAt }

  let watchCache = null;
  const listeners = new Set();

  function getWatch() {
    if (watchCache) return watchCache;
    try {
      const value = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
      watchCache = Array.isArray(value) ? value.filter(entry => entry && entry.definitionId) : [];
    } catch {
      watchCache = [];
    }
    return watchCache;
  }

  function saveWatch() {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(getWatch()));
    } catch (error) {
      console.warn(L("Price Watch: lijst kon niet worden opgeslagen.", "Price Watch: list could not be saved."), error);
    }
    listeners.forEach(listener => listener());
  }

  function findWatched(definitionId) {
    return getWatch().find(entry => entry.definitionId === definitionId) || null;
  }

  function addWatched(entry) {
    if (findWatched(entry.definitionId)) return;
    getWatch().push({ target: null, addedAt: Date.now(), ...entry });
    saveWatch();
    refreshGeniePrices(true);
  }

  function removeWatched(definitionId) {
    const list = getWatch();
    const index = list.findIndex(entry => entry.definitionId === definitionId);
    if (index < 0) return;
    list.splice(index, 1);
    saveWatch();
  }

  // Snipe-list players on the Spelers tab: the max BIN becomes the PC target (an existing target stays).
  function addPlayersToWatch(players) {
    let added = 0;
    players.forEach(player => {
      const existing = findWatched(player.definitionId);
      if (existing) {
        if (!existing.target && player.fixedMax) existing.target = player.fixedMax;
        return;
      }
      getWatch().push({
        definitionId: player.definitionId,
        name: player.name,
        rating: player.rating,
        rarity: player.rarity != null ? player.rarity : null,
        target: player.fixedMax || null,
        addedAt: Date.now()
      });
      added++;
    });
    saveWatch();
    refreshGeniePrices(true);
    return added;
  }

  function setTarget(definitionId, target) {
    const entry = findWatched(definitionId);
    if (!entry || entry.target === target) return;
    entry.target = target;
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(getWatch()));
    } catch (_) {
      // Kept in memory for this session.
    }
  }

  window.addEventListener("storage", event => {
    if (event.key !== WATCH_KEY) return;
    watchCache = null;
    listeners.forEach(listener => listener());
  });

  // One-time import of the Paletools price tracker list + Price Tracker Plus targets.
  function readPaletoolsTracker() {
    return new Promise(resolve => {
      let request;
      try {
        request = indexedDB.open("paletools");
      } catch {
        resolve([]);
        return;
      }
      request.onerror = () => resolve([]);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("priceTracker")) {
          db.close();
          resolve([]);
          return;
        }
        const query = db.transaction("priceTracker").objectStore("priceTracker").getAll();
        query.onsuccess = () => {
          db.close();
          resolve(query.result || []);
        };
        query.onerror = () => {
          db.close();
          resolve([]);
        };
      };
    });
  }

  async function migrateFromPaletools() {
    if (localStorage.getItem(MIGRATED_KEY) === "1") return;
    const cards = await readPaletoolsTracker();
    let oldTargets = {};
    try {
      oldTargets = JSON.parse(localStorage.getItem(OLD_TARGETS_KEY) || "{}") || {};
    } catch (_) {
      // No old targets.
    }

    let added = 0;
    for (const card of cards) {
      if (!card || !card.definitionId || findWatched(card.definitionId)) continue;
      const key = `${card.name}|${card.rating}|${rarityName(card.rarity)}`.toLowerCase();
      const target = Number.isFinite(oldTargets[key]) ? oldTargets[key] : null;
      getWatch().push({
        definitionId: card.definitionId,
        name: card.name || playerNameFor(card.definitionId),
        rating: card.rating,
        rarity: card.rarity,
        target,
        addedAt: Date.now()
      });
      added++;
    }
    if (added) saveWatch();
    localStorage.setItem(MIGRATED_KEY, "1");
    if (added) console.info(L(`Price Watch: ${added} speler(s) overgenomen uit Paletools.`, `Price Watch: ${added} player(s) imported from Paletools.`));
  }

  // ---------------------------------------------------------------------------
  // FUT Genie prices (via the FUT Genie extension; no EA market searches)
  // ---------------------------------------------------------------------------

  let genieRequestedAt = 0;
  let genieLoading = false;
  let genieRefetch = false;

  // FUT.GG live PC price feed. The manifest hash changes when a new immutable feed is published.
  // IDs from player-prices-index are reconstructed as id0, then cumulative deltas in d; p[i] is that ID's PC price.
  const FUTGG_GAME_YEAR = 27;
  const FUTGG_MANIFEST_URL = `https://r2.fut.gg/${FUTGG_GAME_YEAR}/manifest.json`;
  const FUTGG_REFRESH_MS = 60 * 1000; // Check the external FUT.GG manifest each minute; this does not call EA market search.
  let futggPrices = Object.create(null);
  let futggPricesAt = 0;
  let futggPlatform = "pc"; // platform of the loaded FUT.GG price feed
  let futggManifestAt = 0;
  let futggLoading = null;
  let futggFeedKey = "";
  let futggLastError = L("Nog geen fout geregistreerd", "No error recorded yet");
  let futggStage = L("nog niet gestart", "not started yet");

  let futggRequestCounter = 0;
  function futggRequestJson(url, raw = false) {
    return new Promise((resolve, reject) => {
      // This part runs in EA's page context, where Tampermonkey's GM_* APIs are not exposed.
      // Send the request through the userscript sandbox bridge installed at the bottom of this file.
      const requestId = `futgg-${Date.now()}-${++futggRequestCounter}`;
      let settled = false;
      const cleanup = () => {
        document.removeEventListener("pt-futgg-response", onResponse);
        window.clearTimeout(timeoutId);
      };
      const onResponse = event => {
        let data;
        try { data = JSON.parse(event.detail); } catch (_) { return; }
        if (!data || data.id !== requestId || settled) return;
        settled = true;
        cleanup();
        if (!data.ok) return reject(new Error(data.error || L("Onbekende fout bij FUT.GG-aanvraag", "Unknown error in FUT.GG request")));
        if (data.status < 200 || data.status >= 300) return reject(new Error(L(`HTTP ${data.status} bij FUT.GG`, `HTTP ${data.status} from FUT.GG`)));
        if (raw) return resolve(String(data.responseText || ""));
        try { resolve(JSON.parse(data.responseText)); }
        catch (error) { reject(new Error(`Ongeldige FUT.GG JSON: ${error.message}`)); }
      };
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(L("Timeout: geen antwoord van Tampermonkey-verzoekbrug", "Timeout: no response from Tampermonkey request bridge")));
      }, 25000);
      document.addEventListener("pt-futgg-response", onResponse);
      document.dispatchEvent(new CustomEvent("pt-futgg-request", { detail: JSON.stringify({ id: requestId, url }) }));
    });
  }

  async function refreshFutggPrices(force = false) {
    if (futggLoading) return futggLoading;
    if (!force && Date.now() - futggManifestAt < FUTGG_REFRESH_MS) return false;
    futggLoading = (async () => {
      try {
        futggStage = L("manifest ophalen", "fetching manifest");
        futggLastError = "";
        // Cache-buster only for the small manifest; its entries point to immutable, hash-versioned JSON files.
        const manifest = await futggRequestJson(`${FUTGG_MANIFEST_URL}?_=${Date.now()}`);
        futggManifestAt = Date.now();
        const version = manifest && manifest._version;
        const indexHash = manifest && manifest["player-prices-index"];
        // the price feed of your platform: PC, or PS5 for console (FUT.GG has no separate Xbox feed)
        const feedPlatform = userPlatform() === "console" ? "console" : "pc";
        const pcHash = manifest && manifest[feedPlatform === "console" ? "player-prices-ps5-dyn" : "player-prices-pc-dyn"];
        if (version == null || !indexHash || !pcHash) throw new Error(L("FUT.GG-manifest mist prijsindex of prijsfeed", "FUT.GG manifest is missing price index or price feed"));
        const feedKey = `${version}:${indexHash}:${pcHash}:${feedPlatform}`;
        if (!force && feedKey === futggFeedKey && futggPricesAt) return true;
        const base = `https://r2.fut.gg/${FUTGG_GAME_YEAR}`;
        futggStage = L("PC-prijsfeed en index ophalen", "fetching PC price feed and index");
        const [index, feed] = await Promise.all([
          futggRequestJson(`${base}/player-prices-index.v${version}.${indexHash}.json`),
          futggRequestJson(`${base}/player-prices-${feedPlatform === "console" ? "ps5" : "pc"}-dyn.v${version}.${pcHash}.json`)
        ]);
        futggStage = L("feed en index controleren", "checking feed and index");
        if (!Array.isArray(index.d) || !Array.isArray(feed.p) || feed.p.length !== index.d.length + 1) {
          throw new Error(L("FUT.GG prijsfeed en index hebben verschillende lengtes", "FUT.GG price feed and index have different lengths"));
        }
        const next = Object.create(null);
        let id = Number(index.id0);
        if (!Number.isFinite(id)) throw new Error(L("FUT.GG-index heeft geen geldige start-ID", "FUT.GG index has no valid start ID"));
        if (Number(feed.p[0]) > 0) next[String(id)] = Number(feed.p[0]);
        for (let i = 0; i < index.d.length; i++) {
          id += Number(index.d[i]);
          const price = Number(feed.p[i + 1]);
          if (Number.isFinite(price) && price > 0) next[String(id)] = price;
        }
        futggPrices = next;
        futggPricesAt = Date.now();
        futggPlatform = feedPlatform;
        futggStage = L("succesvol bijgewerkt", "updated successfully");
        futggLastError = L("geen", "none");
        futggFeedKey = feedKey;
        console.info(L(`Price Watch: FUT.GG PC-feed bijgewerkt (${Object.keys(next).length} prijzen).`, `Price Watch: FUT.GG PC feed updated (${Object.keys(next).length} prices).`));
        logFutggPriceDiagnostics();
        listeners.forEach(listener => listener());
        return true;
      } catch (error) {
        futggLastError = error && error.message ? error.message : String(error);
        console.warn(L("Price Watch: FUT.GG PC-prijzen ophalen mislukt; bestaande prijsbron blijft actief.", "Price Watch: fetching FUT.GG PC prices failed; existing price source stays active."), error);
        logFutggPriceDiagnostics();
        return false;
      } finally {
        futggLoading = null;
      }
    })();
    return futggLoading;
  }

  // Check the small external manifest each minute; its hash changes when FUT.GG publishes a new dynamic feed.
  window.setInterval(() => refreshFutggPrices(false), FUTGG_REFRESH_MS);
  window.setTimeout(() => refreshFutggPrices(true), 2500);

  function genie() {
    const g = window.FutGenie;
    return g && typeof g.fetchBulkPrices === "function" ? g : null;
  }

  // Standalone: "this is the pc" no longer depends on FUT Genie. A computer does the work (auto checks,
  // history, ntfy, gist sync, transfer list and club watch); a phone or tablet reads what the pc shares.
  // Override per browser in localStorage pt_device_v1 = "pc" | "phone". FUT Genie present = always pc.
  const DEVICE_KEY = "pt_device_v1";
  function pcDevice() {
    let forced = "";
    try { forced = localStorage.getItem(DEVICE_KEY) || ""; } catch (_) { /* default */ }
    if (forced === "pc") return true;
    if (forced === "phone") return false;
    if (genie()) return true;
    return !IS_PHONE && !/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent || "");
  }

  // Without FUT Genie (e.g. on the phone), prices come from the last transfer: { defId: [price, fetchedAt] }.
  const PRICES_KEY = "pt_prices_v1";
  let transferredPrices = null;

  function getTransferredPrices() {
    if (transferredPrices) return transferredPrices;
    try {
      transferredPrices = JSON.parse(localStorage.getItem(PRICES_KEY) || "{}") || {};
    } catch {
      transferredPrices = {};
    }
    return transferredPrices;
  }

  function futggPriceFor(definitionId, resourceId) {
    // FUT.GG's price index can key a special by its EA resource/player ID rather than
    // the full UT definitionId. Try exact ID first, then the explicit resourceId,
    // then the game's static player data. Never substitute a different card version.
    const ids = [definitionId, resourceId].filter(value => Number.isFinite(Number(value)) && Number(value) > 0).map(Number);
    try {
      const baseId = Number(definitionId) & 0xFFFFFF;
      const data = baseId && repositories && repositories.Item && repositories.Item.getStaticDataByDefId(baseId);
      if (data) {
        [data.resourceId, data.id, data.baseId].forEach(value => {
          if (Number.isFinite(Number(value)) && Number(value) > 0) ids.push(Number(value));
        });
      }
    } catch (_) { /* Static player data is not always available during startup. */ }
    for (const id of [...new Set(ids)]) {
      const price = futggPrices[String(id)];
      if (Number.isFinite(price) && price > 0) return { price, id };
    }
    return null;
  }

  function geniePrice(definitionId, resourceId) {
    // Prefer the direct FUT.GG PC-market feed. Resolve special-card IDs without
    // falling back to a different card version in the FUT.GG feed.
    const direct = futggPriceFor(definitionId, resourceId);
    if (direct) {
      return { price: direct.price, _fetchedAt: futggPricesAt, _futgg: true, _futggId: direct.id };
    }
    const g = genie();
    const entry = g && g._cachedPrices ? g._cachedPrices[definitionId] : null;
    if (entry && entry.price > 0) return { ...entry, _genie: true };
    // Without the extension, the newest of: FUT Genie via your own login (phone), your own lowest-price
    // search, or the price from the last transfer.
    const candidates = [
      [getRemotePrices()[definitionId], "_remote"],
      [getMarketPrices()[definitionId], "_market"],
      [getTransferredPrices()[definitionId], "_transferred"]
    ].filter(([value]) => value && value[0] > 0);
    if (!candidates.length) return null;
    const [[price, fetchedAt], source] = candidates.reduce((best, item) => (item[0][1] > best[0][1] ? item : best));
    return { price, _fetchedAt: fetchedAt, [source]: true };
  }

  // Diagnostic logging: show exactly which IDs from the FUT.GG feed match watched cards.
  // Shows a compact on-page alert; no DevTools needed (EA pauses DevTools on debugger statements).
  function logFutggPriceDiagnostics(forceShow = false) {
    try {
      const rows = getWatch().map(entry => {
        const defId = Number(entry.definitionId);
        const resourceId = Number(entry.resourceId || 0);
        const ids = [defId, resourceId];
        try {
          const baseId = defId & 0xFFFFFF;
          const data = baseId && repositories && repositories.Item && repositories.Item.getStaticDataByDefId(baseId);
          if (data) [data.resourceId, data.id, data.baseId].forEach(value => {
            if (Number.isFinite(Number(value)) && Number(value) > 0) ids.push(Number(value));
          });
        } catch (_) {}
        const uniqueIds = [...new Set(ids.filter(id => Number.isFinite(id) && id > 0))];
        const matches = uniqueIds.filter(id => Number(futggPrices[String(id)]) > 0)
          .map(id => ({ id, price: Number(futggPrices[String(id)]) }));
        const selected = geniePrice(entry.definitionId, entry.resourceId);
        let selectedSource = L("geen prijs gevonden", "no price found");
        if (selected && selected._futgg) selectedSource = `FUT.GG (ID ${selected._futggId})`;
        else if (selected && selected._fetchedAt && selected._remote) selectedSource = "remote/cache";
        else if (selected && selected._market) selectedSource = "markt-cache";
        else if (selected && selected._transferred) selectedSource = L("overgezette prijs", "transferred price");
        else if (selected && selected.price > 0) selectedSource = L("FUT Genie/cache of fallback (niet FUT.GG)", "FUT Genie/cache or fallback (not FUT.GG)");
        return {
          player: entry.name,
          rating: entry.rating || "",
          definitionId: defId,
          resourceId: resourceId || "not stored",
          feedMatches: matches.map(match => `${match.id}=${match.price}`).join("; ") || "NO MATCH",
          selectedPrice: selected ? selected.price : L("geen prijs", "no price"),
          selectedSource
        };
      });
      const relevant = rows.filter(row => /de jong|barcola|mora|smenyo|gy[oö]keres/i.test(row.player));
      const displayRows = relevant.length ? relevant : rows.slice(0, 8);
      const lines = displayRows.map(row => `${row.player} (${row.rating}) | defId=${row.definitionId} | resourceId=${row.resourceId} | feed=${row.feedMatches} | Price Watch=${row.selectedPrice} | bron=${row.selectedSource}`);
      const eaLines = eaLogLines(60);
      lines.push("", L("EA-log (biedingen, mislukte EA-verzoeken, EA-meldingen, herladen; nieuwste onderaan):", "EA log (bids, failed EA requests, EA notices, reloads; newest at the bottom):"), ...(eaLines.length ? eaLines : [L("(nog leeg)", "(empty so far)")]));
      const report = L(`FUT.GG PC-feed diagnose (v2.36.1)\nFeed bijgewerkt: ${futggPricesAt ? new Date(futggPricesAt).toLocaleString() : "nee"}\nLaatste stap: ${futggStage}\nLaatste fout: ${futggLastError || "geen"}\nFeed-aantal prijzen: ${Object.keys(futggPrices).length}\nManifest gecontroleerd: ${futggManifestAt ? new Date(futggManifestAt).toLocaleString() : "nee"}\n\n${lines.join("\n")}`, `FUT.GG PC feed diagnostics (v2.36.1)\nFeed updated: ${futggPricesAt ? new Date(futggPricesAt).toLocaleString() : "no"}\nLast step: ${futggStage}\nLast error: ${futggLastError || "none"}\nFeed price count: ${Object.keys(futggPrices).length}\nManifest checked: ${futggManifestAt ? new Date(futggManifestAt).toLocaleString() : "no"}\n\n${lines.join("\n")}`);
      console.info("FUT.GG DIAGNOSTIC", rows, { futggPricesAt, futggFeedKey, futggStage, futggLastError, priceCount: Object.keys(futggPrices).length });
      if (typeof window !== "undefined") {
        // Keep diagnostics hidden unless explicitly opened with Ctrl+Shift+D.
        // Routine refreshes may update an already-open panel, but must never open it.
        const existingPanel = document.getElementById("pt-futgg-diagnostic-panel");
        if (!forceShow && !existingPanel) return;
        const render = () => {
          if (!document.body) return window.setTimeout(render, 250);
          let panel = document.getElementById("pt-futgg-diagnostic-panel");
          if (!panel) {
            panel = document.createElement("div");
            panel.id = "pt-futgg-diagnostic-panel";
            panel.style.cssText = "position:fixed;right:18px;top:70px;z-index:2147483647;width:min(680px,calc(100vw - 36px));max-height:70vh;overflow:auto;background:#101722;color:#f3f6fb;border:2px solid #63b3ff;border-radius:10px;box-shadow:0 12px 40px #000b;padding:14px;font:13px/1.5 system-ui,sans-serif;white-space:normal";
            const head = document.createElement("div");
            head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;font-weight:700;font-size:15px";
            head.appendChild(document.createTextNode("FUT.GG PC-feed diagnose"));
            const close = document.createElement("button"); close.textContent = "Sluiten";
            close.style.cssText = "background:#334155;color:white;border:0;border-radius:5px;padding:5px 9px;cursor:pointer";
            close.addEventListener("click", () => panel.remove()); head.appendChild(close);
            panel.appendChild(head);
            const body = document.createElement("pre"); body.id = "pt-futgg-diagnostic-report";
            body.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.5 ui-monospace,monospace";
            panel.appendChild(body);
            const copy = document.createElement("button"); copy.textContent = "Diagnose kopiëren";
            copy.style.cssText = "margin-top:10px;background:#2563eb;color:white;border:0;border-radius:5px;padding:7px 10px;cursor:pointer";
            copy.addEventListener("click", () => { const text = body.textContent; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => { copy.textContent = L("Gekopieerd", "Copied"); }).catch(() => window.prompt(L("Kopieer diagnose:", "Copy diagnostics:"), text)); else window.prompt(L("Kopieer diagnose:", "Copy diagnostics:"), text); });
            panel.appendChild(copy); document.body.appendChild(panel);
          }
          const body = panel.querySelector("#pt-futgg-diagnostic-report");
          if (body) body.textContent = report;
        };
        render();
      }
    } catch (error) {
      console.warn("FUT.GG DIAGNOSTIC logging failed:", error);
    }
  }

  // Diagnostics are hidden by default. Press Ctrl+Shift+D to toggle the panel.
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyD")) return;
    event.preventDefault();
    event.stopPropagation();
    const panel = document.getElementById("pt-futgg-diagnostic-panel");
    if (panel) panel.remove();
    else logFutggPriceDiagnostics(true);
  }, true);

  // --- Live via your pc: the pc (with FUT Genie) puts your list + prices in your own secret GitHub gist
  // every 5 minutes, the phone reads it every 2 minutes. With the token on the phone too, list changes made
  // there go into a second file that the pc checks every minute and takes over. The requests (and the
  // GitHub token) live in the Tampermonkey part at the bottom of the file; this page talks to it via
  // "pt-relay-*" events.

  const REMOTE_KEY = "pt_remote_v1"; // prices received from the pc: { definitionId: [price, fetchedAt] }
  // { gistId, hasToken, sentAt, receivedAt, pricesAt, listJson, listSentAt, phoneListAt, phoneCheckedAt, error }
  const RELAY_KEY = "pt_relay_v1";
  const RELAY_DEFAULT_GIST = ""; // your own gist: paste its link under "Live via je pc"
  const RELAY_FILE = "price-watch-prices.json";
  const RELAY_LIST_FILE = "price-watch-phone-list.json";
  const RELAY_SETTINGS_FILE = "price-watch-phone-settings.json"; // settings changed on the phone, for the pc
  const RELAY_PUSH_MS = 5 * 60 * 1000;
  const RELAY_PULL_MS = 2 * 60 * 1000;
  const RELAY_LIST_CHECK_MS = 60 * 1000;
  const RELAY_FRESH_MS = 20 * 60 * 1000;
  let remotePrices = null;
  let relayCache = null;
  let relayBusy = false;
  let relaySeq = 0;
  const relayPending = new Map();

  function getRemotePrices() {
    if (remotePrices) return remotePrices;
    try {
      remotePrices = JSON.parse(localStorage.getItem(REMOTE_KEY) || "{}") || {};
    } catch {
      remotePrices = {};
    }
    return remotePrices;
  }

  function getRelay() {
    if (relayCache) return relayCache;
    try {
      relayCache = JSON.parse(localStorage.getItem(RELAY_KEY) || "null");
    } catch {
      relayCache = null;
    }
    relayCache = Object.assign({ gistId: RELAY_DEFAULT_GIST, hasToken: false, error: "" }, relayCache || {});
    return relayCache;
  }

  function saveRelay(patch) {
    Object.assign(getRelay(), patch);
    try {
      localStorage.setItem(RELAY_KEY, JSON.stringify(getRelay()));
    } catch (_) {
      // Kept in memory for this session.
    }
    listeners.forEach(listener => listener());
  }

  // A gist link or id → the 32-character id.
  function gistIdFrom(text) {
    const match = String(text || "").match(/[0-9a-f]{20,40}/i);
    return match ? match[0] : "";
  }

  // Phone: Tampermonkey's part stored a token from the QR link of the pc (see "tokenQr" at the bottom).
  document.addEventListener("pt-relay-token", event => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    const show = () => {
      if (message.ok) {
        saveRelay({ hasToken: true, gistId: message.gistId || getRelay().gistId, listJson: "", error: "" });
        showToast(L("Price Watch: token van je pc opgeslagen. Wis de link nog uit de geschiedenis van Safari.", "Price Watch: token from your PC saved. Now clear the link from your Safari history."), true);
      } else {
        showToast(L(`Price Watch: token niet opgeslagen – ${message.error}`, `Price Watch: token not saved – ${message.error}`), false);
      }
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show, { once: true });
  });

  document.addEventListener("pt-relay-response", event => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    const pending = relayPending.get(message.id);
    if (!pending) return;
    relayPending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || L("onbekende fout", "unknown error")));
  });

  function relayCall(type, data) {
    return new Promise((resolve, reject) => {
      const id = ++relaySeq;
      relayPending.set(id, { resolve, reject });
      document.dispatchEvent(new CustomEvent("pt-relay-request", { detail: JSON.stringify({ id, type, ...data }) }));
      window.setTimeout(() => {
        if (relayPending.delete(id)) reject(new Error(L("geen antwoord van Tampermonkey", "no response from Tampermonkey")));
      }, 30000);
    });
  }

  // Phone: are the prices from the pc recent enough to count as live?
  function relayFresh() {
    return !pcDevice() && Date.now() - (getRelay().pricesAt || 0) < RELAY_FRESH_MS;
  }

  // The list as it goes into the gist, to see whether it changed since the last sync.
  function listJsonNow() {
    return JSON.stringify(buildTransferData().w);
  }

  // Devices without FUT Genie read prices; on a big screen only once FUT Genie had time to load.
  function relayReader(force) {
    return !pcDevice() && (force || IS_PHONE || Date.now() - startedAt >= 20000);
  }

  // Pc: fresh FUT Genie prices for the list, then into the gist. "l" tells the phone which of its own
  // lists the pc has taken over, so the phone doesn't fall back to the pc's older list in the meantime.
  async function pushRelay(force) {
    const relay = getRelay();
    if (!pcDevice() || relayBusy || !relay.hasToken || !relay.gistId) return;
    if (!force && Date.now() - (relay.sentAt || 0) < RELAY_PUSH_MS) return;
    relayBusy = true;
    try {
      // Cards on your transfer list and in your snipe lists (what you buy is what you list next).
      const extraIds = [...new Set(readJson(TL_IDS_KEY, []).concat(getStock().filter(list => list.type === "players")
        .flatMap(list => list.players.filter(player => !(player.special && player.definitionId <= 0xFFFFFF)).map(player => player.definitionId))))];
      await fetchGeniePrices(getWatch().map(entry => entry.definitionId).concat(extraIds));
      const data = { ...buildTransferData(), l: relay.phoneListAt || 0, s: transferStatusForRelay(), x: extraPrices(extraIds), cr: clubRiseForRelay(), bm: readJson(BOUGHT_KEY, {}), h: flipHistoryForRelay() };
      await relayCall("push", { gistId: relay.gistId, file: RELAY_FILE, content: JSON.stringify(data) });
      saveRelay({ sentAt: Date.now(), error: "" });
    } catch (error) {
      saveRelay({ sentAt: Date.now(), error: error.message }); // retry at the next interval, not right away
    } finally {
      relayBusy = false;
    }
  }

  // Pc: did the phone send a new list? Then it replaces the list here and goes out with prices right away.
  async function checkPhoneList(force) {
    const relay = getRelay();
    if (!pcDevice() || relayBusy || !relay.hasToken || !relay.gistId) return;
    if (!force && Date.now() - (relay.phoneCheckedAt || 0) < RELAY_LIST_CHECK_MS) return;
    relayBusy = true;
    let changed = false;
    try {
      const data = JSON.parse(await relayCall("pull", { gistId: relay.gistId, file: RELAY_LIST_FILE }));
      if (data && Array.isArray(data.w) && data.t > (relay.phoneListAt || 0)) {
        if (JSON.stringify(data.w) !== listJsonNow()) {
          const result = applyTransfer({ t: data.t, w: data.w, p: {} });
          showToast(L(`Price Watch: lijst van je telefoon overgenomen (${result.players} spelers).`, `Price Watch: list imported from your phone (${result.players} players).`), true);
        }
        saveRelay({ phoneListAt: data.t });
        changed = true;
      }
      saveRelay({ phoneCheckedAt: Date.now() });
    } catch (error) {
      saveRelay({ phoneCheckedAt: Date.now(), error: error.message });
    } finally {
      relayBusy = false;
    }
    if (changed) pushRelay(true);
  }

  // Phone with token: a list changed here goes into the gist for the pc.
  async function pushPhoneList(force) {
    const relay = getRelay();
    if (!relayReader(force) || relayBusy || !relay.hasToken || !relay.gistId) return;
    const listJson = listJsonNow();
    // Only once this phone has had the pc's list, so an old list here never overwrites the pc's.
    if (!force && (!relay.listJson || listJson === relay.listJson)) return;
    relayBusy = true;
    listeners.forEach(listener => listener());
    try {
      const data = buildTransferData();
      await relayCall("push", { gistId: relay.gistId, file: RELAY_LIST_FILE, content: JSON.stringify({ t: data.t, w: data.w }) });
      saveRelay({ listJson, listSentAt: data.t, error: "" });
    } catch (error) {
      saveRelay({ error: error.message });
    } finally {
      relayBusy = false;
      listeners.forEach(listener => listener());
    }
  }

  // Phone: read the gist. The list follows the pc when it changed there; prices always.
  async function pullRelay(force) {
    const relay = getRelay();
    if (!relayReader(force) || relayBusy || !relay.gistId) return;
    if (!force && Date.now() - (relay.receivedAt || 0) < RELAY_PULL_MS) return;
    relayBusy = true;
    listeners.forEach(listener => listener());
    try {
      const data = JSON.parse(await relayCall("pull", { gistId: relay.gistId, file: RELAY_FILE }));
      if (!data || !Array.isArray(data.w)) throw new Error(L("nog geen prijzen van je pc in de gist", "no prices from your PC in the gist yet"));
      const pcListJson = JSON.stringify(data.w);
      // Not while a list change from here is still waiting to be sent or to be taken over by the pc.
      const localEdit = relay.hasToken && relay.listJson && listJsonNow() !== relay.listJson;
      const pcHasOurList = (data.l || 0) >= (relay.listSentAt || 0);
      const listPatch = {};
      if (pcListJson !== relay.pcListJson && !localEdit && pcHasOurList) {
        applyTransfer({ t: data.t, w: data.w, p: {} });
        Object.assign(listPatch, { pcListJson, listJson: listJsonNow() });
      }
      const store = getRemotePrices();
      Object.entries({ ...(data.x || {}), ...(data.p || {}) }).forEach(([id, value]) => {
        if (Array.isArray(value) && value[0] > 0) store[id] = value;
      });
      try {
        localStorage.setItem(REMOTE_KEY, JSON.stringify(store));
      } catch (_) {
        // Kept in memory for this session.
      }
      if (data.s && typeof data.s === "object") listPatch.pcTransfer = data.s;
      if (data.cr && typeof data.cr === "object") listPatch.pcClubRise = data.cr;
      if (data.bm && typeof data.bm === "object") writeJson(BOUGHT_KEY, { ...data.bm, ...readJson(BOUGHT_KEY, {}) });
      if (data.h && typeof data.h === "object") syncFlipHistory(data.h); // flip price history of the pc
      saveRelay({ receivedAt: Date.now(), pricesAt: data.t, ...listPatch, error: "" });
    } catch (error) {
      saveRelay({ receivedAt: Date.now(), error: error.message });
    } finally {
      relayBusy = false;
      listeners.forEach(listener => listener());
    }
  }

  let relayStarted = false;
  function startRelay() {
    if (relayStarted) return;
    relayStarted = true;
    relayCall("status", {}).then(status => saveRelay({ hasToken: !!status.hasToken })).catch(() => {})
      .then(() => checkPhoneList(true))
      .then(() => { pushRelay(false); return pullRelay(true); })
      .then(() => pushPhoneList(false));
    window.setInterval(async () => {
      await checkPhoneList(false);
      await checkPhoneSettings();
      await pushRelay(false);
      await pullRelay(false);
      await pushPhoneList(false);
      flipHistoryTick();
    }, 30 * 1000);
  }

  // --- Lowest market price: explicit user action only, with conservative request limits ---
  // This uses EA's live transfer-market search endpoint. It is never run on page load, on a timer,
  // or as part of the background FUT.GG feed. EA publishes no fixed safe request limit; these are
  // intentionally strict local guardrails, not a guarantee against market restrictions.

  const MARKET_KEY = "pt_market_v1";
  const MARKET_SCAN_LOG_KEY = "pt_market_scan_log_v1";
  const MARKET_SCAN_BACKOFF_KEY = "pt_market_scan_backoff_v1";
  const MARKET_SCAN_BACKOFF_INFO_KEY = "pt_market_scan_backoff_info_v1";
  const MARKET_MAX_SEARCHES = 3;                 // Up to three EA requests per tap (Paletools can do more).
  const MARKET_PAUSE_MS = [12000, 18000];         // Random 12–18s between requests.
  const MARKET_SCAN_MAX_10M = 3;                  // At most three scripted EA requests per 10 minutes.
  const MARKET_SCAN_MAX_HOUR = 6;                // At most two full scans per hour.
  const MARKET_CARD_COOLDOWN_MS = 15 * 60 * 1000; // Same card: wait 15 minutes before scanning again.
  const MARKET_TOTAL_GUARD_10M = 8;               // Includes normal EA searches on this device.
  const MARKET_TOTAL_GUARD_HOUR = 30;             // Includes normal EA searches on this device.
  const MARKET_ERROR_BACKOFF_MS = 30 * 60 * 1000; // Any EA/search error pauses further scripted scans for 30m.
  let marketPrices = null;
  let marketBusy = false;
  let marketBusySince = 0;
  // A device-activity guard can be overruled once with a second click on the same card.
  // The arm exists only in memory and expires quickly; other safety limits remain in force.
  const MARKET_OVERRIDE_ARM_MS = 30 * 1000;
  const pendingMarketOverrides = new Map();
  // Last lowest-price search per card: the cheapest prices with how many listings at each.
  const lastLowest = {};

  function getMarketScanLog() {
    const now = Date.now();
    const entries = readJson(MARKET_SCAN_LOG_KEY, []);
    const valid = Array.isArray(entries) ? entries.filter(entry => entry && Number(entry.at) > now - 24 * 60 * 60 * 1000 && entry.id != null) : [];
    if (!Array.isArray(entries) || valid.length !== entries.length) writeJson(MARKET_SCAN_LOG_KEY, valid);
    return valid;
  }

  function waitLabel(until) {
    const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    if (minutes < 60) return L(`ongeveer ${minutes} min.`, `about ${minutes} min.`);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? L(`ongeveer ${hours} uur en ${rest} min.`, `about ${hours} h ${rest} min.`) : L(`ongeveer ${hours} uur`, `about ${hours} h`);
  }

  // When the rolling window is full, calculate when enough old entries expire for one slot to open.
  function nextSearchSlot(entries, limit, windowMs) {
    const sorted = entries.map(entry => Number(entry.at || entry)).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length < limit) return Date.now();
    return sorted[sorted.length - limit] + windowMs;
  }

  function marketScanBlockReason(definitionId, continuingScan = false, overrideDeviceGuard = false) {
    const now = Date.now();
    const backoffUntil = Number(readJson(MARKET_SCAN_BACKOFF_KEY, 0)) || 0;
    if (backoffUntil > now) {
      const minutes = Math.ceil((backoffUntil - now) / 60000);
      const info = readJson(MARKET_SCAN_BACKOFF_INFO_KEY, {}) || {};
      if (info.kind === "rateLimit") {
        const status = info.status ? ` (HTTP ${info.status})` : "";
        return L(`EA gaf een rate-limit-/Too Many Actions-signaal${status}. BIN-scans zijn uit voorzorg gepauzeerd; probeer over ongeveer ${minutes} min. opnieuw. Dit is een echte EA-reactie. De override kan deze pauze niet passeren.`, `EA returned a rate-limit/Too Many Actions signal${status}. BIN scans are paused as a precaution; try again in about ${minutes} min. This is a real EA response. The override cannot bypass this pause.`);
      }
      if (info.kind === "timeout") {
        return L(`EA heeft niet op tijd geantwoord. Price Watch pauzeert BIN-scans uit voorzorg nog ${minutes} min. Dit bewijst op zichzelf niet dat EA je heeft geblokkeerd.`, `EA did not respond in time. Price Watch is pausing BIN scans as a precaution for another ${minutes} min. This alone does not prove EA has blocked you.`);
      }
      return L(`EA gaf geen bruikbaar antwoord. Price Watch pauzeert BIN-scans uit voorzorg nog ${minutes} min. Dit is niet automatisch een softban.`, `EA returned no usable response. Price Watch is pausing BIN scans as a precaution for another ${minutes} min. This is not automatically a softban.`);
    }

    const entries = getMarketScanLog();
    const recent = entries.filter(entry => Number(entry.at) > now - 10 * 60 * 1000);
    const hourly = entries.filter(entry => Number(entry.at) > now - 60 * 60 * 1000);
    const lastCard = entries.filter(entry => String(entry.id) === String(definitionId))
      .reduce((latest, entry) => Math.max(latest, Number(entry.at) || 0), 0);

    if (!continuingScan && lastCard && now - lastCard < MARKET_CARD_COOLDOWN_MS) {
      const until = lastCard + MARKET_CARD_COOLDOWN_MS;
      return L(`Deze kaart is al door Price Watch gecontroleerd. Je kunt haar over ${waitLabel(until)} opnieuw scannen (15 min. kaartcooldown).`, `This card was already checked by Price Watch. You can scan it again in ${waitLabel(until)} (15 min card cooldown).`);
    }
    if (recent.length >= MARKET_SCAN_MAX_10M) {
      const until = nextSearchSlot(recent, MARKET_SCAN_MAX_10M, 10 * 60 * 1000);
      return L(`Price Watch-rem: ${recent.length}/${MARKET_SCAN_MAX_10M} eigen BIN-zoekacties gestart in 10 min. Een volgende scan kan over ${waitLabel(until)}. Dit is een lokale limiet, geen blokkademelding van EA.`, `Price Watch brake: ${recent.length}/${MARKET_SCAN_MAX_10M} own BIN searches started in 10 min. The next scan is possible in ${waitLabel(until)}. This is a local limit, not a block notice from EA.`);
    }
    if (hourly.length >= MARKET_SCAN_MAX_HOUR) {
      const until = nextSearchSlot(hourly, MARKET_SCAN_MAX_HOUR, 60 * 60 * 1000);
      return L(`Price Watch-rem: ${hourly.length}/${MARKET_SCAN_MAX_HOUR} eigen BIN-zoekacties gestart in 1 uur. Een volgende scan kan over ${waitLabel(until)}. Dit is een lokale limiet, geen blokkademelding van EA.`, `Price Watch brake: ${hourly.length}/${MARKET_SCAN_MAX_HOUR} own BIN searches started in 1 hour. The next scan is possible in ${waitLabel(until)}. This is a local limit, not a block notice from EA.`);
    }

    const total = searchCounts();
    const allSearches = getSearchLog();
    const totalRecent = allSearches.filter(at => Number(at) > now - 10 * 60 * 1000);
    const totalHourly = allSearches.filter(at => Number(at) > now - 60 * 60 * 1000);
    // Only the two device-wide local activity guards can be overruled. Script limits,
    // same-card cooldown and any EA-error backoff are never bypassed.
    if (!overrideDeviceGuard && total.tenMinutes >= MARKET_TOTAL_GUARD_10M) {
      const until = nextSearchSlot(totalRecent, MARKET_TOTAL_GUARD_10M, 10 * 60 * 1000);
      return L(`Lokale druktebeveiliging: ${total.tenMinutes}/${MARKET_TOTAL_GUARD_10M} transfermarktzoekacties gestart in 10 min. BIN-scan uitgesteld tot er ruimte is (over ${waitLabel(until)}). Dit is geen melding dat EA je heeft geblokkeerd.`, `Local load protection: ${total.tenMinutes}/${MARKET_TOTAL_GUARD_10M} transfer market searches started in 10 min. BIN scan postponed until there is room (in ${waitLabel(until)}). This is not a notice that EA has blocked you.`);
    }
    if (!overrideDeviceGuard && total.hour >= MARKET_TOTAL_GUARD_HOUR) {
      const until = nextSearchSlot(totalHourly, MARKET_TOTAL_GUARD_HOUR, 60 * 60 * 1000);
      return L(`Lokale druktebeveiliging: ${total.hour}/${MARKET_TOTAL_GUARD_HOUR} transfermarktzoekacties gestart in 1 uur. BIN-scan uitgesteld tot er ruimte is (over ${waitLabel(until)}). Dit is geen melding dat EA je heeft geblokkeerd.`, `Local load protection: ${total.hour}/${MARKET_TOTAL_GUARD_HOUR} transfer market searches started in 1 hour. BIN scan postponed until there is room (in ${waitLabel(until)}). This is not a notice that EA has blocked you.`);
    }
    return "";
  }

  function isDeviceSearchGuard(reason) {
    return typeof reason === "string" && reason.startsWith("Lokale druktebeveiliging:");
  }

  function armOrConfirmMarketOverride(definitionId, reason) {
    const key = String(definitionId);
    const now = Date.now();
    const armedAt = pendingMarketOverrides.get(key) || 0;
    if (!armedAt || now - armedAt > MARKET_OVERRIDE_ARM_MS) {
      pendingMarketOverrides.set(key, now);
      throw new Error(L(`${reason} Klik binnen 30 seconden nogmaals op 'Laagste prijs' om één extra, beperkte scan bewust toe te staan.`, `${reason} Click 'Lowest price' again within 30 seconds to deliberately allow one extra, limited scan.`));
    }

    pendingMarketOverrides.delete(key);
    let accepted = false;
    try {
      accepted = window.confirm(
        L("Price Watch heeft een lokale druktebeveiliging geactiveerd omdat er kort geleden veel transfermarktzoekacties op dit apparaat zijn gestart. Dit is geen melding dat EA je account heeft geblokkeerd.\n\n", "Price Watch has activated local load protection because many transfer market searches were started on this device a short while ago. This is not a notice that EA has blocked your account.\n\n") +
        L("Wil je bewust één beperkte BIN-scan toestaan?\n\n", "Do you want to deliberately allow one limited BIN scan?\n\n") +
        L(`• Maximaal ${MARKET_MAX_SEARCHES} EA-zoekopdrachten voor deze scan\n`, `• Maximum ${MARKET_MAX_SEARCHES} EA searches for this scan\n`) +
        L("• 12–18 seconden pauze tussen zoekopdrachten\n", "• 12–18 seconds pause between searches\n") +
        L("• Eigen scannerlimieten, kaartcooldown en pauze na een EA-fout blijven actief\n\n", "• Own scanner limits, card cooldown and pause after an EA error stay active\n\n") +
        L("Ook met deze beperking kan EA marktactiviteit afremmen. Er bestaat geen door EA bevestigde veilige grens. Doorgaan?", "Even with this limit, EA may throttle market activity. There is no EA-confirmed safe threshold. Continue?")
      );
    } catch (_) {
      accepted = false;
    }
    if (!accepted) throw new Error(L("Eenmalige override geannuleerd; er zijn geen extra zoekopdrachten gestart.", "One-time override cancelled; no extra searches were started."));
    return true;
  }

  function recordMarketScanRequest(definitionId) {
    const entries = getMarketScanLog();
    entries.push({ at: Date.now(), id: String(definitionId) });
    writeJson(MARKET_SCAN_LOG_KEY, entries);
  }

  function setMarketScanBackoff(error) {
    const kind = error && error.marketSignal === "rateLimit" ? "rateLimit"
      : error && error.marketSignal === "timeout" ? "timeout" : "eaError";
    writeJson(MARKET_SCAN_BACKOFF_KEY, Date.now() + MARKET_ERROR_BACKOFF_MS);
    writeJson(MARKET_SCAN_BACKOFF_INFO_KEY, {
      kind,
      status: error && Number(error.status) ? Number(error.status) : null,
      at: Date.now()
    });
  }

  // "900 ×1 · 950 ×3 · 1.000 ×4+" ("+" = seen on a full page: there may be more at that price).
  function formatLowestCounts(definitionId) {
    const result = lastLowest[definitionId];
    if (!result || !result.counts.length) return "";
    return result.counts.map(({ price, count, exact }) => `${priceFormat.format(price)} ×${count}${exact ? "" : "+"}`).join(" · ") +
      (result.certain ? "" : L(" (nog niet zeker de laagste)", " (not yet sure it is the lowest)"));
  }

  function getMarketPrices() {
    if (marketPrices) return marketPrices;
    try {
      marketPrices = JSON.parse(localStorage.getItem(MARKET_KEY) || "{}") || {};
    } catch {
      marketPrices = {};
    }
    return marketPrices;
  }

  // EA's price ladder: the next allowed price below `price`.
  function priceStepBelow(price) {
    const step = price <= 1000 ? 50 : price <= 10000 ? 100 : price <= 50000 ? 250 : price <= 100000 ? 500 : 1000;
    return price - step;
  }

  function searchMarketOnce(definitionId, maxBuy) {
    return new Promise((resolve, reject) => {
      const criteria = new UTSearchCriteriaDTO();
      criteria.type = SearchType.PLAYER;
      criteria.defId = [definitionId];
      criteria.count = 21;
      criteria.offset = 0;
      if (maxBuy) criteria.maxBuy = maxBuy;
      try {
        services.Item.clearTransferMarketCache();
      } catch (_) {
        // Older builds cache less.
      }
      const observable = services.Item.searchTransferMarket(criteria, 1);
      if (!observable || typeof observable.observe !== "function") throw new Error(L("EA-zoekfunctie niet beschikbaar", "EA search function not available"));
      const context = {};
      const timeout = window.setTimeout(() => {
        try {
          observable.unobserve(context);
        } catch (_) {
          // Already done.
        }
        const error = new Error(L("EA reageerde niet binnen 15 seconden (time-out).", "EA did not respond within 15 seconds (timeout)."));
        error.marketSignal = "timeout";
        reject(error);
      }, 15000);
      observable.observe(context, (sender, response) => {
        window.clearTimeout(timeout);
        sender.unobserve(context);
        if (!response || !response.success) {
          const status = Number(response && (response.status || response.statusCode)) || 0;
          const detail = [
            response && response.message,
            response && response.error,
            response && response.errorMessage,
            response && response.reason,
            response && response.responseText
          ].filter(value => typeof value === "string").join(" ");
          const rateLimited = status === 429 || /too\s+many\s+actions|rate.?limit|soft.?ban|temporarily\s+blocked/i.test(detail);
          const error = new Error(rateLimited
            ? L(`EA gaf een rate-limit-/Too Many Actions-signaal${status ? ` (HTTP ${status})` : ""}. Stop met scannen en probeer later opnieuw.`, `EA returned a rate-limit/Too Many Actions signal${status ? ` (HTTP ${status})` : ""}. Stop scanning and try again later.`)
            : L(`EA gaf geen succesvolle reactie${status ? ` (HTTP ${status})` : ""}. Price Watch neemt uit voorzorg pauze.`, `EA returned no successful response${status ? ` (HTTP ${status})` : ""}. Price Watch is pausing as a precaution.`));
          error.marketSignal = rateLimited ? "rateLimit" : "eaError";
          error.status = status || null;
          reject(error);
          return;
        }
        const items = (response.data && response.data.items) || [];
        const listings = items.map(item => {
          const auction = typeof item.getAuctionData === "function" ? item.getAuctionData() : item._auction;
          return { id: (auction && auction.tradeId) || item.id, price: auction && auction.buyNowPrice };
        }).filter(listing => listing.price > 0);
        resolve({ listings, full: items.length >= criteria.count });
      });
    });
  }

  // EA may raise its loading click shield for a market request; our search has no EA screen to lower
  // it again, which leaves the whole app untappable until a refresh. Lower it ourselves.
  function lowerClickShield() {
    try {
      if (typeof gClickShield === "undefined" || !gClickShield || typeof gClickShield.hideShield !== "function") return;
      const shields = typeof EAClickShieldView !== "undefined" && EAClickShieldView.Shield ? Object.values(EAClickShieldView.Shield) : [];
      shields.forEach(shield => {
        try {
          gClickShield.hideShield(shield);
        } catch (_) {
          // Not shown.
        }
      });
    } catch (_) {
      // No shield in this build.
    }
  }

  async function findLowestPrice(definitionId, onProgress) {
    if (marketBusy) throw new Error(L("Er loopt al een zoekopdracht", "A search is already running"));
    if (!definitionId) throw new Error(L("Speler-ID ontbreekt", "Player ID missing"));
    const initialBlock = marketScanBlockReason(definitionId);
    let overrideDeviceGuard = false;
    if (initialBlock) {
      if (isDeviceSearchGuard(initialBlock)) {
        overrideDeviceGuard = armOrConfirmMarketOverride(definitionId, initialBlock);
      } else {
        pendingMarketOverrides.delete(String(definitionId));
        throw new Error(initialBlock);
      }
    } else {
      pendingMarketOverrides.delete(String(definitionId));
    }
    marketBusy = true;
    marketBusySince = Date.now();
    let requestError = false;
    try {
      let lowest = null;
      let certain = false;
      // Deduplicate listings by trade id. EA's result order is not guaranteed to be price order.
      const seen = new Map();
      let exactUpTo = 0;
      let maxBuy = null;
      for (let search = 1; search <= MARKET_MAX_SEARCHES; search++) {
        if (search > 1) {
          const [min, max] = MARKET_PAUSE_MS;
          await new Promise(resolve => window.setTimeout(resolve, min + Math.random() * (max - min)));
        }
        if (maxBuy !== null && maxBuy < 150) {
          certain = true;
          break;
        }
        // Check every request, not only once per run: manual EA searches also count toward the guard.
        const block = marketScanBlockReason(definitionId, search > 1, overrideDeviceGuard);
        if (block) {
          if (search === 1) throw new Error(block);
          certain = false;
          break;
        }
        recordMarketScanRequest(definitionId);
        if (onProgress) onProgress(search, lowest, MARKET_MAX_SEARCHES);
        let result;
        try {
          result = await searchMarketOnce(definitionId, maxBuy);
        } catch (error) {
          requestError = true;
          throw error; // Do not retry an EA error; the outer catch applies a long backoff.
        }
        result.listings.forEach(listing => seen.set(listing.id, listing.price));
        const cheapest = result.listings.length ? Math.min(...result.listings.map(listing => listing.price)) : null;
        if (!result.full) {
          // A non-full result page contains all listings matching this query.
          exactUpTo = Math.max(exactUpTo, maxBuy === null ? Infinity : maxBuy);
          if (cheapest !== null) lowest = cheapest;
          certain = true;
          break;
        }
        lowest = cheapest;
        if (cheapest === null) break;
        // Include the current price once; only step below when EA returned a full page at the same ceiling.
        maxBuy = maxBuy !== null && cheapest >= maxBuy ? priceStepBelow(cheapest) : cheapest;
      }
      const counts = new Map();
      seen.forEach(price => counts.set(price, (counts.get(price) || 0) + 1));
      lastLowest[definitionId] = {
        lowest,
        certain,
        at: Date.now(),
        counts: [...counts.entries()].sort((a, b) => a[0] - b[0]).slice(0, 5)
          .map(([price, count]) => ({ price, count, exact: price <= exactUpTo }))
      };
      if (lowest) {
        getMarketPrices()[definitionId] = [lowest, Date.now()];
        try {
          localStorage.setItem(MARKET_KEY, JSON.stringify(getMarketPrices()));
        } catch (_) {
          // Kept in memory for this session.
        }
      }
      return lowest;
    } catch (error) {
      if (requestError) setMarketScanBackoff(error);
      throw error;
    } finally {
      marketBusy = false;
      lowerClickShield();
      window.setTimeout(lowerClickShield, 500);
    }
  }

  // Oldest price time among the transferred prices of these cards (null if none).
  function transferredAt(ids) {
    const prices = getTransferredPrices();
    const times = ids.map(id => prices[id] && prices[id][1]).filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }

  // Asks FUT Genie for prices; resolves once all are fresh in its cache (or after a timeout).
  function fetchGeniePrices(ids) {
    const g = genie();
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return Promise.resolve(false);
    if (!g) return Promise.resolve(refreshFutggPrices(false)).then(() => Object.keys(futggPrices).length > 0).catch(() => false);

    const startedAt = Date.now();
    try {
      g.fetchBulkPrices(unique);
    } catch (error) {
      console.warn(L("Price Watch: FUT Genie-prijzen ophalen mislukt.", "Price Watch: fetching FUT Genie prices failed."), error);
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const poll = window.setInterval(() => {
        const done = unique.every(id => {
          const entry = g._cachedPrices && g._cachedPrices[id];
          return entry && Number(entry._fetchedAt) >= startedAt;
        });
        if (!done && Date.now() - startedAt < GENIE_TIMEOUT_MS) return;
        window.clearInterval(poll);
        resolve(done);
      }, 300);
    });
  }

  function refreshGeniePrices(force) {
    if (!pcDevice()) {
      // Phone: the refresh button sends a changed list (with token) and reads the prices your pc put in the gist.
      if (force) pushPhoneList(false).then(() => pullRelay(true));
      return;
    }
    if (!genie()) {
      // Pc without FUT Genie: the FUT.GG feed has every card; just make sure it is current.
      refreshFutggPrices(!!force);
      return;
    }
    if (genieLoading) {
      // E.g. a player was added mid-request: fetch again once this one finishes.
      if (force) genieRefetch = true;
      return;
    }
    if (!force && Date.now() - genieRequestedAt < GENIE_REFRESH_MS) return;

    const ids = getWatch().map(entry => entry.definitionId)
      .concat(getStock().filter(list => list.type === "players").flatMap(list => list.players.flatMap(player => player.normalId ? [player.definitionId, player.normalId] : [player.definitionId])));
    if (!ids.length) return;

    genieRequestedAt = Date.now();
    genieLoading = true;
    listeners.forEach(listener => listener());
    fetchGeniePrices(ids).then(() => {
      genieLoading = false;
      listeners.forEach(listener => listener());
      if (genieRefetch) {
        genieRefetch = false;
        refreshGeniePrices(true);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Transfer market: prepares the filters only, never runs a search
  // ---------------------------------------------------------------------------

  const SEARCH_TITLE = L("Transfermarkt voorbereiden: speler + rarity + max BIN = instapdoel (Shift+klik: zonder max BIN). Zoeken doe je zelf.", "Preparing transfer market: player + rarity + max BIN = entry target (Shift+click: without max BIN). You do the search yourself.");

  // Opens the market *filters* screen with the given criteria. The user presses Search.
  function openFilters(criteria, playerData) {
    const root = getAppMain().getRootViewController();
    root.setGameViewTab(UTGameTabBarController.TabTag.TRANSFERS);
    // Desktop: presented view controller is the tab bar. Phone layout differs, so also ask the tab bar itself.
    const isNav = node => node && typeof node.pushViewController === "function";
    const current = tabs => tabs && (typeof tabs.getCurrentViewController === "function" ? tabs.getCurrentViewController() : tabs.currentController);
    const presented = typeof root.getPresentedViewController === "function" ? root.getPresentedViewController() : null;
    const tabBar = findTabBarController();
    const transfersTab = tabBar && tabBar.childViewControllers.find(child => child.tabBarItem && child.tabBarItem.getTag &&
      child.tabBarItem.getTag() === UTGameTabBarController.TabTag.TRANSFERS);
    const nav = [presented instanceof UTTabBarController ? current(presented) : presented, transfersTab, current(tabBar)].find(isNav);
    if (!nav) throw new Error(L("Transfers-navigatie niet gevonden", "Transfers navigation not found"));

    // Back to the Transfers hub first, so repeated use doesn't grow the navigation stack.
    const stack = nav.childViewControllers || [];
    if (stack.length > 1) nav.popToViewController(stack[0], false);

    const controller = new UTMarketSearchFiltersViewController();
    controller.initWithSearchCriteria(criteria);
    // Holo flag on the screen's own criteria too (FUT Genie ticks its checkbox from there); off otherwise.
    try {
      const own = controller.viewmodel && controller.viewmodel.searchCriteria;
      if (own && own !== criteria) {
        if (criteria.__futgenieHoloOnly) own.__futgenieHoloOnly = true;
        else delete own.__futgenieHoloOnly;
        own.minBid = criteria.minBid || 0;
      }
    } catch (_) {
      // Holo stays on our criteria only.
    }
    if (playerData) controller.viewmodel.setPlayerData(playerData);
    nav.pushViewController(controller);
    if (criteria.minBid) window.setTimeout(() => showMinBid(criteria.minBid), 150);
  }

  // The filter screen doesn't always show a prepared min bid: fill its first price field.
  function showMinBid(value) {
    const inputs = filterPriceInputs();
    if (inputs.length !== 4 || parsePrice(inputs[0].value) === value) return;
    inputs[0].value = String(value);
    ["input", "change", "blur"].forEach(type => inputs[0].dispatchEvent(new Event(type, { bubbles: true })));
  }

  function baseCriteria() {
    const criteria = new UTSearchCriteriaDTO();
    criteria.type = SearchType.PLAYER;
    criteria.category = SearchCategory.ANY;
    return criteria;
  }

  function openPreparedSearch(entry, maxBuy) {
    const baseId = entry.definitionId & 0xFFFFFF;
    const criteria = baseCriteria();
    criteria.maskedDefId = baseId;
    if (entry.rarity != null) criteria.rarities = [entry.rarity];
    if (maxBuy) criteria.maxBuy = maxBuy;
    openFilters(criteria, repositories.Item.getStaticDataByDefId(baseId));
  }

  // ---------------------------------------------------------------------------
  // Distance
  // ---------------------------------------------------------------------------

  // The distance as a small bar + text (layout C): full green = at or under target, amber = near, grey = far.
  function distanceBar(node, state) {
    node.textContent = "";
    node.className = `${state.className} pt-dist`;
    node.title = state.title;
    const track = el("span", "pt-dist-track");
    const fill = el("i");
    const pct = state.percent;
    fill.style.width = `${pct == null ? 0 : pct <= 0 ? 100 : Math.max(8, Math.round(100 - pct * 4))}%`;
    track.appendChild(fill);
    node.append(track, el("b", "pt-dist-text", pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`));
    node.title = `${state.title}${pct == null ? "" : ` · ${state.text}`}`;
  }

  function distanceState(target, current) {
    if (target === null || current === null) {
      return { percent: null, text: "—", className: "pt-distance", title: target === null ? L("Vul een PC-instapdoel in om de afstand te berekenen", "Enter a PC entry target to calculate the distance") : L("Nog geen FUT Genie-prijs", "No FUT Genie price yet") };
    }

    const delta = current - target;
    const percent = (delta / target) * 100;
    const sign = delta > 0 ? "+" : "";
    const text = `${sign}${priceFormat.format(delta)} (${sign}${percent.toFixed(1)}%)`;

    if (delta <= 0) {
      return { percent, text, className: "pt-distance pt-hit", title: L("Instapdoel bereikt: huidige prijs is op of onder je doelprijs", "Entry target reached: current price is at or below your target price") };
    }
    if (percent <= NEAR_PERCENT) {
      return { percent, text, className: "pt-distance pt-near", title: L(`Bijna op je instapdoel: maximaal ${NEAR_PERCENT}% erboven`, `Almost at your entry target: at most ${NEAR_PERCENT}% above`) };
    }
    return { percent, text, className: "pt-distance pt-far", title: L(`Huidige prijs ligt meer dan ${NEAR_PERCENT}% boven je instapdoel`, `Current price is more than ${NEAR_PERCENT}% above your entry target`) };
  }

  // ---------------------------------------------------------------------------
  // Transfer to the phone: watch list + current FUT Genie prices as one code / QR code
  // ---------------------------------------------------------------------------
  // Code: "PW1." + "z" (deflate-raw) or "j" (plain) + base64url(JSON
  //   { t, w: [[definitionId, name, rating, rarity, target, addedAt]], p: { definitionId: [price, fetchedAt] } })

  const WATCH_BACKUP_KEY = "pt_watch_backup_v1";

  function toBase64Url(bytes) {
    let binary = "";
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(text) {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function pipeBytes(bytes, stream) {
    const piped = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(piped).arrayBuffer());
  }

  async function encodeTransfer(data) {
    const json = new TextEncoder().encode(JSON.stringify(data));
    if (typeof CompressionStream === "function") {
      try {
        return "PW1.z" + toBase64Url(await pipeBytes(json, new CompressionStream("deflate-raw")));
      } catch (_) {
        // Plain code below.
      }
    }
    return "PW1.j" + toBase64Url(json);
  }

  async function decodeTransfer(code) {
    const match = String(code || "").replace(/\s+/g, "").match(/PW1\.([zj])([\w-]+)/);
    if (!match) throw new Error(L("Geen geldige overzetcode (die begint met PW1.)", "Not a valid transfer code (it starts with PW1.)"));
    let bytes = fromBase64Url(match[2]);
    if (match[1] === "z") {
      if (typeof DecompressionStream !== "function") throw new Error(L("Deze browser kan de code niet uitpakken (update iOS)", "This browser cannot unpack the code (update iOS)"));
      bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || !Array.isArray(data.w)) throw new Error(L("De code bevat geen Price Watch-lijst", "The code contains no Price Watch list"));
    return data;
  }

  function buildTransferData() {
    const now = Date.now();
    const watch = getWatch();
    const prices = {};
    watch.forEach(entry => {
      const price = geniePrice(entry.definitionId, entry.resourceId);
      if (price) prices[entry.definitionId] = [price.price, Number(price._fetchedAt) || now];
    });
    return {
      t: now,
      w: watch.map(entry => [entry.definitionId, entry.name, entry.rating || 0, entry.rarity ?? null, entry.target || 0, entry.addedAt || 0]),
      p: prices
    };
  }

  // The transferred list replaces the list on this device (old list kept as a backup); prices: newest wins.
  function applyTransfer(data) {
    try {
      localStorage.setItem(WATCH_BACKUP_KEY, JSON.stringify(getWatch()));
    } catch (_) {
      // Backup is best effort.
    }
    const list = getWatch();
    const previous = new Map(list.map(entry => [entry.definitionId, entry]));
    list.length = 0;
    data.w.forEach(([definitionId, name, rating, rarity, target, addedAt]) => {
      if (!definitionId || list.some(entry => entry.definitionId === definitionId)) return;
      list.push({ ...(previous.get(definitionId) || {}), definitionId, name, rating, rarity, target: target || null, addedAt: addedAt || Date.now() });
    });

    const prices = getTransferredPrices();
    Object.entries(data.p || {}).forEach(([id, value]) => {
      if (Array.isArray(value) && value[0] > 0 && !(prices[id] && prices[id][1] > value[1])) prices[id] = value;
    });
    try {
      localStorage.setItem(PRICES_KEY, JSON.stringify(prices));
    } catch (_) {
      // Prices stay in memory for this session.
    }
    saveWatch();
    return { players: list.length, priced: Object.keys(data.p || {}).length, at: data.t };
  }

  function transferSummary(result) {
    return L(`${result.players} speler(s) overgezet, ${result.priced} met prijs (van ${formatDayTime(result.at)}).`, `${result.players} player(s) transferred, ${result.priced} with price (from ${formatDayTime(result.at)}).`);
  }

  // The QR library is only needed on the pc, when the transfer panel opens.
  let qrLibrary = null;
  function loadQrLibrary() {
    if (typeof window.qrcode === "function") return Promise.resolve(true);
    qrLibrary = qrLibrary || new Promise(resolve => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
      script.onload = () => resolve(typeof window.qrcode === "function");
      script.onerror = () => { qrLibrary = null; resolve(false); };
      document.head.appendChild(script);
    });
    return qrLibrary;
  }

  // 📲 Push via ntfy: your topic lives in Tampermonkey on this pc; the ntfy app on the phone subscribes to it.
  function buildPushPanel() {
    const panel = el("div", "pt-transfer");
    const part = el("div", "pt-transfer-part");
    part.appendChild(el("div", "pt-transfer-title", L("Pushmelding op je telefoon (ntfy)", "Push notification on your phone (ntfy)")));
    const info = el("div", "pt-muted");
    const topic = el("input", "pt-transfer-input");
    topic.type = "text";
    topic.autocomplete = "off";
    topic.placeholder = L("jouw topic, bijv. pw-k8f3x9q2m7", "your topic, e.g. pw-k8f3x9q2m7");
    const save = el("button", "pt-watch-refresh", L("Opslaan", "Save"));
    const test = el("button", "pt-watch-refresh", "Test sturen");
    const off = el("button", "pt-link-btn", "Uitzetten");
    const result = el("span", "pt-muted");
    [save, test, off].forEach(button => { button.type = "button"; });
    part.append(info, topic, save, test, off, result);
    panel.appendChild(part);

    let current = "";
    const render = () => {
      test.style.display = current ? "" : "none";
      off.style.display = current ? "" : "none";
      info.textContent = (current
        ? L(`Aan: zakt een speler na een prijsupdate tot zijn doel, dan stuurt deze pc een melding naar topic "${current}".`, `On: if a player drops to his target after a price update, this PC sends a notification to topic "${current}".`)
        : L("Uit. Kies een lange, willekeurige topic-naam (iedereen die hem kent kan meelezen) en klik op Opslaan.", "Off. Choose a long, random topic name (anyone who knows it can read along) and click Save.")) +
        L(" Op je iPhone: installeer de app ntfy, tik op + en abonneer je op precies dezelfde topic.", " On your iPhone: install the ntfy app, tap + and subscribe to exactly the same topic.") +
        (pcDevice() ? "" : L(" Let op: alleen je pc (computer) verstuurt meldingen.", " Note: only your PC (computer) sends notifications."));
    };
    const randomTopic = () => `pw-${Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => "abcdefghijkmnpqrstuvwxyz23456789"[byte % 32]).join("")}`;
    const call = (type, data, done) => {
      result.textContent = "…";
      relayCall(type, data).then(value => { result.textContent = done(value) || ""; render(); }, error => { result.textContent = L(`Mislukt: ${error.message}`, `Failed: ${error.message}`); });
    };
    save.addEventListener("click", () => call("setNtfy", { topic: topic.value.trim() }, value => { current = value.topic; return current ? "Opgeslagen." : "Uitgezet."; }));
    off.addEventListener("click", () => call("setNtfy", { topic: "" }, () => { current = ""; topic.value = randomTopic(); return "Uitgezet."; }));
    test.addEventListener("click", () => call("notify", { title: "Price Watch test", text: L("Zo ziet een melding eruit als een speler op doel zit.", "This is what a notification looks like when a player is at target.") },
      sent => (sent ? L("Verstuurd – komt hij binnen op je telefoon?", "Sent – did it arrive on your phone?") : L("Geen topic ingesteld.", "No topic set."))));
    panel.__ptOpen = () => {
      relayCall("ntfyStatus", {}).then(status => {
        current = status.topic || "";
        topic.value = current || randomTopic();
        render();
      }, error => { info.textContent = L(`Tampermonkey antwoordt niet: ${error.message}`, `Tampermonkey is not responding: ${error.message}`); });
    };
    return panel;
  }

  function buildTransferPanel() {
    const panel = el("div", "pt-transfer");

    const send = el("div", "pt-transfer-part");
    send.appendChild(el("div", "pt-transfer-title", L("Naar je telefoon", "To your phone")));
    const qrBox = el("div", "pt-transfer-qr");
    const sendInfo = el("div", "pt-muted");
    const copy = el("button", "pt-watch-refresh", L("📋 Kopieer code", "📋 Copy code"));
    copy.type = "button";
    send.append(qrBox, sendInfo, copy);

    const receive = el("div", "pt-transfer-part");
    receive.appendChild(el("div", "pt-transfer-title", L("Code plakken", "Paste code")));
    const area = el("textarea", "pt-transfer-input");
    area.placeholder = "PW1.…";
    area.rows = 3;
    const apply = el("button", "pt-watch-refresh", "Overnemen");
    apply.type = "button";
    const receiveInfo = el("div", "pt-muted",
      L("Vervangt de lijst op dit apparaat door die uit de code (doelen + FUT Genie-prijzen van dat moment).", "Replaces the list on this device with the one from the code (targets + FUT Genie prices from that moment)."));
    receive.append(area, apply, receiveInfo);
    panel.append(send, receive);

    // Live via your pc: the pc (with FUT Genie) writes list + prices to your gist, the phone reads it.
    const live = el("div", "pt-transfer-part");
    live.appendChild(el("div", "pt-transfer-title", L("Live via je pc (GitHub gist)", "Live via your PC (GitHub gist)")));
    const liveInfo = el("div", "pt-muted");
    const gist = el("input", "pt-transfer-input");
    gist.type = "text";
    gist.placeholder = L("Link of id van je geheime gist", "Link or ID of your secret gist");
    const token = el("input", "pt-transfer-input");
    token.type = "password";
    token.autocomplete = "off";
    token.placeholder = L("GitHub-token (alleen recht: gist)", "GitHub token (only permission: gist)");
    const saveToken = el("button", "pt-watch-refresh", L("Token opslaan", "Save token"));
    saveToken.type = "button";
    const sendNow = el("button", "pt-watch-refresh", L("↑ Nu versturen", "↑ Send now"));
    sendNow.type = "button";
    const clearToken = el("button", "pt-watch-refresh", "Token wissen");
    clearToken.type = "button";
    const pullNow = el("button", "pt-watch-refresh", L("↓ Nu ophalen", "↓ Fetch now"));
    pullNow.type = "button";
    // The token to the phone as a QR code. Tampermonkey's part draws it, so the token never reaches this page.
    const tokenQr = el("button", "pt-watch-refresh", L("📱 Token naar telefoon", "📱 Token to phone"));
    tokenQr.type = "button";
    const tokenQrBox = el("div", "pt-transfer-qr");
    tokenQrBox.id = "pt-token-qr";
    const tokenQrInfo = el("div", "pt-muted");
    let tokenQrTimer = 0;
    const hideTokenQr = () => {
      window.clearTimeout(tokenQrTimer);
      tokenQrBox.textContent = "";
      tokenQrInfo.textContent = "";
      tokenQr.textContent = L("📱 Token naar telefoon", "📱 Token to phone");
    };
    live.append(liveInfo, gist, token, saveToken, sendNow, clearToken, pullNow, tokenQr, tokenQrBox, tokenQrInfo);
    panel.prepend(live);

    const renderLive = () => {
      const relay = getRelay();
      const pc = pcDevice();
      if (document.activeElement !== gist) gist.value = relay.gistId || "";
      token.style.display = relay.hasToken ? "none" : "";
      saveToken.style.display = relay.hasToken ? "none" : "";
      sendNow.textContent = pc ? L("↑ Nu versturen", "↑ Send now") : L("↑ Lijst naar pc", "↑ List to PC");
      sendNow.style.display = relay.hasToken ? "" : "none";
      clearToken.style.display = relay.hasToken ? "" : "none";
      pullNow.style.display = pc ? "none" : "";
      tokenQr.style.display = pc && relay.hasToken ? "" : "none";
      if (!(pc && relay.hasToken) && tokenQrBox.firstChild) hideTokenQr();
      const error = relay.error ? L(` Laatste fout: ${relay.error}`, ` Last error: ${relay.error}`) : "";
      const phoneList = relay.hasToken
        ? L(" Wijzig je hier de lijst, dan gaat die binnen een halve minuut naar je pc, die hem overneemt en er prijzen bij zoekt.", " If you change the list here, it goes to your PC within half a minute, which imports it and looks up prices for it.") +
          (relay.listSentAt ? L(` Laatst verstuurd: ${formatDayTime(relay.listSentAt)}.`, ` Last sent: ${formatDayTime(relay.listSentAt)}.`) : "")
        : L(" Wil je hier een lijst maken voor je pc? Vul dan hier hetzelfde GitHub-token in.", " Want to create a list here for your PC? Then enter the same GitHub token here.");
      liveInfo.textContent = pc
        ? relay.hasToken
          ? L("Deze pc zet elke 5 minuten je lijst + FUT Genie-prijzen in de gist (zolang de web app openstaat)", "This PC puts your list + FUT Genie prices in the gist every 5 minutes (as long as the web app is open)") +
            L(" en neemt elke minuut een nieuwe lijst van je telefoon over.", " and imports a new list from your phone every minute.") +
            (relay.sentAt ? ` Laatst: ${formatDayTime(relay.sentAt)}.` : "") + error
          : L("Vul een GitHub-token in (alleen het recht \"gist\"); die blijft in Tampermonkey op deze pc.", "Enter a GitHub token (only the \"gist\" permission); it stays in Tampermonkey on this PC.") + error
        : (relay.pricesAt
          ? L(`Prijzen van je pc: ${formatDayTime(relay.pricesAt)}${relayFresh() ? " (live)" : " – staat de web app op je pc open?"}.`, `Prices from your PC: ${formatDayTime(relay.pricesAt)}${relayFresh() ? " (live)" : " – is the web app open on your PC?"}.`)
          : L("Wacht op prijzen van je pc. Zet daar eerst het token in.", "Waiting for prices from your PC. Set the token there first.")) + phoneList + error;
    };
    gist.addEventListener("change", () => {
      const id = gistIdFrom(gist.value);
      saveRelay({ gistId: id, listJson: "", error: id ? "" : L("Geen geldige gist-link", "Not a valid gist link") });
    });
    saveToken.addEventListener("click", async () => {
      saveToken.disabled = true;
      try {
        await relayCall("setToken", { token: token.value.trim(), gistId: getRelay().gistId });
        token.value = "";
        saveRelay({ hasToken: true, error: "" });
        if (pcDevice()) pushRelay(true);
      } catch (error) {
        saveRelay({ error: error.message });
      }
      saveToken.disabled = false;
    });
    clearToken.addEventListener("click", async () => {
      await relayCall("clearToken", {}).catch(() => {});
      saveRelay({ hasToken: false, error: "" });
    });
    sendNow.addEventListener("click", () => (pcDevice() ? pushRelay(true) : pushPhoneList(true)));
    pullNow.addEventListener("click", () => pullRelay(true));
    tokenQr.addEventListener("click", async () => {
      if (tokenQrBox.firstChild) {
        hideTokenQr();
        return;
      }
      tokenQr.disabled = true;
      try {
        await relayCall("tokenQr", { targetId: tokenQrBox.id, base: `${location.origin}${location.pathname}`, gistId: getRelay().gistId });
        tokenQr.textContent = L("Verberg QR-code", "Hide QR code");
        tokenQrInfo.textContent = L("Scan met de camera van je iPhone: Price Watch daar slaat het token op. ", "Scan with your iPhone camera: Price Watch there saves the token. ") +
          L("Het token staat in deze link, wis hem daarna uit de geschiedenis van Safari. De code verdwijnt na 2 minuten.", "The token is in this link, so clear it from your Safari history afterwards. The code disappears after 2 minutes.");
        tokenQrTimer = window.setTimeout(hideTokenQr, 2 * 60 * 1000);
      } catch (error) {
        hideTokenQr();
        tokenQrInfo.textContent = L(`Geen QR-code: ${error.message}`, `No QR code: ${error.message}`);
      }
      tokenQr.disabled = false;
    });
    listeners.add(renderLive);

    let code = "";
    copy.addEventListener("click", async () => {
      const ok = await copyText(code);
      flashButton(copy, ok ? L("✓ Gekopieerd", "✓ Copied") : L("Kopiëren mislukt", "Copy failed"), ok, "", L("📋 Kopieer code", "📋 Copy code"), "");
    });
    apply.addEventListener("click", async () => {
      try {
        receiveInfo.textContent = transferSummary(applyTransfer(await decodeTransfer(area.value)));
        area.value = "";
      } catch (error) {
        receiveInfo.textContent = L(`Overnemen mislukt: ${error.message}`, `Import failed: ${error.message}`);
      }
    });

    panel.__ptOpen = async () => {
      renderLive();
      const data = buildTransferData();
      code = await encodeTransfer(data);
      const url = `${location.origin}${location.pathname}#pw=${code}`;
      qrBox.textContent = "";
      try {
        if (!(await loadQrLibrary())) throw new Error(L("QR-bibliotheek niet geladen", "QR library not loaded"));
        const qr = window.qrcode(0, "L");
        qr.addData(url);
        qr.make();
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      } catch (error) {
        qrBox.appendChild(el("div", "pt-muted", L(`Geen QR-code (${error.message}). Gebruik "Kopieer code" en plak hem op je telefoon.`, `No QR code (${error.message}). Use "Copy code" and paste it on your phone.`)));
      }
      sendInfo.textContent = L(`${data.w.length} speler(s), ${Object.keys(data.p).length} met prijs. `, `${data.w.length} player(s), ${Object.keys(data.p).length} with price. `) +
        L("Scan met de camera van je iPhone: Safari opent de web app en neemt de lijst over. Prijzen zijn die van nu; zet opnieuw over voor verse prijzen.", "Scan with your iPhone camera: Safari opens the web app and imports the list. Prices are as of now; transfer again for fresh prices.");
    };
    return panel;
  }

  // A code from the QR link: import it once the app (and its static data) is up.
  function importPendingTransfer() {
    let code = pendingTransfer;
    try {
      code = sessionStorage.getItem("pt_transfer_pending") || code;
      sessionStorage.removeItem("pt_transfer_pending");
    } catch (_) {
      // Use the code read at startup.
    }
    if (!code) return;
    decodeTransfer(code)
      .then(data => showToast(`Price Watch: ${transferSummary(applyTransfer(data))}`, true))
      .catch(error => showToast(L(`Price Watch: overzetten mislukt – ${error.message}`, `Price Watch: transfer failed – ${error.message}`), false));
  }

  function showToast(text, ok) {
    const toast = el("div", `pt-toast ${ok ? "pt-ok" : "pt-error"}`, text);
    document.body.appendChild(toast);
    toast.addEventListener("click", () => toast.remove());
    window.setTimeout(() => toast.remove(), 8000);
  }

  // ---------------------------------------------------------------------------
  // Target chime: a soft "pling" when a player reaches its PC target after a price update
  // ---------------------------------------------------------------------------

  const CHIME_KEY = "pt_chime_v1"; // "off" = muted
  let chimeAudio = null;
  let atTarget = null; // ids at or under their target at the last check; null = not seeded yet
  const lastSeenPrice = new Map(); // id -> price at the last check (a changed target alone doesn't pling)

  function chimeOn() {
    try {
      return localStorage.getItem(CHIME_KEY) !== "off";
    } catch {
      return true;
    }
  }

  // Browsers only allow sound after a tap/click on the page: create the audio context on the first one.
  function unlockChime() {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!chimeAudio && Context) chimeAudio = new Context();
      if (chimeAudio && chimeAudio.state === "suspended") chimeAudio.resume();
    } catch (_) {
      // No sound on this device.
    }
  }
  ["pointerdown", "touchend", "keydown"].forEach(type => document.addEventListener(type, unlockChime, { capture: true, passive: true }));

  // Two soft sine notes (E6 → A6) that fade out.
  function playChime() {
    if (!chimeAudio || chimeAudio.state !== "running") return;
    const now = chimeAudio.currentTime;
    [[1318.5, 0], [1760, 0.12]].forEach(([frequency, delay]) => {
      const oscillator = chimeAudio.createOscillator();
      const gain = chimeAudio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(0.08, now + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.9);
      oscillator.connect(gain).connect(chimeAudio.destination);
      oscillator.start(now + delay);
      oscillator.stop(now + delay + 1);
    });
  }

  // Players that newly reached their target since the last check: pling + toast. The first check
  // (prices from before this visit) only takes stock, so opening the app stays quiet.
  function checkTargetHits() {
    const hits = new Set();
    const newlyHit = [];
    getWatch().forEach(entry => {
      const price = (geniePrice(entry.definitionId, entry.resourceId) || {}).price;
      const previous = lastSeenPrice.get(entry.definitionId);
      if (price) lastSeenPrice.set(entry.definitionId, price);
      if (!entry.target || !price || price > entry.target) return;
      hits.add(entry.definitionId);
      if (atTarget && !atTarget.has(entry.definitionId) && price !== previous) newlyHit.push({ entry, price });
    });
    const seeded = !!atTarget;
    atTarget = hits;
    if (!seeded || !newlyHit.length) return;
    if (chimeOn()) playChime();
    const text = newlyHit.map(({ entry, price }) => L(`${entry.name}: ${priceFormat.format(price)} (doel ${priceFormat.format(entry.target)})`, `${entry.name}: ${priceFormat.format(price)} (target ${priceFormat.format(entry.target)})`));
    showToast(L(`🎯 Op doel: ${text.join(" · ")}`, `🎯 At target: ${text.join(" · ")}`), true);
    // Push to the phone (ntfy) only from the pc with FUT Genie, so a phone with the app open doesn't send it twice.
    if (pcDevice()) relayCall("notify", { title: newlyHit.length > 1 ? L(`${newlyHit.length} spelers op doel`, `${newlyHit.length} players at target`) : L("Speler op doel", "Player at target"), text: text.join("\n") })
      .catch(error => console.warn(L("Price Watch: ntfy-melding mislukt.", "Price Watch: ntfy notification failed."), error));
  }
  // Seed once the first prices are in; after that every update (Genie on the pc, the gist on the phone) counts.
  listeners.add(() => {
    if (!atTarget && !getWatch().some(entry => geniePrice(entry.definitionId, entry.resourceId))) return;
    checkTargetHits();
  });

  // ---------------------------------------------------------------------------
  // Price Watch page
  // ---------------------------------------------------------------------------

  let sortByDistance = (() => {
    try {
      return localStorage.getItem(SORT_KEY) !== "added";
    } catch {
      return true;
    }
  })();

  function buildPage(root) {
    root.textContent = "";
    const card = el("div", "pt-watch-card");
    root.appendChild(card);

    const toolbar = el("div", "pt-watch-toolbar");
    const heading = el("div", "pt-watch-heading");
    const status = el("div", "pt-watch-status");
    const title = el("h1", "pt-watch-title", "Price Watch");
    // Show the installed version, so an outdated copy is easy to spot.
    const version = SCRIPT_VERSION;
    if (version) title.appendChild(el("span", "pt-watch-version", `v${version}`));
    heading.append(title, status);
    const refresh = el("button", "pt-watch-refresh", L("↻ Prijzen verversen", "↻ Refresh prices"));
    refresh.type = "button";
    refresh.addEventListener("click", async () => {
      if (refresh.dataset.refreshing === "1") return;
      refresh.dataset.refreshing = "1";
      refresh.disabled = true;
      refresh.textContent = L("↻ Bezig met verversen…", "↻ Refreshing…");
      try {
        // Force a fresh FUT.GG manifest + PC feed download, and refresh FUT Genie too when available.
        const futggPromise = refreshFutggPrices(true);
        refreshGeniePrices(true);
        const futggOk = await futggPromise;
        const count = Object.keys(futggPrices).length;
        const time = futggPricesAt ? new Date(futggPricesAt).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : L("onbekend", "unknown");
        if (futggOk && count) {
          showToast(L(`✅ FUT.GG PC-prijzen opnieuw opgehaald: ${count.toLocaleString("nl-NL")} prijzen (${time}). ${genie() ? "FUT Genie-refresh ook gestart." : "Geen FUT Genie gevonden; telefoonprijzen worden via de relay bijgewerkt."}`, `✅ FUT.GG PC prices fetched again: ${count.toLocaleString("nl-NL")} prices (${time}). ${genie() ? "FUT Genie refresh also started." : "No FUT Genie found; phone prices are updated via the relay."}`), true);
        } else {
          showToast(L(`⚠️ FUT.GG verversen mislukt: ${futggLastError || "onbekende fout"}. ${genie() ? "FUT Genie-refresh is wel gestart." : ""}`, `⚠️ FUT.GG refresh failed: ${futggLastError || "unknown error"}. ${genie() ? "FUT Genie refresh was started." : ""}`), false);
        }
      } catch (error) {
        showToast(L(`Prijzen verversen mislukt: ${error && error.message ? error.message : error}`, `Refreshing prices failed: ${error && error.message ? error.message : error}`), false);
      } finally {
        refresh.dataset.refreshing = "0";
        refresh.disabled = false;
        refresh.textContent = L("↻ Prijzen verversen", "↻ Refresh prices");
      }
    });
    const transfer = el("button", "pt-watch-refresh", L("⇄ Overzetten", "⇄ Transfer"));
    transfer.type = "button";
    transfer.title = L("Lijst + prijzen naar je telefoon (QR-code) of een code van je pc plakken", "Send list + prices to your phone (QR code) or paste a code from your PC");
    const walk = el("button", "pt-watch-refresh pt-primary", L("▶ Alles afgaan", "▶ Go through all"));
    walk.type = "button";
    walk.title = L("Zet speler na speler klaar op de transfermarkt (balk met \"Volgende\"): jouw PC-instapdoel als max BIN, leeg = auto uit de Genie-prijs. Duurste eerst.", "Sets up player after player on the transfer market (bar with \"Next\"): your PC entry target as max BIN, empty = auto from the Genie price. Most expensive first.");
    walk.addEventListener("click", async () => {
      if (!(await startWatchRun())) showToast(L("Nog geen spelers om af te gaan.", "No players to go through yet."), false);
    });
    const chime = el("button", "pt-watch-refresh");
    chime.type = "button";
    const showChime = () => {
      chime.textContent = chimeOn() ? "🔔" : "🔕";
      chime.title = chimeOn() ? L("Pling als een speler na een prijsupdate op je doel zit (klik om uit te zetten)", "Ding when a player is at your target after a price update (click to turn off)") : L("Pling staat uit (klik om aan te zetten)", "Ding is off (click to turn on)");
    };
    chime.addEventListener("click", () => {
      try {
        localStorage.setItem(CHIME_KEY, chimeOn() ? "off" : "on");
      } catch (_) {
        // Only for this session.
      }
      showChime();
      if (chimeOn()) playChime(); // let you hear it
    });
    showChime();
    const oneClick = el("button", "pt-watch-refresh");
    oneClick.type = "button";
    const showOneClick = () => {
      oneClick.textContent = oneClickOn() ? L("⚡ 1-klik", "⚡ 1-click") : "🛑 Pop-up";
      oneClick.title = oneClickOn()
        ? L("Buy Now koopt direct, zonder bevestigings-pop-up (klik om de pop-up terug te zetten)", "Buy Now buys instantly, without a confirmation pop-up (click to bring the pop-up back)")
        : L("Buy Now vraagt om bevestiging (klik voor kopen zonder pop-up). Staat One click Buy Now in FUT Genie aan, dan slaat Genie de pop-up nog steeds over.", "Buy Now asks for confirmation (click to buy without pop-up). If One click Buy Now is on in FUT Genie, Genie still skips the pop-up.");
    };
    oneClick.addEventListener("click", () => {
      try {
        localStorage.setItem(ONE_CLICK_KEY, oneClickOn() ? "off" : "on");
      } catch (_) {
        // Only for this session.
      }
      showOneClick();
    });
    showOneClick();
    const push = el("button", "pt-watch-refresh", "📲");
    push.type = "button";
    push.title = L("Pushmelding op je telefoon (ntfy) als een speler op doel zit, ook als hij vergrendeld is", "Push notification on your phone (ntfy) when a player is at target, even if he is locked");
    const actions = el("div", "pt-watch-actions");
    actions.append(walk, oneClick, chime, push, transfer, refresh);
    const pushPanel = buildPushPanel();
    pushPanel.style.display = "none";
    push.addEventListener("click", () => {
      const open = pushPanel.style.display === "none";
      pushPanel.style.display = open ? "" : "none";
      if (open) pushPanel.__ptOpen();
    });
    toolbar.append(heading, actions);
    const transferPanel = buildTransferPanel();
    transferPanel.style.display = "none";
    transfer.addEventListener("click", () => {
      const open = transferPanel.style.display === "none";
      transferPanel.style.display = open ? "" : "none";
      if (open) transferPanel.__ptOpen();
    });

    const table = el("table", "pt-watch-table pt-players-table");
    const head = el("thead");
    const headRow = el("tr");
    const columns = [
      [L("Speler", "Player"), "pt-col-name"],
      ["Rating", "pt-col-rating"],
      ["Rarity", "pt-col-rarity"],
      ["Marketprijs", "pt-col-price"],
      [L("PC-instapdoel", "PC entry target"), "pt-col-target"],
      [L("Afstand", "Distance"), "pt-col-distance pt-sortable"],
      ["", "pt-col-remove"]
    ];
    columns.forEach(([label, className]) => headRow.appendChild(el("th", className, label)));
    const distanceHeader = headRow.querySelector(".pt-col-distance");
    distanceHeader.addEventListener("click", () => {
      sortByDistance = !sortByDistance;
      try {
        localStorage.setItem(SORT_KEY, sortByDistance ? "distance" : "added");
      } catch (_) {
        // Sorting still works for this session.
      }
      renderRows();
    });
    head.appendChild(headRow);
    const body = el("tbody");
    table.append(head, body);

    const empty = el("div", "pt-watch-empty",
      L("Nog geen spelers. Open een spelerskaart (club, transfermarkt, transfer list, SBC) en klik op \"+ Price Watch\".", "No players yet. Open a player card (club, transfer market, transfer list, SBC) and click \"+ Price Watch\"."));

    card.append(toolbar, pushPanel, transferPanel, table, empty);

    const rowsById = new Map();

    function makeRow(entry) {
      const row = el("tr");
      const nameCell = el("td", "pt-col-name");
      const name = el("span", "pt-watch-name", entry.name);
      name.title = entry.name;
      const copy = el("button", "pt-icon-btn", "📋");
      copy.type = "button";
      copy.title = L("Kopieer spelersnaam", "Copy player name");
      copy.addEventListener("click", async () => {
        const ok = await copyText(entry.name);
        flashButton(copy, ok ? "✓" : "!", ok, ok ? L(`Gekopieerd: ${entry.name}`, `Copied: ${entry.name}`) : L("Kopiëren mislukt", "Copy failed"), "📋", L("Kopieer spelersnaam", "Copy player name"));
      });
      const search = el("button", "pt-icon-btn pt-transfer-search", "🔍");
      search.type = "button";
      search.title = SEARCH_TITLE;
      search.addEventListener("click", event => {
        try {
          openPreparedSearch(entry, event.shiftKey ? null : entry.target);
        } catch (error) {
          console.error("Price Watch:", error);
          flashButton(search, "⚠️", false, L(`Fout: ${error.message}`, `Error: ${error.message}`), "🔍", SEARCH_TITLE);
          showToast(L(`Transfermarkt openen mislukt – ${error.message}`, `Opening transfer market failed – ${error.message}`), false);
        }
      });
      const LOWEST_TITLE = L("Handmatige live BIN-scan: maximaal 3 EA-zoekopdrachten, 12–18s pauze. Bij de apparaatlimiet: klik binnen 30s nogmaals voor een eenmalige bevestigde uitzondering.", "Manual live BIN scan: at most 3 EA searches, 12–18s pause. At the device limit: click again within 30s for a one-time confirmed exception.");
      const lowest = el("button", "pt-icon-btn pt-lowest", "🏷️");
      lowest.type = "button";
      lowest.title = LOWEST_TITLE;
      let lastTap = 0;
      const startLowest = async event => {
        // Touch + the click that follows it count as one tap.
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (Date.now() - lastTap < 600) return;
        lastTap = Date.now();
        if (marketBusy) {
          showToast(L(`Er loopt nog een zoekopdracht (${Math.round((Date.now() - marketBusySince) / 1000)}s) – even wachten`, `A search is still running (${Math.round((Date.now() - marketBusySince) / 1000)}s) – wait a moment`), false);
          return;
        }
        lowest.disabled = true;
        lowest.textContent = "…";
        showToast(L(`${entry.name}: laagste prijs zoeken…`, `${entry.name}: searching lowest price…`), true);
        try {
          const price = await findLowestPrice(entry.definitionId, search => { lowest.textContent = `${search}…`; });
          flashButton(lowest, price ? "✓" : "–", true, price ? L(`Laagste BIN: ${priceFormat.format(price)}`, `Lowest BIN: ${priceFormat.format(price)}`) : L("Niets te koop gevonden", "Nothing for sale found"), "🏷️", LOWEST_TITLE);
          // Phones show no tooltips: say the result on screen.
          const state = distanceState(entry.target, price);
          showToast(price
            ? `${entry.name}: ${formatLowestCounts(entry.definitionId) || L(`laagste BIN ${priceFormat.format(price)}`, `lowest BIN ${priceFormat.format(price)}`)}` + (entry.target ? L(` · afstand tot doel ${state.text}`, ` · distance to target ${state.text}`) : "")
            : L(`${entry.name}: niets te koop gevonden`, `${entry.name}: nothing for sale found`), true);
          listeners.forEach(listener => listener());
        } catch (error) {
          console.warn(L("Price Watch: laagste prijs zoeken mislukt.", "Price Watch: searching lowest price failed."), error);
          flashButton(lowest, "⚠️", false, error.message, "🏷️", LOWEST_TITLE);
          showToast(L(`${entry.name}: zoeken mislukt – ${error.message}`, `${entry.name}: search failed – ${error.message}`), false);
        } finally {
          lowest.disabled = false;
        }
      };
      // Only a real tap starts a search, never a scroll that happens to start on the button.
      let touchStart = null;
      lowest.addEventListener("touchstart", event => {
        const touch = event.touches[0];
        touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }, { passive: true });
      lowest.addEventListener("touchend", event => {
        const touch = event.changedTouches[0];
        const moved = !touchStart || !touch || Math.abs(touch.clientX - touchStart.x) > 10 || Math.abs(touch.clientY - touchStart.y) > 10;
        touchStart = null;
        if (moved) return;
        startLowest(event);
      });
      lowest.addEventListener("click", startLowest);
      const nameWrap = el("div", "pt-name-wrap");
      nameWrap.append(name, copy, search, lowest);
      nameCell.appendChild(nameWrap);

      const priceCell = el("td", "pt-col-price");
      const priceValue = el("span", "pt-price-value");
      const priceSource = el("span", "pt-price-source");
      const liveBinValue = el("span", "pt-price-live-bin");
      priceCell.append(priceValue, priceSource, liveBinValue);
      const targetCell = el("td", "pt-col-target");
      const input = el("input", "pt-target-input");
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = L("Bijv. 50000", "E.g. 50000");
      input.value = entry.target ? String(entry.target) : "";
      input.setAttribute("aria-label", L(`PC-instapdoel ${entry.name}`, `PC entry target ${entry.name}`));
      targetCell.appendChild(input);

      const distanceCell = el("td", "pt-col-distance");
      const distance = el("span", "pt-distance", "—");
      distanceCell.appendChild(distance);

      const removeCell = el("td", "pt-col-remove");
      const remove = el("button", "pt-icon-btn pt-remove", "×");
      remove.type = "button";
      remove.title = L(`Verwijder ${entry.name} uit Price Watch`, `Remove ${entry.name} from Price Watch`);
      remove.addEventListener("click", () => removeWatched(entry.definitionId));
      removeCell.appendChild(remove);

      row.append(nameCell, el("td", "pt-col-rating", String(entry.rating || "")),
        el("td", "pt-col-rarity", entry.rarity != null ? rarityName(entry.rarity) : ""), priceCell, targetCell, distanceCell, removeCell);

      const update = () => {
        const genieEntry = geniePrice(entry.definitionId, entry.resourceId);
        const price = genieEntry ? genieEntry.price : null;
        priceValue.textContent = price !== null ? priceFormat.format(price) : "—";
        let sourceLabel = "";
        let sourceTitle = L("Geen prijsbron beschikbaar", "No price source available");
        if (genieEntry && genieEntry._futgg) {
          sourceLabel = "GG";
          sourceTitle = `FUT.GG PC-feed · ID ${genieEntry._futggId}`;
        } else if (genieEntry && genieEntry._genie) {
          sourceLabel = "G";
          sourceTitle = "FUT Genie (PC)";
        } else if (genieEntry && genieEntry._market) {
          sourceLabel = "";
          sourceTitle = L("Laagste BIN op de markt (zelf gezocht)", "Lowest BIN on the market (searched yourself)");
        } else if (genieEntry && genieEntry._transferred) {
          sourceTitle = L("Overgezette prijs (bron niet bevestigd)", "Transferred price (source not confirmed)");
        } else if (genieEntry && genieEntry._remote) {
          sourceTitle = "Overige gesynchroniseerde prijsbron";
        }
        priceSource.textContent = sourceLabel;
        priceSource.style.display = sourceLabel ? "inline-flex" : "none";
        priceSource.title = sourceTitle;
        const liveScan = lastLowest[entry.definitionId];
        const savedMarket = getMarketPrices()[entry.definitionId];
        const livePrice = liveScan && liveScan.lowest > 0 ? liveScan.lowest
          : !liveScan && Array.isArray(savedMarket) && Number(savedMarket[0]) > 0 ? Number(savedMarket[0]) : null;
        if (livePrice) {
          const uncertain = !!(liveScan && !liveScan.certain);
          liveBinValue.textContent = `EA BIN ${uncertain ? "≥ " : ""}${priceFormat.format(livePrice)}`;
          liveBinValue.title = liveScan
            ? L(`Laagste door Price Watch gevonden EA-BIN · ${liveScan.certain ? L("resultaat compleet binnen de zoekfilters", "complete result within the search filters") : L("resultaat is een voorlopige ondergrens; scanlimiet bereikt", "result is a provisional lower bound; scan limit reached")} · ${formatDayTime(liveScan.at)}`, `Lowest EA BIN found by Price Watch · ${liveScan.certain ? L("resultaat compleet binnen de zoekfilters", "complete result within the search filters") : L("resultaat is een voorlopige ondergrens; scanlimiet bereikt", "result is a provisional lower bound; scan limit reached")} · ${formatDayTime(liveScan.at)}`)
            : L(`Eerder gevonden EA-BIN · ${formatDayTime(Number(savedMarket[1]) || Date.now())}`, `Earlier found EA BIN · ${formatDayTime(Number(savedMarket[1]) || Date.now())}`);
          liveBinValue.classList.toggle("pt-live-uncertain", uncertain);
          liveBinValue.style.display = "block";
        } else if (liveScan) {
          liveBinValue.textContent = L("EA BIN geen aanbod", "EA BIN no listings");
          liveBinValue.title = L(`Geen aanbod gevonden tijdens de EA-scan · ${formatDayTime(liveScan.at)}`, `No listings found during the EA scan · ${formatDayTime(liveScan.at)}`);
          liveBinValue.classList.remove("pt-live-uncertain");
          liveBinValue.style.display = "block";
        } else {
          liveBinValue.textContent = "";
          liveBinValue.title = L("Nog geen handmatige EA-BIN-scan gedaan", "No manual EA BIN scan done yet");
          liveBinValue.style.display = "none";
        }
        priceCell.classList.toggle("pt-missing", price === null);
        lowest.style.display = ""; // Keep EA live BIN lookup available next to FUT.GG / FUT Genie reference prices.
        priceCell.classList.toggle("pt-transferred", !!(genieEntry && genieEntry._transferred));
        priceCell.classList.toggle("pt-market", !!(genieEntry && genieEntry._market));
        priceCell.title = genieEntry
          ? genieEntry._market
            ? L(`Laagste BIN op de markt (zelf gezocht) · ${formatDayTime(Number(genieEntry._fetchedAt))}`, `Lowest BIN on the market (searched yourself) · ${formatDayTime(Number(genieEntry._fetchedAt))}`)
            : genieEntry._transferred
            ? L(`FUT Genie (PC), overgezet · prijs van ${formatDayTime(Number(genieEntry._fetchedAt) || Date.now())}`, `FUT Genie (PC), transferred · price from ${formatDayTime(Number(genieEntry._fetchedAt) || Date.now())}`)
            : L(`FUT Genie (PC), opgehaald om ${formatTime(Number(genieEntry._fetchedAt) || Date.now())}`, `FUT Genie (PC), fetched at ${formatTime(Number(genieEntry._fetchedAt) || Date.now())}`)
          : genie() ? L("Nog geen FUT Genie-prijs voor deze kaart", "No FUT Genie price for this card yet") : pcDevice() ? L("Nog geen FUT.GG-prijs voor deze kaart", "No FUT.GG price for this card yet") : L("Nog geen prijs van je pc ontvangen", "No price received from your PC yet");

        const state = distanceState(entry.target, price);
        row.__ptPercent = state.percent;
        distanceBar(distance, state);
        row.classList.toggle("pt-row-hit", state.percent != null && state.percent <= 0);
        row.classList.toggle("pt-row-near", state.percent != null && state.percent > 0 && state.percent <= NEAR_PERCENT);
      };

      input.addEventListener("input", () => {
        setTarget(entry.definitionId, parsePrice(input.value));
        update();
      });
      // Re-sort once editing is done (sorting while typing would steal focus).
      input.addEventListener("change", renderRows);

      return { row, update };
    }

    function renderRows() {
      const list = getWatch();
      const ids = new Set(list.map(entry => entry.definitionId));
      rowsById.forEach((value, id) => { if (!ids.has(id)) { value.row.remove(); rowsById.delete(id); } });

      list.forEach(entry => {
        if (!rowsById.has(entry.definitionId)) rowsById.set(entry.definitionId, makeRow(entry));
        rowsById.get(entry.definitionId).update();
      });

      let ordered = list.map(entry => rowsById.get(entry.definitionId).row);
      if (sortByDistance) {
        const rank = row => (row.__ptPercent == null ? Infinity : row.__ptPercent);
        ordered = ordered.map((row, index) => ({ row, index }))
          .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
          .map(item => item.row);
      }
      const active = document.activeElement;
      const typing = active && active.classList && active.classList.contains("pt-target-input") && body.contains(active);
      const current = [...body.children];
      if (!typing && !(current.length === ordered.length && ordered.every((row, i) => current[i] === row))) {
        ordered.forEach(row => body.appendChild(row));
      }

      distanceHeader.classList.toggle("pt-sorted", sortByDistance);
      distanceHeader.title = sortByDistance
        ? L("Gesorteerd op afstand tot je instapdoel (klik: volgorde van toevoegen)", "Sorted by distance to your entry target (click: order added)")
        : L("Klik om te sorteren op afstand tot je instapdoel", "Click to sort by distance to your entry target");

      table.style.display = list.length ? "" : "none";
      empty.style.display = list.length ? "none" : "";

      // Phone: the refresh button reads the gist (prices from your pc).
      const relay = getRelay();
      const live = pcDevice() || relayFresh();
      refresh.disabled = pcDevice() ? genieLoading : relayBusy;
      const priceHeader = headRow.querySelector(".pt-col-price");
      priceHeader.textContent = live ? "Genie (PC)" : L("Prijs", "Price");
      priceHeader.title = live ? "" : L("Groen = laagste BIN die je zelf zocht (🏷️), wit = van je pc", "Green = lowest BIN you searched yourself (🏷️), white = from your PC");
      const hits = list.filter(entry => (rowsById.get(entry.definitionId).row.__ptPercent ?? Infinity) <= 0).length;
      setTabBadge("watch", hits, true);
      const summary = L(`${list.length} speler(s)`, `${list.length} player(s)`) + (hits ? L(` · ${hits} op of onder doel`, ` · ${hits} at or below target`) : "");
      if (pcDevice()) {
        status.textContent = futggPricesAt
          ? L(`${summary} · FUT.GG PC-feed bijgewerkt om ${formatTime(futggPricesAt)} · manifest elke minuut gecontroleerd`, `${summary} · FUT.GG PC feed updated at ${formatTime(futggPricesAt)} · manifest checked every minute`) + (genieLoading ? L(" · FUT Genie ook actief", " · FUT Genie also active") : "")
          : genieLoading
            ? L(`${summary} · prijzen ophalen bij FUT Genie…`, `${summary} · fetching prices from FUT Genie…`)
            : genieRequestedAt
              ? L(`${summary} · FUT Genie (PC) opgehaald om ${formatTime(genieRequestedAt)} · ververst elke 5 min`, `${summary} · FUT Genie (PC) fetched at ${formatTime(genieRequestedAt)} · refreshed every 5 min`)
              : summary;
        return;
      }
      const pricesFrom = transferredAt(list.map(entry => entry.definitionId));
      const relayError = relay.error ? ` · gist: ${relay.error}` : "";
      status.textContent = relayBusy
        ? L(`${summary} · prijzen van je pc ophalen…`, `${summary} · fetching prices from your PC…`)
        : relayFresh()
          ? L(`${summary} · FUT Genie via je pc · prijzen van ${formatTime(relay.pricesAt)} · ververst elke 2 min`, `${summary} · FUT Genie via your PC · prices from ${formatTime(relay.pricesAt)} · refreshed every 2 min`) + relayError
          : relay.pricesAt
            ? L(`${summary} · laatste prijzen van je pc: ${formatDayTime(relay.pricesAt)} (web app op je pc dicht?) · tik 🏷️ voor nu`, `${summary} · latest prices from your PC: ${formatDayTime(relay.pricesAt)} (web app on your PC closed?) · tap 🏷️ for now`) + relayError
            : (pricesFrom
              ? L(`${summary} · prijzen overgezet van je pc (${formatDayTime(pricesFrom)}) · tik 🏷️ voor nu`, `${summary} · prices transferred from your PC (${formatDayTime(pricesFrom)}) · tap 🏷️ for now`)
              : L(`${summary} · nog geen prijzen: zet op je pc "Live via je pc" aan (⇄ Overzetten) · tik 🏷️ voor nu`, `${summary} · no prices yet: on your PC turn on "Live via your PC" (⇄ Transfer) · tap 🏷️ for now`)) + relayError;
    }

    const renderStock = buildStockSection(root);
    const renderFodder = buildFodderSection(root);
    const renderTransfers = buildTransferSection(root);
    const renderFlip = buildFlipSection(root);
    buildTabs(root, {
      watch: card,
      fodder: root.querySelector(".pt-fodder-card"),
      lists: root.querySelector(".pt-stock-card"),
      transfers: root.querySelector(".pt-transfer-card"),
      flip: root.querySelector(".pt-flip-card")
    });
    return () => {
      renderRows();
      renderStock();
      renderFodder();
      renderTransfers();
      renderFlip();
    };
  }

  // ---------------------------------------------------------------------------
  // Stock lists: club + quality + max BIN rules, imported from a pasted tip
  // ---------------------------------------------------------------------------
  // List: { id, name, createdAt, levels: { gold|silver|bronze: { enabled, max, ideal } },
  //         clubs: [{ teamId, teamName, leagueId, leagueName, levels? }], done: { "teamId|level": timestamp } }

  const LEVELS = ["gold", "silver", "bronze"];
  const LEVEL_LABEL = { gold: "Goud", silver: "Zilver", bronze: "Brons" };
  const MATCH_SURE = 0.85;
  const MATCH_MAYBE = 0.6;

  let stockCache = null;

  function getStock() {
    if (stockCache) return stockCache;
    try {
      const value = JSON.parse(localStorage.getItem(STOCK_KEY) || "[]");
      stockCache = Array.isArray(value) ? value : [];
    } catch {
      stockCache = [];
    }
    return stockCache;
  }

  function saveStock() {
    try {
      localStorage.setItem(STOCK_KEY, JSON.stringify(getStock()));
    } catch (error) {
      console.warn(L("Price Watch: stock-lijsten konden niet worden opgeslagen.", "Price Watch: stock lists could not be saved."), error);
    }
    listeners.forEach(listener => listener());
  }

  // Clubs without "levels" get every quality of the list.
  function clubHasLevel(club, level) {
    return !club.levels || club.levels.includes(level);
  }

  // --- Lazy flip: list.flip = { under, sellLow, sellHigh }, list.market = { "teamId|level": { price, at } } ---
  // Without a market price the filter shows the market (max BIN = the tip's upper bound); once you type in the
  // cheapest BIN you saw, the filter becomes "market − under" and the bar shows the relist prices.
  const FLIP_DEFAULT = { under: 100, sellLow: 300, sellHigh: 900 };
  const FLIP_MIN_BIN = 150;

  function roundDownToStep(price) {
    const step = price < 1000 ? 50 : price < 10000 ? 100 : price < 50000 ? 250 : price < 100000 ? 500 : 1000;
    return Math.floor(price / step) * step;
  }

  function flipBuyMax(list, marketPrice) {
    return Math.max(FLIP_MIN_BIN, roundDownToStep(marketPrice - list.flip.under));
  }

  // Filter lists: sold instantly at `sell` → max BIN that leaves the list's profit % after the 5% tax
  // (2.300 → 2.185 after tax → 5% profit → 2.000).
  function filterBuyMax(list, sell) {
    return roundDownToStep(sell * (1 - EA_TAX) / (1 + profitFor(list) / 100));
  }

  function flipNet(sell, buy) {
    return Math.round(sell * (1 - EA_TAX) - buy);
  }

  function formatSigned(value) {
    return `${value > 0 ? "+" : ""}${priceFormat.format(value)}`;
  }

  // Your own market searches keep the flip market prices current. We only listen to the answer of the
  // search you ran. Market = the 3rd cheapest BIN in the results (the cheapest if there are fewer), so one
  // card listed too cheap is a card to buy, not the market. EA sorts results by time left, not price, so a
  // search without max BIN can miss cheaper cards: a buy-filter search that shows 3+ cards below the market
  // lowers it.
  const MARKET_SAMPLE = 3;

  function recordMarketSearch(criteria, response) {
    if (!criteria || !criteria.club || !response || !response.success) return;
    const items = (response.data && response.data.items) || [];
    const prices = items.map(item => {
      const auction = typeof item.getAuctionData === "function" ? item.getAuctionData() : item._auction;
      return auction && auction.buyNowPrice;
    }).filter(price => price > 0).sort((a, b) => a - b);
    if (!prices.length) return;
    const enough = prices.length >= MARKET_SAMPLE;
    const seenMarket = enough ? prices[MARKET_SAMPLE - 1] : prices[0];
    const nextPage = criteria.offset > 0;
    let changed = false;
    getStock().filter(list => list.flip && Array.isArray(list.clubs)).forEach(list => {
      stockRules(list).forEach(rule => {
        if (Number(rule.club.teamId) !== Number(criteria.club) || SearchLevel[rule.level.toUpperCase()] !== criteria.level) return;
        const known = list.market && list.market[rule.key];
        const buySearch = rule.market && criteria.maxBuy > 0 && criteria.maxBuy <= rule.max;
        let price;
        if (buySearch) {
          // Results sit below the market by design; only 3+ of them mean the market itself is lower.
          if (!enough || seenMarket >= rule.market.price) return;
          price = seenMarket;
        } else {
          // Next pages of the same search: keep the lowest one seen.
          price = nextPage && known && Date.now() - known.at < 5 * 60 * 1000 ? Math.min(known.price, seenMarket) : seenMarket;
        }
        list.market = list.market || {};
        list.market[rule.key] = { price, at: Date.now(), seen: true, count: prices.filter(value => value <= price).length };
        changed = true;
      });
    });
    if (!changed) return;
    saveStock();
    renderRunBar();
  }

  // Min bid wrap: FUT Genie's right arrow raises the min bid on the search filters (to refresh EA's results).
  // Once it reaches the max buy now price, start again at 0.
  function currentSearchFilters() {
    if (typeof UTMarketSearchFiltersViewController === "undefined") return null;
    const root = getAppMain().getRootViewController();
    const current = tabs => tabs && (typeof tabs.getCurrentViewController === "function" ? tabs.getCurrentViewController() : tabs.currentController);
    const presented = typeof root.getPresentedViewController === "function" ? root.getPresentedViewController() : null;
    const tabBar = findTabBarController();
    const navs = [presented instanceof UTTabBarController ? current(presented) : presented, current(tabBar), ...((tabBar && tabBar.childViewControllers) || [])];
    for (const nav of navs) {
      const stack = (nav && nav.childViewControllers) || [];
      const top = stack[stack.length - 1];
      if (top instanceof UTMarketSearchFiltersViewController) return top;
    }
    return null;
  }

  // The four price inputs of the filter screen: bid min, bid max, buy now min, buy now max.
  function filterPriceInputs() {
    return [...document.querySelectorAll(".search-prices input")].filter(input => input.offsetParent !== null);
  }

  function wrapMinBid() {
    const controller = currentSearchFilters();
    const viewmodel = controller && (controller.viewmodel || controller._viewmodel);
    const criteria = viewmodel && viewmodel.searchCriteria;
    const inputs = filterPriceInputs();
    const shown = inputs.length === 4 ? { minBid: parsePrice(inputs[0].value), maxBuy: parsePrice(inputs[3].value) } : null;
    const minBid = Math.max((criteria && criteria.minBid) || 0, (shown && shown.minBid) || 0);
    const maxBuy = (shown && shown.maxBuy) || (criteria && criteria.maxBuy) || 0; // what you see first
    if (!maxBuy || minBid < maxBuy) return;
    if (criteria) criteria.minBid = 0;
    if (shown) {
      const input = inputs[0];
      input.value = "";
      ["input", "change", "blur"].forEach(type => input.dispatchEvent(new Event(type, { bubbles: true })));
    }
    showToast(L("Min bid weer op 0 (bereikte je max BIN)", "Min bid back to 0 (you reached your max BIN)"), true);
  }

  let minBidWrapInstalled = false;

  function installMinBidWrap() {
    if (minBidWrapInstalled) return;
    minBidWrapInstalled = true;
    // Min bid at or above max buy now → back to 0. Checked after FUT Genie's arrow keys, EA's +/− buttons and
    // typing in the price fields. On window in the capture phase: FUT Genie stops the arrow keys on document,
    // so a listener there never heard them.
    const check = () => {
      if (!filterPriceInputs().length) return;
      [80, 400].forEach(delay => window.setTimeout(() => {
        try {
          wrapMinBid();
        } catch (error) {
          console.warn(L("Price Watch: min bid terugzetten mislukt.", "Price Watch: resetting min bid failed."), error);
        }
      }, delay));
    };
    window.addEventListener("keydown", event => { if (/^Arrow/.test(event.key) || event.key === "Enter") check(); }, true);
    window.addEventListener("click", event => {
      if (event.target instanceof Element && event.target.closest(".search-prices")) check();
    }, true);
    window.addEventListener("change", event => {
      if (event.target instanceof Element && event.target.closest(".search-prices")) check();
    }, true);
  }

  // --- One click Buy Now: no confirmation pop-up after your own click on Buy Now --------------------
  // A full Unassigned/PURCHASED pile must not force the normal EA confirmation flow.
  // EA's own eBidConfirmed() route handles the purchase; never buys without your explicit click.
  const ONE_CLICK_KEY = "pt_one_click_v1"; // "off" = keep EA's pop-up
  const ONE_CLICK_REPEAT_MS = 1500; // a double click must not send a second buy
  let oneClickInstalled = false;
  let lastOneClick = { id: null, at: 0 };

  function oneClickOn() {
    try {
      return localStorage.getItem(ONE_CLICK_KEY) !== "off";
    } catch {
      return true;
    }
  }

  function oneClickPrice(controller) {
    const item = controller.viewmodel.current();
    const auction = item.getAuctionData();
    if (auction.getSecondsRemaining() <= 0 || !(auction.buyNowPrice > 0)) return null;
    const coins = services.User.getUser().getCurrency(window.GameCurrency.COINS).amount;
    return auction.canBuy(coins) ? { id: item.id, price: auction.buyNowPrice } : null;
  }

  function installOneClickBuyNow() {
    const proto = window.UTItemDetailsViewController && window.UTItemDetailsViewController.prototype;
    if (oneClickInstalled || !proto || typeof proto.onBuyNow !== "function" || typeof proto.eBidConfirmed !== "function") return;
    oneClickInstalled = true;
    const original = proto.onBuyNow;
    proto.onBuyNow = function () {
      if (!oneClickOn()) return original.apply(this, arguments);
      let buy = null;
      try {
        buy = oneClickPrice(this);
      } catch (error) {
        console.warn(L("Price Watch: one click Buy Now niet mogelijk, EA's pop-up volgt.", "Price Watch: one click Buy Now not possible, EA's pop-up follows."), error);
      }
      if (!buy) return original.apply(this, arguments);
      if (buy.id === lastOneClick.id && Date.now() - lastOneClick.at < ONE_CLICK_REPEAT_MS) return undefined;
      lastOneClick = { id: buy.id, at: Date.now() };
      this.requestedBid = buy.price;
      return this.eBidConfirmed();
    };
  }

  // --- Transfer list timer: a pling (+ ntfy) when your listings run out ----------------------------
  // Follows what the web app does itself (opening the transfer list, listing, relisting); no extra
  // market requests. Listings ending within 2 minutes of each other share one alert.
  const LISTING_KEY = "pt_listing_ends_v1"; // [{ end, count }]
  const LISTING_GROUP_MS = 2 * 60 * 1000;
  let listingTimers = [];

  function getListingEnds() {
    try {
      const value = JSON.parse(localStorage.getItem(LISTING_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function saveListingEnds(groups) {
    try {
      localStorage.setItem(LISTING_KEY, JSON.stringify(groups));
    } catch (_) {
      // Timers still run for this session.
    }
    scheduleListingAlerts(groups);
  }

  function groupEnds(ends) {
    const groups = [];
    ends.sort((a, b) => a - b).forEach(end => {
      const last = groups[groups.length - 1];
      if (last && end - last.end <= LISTING_GROUP_MS) {
        last.end = end;
        last.count++;
      } else {
        groups.push({ end, count: 1 });
      }
    });
    return groups;
  }

  // The transfer list as the web app loaded it: active listings and when they end (replaces what we had).
  // Returns how many listings are at 0 seconds but not yet sold/expired on EA's side.
  function recordTransferList(items) {
    const now = Date.now();
    let ending = 0;
    const ends = items.map(item => {
      const auction = auctionOf(item);
      if (!auction) return null;
      const active = typeof auction.isActiveTrade === "function" ? auction.isActiveTrade() : auction.tradeState === "active";
      const seconds = Number(auction.expires);
      if (active && !(seconds > 0)) ending++;
      return active && seconds > 0 ? now + seconds * 1000 : null;
    }).filter(Boolean);
    saveListingEnds(groupEnds(ends));
    return ending;
  }

  // --- Sold / expired: the script looks at your transfer list itself --------------------------------
  // Every 5 minutes while you have listings, and right after a listing ends. Only the transfer list
  // (what opening it in the web app does), never the market. Each sale/expiry is reported once.
  const LISTING_SEEN_KEY = "pt_listing_seen_v1"; // ["tradeId:closed" | "tradeId:expired"]
  const LISTING_POLL_MS = 5 * 60 * 1000;
  const LISTING_MIN_GAP_MS = 60 * 1000;
  let listingPollTimer = null;
  let dueGroups = [];
  let ownTransferPoll = ""; // why the script loads the list itself; "" = you (or EA) did
  let lastTransferLoad = 0;
  const TL_LOG_KEY = "pt_tl_log_v1"; // last checks, shown in the Transfers tab
  let lastActivity = 0;
  ["pointerdown", "keydown", "wheel"].forEach(type => document.addEventListener(type, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));

  function logTransferCheck(entry) {
    const log = readJson(TL_LOG_KEY, []);
    const last = log[log.length - 1];
    // The same result again (FUT Genie loads the list often): just move the time and count.
    if (last && last.why === entry.why && last.text === entry.text) Object.assign(last, { at: Date.now(), n: (last.n || 1) + 1 });
    else log.push({ at: Date.now(), ...entry });
    writeJson(TL_LOG_KEY, log.slice(-15));
    listeners.forEach(listener => listener());
  }

  // Someone at the pc right now: the tab is in front and was used in the last minute.
  function watchingPc() {
    return !document.hidden && document.hasFocus() && Date.now() - lastActivity < 60 * 1000;
  }

  function getSeenTrades() {
    try {
      const value = JSON.parse(localStorage.getItem(LISTING_SEEN_KEY));
      return Array.isArray(value) ? new Set(value) : null;
    } catch {
      return null;
    }
  }

  // Every load of the list counts (yours, EA's, FUT Genie's): what's new since the last one is reported once.
  // The first time ever only remembers. Returns what it found, for the log.
  function reportTransferChanges(items) {
    const seen = getSeenTrades();
    const now = new Set();
    const sold = [];
    let expired = 0;
    items.forEach(item => {
      const auction = auctionOf(item);
      if (!auction || !auction.tradeId || (auction.tradeState !== "closed" && auction.tradeState !== "expired")) return;
      const key = `${auction.tradeId}:${auction.tradeState}`;
      now.add(key);
      if (seen && seen.has(key)) return;
      if (auction.tradeState === "expired") expired++;
      else sold.push({ name: playerNameFor(item.definitionId, (item._staticData && item._staticData.name) || "item"), price: auction.currentBid || auction.buyNowPrice || 0, bought: boughtPrice(item) });
    });
    try {
      localStorage.setItem(LISTING_SEEN_KEY, JSON.stringify([...now])); // only what's still in the list
    } catch (_) {
      // Reported again next time.
    }
    // Sales go into the log even when you looked yourself (not the first time: unknown when they sold).
    if (seen) recordTransferStatus(items, sold.map(sale => ({ n: sale.name, p: sale.price, b: sale.bought, at: Date.now() })));
    else recordTransferStatus(items, []);
    if ((sold.length || expired) && seen && pcDevice()) window.setTimeout(() => pushRelay(true), 3000); // phone sees it soon
    if (!seen || (!sold.length && !expired)) return { sold: sold.length, expired, sent: !seen ? L("eerste keer: alleen onthouden", "first time: just remembering") : "" };
    const parts = [];
    if (sold.length) {
      const total = sold.reduce((sum, sale) => sum + sale.price, 0);
      parts.push(L(`💰 ${sold.length} verkocht: ${sold.slice(0, 5).map(sale => `${sale.name} ${priceFormat.format(sale.price)}`).join(", ")}${sold.length > 5 ? ", …" : ""}`, `💰 ${sold.length} sold: ${sold.slice(0, 5).map(sale => `${sale.name} ${priceFormat.format(sale.price)}`).join(", ")}${sold.length > 5 ? ", …" : ""}`) +
        ` (+${priceFormat.format(Math.floor(total * 0.95))} na tax)`);
    }
    if (expired) parts.push(L(`⏰ ${expired === 1 ? "1 kaart" : `${expired} kaarten`} niet verkocht – opnieuw listen (Price Watch → Transfers: met opslag op je aankoopprijs)`, `⏰ ${expired === 1 ? "1 card" : `${expired} cards`} not sold – relist (Price Watch → Transfers: with markup on your purchase price)`));
    if (chimeOn()) playChime();
    showToast(L(`Transferlijst: ${parts.join(" · ")}`, `Transfer list: ${parts.join(" · ")}`), true);
    // Busy at the pc right now: the toast is enough. Otherwise also on your phone.
    if (watchingPc()) return { sold: sold.length, expired, sent: L("alleen in beeld (je zat achter de pc)", "only shown on screen (you were at the PC)") };
    const title = sold.length && expired ? L("Verkocht + verlopen", "Sold + expired") : sold.length ? L(`${sold.length} verkocht`, `${sold.length} sold`) : L("Transferlijst verlopen", "Transfer list expired");
    relayCall("notify", { title, text: parts.join("\n") }).then(
      sent => logTransferCheck({ why: "melding", text: sent ? L("ntfy verstuurd", "ntfy sent") : L("geen ntfy-topic ingesteld", "no ntfy topic set") }),
      error => logTransferCheck({ why: "melding", text: L(`ntfy mislukt: ${error.message}`, `ntfy failed: ${error.message}`) }));
    return { sold: sold.length, expired, sent: "ntfy" };
  }

  // Logged out (EA allows one web app at a time: logging in on your phone or in the FUT Genie app logs
  // the pc out): the pc can't see sales any more, so it says so on your phone, once, and again when it's back.
  const LOGGED_OUT_KEY = "pt_logged_out_v1"; // when the pc reported being logged out; 0 = logged in
  let transferLoadFailures = 0;

  function noteLoggedOut() {
    if (!pcDevice() || readJson(LOGGED_OUT_KEY, 0)) return;
    writeJson(LOGGED_OUT_KEY, Date.now());
    showToast(L("⚠️ Uitgelogd bij EA: je transferlijst wordt niet meer gevolgd tot je opnieuw inlogt.", "⚠️ Logged out of EA: your transfer list is no longer tracked until you log in again."), false);
    relayCall("notify", { title: L("Pc uitgelogd bij EA", "PC logged out of EA"), text: L("⚠️ Je pc kan je transferlijst niet meer ophalen (uitgelogd, bijv. omdat je op je telefoon of in de FUT Genie-app inlogde). Verkopen worden niet gemeld tot je op de pc opnieuw inlogt.", "⚠️ Your PC can no longer fetch your transfer list (logged out, e.g. because you logged in on your phone or in the FUT Genie app). Sales won't be reported until you log in again on the PC.") })
      .then(sent => logTransferCheck({ why: "uitgelogd", text: sent ? L("ntfy verstuurd", "ntfy sent") : L("geen ntfy-topic ingesteld", "no ntfy topic set") }),
        error => logTransferCheck({ why: "uitgelogd", text: L(`ntfy mislukt: ${error.message}`, `ntfy failed: ${error.message}`) }));
  }

  function noteTransferLoad(ok) {
    if (!ok) {
      transferLoadFailures++;
      if (transferLoadFailures >= 2) noteLoggedOut(); // once can be the network
      return;
    }
    transferLoadFailures = 0;
    if (!readJson(LOGGED_OUT_KEY, 0)) return;
    writeJson(LOGGED_OUT_KEY, 0);
    if (pcDevice()) relayCall("notify", { title: "Pc weer ingelogd", text: L("✅ Je pc volgt je transferlijst weer; wat in de tussentijd verkocht is komt in de volgende melding.", "✅ Your PC is tracking your transfer list again; anything sold in the meantime will be in the next notification.") }).catch(() => {});
  }

  function scheduleListingPoll(delay, why) {
    window.clearTimeout(listingPollTimer);
    listingPollTimer = null;
    if (delay == null) {
      if (!getListingEnds().length) return; // nothing listed: nothing to watch
      delay = LISTING_POLL_MS;
      why = "elke 5 min";
    }
    listingPollTimer = window.setTimeout(() => pollTransferList(why), delay);
  }

  // One request covers the whole list, and never more than one a minute however many listings end.
  // Ended listings wait in dueGroups; when the list can't be loaded (logged out) you still hear them.
  async function pollTransferList(why) {
    const wait = lastTransferLoad + LISTING_MIN_GAP_MS - Date.now();
    if (wait > 0) return scheduleListingPoll(dueGroups.length ? wait : null, why);
    const due = dueGroups;
    dueGroups = [];
    lastTransferLoad = Date.now();
    ownTransferPoll = why || L("controle", "check");
    const items = await requestPile("requestTransferItems");
    ownTransferPoll = "";
    if (!items) {
      logTransferCheck({ why: why || L("controle", "check"), text: L("transferlijst ophalen mislukt (niet ingelogd?)", "fetching transfer list failed (not logged in?)") });
      if (due.length) listingAlert({ count: due.reduce((sum, group) => sum + group.count, 0) });
      noteTransferLoad(false);
      return scheduleListingPoll(transferLoadFailures < 2 ? 2 * 60 * 1000 : null, why); // check again soon: logged out?
    }
    // The wrapper in installListingWatch did the rest; a listing at 0 seconds: look again in a minute.
    if (items.some(item => { const a = auctionOf(item); return a && a.tradeState === "active" && !(Number(a.expires) > 0); })) scheduleListingPoll(LISTING_MIN_GAP_MS + 2000, L("listing op 0 sec, nog eens", "listing at 0 sec, again"));
    else scheduleListingPoll();
  }

  // Test button: the transfer list fresh from EA now. Watches for the real request to EA's tradepile,
  // so a cached copy shows up as a failed test. Changes found are reported like a normal check.
  async function testTransferPoll() {
    const requests = [];
    let observer = null;
    try {
      observer = new PerformanceObserver(list => list.getEntries().forEach(entry => { if (/tradepile/i.test(entry.name)) requests.push(entry); }));
      observer.observe({ type: "resource" });
    } catch (_) {
      observer = null; // can't see requests: only the result counts
    }
    lastTransferLoad = Date.now();
    ownTransferPoll = "test";
    const items = await requestPile("requestTransferItems");
    ownTransferPoll = "";
    await new Promise(resolve => window.setTimeout(resolve, 800)); // resource entries come in a bit later
    if (observer) observer.disconnect();
    if (!items) return { ok: false, text: L("Transferlijst ophalen mislukt (niet ingelogd in de web app?).", "Fetching transfer list failed (not logged in to the web app?).") };
    const count = state => items.filter(item => { const a = auctionOf(item); return a && a.tradeState === state; }).length;
    const left = items.map(item => { const a = auctionOf(item); return a && a.tradeState === "active" ? Number(a.expires) : 0; }).filter(seconds => seconds > 0);
    const fresh = !observer || requests.length > 0;
    const text = `${L("Transferlijst", "Transfer list")} ${!observer ? L("opgehaald", "fetched") : fresh ? L("vers van EA opgehaald", "freshly fetched from EA") : L("NIET vers opgehaald (oude kopie, geen verzoek naar EA gezien)", "NOT freshly fetched (old copy, no request to EA seen)")}: ` +
      L(`${count("active")} actief, ${count("closed")} verkocht, ${count("expired")} verlopen`, `${count("active")} active, ${count("closed")} sold, ${count("expired")} expired`) +
      (left.length ? ` · eerstvolgende loopt af over ${Math.max(1, Math.round(Math.min(...left) / 60))} min` : "");
    return { ok: fresh, text };
  }

  function scheduleListingAlerts(groups) {
    listingTimers.forEach(timer => window.clearTimeout(timer));
    listingTimers = (groups || getListingEnds())
      .filter(group => group.end > Date.now() - 10 * 60 * 1000) // missed by up to 10 min (page was closed): still say it
      .map(group => window.setTimeout(() => listingDue(group), Math.max(0, group.end - Date.now() + 15000)));
    if (!listingPollTimer) scheduleListingPoll();
  }

  function listingDue(group) {
    saveListingEnds(getListingEnds().filter(item => item.end !== group.end));
    dueGroups.push(group);
    scheduleListingPoll(0, L("listing afgelopen", "listing ended"));
  }

  // Fallback when the transfer list can't be loaded: only the timer is known.
  function listingAlert(group) {
    const what = group.count === 1 ? L("1 kaart", "1 card") : L(`${group.count} kaarten`, `${group.count} cards`);
    if (chimeOn()) playChime();
    showToast(L(`⏰ Transferlijst: listing van ${what} is afgelopen – wat niet verkocht is kun je opnieuw listen.`, `⏰ Transfer list: listing of ${what} has ended – you can relist whatever didn't sell.`), true);
    relayCall("notify", { title: L("Transferlijst verlopen", "Transfer list expired"), text: L(`Listing van ${what} afgelopen. Niet verkocht? Opnieuw listen.`, `Listing of ${what} ended. Not sold? Relist.`) })
      .catch(error => console.warn(L("Price Watch: ntfy-melding mislukt.", "Price Watch: ntfy notification failed."), error));
  }

  // Watch EA's own transfer list calls: loading it, listing one card, relisting the expired ones.
  function installListingWatch() {
    if (typeof services === "undefined" || !services.Item) return;
    const wrap = (method, onSuccess) => {
      const original = services.Item[method];
      if (typeof original !== "function" || original.__ptListing) return;
      const wrapped = function (...args) {
        const observable = original.apply(this, args);
        try {
          if (observable && typeof observable.observe === "function") {
            const context = {};
            observable.observe(context, (sender, response) => {
              sender.unobserve(context);
              try {
                if (response && response.success) onSuccess(response, args);
              } catch (error) {
                console.warn(L("Price Watch: transferlijst-timer niet bijgewerkt.", "Price Watch: transfer list timer not updated."), error);
              }
            });
          }
        } catch (_) {
          // Never get in the way of EA's own request.
        }
        return observable;
      };
      wrapped.__ptListing = true;
      services.Item[method] = wrapped;
    };
    wrap("requestWatchedItems", response => {
      const items = (response.response && response.response.items) || (response.data && response.data.items);
      if (!Array.isArray(items)) return;
      const active = items.filter(item => { const a = auctionOf(item); return a && a.tradeState === "active"; }).length;
      watchListCount = { n: items.length, active, at: Date.now() };
      noteWatchedItems(items);
      if (runBar) renderRunBar();
    });
    wrap("requestTransferItems", response => {
      const items = (response.response && response.response.items) || (response.data && response.data.items);
      if (!Array.isArray(items)) return;
      lastTransferLoad = Date.now();
      noteTransferLoad(true);
      const why = ownTransferPoll || L("geladen door jou, de web app of FUT Genie", "loaded by you, the web app or FUT Genie");
      recordTransferList(items);
      rememberTransferItems(items);
      const found = reportTransferChanges(items);
      const active = items.filter(item => { const a = auctionOf(item); return a && a.tradeState === "active"; }).length;
      logTransferCheck({ why, text: L(`${active} actief · ${found.sold ? `${found.sold} nieuw verkocht` : "niets nieuw verkocht"} · ${found.expired ? `${found.expired} nieuw verlopen` : "niets nieuw verlopen"}${found.sent ? ` → ${found.sent}` : ""}`, `${active} active · ${found.sold ? `${found.sold} newly sold` : "nothing newly sold"} · ${found.expired ? `${found.expired} newly expired` : "nothing newly expired"}${found.sent ? ` → ${found.sent}` : ""}`) });
    });
    // Listing one card: (item, startingBid, buyNowPrice, duration in seconds).
    wrap("list", (response, args) => {
      // What you paid, remembered the moment you list it: EA sets lastSalePrice to 0 once the card has sold,
      // and a card listed straight from your club / Unassigned may sell before the transfer list is opened.
      const listed = args[0];
      const paid = listed && (listed.lastSalePrice > 0 ? listed.lastSalePrice : wonPrices.get(listed.id) || 0);
      if (listed && listed.id && paid > 0) writeJson(BOUGHT_KEY, { ...readJson(BOUGHT_KEY, {}), [listed.id]: paid });
      const duration = Number(args[3]);
      if (duration > 0) saveListingEnds(groupEnds(getListingEnds().flatMap(group => Array(group.count).fill(group.end)).concat(Date.now() + duration * 1000)));
    });
    // "Re-list all": ask for the transfer list once, the wrapper above takes the new end times from it.
    wrap("relistExpiredAuctions", () => window.setTimeout(() => {
      try {
        markPileDirty("requestTransferItems");
        services.Item.requestTransferItems();
      } catch (_) {
        // The next time you open the transfer list.
      }
    }, 1500));
    scheduleListingAlerts();
    // Sold while the page was closed, or listed from the game/app: look once shortly after loading.
    scheduleListingPoll(20 * 1000, L("na laden", "after load"));
  }

  // --- Transfer list status and sales, for the Transfers tab (and via the gist on your phone) ------
  const TL_STATUS_KEY = "pt_tl_status_v1"; // { at, active, next, expired, sold }
  const SALES_KEY = "pt_sales_v1"; // [{ n, p, b, at }], last 7 days
  const SALES_KEEP_MS = 7 * 24 * 3600 * 1000;
  const TL_IDS_KEY = "pt_tl_ids_v1"; // definitionIds on the transfer list (not sold)
  // What you paid, per card on the transfer list: EA drops it (lastSalePrice) once a card is sold.
  const BOUGHT_KEY = "pt_bought_v1"; // { itemId: coins }, only cards still on the list
  function rememberBought(items) {
    const known = readJson(BOUGHT_KEY, {});
    const next = {};
    items.forEach(item => {
      const price = item.lastSalePrice > 0 ? item.lastSalePrice : known[item.id];
      if (item.id && price > 0) next[item.id] = price;
    });
    writeJson(BOUGHT_KEY, next);
  }

  function boughtPrice(item) {
    return item.lastSalePrice > 0 ? item.lastSalePrice : readJson(BOUGHT_KEY, {})[item.id] || 0;
  }

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Only for this session.
    }
  }

  function recordTransferStatus(items, newSales) {
    const count = state => items.filter(item => { const a = auctionOf(item); return a && a.tradeState === state; }).length;
    const ends = getListingEnds();
    writeJson(TL_STATUS_KEY, { at: Date.now(), active: count("active"), next: ends.length ? ends[0].end : 0, expired: count("expired"), sold: count("closed") });
    // Cards still on the list: the pc sends their FUT Genie prices to the phone too.
    writeJson(TL_IDS_KEY, [...new Set(items.filter(item => { const a = auctionOf(item); return a && a.tradeState !== "closed"; }).map(item => item.definitionId).filter(Boolean))].slice(0, 120));
    if (newSales.length) {
      const since = Date.now() - SALES_KEEP_MS;
      writeJson(SALES_KEY, readJson(SALES_KEY, []).filter(sale => sale.at > since).concat(newSales).slice(-300));
    }
    listeners.forEach(listener => listener());
  }

  // What the pc puts in the gist: status + the sales of the last 24 hours.
  function transferStatusForRelay() {
    const since = Date.now() - 24 * 3600 * 1000;
    return { ...readJson(TL_STATUS_KEY, {}), sales: readJson(SALES_KEY, []).filter(sale => sale.at > since).slice(-40) };
  }

  // Prices for the phone beyond the watch list: cards on your transfer list, and (club rise on) your club's
  // cards as far as FUT Genie already has them. In the gist next to "p"; the phone keeps them the same way.
  function extraPrices(ids) {
    const prices = {};
    ids.concat(getClubRise().cards.map(card => card.d)).slice(0, 600).forEach(id => {
      const entry = geniePrice(id);
      if (entry) prices[id] = [entry.price, Number(entry._fetchedAt) || Date.now()];
    });
    return prices;
  }

  // Newest of this device's own view and the pc's (via the gist).
  function transferStatusNow() {
    const own = { ...readJson(TL_STATUS_KEY, {}), sales: readJson(SALES_KEY, []), own: true };
    const pc = getRelay().pcTransfer;
    return pc && (pc.at || 0) > (own.at || 0) ? { ...pc, own: false } : own;
  }

  // Profit after the 5% tax when selling at `price` a card bought for `bought`.
  function netProfit(price, bought) {
    return Math.floor(price * (1 - EA_TAX)) - bought;
  }

  function signedCoins(value) {
    return `${value >= 0 ? "+" : "−"}${priceFormat.format(Math.abs(value))}`;
  }

  // --- Search counter: local visibility into transfer-market activity -------------------------------
  // EA doesn't publish a limit; a few hundred searches an hour is where people start getting blocked.
  const SEARCH_LOG_KEY = "pt_search_log_v1"; // timestamps of transfer-market search calls observed in this browser
  const SEARCH_LIMIT_KEY = "pt_search_limit_v1";
  const SEARCH_ALERT_STATE_KEY = "pt_search_alert_state_v1";
  const SEARCH_LIMIT_DEFAULT = 30; // Personal reminder threshold only; not an EA limit or a safe-use target.
  const SEARCH_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // At most one reminder of each level per hour.
  let searchLog = null;

  function getSearchLog() {
    if (!searchLog) {
      searchLog = readJson(SEARCH_LOG_KEY, []);
      if (!Array.isArray(searchLog)) searchLog = [];
    }
    const since = Date.now() - 24 * 3600 * 1000;
    while (searchLog.length && searchLog[0] < since) searchLog.shift();
    return searchLog;
  }

  function searchLimit() {
    const value = Number(readJson(SEARCH_LIMIT_KEY, SEARCH_LIMIT_DEFAULT));
    return value >= 10 ? value : SEARCH_LIMIT_DEFAULT;
  }

  function searchCounts() {
    const log = getSearchLog();
    const now = Date.now();
    return { hour: log.filter(time => time > now - 3600 * 1000).length, tenMinutes: log.filter(time => time > now - 600 * 1000).length, day: log.length };
  }

  function showSearchReminder(level, message) {
    const now = Date.now();
    const state = readJson(SEARCH_ALERT_STATE_KEY, {}) || {};
    const last = Number(state[level]) || 0;
    if (now - last < SEARCH_ALERT_COOLDOWN_MS) return;
    state[level] = now;
    writeJson(SEARCH_ALERT_STATE_KEY, state);
    showToast(message, false);
  }

  function logSearch() {
    getSearchLog().push(Date.now());
    writeJson(SEARCH_LOG_KEY, getSearchLog());
    const { hour } = searchCounts();
    const limit = searchLimit();
    const near = Math.max(1, Math.ceil(limit * 0.8));
    if (hour >= limit) {
      showSearchReminder("limit", L(`Zoekactiviteit hoog: ${hour}/${limit} transfermarktzoekacties gestart in het afgelopen uur. Dit is jouw lokale herinneringsgrens, geen melding of banstatus van EA.`, `High search activity: ${hour}/${limit} transfer market searches started in the past hour. This is your local reminder limit, not an EA notice or ban status.`));
    } else if (hour >= near) {
      showSearchReminder("near", L(`Let op: ${hour}/${limit} transfermarktzoekacties gestart in het afgelopen uur. Je nadert je zelf ingestelde herinneringsgrens. Dit zegt niet dat EA je heeft geblokkeerd.`, `Heads up: ${hour}/${limit} transfer market searches started in the past hour. You're nearing your own reminder limit. This doesn't mean EA has blocked you.`));
    }
    updateSearchBadges();
  }

  function updateSearchBadges() {
    const counts = searchCounts();
    const limit = searchLimit();
    document.querySelectorAll(".pt-search-count").forEach(node => {
      node.textContent = `🔎 ${counts.hour}/u`;
      node.title = L(`Waargenomen transfermarktzoekacties in deze browser: ${counts.tenMinutes} in 10 min, ${counts.hour} in 1 uur, ${counts.day} in 24 uur. Jouw herinneringsgrens: ${limit}/uur. Dit is geen EA-banstatus.`, `Observed transfer market searches in this browser: ${counts.tenMinutes} in 10 min, ${counts.hour} in 1 hour, ${counts.day} in 24 hours. Your reminder limit: ${limit}/hour. This is not an EA ban status.`);
      node.classList.toggle("pt-search-hot", counts.hour >= limit);
    });
  }

  // --- Relist with a markup on what you paid: expired cards → BIN = bought price + x% -------------
  // Only when you press the button; one card at a time with a pause, like listing them yourself.
  const RELIST_KEY = "pt_relist_v1"; // { pct, duration }
  const RELIST_DURATIONS = [[3600, L("1 uur", "1 hour")], [10800, L("3 uur", "3 hours")], [21600, L("6 uur", "6 hours")], [43200, L("12 uur", "12 hours")], [86400, L("1 dag", "1 day")], [259200, L("3 dagen", "3 days")]];
  const RELIST_PAUSE_MS = 1500;

  function relistSettings() {
    return Object.assign({ pct: 10, duration: 3600 }, readJson(RELIST_KEY, {}));
  }

  function relistPlan(items, pct) {
    return items.map(item => {
      const name = playerNameFor(item.definitionId, (item._staticData && item._staticData.name) || "item");
      const bought = boughtPrice(item);
      const genieNow = (geniePrice(item.definitionId, item.resourceId) || {}).price || 0;
      if (!bought) return { item, name, genie: genieNow, skip: true };
      const bin = Math.max(200, roundUpToStep(bought * (1 + pct / 100)));
      return { item, name, bought, bin, start: Math.max(150, priceStepBelow(bin)), net: netProfit(bin, bought), genie: genieNow };
    });
  }

  function listItem(item, start, bin, duration) {
    return new Promise(resolve => {
      const owner = {};
      const timer = window.setTimeout(() => resolve(false), 15000);
      try {
        services.Item.list(item, start, bin, duration).observe(owner, (observable, response) => {
          observable.unobserve(owner);
          window.clearTimeout(timer);
          resolve(!!(response && response.success));
        });
      } catch (error) {
        window.clearTimeout(timer);
        resolve(false);
      }
    });
  }

  // --- Club price rises (pc, FUT Genie): a push when a tradeable card in your club went up x% ------
  // Compared with what you paid, or (packed cards) the price when the script first saw it. The club is
  // read like the Club screen does, every 12 hours; prices come from FUT Genie every 15 minutes.
  const CLUB_RISE_KEY = "pt_club_rise_v1"; // { on, pct, min, scannedAt, checkedAt, cards: [{ i, d, n, r, b, base, now, alerted }] }
  const CLUB_RISE_SCAN_MS = 12 * 3600 * 1000;
  const CLUB_RISE_CHECK_MS = 15 * 60 * 1000;
  let clubRiseBusy = "";

  function getClubRise() {
    return Object.assign({ on: false, pct: 20, min: 10000, scannedAt: 0, checkedAt: 0, cards: [] }, readJson(CLUB_RISE_KEY, {}));
  }

  function saveClubRise(patch) {
    writeJson(CLUB_RISE_KEY, Object.assign(getClubRise(), patch));
    listeners.forEach(listener => listener());
  }

  async function scanClubRise() {
    if (!pcDevice() || clubRiseBusy || typeof services === "undefined" || !services.Club) return;
    clubRiseBusy = L("club lezen…", "reading club…");
    listeners.forEach(listener => listener());
    try {
      const items = await clubItems(() => {});
      const old = new Map(getClubRise().cards.map(card => [card.i, card]));
      const cards = items.filter(item => item && item.isPlayer && item.isPlayer() && !item.concept &&
          !(item.isTradeable && !item.isTradeable()) && !(item.isLimitedUse && item.isLimitedUse()))
        .map(item => {
          const before = old.get(item.id) || {};
          return { i: item.id, d: item.definitionId, n: playerNameFor(item.definitionId, item.displayName), r: item.rating,
            b: item.lastSalePrice > 0 ? item.lastSalePrice : 0, base: before.base || 0, now: before.now || 0, alerted: before.alerted || 0 };
        });
      saveClubRise({ cards, scannedAt: Date.now() });
    } catch (error) {
      saveClubRise({ scannedAt: Date.now() - CLUB_RISE_SCAN_MS + 30 * 60 * 1000 }); // try again in half an hour
      console.warn(L("Price Watch: club lezen voor prijsstijgingen mislukt.", "Price Watch: reading club for price rises failed."), error);
    } finally {
      clubRiseBusy = "";
    }
    await checkClubRise(true);
  }

  async function checkClubRise(force) {
    const state = getClubRise();
    if (!pcDevice() || !state.on || clubRiseBusy || !state.cards.length) return;
    if (!force && Date.now() - state.checkedAt < CLUB_RISE_CHECK_MS) return;
    clubRiseBusy = L("prijzen…", "prices…");
    listeners.forEach(listener => listener());
    try {
      const ids = [...new Set(state.cards.map(card => card.d))];
      for (let i = 0; i < ids.length; i += 150) await fetchGeniePrices(ids.slice(i, i + 150));
      const risen = [];
      state.cards.forEach(card => {
        const price = (geniePrice(card.d) || {}).price;
        if (!price) return;
        card.now = price;
        if (!card.base) card.base = card.b || price;
        if (card.alerted && price < card.base * (1 + state.pct / 200)) card.alerted = 0; // fell back: start over
        if (price < state.min) return;
        if (price >= Math.max(card.base, card.alerted) * (1 + state.pct / 100)) {
          risen.push(card);
          card.alerted = price;
        }
      });
      saveClubRise({ cards: state.cards, checkedAt: Date.now() });
      if (risen.length) {
        const lines = risen.sort((a, b) => b.now / b.base - a.now / a.base).slice(0, 6).map(card =>
          `${card.n} (${card.r}): ${priceFormat.format(card.base)} → ${priceFormat.format(card.now)} (+${Math.round((card.now / card.base - 1) * 100)}%)` +
          (card.b ? L(` · verkopen = ${signedCoins(netProfit(card.now, card.b))} na tax`, ` · sell = ${signedCoins(netProfit(card.now, card.b))} after tax`) : ""));
        if (chimeOn()) playChime();
        showToast(L(`📈 Gestegen in je club: ${lines.join(" · ")}`, `📈 Risen in your club: ${lines.join(" · ")}`), true);
        relayCall("notify", { title: risen.length === 1 ? `${risen[0].n} gestegen` : `${risen.length} clubkaarten gestegen`, text: lines.join("\n") })
          .catch(error => console.warn(L("Price Watch: ntfy-melding mislukt.", "Price Watch: ntfy notification failed."), error));
      }
    } finally {
      clubRiseBusy = "";
      listeners.forEach(listener => listener());
    }
  }

  function topRisers(state) {
    return state.cards.filter(card => card.now && card.base && card.now >= state.min)
      .sort((a, b) => b.now / b.base - a.now / a.base).slice(0, 5)
      .map(card => ({ n: card.n, r: card.r, b: card.b, base: card.base, now: card.now }));
  }

  // What the pc puts in the gist for the phone (settings + status, not the whole club).
  function clubRiseForRelay() {
    const state = getClubRise();
    return { on: state.on, pct: state.pct, min: state.min, settingsAt: state.settingsAt || 0, scannedAt: state.scannedAt,
      checkedAt: state.checkedAt, count: state.cards.length, top: topRisers(state), at: Date.now() };
  }

  // Pc: its own state. Phone: the pc's state from the gist, with a change sent from here on top until the pc has it.
  function clubRiseView() {
    if (pcDevice()) {
      const state = getClubRise();
      return { ...state, count: state.cards.length, top: topRisers(state), busy: !!clubRiseBusy, busyText: clubRiseBusy };
    }
    const relay = getRelay();
    const pc = relay.pcClubRise || { on: false, pct: 20, min: 10000, count: 0, top: [] };
    const sent = relay.phoneRise;
    const pending = !!(sent && sent.at > (pc.settingsAt || 0));
    return { ...pc, ...(pending ? { on: sent.on, pct: sent.pct, min: sent.min } : {}), top: pc.top || [], pending, busy: false, pcAt: pc.at || 0 };
  }

  function changeClubRise(patch) {
    if (pcDevice()) {
      const { scanAt, ...settings } = patch;
      saveClubRise({ ...settings, settingsAt: Date.now() });
      if (scanAt || (settings.on && !getClubRise().cards.length)) scanClubRise();
      pushRelay(true);
      return;
    }
    // Phone: into its own gist file; the pc reads it every minute.
    const view = clubRiseView();
    const sent = { on: view.on, pct: view.pct, min: view.min, ...patch, at: Date.now() };
    saveRelay({ phoneRise: sent });
    const relay = getRelay();
    relayCall("push", { gistId: relay.gistId, file: RELAY_SETTINGS_FILE, content: JSON.stringify(sent) })
      .catch(error => showToast(L(`Instelling niet verstuurd: ${error.message}`, `Setting not sent: ${error.message}`), false));
  }

  // Pc: a change from the phone (newer than the last one here) wins; "scanAt": read the club now.
  let phoneSettingsCheckedAt = 0;
  async function checkPhoneSettings() {
    const relay = getRelay();
    if (!pcDevice() || !relay.hasToken || !relay.gistId || Date.now() - phoneSettingsCheckedAt < RELAY_LIST_CHECK_MS) return;
    phoneSettingsCheckedAt = Date.now();
    let sent;
    try {
      sent = JSON.parse(await relayCall("pull", { gistId: relay.gistId, file: RELAY_SETTINGS_FILE }));
    } catch (_) {
      return; // no file yet: nothing set on the phone
    }
    const state = getClubRise();
    if (!sent || !(sent.at > (state.settingsAt || 0))) return;
    saveClubRise({ on: !!sent.on, pct: Math.max(5, Number(sent.pct) || 20), min: Math.max(0, Number(sent.min) || 0), settingsAt: sent.at });
    if (sent.on && (sent.scanAt || !state.cards.length)) await scanClubRise();
    showToast(L(`Price Watch: clubkaart-meldingen ${sent.on ? `aan (${sent.pct}%)` : "uit"} gezet vanaf je telefoon.`, `Price Watch: club card alerts ${sent.on ? `on (${sent.pct}%)` : "off"} set from your phone.`), true);
    pushRelay(true);
  }

  let clubRiseStarted = false;
  function startClubRise() {
    if (clubRiseStarted || !pcDevice()) return;
    clubRiseStarted = true;
    const step = () => {
      const state = getClubRise();
      if (!state.on) return;
      if (Date.now() - state.scannedAt > CLUB_RISE_SCAN_MS) scanClubRise();
      else checkClubRise(false);
    };
    window.setTimeout(step, 60 * 1000);
    window.setInterval(step, 60 * 1000);
  }

  // --- Transfers tab ----------------------------------------------------------------------------------
  function buildTransferSection(root) {
    const card = el("div", "pt-watch-card pt-transfer-card");
    root.appendChild(card);
    const heading = el("div", "pt-watch-heading");
    heading.append(el("h2", "pt-watch-title", "Transfers"));
    card.appendChild(heading);

    // Status of the transfer list + recent sales.
    const statusBlock = el("div", "pt-tl-block");
    const statusLine = el("div", "pt-tl-line");
    const salesLine = el("div", "pt-tl-line");
    const salesList = el("div", "pt-tl-sales");
    statusBlock.append(el("h3", "pt-tl-title", L("📋 Transferlijst", "📋 Transfer list")), statusLine, salesLine, salesList);
    // Test: fetch the list now, result to your phone via ntfy (only a pc with FUT Genie sends ntfy).
    const checkLog = el("div", "pt-tl-sales");
    if (pcDevice()) {
      const testButton = el("button", "pt-watch-refresh", L("🧪 Test: lijst nu ophalen + ntfy", "🧪 Test: fetch list now + ntfy"));
      testButton.type = "button";
      const testInfo = el("div", "pt-tl-line pt-muted");
      statusBlock.append(testButton, testInfo, el("div", "pt-tl-line", L("Laatste controles (nieuwste bovenaan):", "Latest checks (newest first):")), checkLog);
      testButton.addEventListener("click", async () => {
        testButton.disabled = true;
        testInfo.textContent = L("Transferlijst bij EA ophalen…", "Fetching transfer list from EA…");
        const result = await testTransferPoll();
        testInfo.textContent = result.text;
        try {
          const sent = await relayCall("notify", { title: result.ok ? L("Test transferlijst geslaagd", "Transfer list test passed") : L("Test transferlijst mislukt", "Transfer list test failed"), text: result.text });
          testInfo.textContent += sent ? L(" · ntfy-melding verstuurd", " · ntfy notification sent") : L(" · geen ntfy-topic ingesteld (Instellingen → meldingen)", " · no ntfy topic set (Settings → notifications)");
        } catch (error) {
          testInfo.textContent += L(` · ntfy mislukt: ${error.message}`, ` · ntfy failed: ${error.message}`);
        }
        testButton.disabled = false;
      });
    }

    // Relist with a markup.
    const relistBlock = el("div", "pt-tl-block");
    const settings = relistSettings();
    const pctRow = el("div", "pt-stock-list-buttons");
    const pctButtons = [10, 15].map(pct => {
      const button = el("button", "pt-watch-refresh pt-pct-btn", `+${pct}%`);
      button.type = "button";
      button.__pct = pct;
      return button;
    });
    const customLabel = el("label", "pt-goal");
    const custom = el("input", "pt-target-input");
    custom.inputMode = "numeric";
    custom.placeholder = "eigen";
    customLabel.append(el("span", "pt-muted", L("of", "or")), custom, el("span", "pt-muted", "%"));
    const durationLabel = el("label", "pt-goal");
    const duration = el("select", "pt-stock-select");
    RELIST_DURATIONS.forEach(([seconds, label]) => duration.appendChild(new Option(label, String(seconds))));
    duration.value = String(settings.duration);
    durationLabel.append(el("span", "pt-muted", L("Duur", "Duration")), duration);
    const load = el("button", "pt-watch-refresh", L("↻ Verlopen kaarten laden", "↻ Load expired cards"));
    const go = el("button", "btn-standard call-to-action pt-relist-go", "▶ Listen");
    [load, go].forEach(button => { button.type = "button"; });
    pctRow.append(...pctButtons, customLabel, durationLabel, load);
    const relistInfo = el("div", "pt-tl-line pt-muted", L("Kies een opslag: de kaarten die niet verkocht zijn gaan opnieuw op de lijst met BIN = aankoopprijs + dat percentage.", "Choose a markup: cards that didn't sell go back on the list with BIN = purchase price + that percentage."));
    const relistTable = el("div", "pt-tl-sales pt-relist-table");
    relistBlock.append(el("h3", "pt-tl-title", L("🔁 Opnieuw listen met opslag op je aankoopprijs", "🔁 Relist with markup on your purchase price")), pctRow, relistInfo, relistTable, go);

    let expired = null;
    let plan = [];
    let relistBusy = false;
    const pctNow = () => {
      const typed = Number(String(custom.value).replace(",", "."));
      return custom.value && Number.isFinite(typed) && typed > -50 && typed <= 500 ? typed : relistSettings().pct;
    };
    const showPlan = () => {
      const pct = pctNow();
      pctButtons.forEach(button => button.classList.toggle("pt-tab-active", !custom.value && button.__pct === pct));
      relistTable.textContent = "";
      if (!expired) {
        go.style.display = "none";
        return;
      }
      plan = relistPlan(expired, pct);
      const ready = plan.filter(row => !row.skip);
      plan.forEach(row => {
        const line = el("div", "pt-tl-sale");
        if (row.skip) {
          line.textContent = L(`${row.name}: geen aankoopprijs bekend (bijv. uit een pack) – overgeslagen`, `${row.name}: no purchase price known (e.g. from a pack) – skipped`);
          line.classList.add("pt-muted");
        } else {
          line.append(L(`${row.name}: gekocht ${priceFormat.format(row.bought)} → BIN ${priceFormat.format(row.bin)} `, `${row.name}: bought ${priceFormat.format(row.bought)} → BIN ${priceFormat.format(row.bin)} `),
            el("span", row.net >= 0 ? "pt-pos" : "pt-neg", `${signedCoins(row.net)} na tax`),
            row.genie ? el("span", row.genie < row.bin ? "pt-neg" : "pt-muted", ` · Genie ${priceFormat.format(row.genie)}${row.genie < row.bin ? L(" (lager dan je BIN)", " (lower than your BIN)") : ""}`) : "");
        }
        relistTable.appendChild(line);
      });
      const total = ready.reduce((sum, row) => sum + row.net, 0);
      relistInfo.textContent = expired.length
        ? L(`${expired.length} verlopen · ${ready.length} met aankoopprijs · opslag ${pct}% · samen ${signedCoins(total)} winst na tax als alles verkoopt`, `${expired.length} expired · ${ready.length} with purchase price · markup ${pct}% · together ${signedCoins(total)} profit after tax if everything sells`)
        : L("Geen verlopen kaarten op je transferlijst.", "No expired cards on your transfer list.");
      go.textContent = L(`▶ ${ready.length} kaart(en) listen voor ${RELIST_DURATIONS.find(([seconds]) => seconds === Number(duration.value))[1]}`, `▶ List ${ready.length} card(s) for ${RELIST_DURATIONS.find(([seconds]) => seconds === Number(duration.value))[1]}`);
      go.style.display = ready.length ? "" : "none";
      go.disabled = relistBusy;
    };
    const loadExpired = async () => {
      load.disabled = true;
      relistInfo.textContent = L("Transferlijst laden…", "Loading transfer list…");
      const items = await requestPile("requestTransferItems");
      load.disabled = false;
      if (!items) {
        relistInfo.textContent = L("Transferlijst laden mislukt (niet ingelogd in de web app?).", "Loading transfer list failed (not logged in to the web app?).");
        return;
      }
      expired = items.filter(item => { const a = auctionOf(item); return a && a.tradeState === "expired"; });
      await fetchGeniePrices(expired.map(item => item.definitionId));
      showPlan();
    };
    pctButtons.forEach(button => button.addEventListener("click", () => {
      custom.value = "";
      writeJson(RELIST_KEY, { ...relistSettings(), pct: button.__pct });
      if (expired) showPlan();
      else loadExpired();
    }));
    custom.addEventListener("input", () => {
      if (custom.value && Number.isFinite(pctNow())) writeJson(RELIST_KEY, { ...relistSettings(), pct: pctNow() });
      if (expired) showPlan();
    });
    custom.addEventListener("change", () => { if (!expired) loadExpired(); });
    duration.addEventListener("change", () => {
      writeJson(RELIST_KEY, { ...relistSettings(), duration: Number(duration.value) });
      showPlan();
    });
    load.addEventListener("click", loadExpired);
    go.addEventListener("click", async () => {
      const rows = plan.filter(row => !row.skip);
      if (!rows.length || relistBusy) return;
      relistBusy = true;
      go.disabled = true;
      let listed = 0;
      let failed = 0;
      for (let i = 0; i < rows.length; i++) {
        if (i) await new Promise(resolve => window.setTimeout(resolve, RELIST_PAUSE_MS));
        relistInfo.textContent = L(`Listen ${i + 1}/${rows.length}: ${rows[i].name} voor ${priceFormat.format(rows[i].bin)}…`, `Listing ${i + 1}/${rows.length}: ${rows[i].name} for ${priceFormat.format(rows[i].bin)}…`);
        if (await listItem(rows[i].item, rows[i].start, rows[i].bin, Number(duration.value))) listed++;
        else failed++;
      }
      relistBusy = false;
      showToast(L(`🔁 ${listed} kaart(en) opnieuw gelist`, `🔁 ${listed} card(s) relisted`) + (failed ? L(`, ${failed} mislukt (bijv. buiten EA's prijsgrenzen voor die kaart)`, `, ${failed} failed (e.g. outside EA's price limits for that card)`) : "") + ".", !failed);
      await loadExpired();
    });

    // Search counter.
    const searchBlock = el("div", "pt-tl-block");
    const searchLine = el("div", "pt-tl-line");
    const limitLabel = el("label", "pt-goal");
    const limitInput = el("input", "pt-target-input");
    limitInput.inputMode = "numeric";
    limitInput.value = String(searchLimit());
    limitInput.addEventListener("change", () => {
      const value = parsePrice(limitInput.value);
      writeJson(SEARCH_LIMIT_KEY, value && value >= 10 ? value : SEARCH_LIMIT_DEFAULT);
      limitInput.value = String(searchLimit());
      render();
    });
    limitLabel.append(el("span", "pt-muted", L("Waarschuwen bij", "Warn at")), limitInput, el("span", "pt-muted", L("per uur", "per hour")));
    searchBlock.append(el("h3", "pt-tl-title", L("🔎 Transfermarkt-zoekteller", "🔎 Transfer market search counter")), searchLine, limitLabel,
      el("div", "pt-tl-line pt-muted", L("Telt transfermarktzoekacties die deze browser via de EA Web App ziet starten. Dit is alleen een persoonlijke herinneringsgrens: geen officiële EA-limiet en geen indicatie dat je account geblokkeerd is. Pc en telefoon hebben ieder hun eigen lokale teller; EA kan activiteit over apparaten combineren.", "Counts transfer market searches that this browser sees starting via the EA Web App. This is only a personal reminder limit: not an official EA limit and no indication that your account is blocked. PC and phone each have their own local counter; EA may combine activity across devices.")),
      el("div", "pt-tl-line pt-muted", L("BIN-scan: alleen na een handmatige klik, maximaal 3 zoekopdrachten per scan met 12–18 seconden pauze, maximaal 3 eigen scannerverzoeken per 10 minuten en 6 per uur, plus 15 minuten cooldown per speler. Bij veel andere transfermarktactiviteit kan de lokale druktebeveiliging de scan uitstellen. Alleen een expliciete EA-rate-limitreactie wordt als zodanig gemeld; een time-out of algemene fout is niet automatisch een softban. De pauze na een fout duurt 30 minuten. Dit is geen garantie tegen marktbeperkingen.", "BIN scan: only after a manual click, at most 3 searches per scan with a 12–18 second pause, at most 3 own scanner requests per 10 minutes and 6 per hour, plus a 15 minute cooldown per player. With a lot of other transfer market activity, the local busy protection may postpone the scan. Only an explicit EA rate limit response is reported as such; a timeout or general error is not automatically a soft ban. The pause after an error lasts 30 minutes. This is no guarantee against market restrictions.")));

    // Club price rises.
    const riseBlock = el("div", "pt-tl-block");
    const riseRow = el("div", "pt-stock-list-buttons");
    const riseOnLabel = el("label", "pt-goal");
    const riseOn = el("input");
    riseOn.type = "checkbox";
    riseOnLabel.append(riseOn, el("span", "", "Melden"));
    const risePctLabel = el("label", "pt-goal");
    const risePct = el("input", "pt-target-input");
    const riseMinLabel = el("label", "pt-goal");
    const riseMin = el("input", "pt-target-input");
    [risePct, riseMin].forEach(input => { input.inputMode = "numeric"; });
    risePctLabel.append(el("span", "pt-muted", L("bij", "at")), risePct, el("span", "pt-muted", "% stijging"));
    riseMinLabel.append(el("span", "pt-muted", L("kaarten vanaf", "cards from")), riseMin);
    const riseScan = el("button", "pt-watch-refresh", L("↻ Club nu lezen", "↻ Read club now"));
    riseScan.type = "button";
    riseRow.append(riseOnLabel, risePctLabel, riseMinLabel, riseScan);
    const riseLine = el("div", "pt-tl-line");
    const riseList = el("div", "pt-tl-sales");
    riseBlock.append(el("h3", "pt-tl-title", L("📈 Prijsstijging van je clubkaarten", "📈 Price rise of your club cards")), riseRow, riseLine, riseList);
    const fillRiseInputs = () => {
      const view = clubRiseView();
      riseOn.checked = view.on;
      if (document.activeElement !== risePct) risePct.value = String(view.pct);
      if (document.activeElement !== riseMin) riseMin.value = priceFormat.format(view.min);
    };
    fillRiseInputs();
    riseOn.addEventListener("change", () => changeClubRise({ on: riseOn.checked }));
    risePct.addEventListener("change", () => changeClubRise({ pct: Math.max(5, parsePrice(risePct.value) || 20) }));
    riseMin.addEventListener("change", () => changeClubRise({ min: parsePrice(riseMin.value) || 0 }));
    riseScan.addEventListener("click", () => changeClubRise({ scanAt: Date.now() }));

    card.append(statusBlock, relistBlock, searchBlock, riseBlock);

    function render() {
      const status = transferStatusNow();
      const where = status.own ? "" : L(" (via je pc)", " (via your PC)");
      statusLine.textContent = status.at
        ? L(`${status.active || 0} gelist`, `${status.active || 0} listed`) + (status.next > Date.now() ? L(` · volgende loopt af om ${formatTime(status.next)}`, ` · next one expires at ${formatTime(status.next)}`) : "") +
          L(` · ${status.expired || 0} verlopen · ${status.sold || 0} verkocht (nog niet opgeruimd) · bijgewerkt ${formatDayTime(status.at)}${where}`, ` · ${status.expired || 0} expired · ${status.sold || 0} sold (not cleared yet) · updated ${formatDayTime(status.at)}${where}`)
        : L("Nog niet bekend: open één keer je transferlijst in de web app.", "Not known yet: open your transfer list once in the web app.");
      const since = Date.now() - 24 * 3600 * 1000;
      const sales = (status.sales || []).filter(sale => sale.at > since).reverse();
      const income = sales.reduce((sum, sale) => sum + Math.floor(sale.p * (1 - EA_TAX)), 0);
      const known = sales.filter(sale => sale.b > 0);
      const profit = known.reduce((sum, sale) => sum + netProfit(sale.p, sale.b), 0);
      salesLine.textContent = sales.length
        ? L(`Verkocht in 24 uur: ${sales.length} · ${priceFormat.format(income)} na tax`, `Sold in 24 hours: ${sales.length} · ${priceFormat.format(income)} after tax`) + (known.length ? L(` · winst ${signedCoins(profit)}${known.length < sales.length ? ` (van ${known.length} met aankoopprijs)` : ""}`, ` · profit ${signedCoins(profit)}${known.length < sales.length ? ` (of ${known.length} with purchase price)` : ""}`) : "")
        : L("Verkocht in 24 uur: nog niets gezien.", "Sold in 24 hours: nothing seen yet.");
      checkLog.textContent = "";
      readJson(TL_LOG_KEY, []).slice().reverse().forEach(entry => {
        checkLog.appendChild(el("div", "pt-tl-sale pt-muted", `${formatDayTime(entry.at)}${entry.n > 1 ? ` (${entry.n}×)` : ""} · ${entry.why}: ${entry.text}`));
      });
      salesList.textContent = "";
      sales.slice(0, 10).forEach(sale => {
        const line = el("div", "pt-tl-sale", `${formatTime(sale.at)} ${sale.n} ${priceFormat.format(sale.p)}`);
        if (sale.b > 0) {
          const net = netProfit(sale.p, sale.b);
          line.append(L(` (gekocht ${priceFormat.format(sale.b)} → `, ` (bought ${priceFormat.format(sale.b)} → `), el("span", net >= 0 ? "pt-pos" : "pt-neg", signedCoins(net)), ")");
        }
        salesList.appendChild(line);
      });

      const counts = searchCounts();
      searchLine.textContent = L(`${counts.tenMinutes} in 10 min · ${counts.hour} in het afgelopen uur · ${counts.day} in 24 uur`, `${counts.tenMinutes} in 10 min · ${counts.hour} in the past hour · ${counts.day} in 24 hours`);
      searchLine.classList.toggle("pt-neg", counts.hour >= searchLimit());

      const rise = clubRiseView();
      const relay = getRelay();
      // Phone: set it here, the pc (FUT Genie) does the work; needs the token to send.
      riseBlock.style.display = pcDevice() || (relay.hasToken && relay.gistId) ? "" : "none";
      riseScan.disabled = rise.busy;
      if (!riseBlock.contains(document.activeElement)) fillRiseInputs();
      const via = pcDevice() ? "" : rise.pcAt ? L(` · stand van je pc ${formatDayTime(rise.pcAt)}`, ` · status of your PC ${formatDayTime(rise.pcAt)}`) : L(" · nog niets van je pc ontvangen", " · nothing received from your PC yet");
      riseLine.textContent = (rise.pending ? L("⏳ Verstuurd, je pc neemt het binnen een minuut over (web app op je pc moet open zijn). ", "⏳ Sent, your PC picks it up within a minute (web app on your PC must be open). ") : "") + (!rise.on
        ? L("Uit. Zet aan om een melding (ook op je telefoon) te krijgen als een verhandelbare kaart in je club flink stijgt t.o.v. je aankoopprijs.", "Off. Turn on to get a notification (also on your phone) when a tradable card in your club rises sharply vs. your purchase price.")
        : (rise.busyText ? L(`Bezig: ${rise.busyText} · `, `Busy: ${rise.busyText} · `) : "") + (rise.count
          ? L(`${rise.count} kaarten gevolgd · club gelezen ${formatDayTime(rise.scannedAt)}`, `${rise.count} cards tracked · club read ${formatDayTime(rise.scannedAt)}`) + (rise.checkedAt ? L(` · prijzen ${formatTime(rise.checkedAt)}`, ` · prices ${formatTime(rise.checkedAt)}`) : "")
          : L("Club nog niet gelezen.", "Club not read yet."))) + via;
      riseList.textContent = "";
      if (rise.on) {
        rise.top.forEach(c => {
          const change = Math.round((c.now / c.base - 1) * 100);
          const line = el("div", "pt-tl-sale", `${c.n} (${c.r}): ${c.b ? L("gekocht", "bought") : "was"} ${priceFormat.format(c.base)} → ${priceFormat.format(c.now)} `);
          line.appendChild(el("span", change >= 0 ? "pt-pos" : "pt-neg", `${change >= 0 ? "+" : ""}${change}%`));
          if (c.b) line.append(L(` · verkopen ${signedCoins(netProfit(c.now, c.b))} na tax`, ` · sell ${signedCoins(netProfit(c.now, c.b))} after tax`));
          riseList.appendChild(line);
        });
      }
    }
    return render;
  }

  // Phone (no FUT Genie, which shows this itself on the pc): what you paid, break-even and profit after tax.
  function addProfitInfo(root, item) {
    let info = root.querySelector(".pt-profit-info");
    const bought = item.lastSalePrice > 0 && !(item.isTradeable && !item.isTradeable()) ? item.lastSalePrice : 0;
    if (genie() || !bought) {
      if (info) info.remove();
      return;
    }
    if (!info) {
      info = el("div", "pt-profit-info");
      (root.querySelector(".ut-button-group") || root).appendChild(info);
    }
    const price = (geniePrice(item.definitionId, item.resourceId) || {}).price;
    info.textContent = L(`Gekocht ${priceFormat.format(bought)} · break-even BIN ${priceFormat.format(roundUpToStep(bought / (1 - EA_TAX)))}`, `Bought ${priceFormat.format(bought)} · break-even BIN ${priceFormat.format(roundUpToStep(bought / (1 - EA_TAX)))}`);
    if (price) {
      const net = netProfit(price, bought);
      info.append(L(` · bij ${priceFormat.format(price)}: `, ` · at ${priceFormat.format(price)}: `), el("span", net >= 0 ? "pt-pos" : "pt-neg", `${signedCoins(net)} na tax`));
    }
  }

  let marketWatchInstalled = false;

  // "Holographic only", like FUT Genie: the market request gets hypercosmetic=foil. Only during a search
  // whose criteria carry the holo flag (set by a holo snipe list).
  let holoSearch = false;
  function patchHoloParam() {
    try {
      let proto = window.UTHttpRequest && window.UTHttpRequest.prototype;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, "setUrlVariables")) proto = Object.getPrototypeOf(proto);
      if (!proto || typeof proto.setUrlVariables !== "function") return false;
      if (proto.setUrlVariables.__ptHolo || proto.setUrlVariables.__futgenieHoloPatched) return true;
      const original = proto.setUrlVariables;
      const wrapped = function (variables, ...rest) {
        try {
          const url = typeof this.url === "string" ? this.url : "";
          if (holoSearch && variables && typeof variables === "object" && (!url || /\/transfermarket(?:$|\?)/.test(url))) {
            variables = Object.assign({}, variables, { hypercosmetic: "foil" });
          }
        } catch (_) {
          // Unchanged request.
        }
        return original.call(this, variables, ...rest);
      };
      wrapped.__ptHolo = true;
      proto.setUrlVariables = wrapped;
      return true;
    } catch (_) {
      return false;
    }
  }

  function installMarketWatch() {
    if (marketWatchInstalled || typeof services === "undefined" || !services.Item || typeof services.Item.searchTransferMarket !== "function") return;
    marketWatchInstalled = true;
    const original = services.Item.searchTransferMarket;
    services.Item.searchTransferMarket = function (criteria, ...rest) {
      // Safety net for the min bid wrap (see wrapMinBid): never search with min bid ≥ max buy now.
      try {
        if (criteria && criteria.maxBuy > 0 && criteria.minBid >= criteria.maxBuy) criteria.minBid = 0;
      } catch (_) {
        // Leave the search as it is.
      }
      // Holo only without FUT Genie (phone): Genie adds the parameter itself when it's there.
      const genieHolo = window.FutGenieDispatcher && window.FutGenieDispatcher.__futgenieHoloParamPatched;
      try {
        logSearch();
      } catch (_) {
        // Counting never blocks the search.
      }
      holoSearch = !!(criteria && criteria.__futgenieHoloOnly === true && !genieHolo && patchHoloParam());
      let observable;
      try {
        observable = original.call(this, criteria, ...rest);
      } finally {
        holoSearch = false;
      }
      try {
        if (criteria && criteria.club && observable && typeof observable.observe === "function") {
          const snapshot = { club: criteria.club, level: criteria.level, maxBuy: criteria.maxBuy, offset: criteria.offset };
          const context = {};
          observable.observe(context, (sender, response) => {
            try {
              sender.unobserve(context);
              recordMarketSearch(snapshot, response);
            } catch (error) {
              console.warn(L("Price Watch: marktprijs uit zoekopdracht niet verwerkt.", "Price Watch: market price from search not processed."), error);
            }
          });
        }
        // Every search: learn quick-sell values per rating from the results (for "at discard" tips).
        if (observable && typeof observable.observe === "function") {
          const discardContext = {};
          observable.observe(discardContext, (sender, response) => {
            try {
              sender.unobserve(discardContext);
              learnDiscardValues((response && response.data && response.data.items) || []);
            } catch (_) {
              // Learning is optional.
            }
          });
        }
      } catch (_) {
        // Never get in the way of the search itself.
      }
      return observable;
    };
  }

  function stockRules(list) {
    if (list.type === "fodder") {
      return list.ratings.filter(entry => entry.enabled !== false).map(entry => ({
        fodder: entry,
        key: `r${entry.rating}`,
        max: entry.max,
        ideal: entry.ideal
      }));
    }
    if (list.type === "filters") {
      return list.rules.filter(rule => rule.enabled !== false).flatMap(rule => filterSteps(rule).map(step => {
        const key = `f${rule.id}|${step.position || "*"}|${step.league ? step.league.id : "*"}`;
        // The instant-sell price you entered for this filter sets its max BIN.
        const sell = list.sell && list.sell[key] || null;
        return {
          filter: rule,
          position: step.position,
          league: step.league,
          sell,
          max: sell ? filterBuyMax(list, sell.price) : ruleMax(rule),
          ideal: sell ? null : rule.ideal,
          key
        };
      }));
    }
    if (list.type === "players") {
      return list.players.map(player => ({
        player,
        key: `p${player.definitionId}`,
        // Without a known version (only the regular id), the regular card's Genie price says nothing about the special.
        genie: player.special && player.definitionId <= 0xFFFFFF ? null : geniePrice(player.definitionId),
        max: playerMax(list, player)
      }));
    }
    const levels = LEVELS.filter(level => list.levels[level] && list.levels[level].enabled);
    return list.clubs.flatMap(club => levels.filter(level => clubHasLevel(club, level)).map(level => {
      const key = `${club.teamId}|${level}`;
      const market = list.flip && list.market && list.market[key] || null;
      // Flip without a market price yet: no max BIN, so you see where the market really is.
      return {
        club,
        level,
        market,
        ceiling: list.levels[level].max, // the tip's "options that have silvers <300-400"
        max: market ? flipBuyMax(list, market.price) : list.flip ? null : list.levels[level].max,
        ideal: market || list.flip ? null : list.levels[level].ideal,
        key
      };
    }));
  }

  // --- Snipe lists: players, max BIN = FUT Genie price minus a margin ---------------
  // List: { id, type: "players", name, createdAt, margin (null = auto), window: { start, end } | null,
  //         players: [{ definitionId, name, rating, fixedMax }], done: {} }

  // Desired profit after the 5% EA tax, when selling at the FUT Genie price. Default 5%.
  const DEFAULT_PROFIT = 5;

  function profitFor(list) {
    return Number.isFinite(list.profit) && list.profit >= 0 ? list.profit : DEFAULT_PROFIT;
  }

  function profitLabel(list) {
    return Number.isFinite(list.profit) && list.profit >= 0 ? `${list.profit}%` : `auto (${DEFAULT_PROFIT}%)`;
  }

  function roundDownToStep(price) {
    const step = price < 1000 ? 50 : price < 10000 ? 100 : price < 50000 ? 250 : price < 100000 ? 500 : 1000;
    return Math.max(200, Math.floor(price / step) * step);
  }

  // Max BIN so that selling at the Genie price leaves the desired profit after tax:
  // price × 0.95 − max ≥ max × profit%  →  max = price × 0.95 / (1 + profit%).
  // --- Mass bidding ("Biedlijst"): a players list in bid mode, max bid = BIN x (1 - pct%) --------------
  // List: players list + { mode: "bid", massBid: { pct } }; player.sell = the BIN you saw yourself
  // (else the FUT.GG PC price). The script never searches, watches, bids or lists; it prepares the
  // filter, shows per auction whether your bid still fits, and fills the sell price when you list.
  const MASS_BID_DEFAULT_PCT = 20;
  const MASS_BID_WATCH_MAX = 50;
  const MASS_BID_HOT_SECONDS = 30;

  function massBidPct(list) {
    const pct = Number(list && list.massBid && list.massBid.pct);
    return pct > 0 && pct < 90 ? pct : MASS_BID_DEFAULT_PCT;
  }

  function massBidSell(player) {
    if (player.sell > 0) return player.sell;
    const entry = geniePrice(player.definitionId);
    return entry && entry.price > 0 ? entry.price : 0;
  }

  // Tip: "fodder: if you get it 10% lower, just hold". Only on fodder bid lists.
  const MASS_BID_HOLD_PCT = 10;

  function massBidHold(info, paid) {
    return !!(info && info.list.massBid && info.list.massBid.fodder && info.sell && paid > 0 &&
      paid <= info.sell * (1 - MASS_BID_HOLD_PCT / 100));
  }

  function massBidMax(list, player) {
    const sell = massBidSell(player);
    return sell ? Math.max(150, roundDownToStep(sell * (1 - massBidPct(list) / 100))) : null;
  }

  // EA's price ladder: the next allowed price above `price`.
  function priceStepAbove(price) {
    return price + (price < 1000 ? 50 : price < 10000 ? 100 : price < 50000 ? 250 : price < 100000 ? 500 : 1000);
  }

  // The mass-bid entry for a card: the running list first, then any other mass-bid list.
  function massBidInfo(item) {
    if (!item || !item.definitionId) return null;
    const id = item.definitionId;
    const lists = getStock().filter(list => list.massBid && list.type === "players");
    if (!lists.length) return null;
    const running = run && lists.find(list => list.id === run.listId);
    const ordered = running ? [running, ...lists.filter(list => list !== running)] : lists;
    const ids = new Set([id, item.resourceId].filter(Boolean));
    for (const list of ordered) {
      const player = list.players.find(entry => ids.has(entry.definitionId));
      if (player) return { list, player, max: playerMax(list, player), sell: massBidSell(player) };
    }
    return null;
  }

  // Auction end times per tradeId. EA's auction.expires is the seconds left when the data came in; a
  // re-render can reuse old data, so only an earlier estimate replaces the one we have (no extensions).
  const auctionEnds = new Map();

  function auctionEndAt(auction) {
    if (!auction || !auction.tradeId) return 0;
    const seconds = Number(auction.expires);
    const known = auctionEnds.get(auction.tradeId) || 0;
    if (seconds > 0) {
      const estimate = Date.now() + seconds * 1000;
      if (!known || estimate < known) auctionEnds.set(auction.tradeId, estimate);
    }
    return auctionEnds.get(auction.tradeId) || 0;
  }

  function secondsLeft(endAt) {
    return endAt ? Math.max(0, Math.round((endAt - Date.now()) / 1000)) : null;
  }

  function formatLeft(seconds) {
    if (seconds == null) return "";
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}u${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  // --- Session clock + reload advice ----------------------------------------------------------------
  // EA's server currently drops web-app sessions ~65-75 s after login (401, then bids 461 until a reload).
  // A reload gives a fresh session; done 35-100 s before your next watched auction ends, you are back in
  // time and the fresh session usually lasts past the end. Only advice: nothing is sent to EA.
  const watchedEnds = new Map(); // tradeId -> end time, active auctions in Transfer Targets
  let watchedSeenAt = 0; // last time Transfer Targets was loaded
  const RELOAD_LEAD_MIN = 35;
  const RELOAD_LEAD_MAX = 100;
  const SESSION_TYPICAL_S = 60;
  let sessionPill = null;

  function noteWatchedItems(items) {
    watchedSeenAt = Date.now();
    watchedEnds.clear();
    items.forEach(item => {
      const auction = auctionOf(item);
      if (!auction || auction.tradeState !== "active") return;
      const end = auctionEndAt(auction);
      if (end) watchedEnds.set(auction.tradeId, end);
    });
  }

  function nextWatchedEnd() {
    const now = Date.now();
    let next = 0;
    watchedEnds.forEach((end, tradeId) => {
      const best = Math.min(end, auctionEnds.get(tradeId) || end);
      if (best > now && (!next || best < next)) next = best;
    });
    return next;
  }

  function drawSessionPill() {
    if (!sessionAuthAt || !document.body) return;
    if (!sessionPill) {
      sessionPill = el("button", "pt-session-pill", "");
      sessionPill.type = "button";
      sessionPill.addEventListener("click", reloadToTargets);
      document.body.appendChild(sessionPill);
    }
    const age = Math.round((Date.now() - sessionAuthAt) / 1000);
    const next = nextWatchedEnd();
    const left = next ? Math.round((next - Date.now()) / 1000) : null;
    let text = L(`🔌 sessie ${formatLeft(age)}`, `🔌 session ${formatLeft(age)}`);
    let level = age >= SESSION_TYPICAL_S - 10 ? "old" : "fresh";
    let tip = L("Leeftijd van je EA-sessie. EA laat sessies nu vaak na ~1 minuut vervallen. Klik = herladen en terug naar Transfer Targets.", "Age of your EA session. EA now often lets sessions expire after ~1 minute. Click = reload and go back to Transfer Targets.");
    if (left != null && left <= 3600) {
      text += L(` · volgende veiling ${formatLeft(left)}`, ` · next auction ${formatLeft(left)}`);
      if (left >= RELOAD_LEAD_MIN && left <= RELOAD_LEAD_MAX && age + left > SESSION_TYPICAL_S) {
        level = "reload";
        text = L(`⟳ Herlaad nú (klik) · volgende veiling over ${formatLeft(left)} · sessie ${formatLeft(age)}`, `⟳ Reload now (click) · next auction in ${formatLeft(left)} · session ${formatLeft(age)}`);
        tip = L("Nu herladen geeft een verse sessie die het einde van je volgende veiling waarschijnlijk haalt. Na het laden opent Transfer Targets vanzelf.", "Reloading now gives a fresh session that will probably last until the end of your next auction. After loading, Transfer Targets opens automatically.");
      } else if (left < RELOAD_LEAD_MIN) {
        level = sessionState === "ok" ? level : "late";
        text += L(" · niet meer herladen", " · don't reload anymore");
        tip = L("Te laat om te herladen: bied nu. Faalt het (461), dan haal je deze veiling niet.", "Too late to reload: bid now. If it fails (461), you won't get this auction.");
      }
    }
    if (sessionPill.textContent !== text) sessionPill.textContent = text;
    sessionPill.title = tip;
    sessionPill.className = `pt-session-pill pt-session-${level}`;
  }

  window.setInterval(drawSessionPill, 1000);

  // F5 while on Transfer Targets (it was loaded in the last 2 minutes): also go back there.
  window.addEventListener("beforeunload", () => {
    try {
      if (watchedSeenAt && Date.now() - watchedSeenAt < 120 * 1000) sessionStorage.setItem(RETURN_KEY, String(Date.now()));
    } catch (_) {
      // Only a convenience.
    }
  });

  // After a reload: open Transfers → Transfer Targets as soon as the web app is ready (just navigation).
  function returnToTargets() {
    let asked = 0;
    try {
      asked = Number(sessionStorage.getItem(RETURN_KEY)) || 0;
      sessionStorage.removeItem(RETURN_KEY);
    } catch (_) {
      return;
    }
    if (!asked || Date.now() - asked > 3 * 60 * 1000) return;
    const started = Date.now();
    const waitReady = window.setInterval(() => {
      if (Date.now() - started > 60 * 1000) return void window.clearInterval(waitReady);
      try {
        if (!document.querySelector(".ut-tab-bar-item") || !findTabBarController()) return;
      } catch (_) {
        return;
      }
      window.clearInterval(waitReady);
      window.setTimeout(() => {
        try {
          getAppMain().getRootViewController().setGameViewTab(UTGameTabBarController.TabTag.TRANSFERS);
        } catch (_) {
          return;
        }
        const press = (node, types) => types.forEach(type => node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
        let tries = 0;
        const findTile = window.setInterval(() => {
          const tile = document.querySelector(".ut-tile-transfer-targets");
          if (!tile) {
            if (++tries > 24) {
              window.clearInterval(findTile);
              showToast(L("Open Transfer Targets zelf (tegel niet gevonden).", "Open Transfer Targets yourself (tile not found)."), false);
            }
            return;
          }
          window.clearInterval(findTile);
          press(tile, ["mousedown", "mouseup"]);
          // Still on the hub after a moment: EA wanted a click event instead.
          window.setTimeout(() => {
            const still = document.querySelector(".ut-tile-transfer-targets");
            if (still && still.isConnected) press(still, ["click"]);
          }, 900);
        }, 250);
      }, 800);
    }, 500);
  }

  // What to do with one auction: { kind: won|lost|highest|ok|over, text, bid, left, hot }.
  function massBidAdvice(item, info) {
    const auction = auctionOf(item);
    if (!auction || !info) return null;
    const state = auction.tradeState;
    const current = Number(auction.currentBid) || 0;
    const left = secondsLeft(auctionEndAt(auction));
    const highest = auction.bidState === "highest";
    if (state === "closed" || state === "expired" || state === "inactive") {
      return highest && current
        ? { kind: "won", text: massBidHold(info, current)
          ? L(`🏆 gewonnen voor ${priceFormat.format(current)} · 📦 houden (fodder ≥${MASS_BID_HOLD_PCT}% onder ${priceFormat.format(info.sell)})`, `🏆 won for ${priceFormat.format(current)} · 📦 keep (fodder ≥${MASS_BID_HOLD_PCT}% below ${priceFormat.format(info.sell)})`)
          : L(`🏆 gewonnen voor ${priceFormat.format(current)} · verkoop ${info.sell ? priceFormat.format(info.sell) : "—"}${info.sell ? ` = ${formatSigned(flipNet(info.sell, current))}` : ""}`, `🏆 won for ${priceFormat.format(current)} · sell ${info.sell ? priceFormat.format(info.sell) : "—"}${info.sell ? ` = ${formatSigned(flipNet(info.sell, current))}` : ""}`) }
        : { kind: "lost", text: L("✖ voorbij", "✖ over") };
    }
    if (state !== "active") return null;
    const max = info.max;
    if (highest) return { kind: "highest", text: L(`🟢 jij hoogste ${priceFormat.format(current)}`, `🟢 you're highest ${priceFormat.format(current)}`) + (max ? ` · max ${priceFormat.format(max)}` : ""), left };
    const bid = current > 0 ? priceStepAbove(current) : Number(auction.startingBid) || 150;
    if (!max) return { kind: "over", text: L(`bod ${priceFormat.format(bid)} · geen max (geen prijs)`, `bid ${priceFormat.format(bid)} · no max (no price)`), bid, left };
    const outbid = auction.bidState === "outbid";
    if (bid > max) return { kind: "over", text: `${outbid ? "⚠ overboden · " : ""}❌ ${priceFormat.format(bid)} > max ${priceFormat.format(max)}`, bid, left };
    return {
      kind: "ok",
      text: `${outbid ? "⚠ overboden · " : ""}✅ bied ${priceFormat.format(bid)} (max ${priceFormat.format(max)})`,
      bid,
      left,
      hot: left != null && left <= MASS_BID_HOT_SECONDS
    };
  }

  // Badges on auction rows (search results and Transfer Targets), kept current every second.
  const massBidCells = new Set();
  const massBidPanels = new Set();

  function addMassBidBadge(cell, item) {
    const root = typeof cell.getRootElement === "function" ? cell.getRootElement() : null;
    if (!root) return;
    root.querySelectorAll(".pt-mb-badge").forEach(node => node.remove());
    root.classList.remove("pt-mb-hot", "pt-mb-over", "pt-mb-ok", "pt-mb-highest", "pt-mb-tilerow");
    const info = massBidInfo(item);
    if (!info || !auctionOf(item)) return;
    const badge = el("div", "pt-mb-badge");
    badge.__ptItem = item;
    badge.__ptInfo = info;
    badge.__ptRow = root;
    (root.querySelector(".entityContainer") || root).appendChild(badge);
    massBidCells.add(badge);
    drawMassBidBadge(badge);
  }

  function drawMassBidBadge(badge) {
    const advice = massBidAdvice(badge.__ptItem, badge.__ptInfo);
    const row = badge.__ptRow;
    row.classList.toggle("pt-mb-hot", !!(advice && advice.hot));
    row.classList.toggle("pt-mb-over", !!(advice && advice.kind === "over"));
    row.classList.toggle("pt-mb-ok", !!(advice && advice.kind === "ok"));
    row.classList.toggle("pt-mb-highest", !!(advice && advice.kind === "highest"));
    // FC27's grid shows cards as small tiles: there the badge is a compact strip with its own
    // background at the bottom of the tile, so it never runs over the card picture or EA's text.
    const width = row.offsetWidth;
    const tile = width > 0 && width < 340;
    if (tile && badge.parentNode !== row) row.appendChild(badge);
    row.classList.toggle("pt-mb-tilerow", tile);
    badge.textContent = "";
    if (!advice) return;
    badge.className = `pt-mb-badge pt-mb-${advice.kind}${tile ? " pt-mb-tile" : ""}`;
    if (tile) {
      const short = advice.kind === "over" ? `❌ ${priceFormat.format(advice.bid)} > max ${priceFormat.format(badge.__ptInfo.max || 0)}`
        : advice.kind === "ok" ? `✅ bied ${priceFormat.format(advice.bid)} · max ${priceFormat.format(badge.__ptInfo.max)}`
          : advice.text.replace(L("jij hoogste ", "you're highest "), L("hoogste ", "highest ")).replace(L("gewonnen voor ", "won for "), "").replace(L(" · verkoop ", " · sell "), " → ");
      badge.title = advice.text;
      badge.append(el("div", "pt-mb-tile-main", short));
      if (advice.left != null) badge.append(el("div", "pt-mb-left", advice.left <= 0 ? "loopt af" : L(`nog ${formatLeft(advice.left)}`, `${formatLeft(advice.left)} left`)));
      return;
    }
    badge.append(el("span", "", `🎯 ${advice.text}`));
    if (advice.left != null) {
      const endAt = auctionEnds.get((auctionOf(badge.__ptItem) || {}).tradeId);
      badge.append(el("span", "pt-mb-left", ` · ${advice.left <= 0 ? "loopt af" : formatLeft(advice.left)}${endAt && advice.left > 0 ? ` (eindigt ${formatTime(endAt)})` : ""}`));
    }
  }

  window.setInterval(() => {
    massBidCells.forEach(badge => {
      if (!badge.isConnected) return void massBidCells.delete(badge);
      drawMassBidBadge(badge);
    });
    massBidPanels.forEach(line => {
      if (!line.isConnected) return void massBidPanels.delete(line);
      line.__ptDraw();
    });
  }, 1000);

  // In the card's bid panel: does EA's minimum bid still fit your max, and how long is left.
  function addMassBidPanel(panel, item) {
    let root;
    try {
      root = panel.getRootElement();
    } catch {
      return;
    }
    if (!root) return;
    let line = root.querySelector(".pt-mb-panel");
    const info = massBidInfo(item);
    if (!info || !auctionOf(item)) {
      if (line) line.remove();
      return;
    }
    if (!line) {
      line = el("div", "pt-mb-panel");
      root.insertBefore(line, root.firstChild);
    }
    line.__ptDraw = () => {
      const advice = massBidAdvice(item, info);
      line.textContent = "";
      if (!advice) return;
      line.className = `pt-mb-panel pt-mb-${advice.kind}${advice.hot ? " pt-mb-hot" : ""}`;
      const wait = advice.kind === "ok" && advice.left != null && advice.left > MASS_BID_HOT_SECONDS;
      line.append(
        el("div", "pt-mb-panel-main", `🎯 ${advice.text}${advice.left != null ? L(` · nog ${formatLeft(advice.left)}`, ` · ${formatLeft(advice.left)} left`) : ""}`),
        el("div", "pt-mb-panel-sub", (advice.kind === "over" ? L("Niet bieden: boven je max bod. ", "Don't bid: above your max bid. ") : wait ? L("Wacht tot de laatste 30 seconden. ", "Wait until the last 30 seconds. ") : advice.hot ? L("Laatste 30 seconden: nu bieden. ", "Last 30 seconds: bid now. ") : "") +
          (info.list.massBid.flip
            ? ft("mb_flipLine", { sell: info.sell ? priceFormat.format(info.sell) : "—" })
            : `${L("Verkoop", "Sell")} ${info.sell ? priceFormat.format(info.sell) : "—"}${info.player.sell ? L(" (jouw BIN)", " (your BIN)") : " (FUT.GG)"} · max = BIN − ${massBidPct(info.list)}%`) +
          (advice.bid && info.sell ? L(` · bij ${priceFormat.format(advice.bid)}: ${formatSigned(flipNet(info.sell, advice.bid))} na 5%`, ` · at ${priceFormat.format(advice.bid)}: ${formatSigned(flipNet(info.sell, advice.bid))} after 5%`) : ""))
      );
    };
    massBidPanels.add(line);
    line.__ptDraw();
  }

  // Your watch list size, from the last time EA loaded Transfer Targets.
  let watchListCount = null; // { n, active, at }

  function playerMax(list, player) {
    // Mass bid list: your fixed max, else BIN (yours or FUT.GG) minus the list's percentage.
    if (list.massBid) return player.fixedMax || massBidMax(list, player);
    // Discard tip: bid the quick-sell value; pricier cards (> quick-sell + 200) at their price − 150.
    if (list.discard && !player.fixedMax && !(player.special && player.definitionId <= 0xFFFFFF)) {
      const quick = discardForRating(player.rating);
      const entry = geniePrice(player.definitionId);
      if (entry && entry.price && (!quick || entry.price > quick + DISCARD_PRICEY_GAP)) return roundDownToStep(entry.price - DISCARD_UNDER_PRICE);
      return quick || null;
    }
    // Holo snipe: a holographic card for the price of the normal one (its FUT Genie price).
    if (list.holo && !(player.special && player.definitionId <= 0xFFFFFF)) {
      const normal = geniePrice(player.normalId || player.definitionId);
      if (normal) return roundDownToStep(normal.price);
    }
    if (player.fixedMax) return player.fixedMax;
    if (player.special && player.definitionId <= 0xFFFFFF) return null;
    const entry = geniePrice(player.definitionId);
    if (!entry) return null;
    return roundDownToStep(entry.price * (1 - EA_TAX) / (1 + profitFor(list) / 100));
  }

  // What a buy at `max` needs to sell for to break even, and what it nets at the Genie price.
  function snipeOutlook(rule) {
    if (!rule.max) return null;
    return {
      breakEven: roundUpToStep(rule.max / (1 - EA_TAX)),
      atGenie: rule.genie ? Math.round(rule.genie.price * (1 - EA_TAX) - rule.max) : null
    };
  }

  // --- Fodder lists: rated golds ("87s <6 / <6.5") --------------------------------
  // List: { id, type: "fodder", name, createdAt, mode: "bid" | "bin", windows,
  //         ratings: [{ rating, max, ideal, enabled }], done: {} }

  function userPlatform() {
    try {
      const platform = genie() && genie().getBulkPricePlatform();
      if (platform) return platform === "pc" ? "pc" : "console";
    } catch { /* below */ }
    try {
      const saved = JSON.parse(localStorage.getItem("pt_flip_v1") || "null");
      return saved && saved.platform === "console" ? "console" : "pc";
    } catch {
      return "pc";
    }
  }

  // "6" -> 6000, "10.5" -> 10500, "650" -> 650 (fodder prices are quoted in thousands).
  function fodderCoins(value) {
    const number = parseFloat(String(value).replace(",", "."));
    if (!Number.isFinite(number)) return null;
    return Math.round(number < 1000 ? number * 1000 : number);
  }

  function parseFodderTip(text) {
    const lines = String(text || "").split(/\r?\n/);
    // Column order from a header like "Console / PC" (default: a single column for everyone).
    const header = lines.find(line => /console/i.test(line) && /\bpc\b/i.test(line));
    const pcColumn = header ? (header.toLowerCase().indexOf("pc") < header.toLowerCase().indexOf("console") ? 0 : 1) : 0;
    const platform = userPlatform();

    const ratings = [];
    lines.forEach(rawLine => {
      const match = rawLine.trim().match(/^(\d{2})\s*s?\b\s*[:\-–]?\s*(.*\d.*)$/i);
      if (!match) return;
      const rating = +match[1];
      if (rating < 45 || rating > 99 || ratings.some(entry => entry.rating === rating)) return;
      // "<10/10.5 / <10.5/11" -> columns ["<10/10.5", "<10.5/11"]
      const columns = match[2].split(/\s+\/\s+/).map(column => column.replace(/[<≤~k]/gi, "").trim()).filter(Boolean);
      if (!columns.length) return;
      const column = columns[Math.min(header && platform === "pc" ? pcColumn : header ? 1 - pcColumn : 0, columns.length - 1)];
      const values = column.split("/").map(fodderCoins).filter(Boolean);
      if (!values.length) return;
      // "<10.5/11": max = the upper end, ideal = the lower end (like "<650-700" in stock tips).
      ratings.push({ rating, max: Math.max(...values), ideal: values.length > 1 ? Math.min(...values) : null, enabled: true });
    });
    return {
      ratings: ratings.sort((a, b) => a.rating - b.rating),
      platform,
      columnUsed: header ? (platform === "pc" ? "PC" : "Console") : null,
      mode: /\bbids?\b|\bbieden\b/i.test(text) ? "bid" : "bin",
      windows: parseWindows(text)
    };
  }

  // --- Nations: flag emoji -> EA nation id; player nation learned from items we see ----

  const NATION_KEY = "pt_nation_v1";
  let nationCache = null;

  function getNationCache() {
    if (nationCache) return nationCache;
    try {
      nationCache = JSON.parse(localStorage.getItem(NATION_KEY) || "{}") || {};
    } catch {
      nationCache = {};
    }
    return nationCache;
  }

  // Remember base player id -> nation id from any item entity the web app shows us.
  function learnNation(item) {
    if (!item || !item.definitionId || !(item.nationId > 0)) return;
    const cache = getNationCache();
    const baseId = item.definitionId & 0xFFFFFF;
    if (cache[baseId] === item.nationId) return;
    cache[baseId] = item.nationId;
    try {
      localStorage.setItem(NATION_KEY, JSON.stringify(cache));
    } catch (_) {
      // Only a hint; fine to lose.
    }
  }

  function playerNation(definitionId) {
    return getNationCache()[definitionId & 0xFFFFFF] || null;
  }

  let nationLookup = null;
  const NATION_ALIASES = { GB: "england", US: "united states", KR: "korea republic", CZ: "czechia", CI: "cote d ivoire", IR: "iran" };

  // 🇪🇸 -> { id: 45, label: "Spain" } via the region name and the web app's nation list.
  function nationFromFlag(flag) {
    const letters = [...flag].map(char => String.fromCharCode(char.codePointAt(0) - 0x1F1E6 + 65)).join("");
    if (!nationLookup) {
      const nations = factories.DataProvider.getNationDP().filter(nation => nation.id > 0);
      nationLookup = {
        regionNames: new Intl.DisplayNames(["en"], { type: "region" }),
        byLabel: new Map(nations.map(nation => [plainName(nation.label), nation])),
        cache: {}
      };
    }
    if (letters in nationLookup.cache) return nationLookup.cache[letters];

    let name = "";
    try {
      name = plainName(NATION_ALIASES[letters] || nationLookup.regionNames.of(letters));
    } catch (_) {
      // Unknown region code.
    }
    let nation = name ? nationLookup.byLabel.get(name) : null;
    if (!nation && name) {
      const hit = [...nationLookup.byLabel.entries()].find(([label]) => label.startsWith(name) || name.startsWith(label));
      nation = hit ? hit[1] : null;
    }
    nationLookup.cache[letters] = nation ? { id: nation.id, label: nation.label } : null;
    return nationLookup.cache[letters];
  }

  // --- Price target lines in a follow-up post: "<230 🇪🇸", "220s 🇳🇴", "<55/6 🇬🇪", "Pedri <230k" ---

  const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

  function parseTargetLines(text) {
    const targets = [];
    String(text || "").split(/\r?\n/).forEach(rawLine => {
      const line = rawLine.trim();
      if (!line || line.split(/\s+/).length > 8) return;
      const price = line.match(/(?:^|[\s<≤~])(\d+(?:[.,]\d+)?)\s*(k|s)?(?:\s*\/\s*(\d+))?/i);
      if (!price || !/[<≤]|\d\s*s\b|\dk\b/i.test(line) && !FLAG.test(line)) return;
      const flagMatch = line.match(FLAG);
      const nameText = line.replace(FLAG, " ").replace(/\(.*?\)/g, " ").replace(/[<≤~]?\s*\d+(?:[.,]\d+)?\s*(?:k|s)?(?:\s*\/\s*\d+)?/gi, " ").trim();
      const value = parseFloat(price[1].replace(",", "."));
      if (!Number.isFinite(value)) return;
      targets.push({
        raw: line,
        value,
        // "220s" = anywhere in the 220s -> 229; "55/6" -> 55 (the conservative end).
        top: price[2] && price[2].toLowerCase() === "s" ? value + 9 : value,
        thousands: price[2] && price[2].toLowerCase() === "k",
        flag: flagMatch ? flagMatch[0] : null,
        nameText: nameText.length >= 3 ? nameText : ""
      });
    });
    return targets;
  }

  // Coins for a target given the card's price level ("230" next to a 255k card means 230k).
  function targetCoins(target, referencePrice) {
    if (target.thousands || target.top >= 1000) return Math.round(target.top * (target.thousands ? 1000 : 1));
    if (!referencePrice) return Math.round(target.top * 1000);
    const asCoins = target.top;
    const asThousands = target.top * 1000;
    return Math.abs(Math.log(referencePrice / asThousands)) < Math.abs(Math.log(referencePrice / asCoins)) ? asThousands : asCoins;
  }

  // Assign each target line to a player of the list: name if given, else nation (if known) + price fit.
  function assignTargets(targets, list) {
    const taken = new Set();
    const candidatesFor = target => list.players.map(player => {
      const price = (geniePrice(player.definitionId) || {}).price || 0;
      const coins = targetCoins(target, price);
      let cost = price ? Math.abs(Math.log(price / coins) - Math.log(1.06)) : 5;
      let reason = "prijs";
      if (target.nameText) {
        const query = plainName(target.nameText);
        if (plainName(player.name).split(" ").some(word => word === query || word.startsWith(query))) {
          cost -= 10;
          reason = "naam";
        }
      }
      const nation = target.flag && nationFromFlag(target.flag);
      const known = playerNation(player.definitionId);
      if (nation && known) {
        if (known === nation.id) { cost -= 1; reason = reason === "naam" ? reason : L("vlag + prijs", "flag + price"); } else cost += 10;
      }
      return { player, coins, cost, reason };
    }).sort((a, b) => a.cost - b.cost);

    // Greedy: the most certain lines pick first.
    const options = targets.map((target, index) => ({ target, index, ranked: candidatesFor(target) }));
    const order = [...options].sort((a, b) => (a.ranked[0] ? a.ranked[0].cost : 99) - (b.ranked[0] ? b.ranked[0].cost : 99));
    const result = new Array(targets.length);
    order.forEach(option => {
      const pick = option.ranked.find(candidate => !taken.has(candidate.player.definitionId) && candidate.cost < 9);
      if (pick) taken.add(pick.player.definitionId);
      const runnerUp = option.ranked.find(candidate => pick && candidate.player !== pick.player);
      const sure = pick && (pick.reason !== "prijs" || !runnerUp || runnerUp.cost - pick.cost > 0.06);
      result[option.index] = { target: option.target, pick, sure, ranked: option.ranked };
    });
    return result;
  }

  // --- Time windows ("8:05-8:20am tomorrow 🇬🇧") ------------------------------------

  function tzParts(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(timestamp));
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return { year: +value.year, month: +value.month, day: +value.day, hour: +value.hour, minute: +value.minute, second: +value.second };
  }

  function tzOffset(timestamp, timeZone) {
    const p = tzParts(timestamp, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(timestamp / 1000) * 1000;
  }

  // Wall-clock time in a time zone -> timestamp.
  function zonedTime(year, month, day, hour, minute, timeZone) {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    let timestamp = guess - tzOffset(guess, timeZone);
    const second = guess - tzOffset(timestamp, timeZone);
    if (second !== timestamp) timestamp = second;
    return timestamp;
  }

  const TIMEZONE_HINTS = [
    [/🇬🇧|\buk\b|\bgmt\b|\bbst\b|london|british/i, "Europe/London"],
    [/🇳🇱|\bcet\b|\bcest\b|\bnl\b/i, "Europe/Amsterdam"],
    [/🇺🇸|\b(et|est|edt)\b/i, "America/New_York"],
    [/\b(pt|pst|pdt)\b/i, "America/Los_Angeles"]
  ];

  // All time ranges in a text: "8:05-8:20am", "5-7:30am", "8:02am - 8:10am", "20:00-21:00".
  const TIME_RANGE = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|tot)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/gi;

  function parseWindows(text, now = Date.now()) {
    const source = String(text || "");
    const hint = TIMEZONE_HINTS.find(([pattern]) => pattern.test(source));
    const timeZone = hint ? hint[1] : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dayOffset = /tomorrow|morgen/i.test(source) ? 1 : /today|tonight|vandaag|vanavond/i.test(source) ? 0 : null;
    const today = tzParts(now, timeZone);
    const to24 = (hour, amPm) => (amPm === "pm" && hour < 12 ? hour + 12 : amPm === "am" && hour === 12 ? 0 : hour);

    const windows = [];
    for (const match of source.matchAll(TIME_RANGE)) {
      const [, h1, m1, ap1, h2, m2, ap2] = match;
      // Must look like a time (minutes or am/pm), not a price range like "650-700".
      if (!(m1 || m2 || ap1 || ap2) || +h1 > 24 || +h2 > 24 || +(m1 || 0) > 59 || +(m2 || 0) > 59) continue;
      const startHour = to24(+h1, (ap1 || ap2 || "").toLowerCase());
      const endHour = to24(+h2, (ap2 || ap1 || "").toLowerCase());
      const build = offset => {
        const start = zonedTime(today.year, today.month, today.day + offset, startHour, +(m1 || 0), timeZone);
        let end = zonedTime(today.year, today.month, today.day + offset, endHour, +(m2 || 0), timeZone);
        if (end <= start) end += 24 * 60 * 60 * 1000;
        return { start, end };
      };
      let span = build(dayOffset || 0);
      if (dayOffset === null && span.end < now) span = build(1); // next occurrence
      if (!windows.some(other => other.start === span.start && other.end === span.end)) windows.push({ ...span, timeZone });
    }
    return windows.sort((a, b) => a.start - b.start);
  }

  function listWindows(list) {
    if (Array.isArray(list.windows)) return list.windows;
    return list.window ? [list.window] : [];
  }

  // The window that matters now: an open one, else the next one, else the last one.
  function listWindowState(list, now = Date.now()) {
    const windows = listWindows(list).filter(span => span && span.start && span.end);
    const open = windows.find(span => now >= span.start && now <= span.end);
    const next = windows.filter(span => span.start > now).sort((a, b) => a.start - b.start)[0];
    const last = windows.filter(span => span.end < now).sort((a, b) => b.end - a.end)[0];
    const state = windowState(open || next || last, now);
    if (state && windows.length > 1) state.text += L(` · ${windows.length} vensters`, ` · ${windows.length} windows`);
    return state;
  }

  function formatDuration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 1) return "<1m";
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}u ${minutes % 60}m` : `${minutes}m`;
  }

  function formatDayTime(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const day = date.toDateString() === today.toDateString() ? L("vandaag", "today")
      : date.toDateString() === tomorrow.toDateString() ? "morgen"
        : date.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
    return `${day} ${formatTime(timestamp)}`;
  }

  function windowState(span, now = Date.now()) {
    if (!span || !span.start || !span.end) return null;
    if (now < span.start) {
      return { state: "before", text: L(`Venster ${formatDayTime(span.start)}–${formatTime(span.end)} · begint over ${formatDuration(span.start - now)}`, `Window ${formatDayTime(span.start)}–${formatTime(span.end)} · starts in ${formatDuration(span.start - now)}`) };
    }
    if (now <= span.end) return { state: "open", text: L(`VENSTER OPEN · nog ${formatDuration(span.end - now)}`, `WINDOW OPEN · ${formatDuration(span.end - now)} left`) };
    return { state: "after", text: L(`Venster voorbij (${formatDayTime(span.start)}–${formatTime(span.end)})`, `Window over (${formatDayTime(span.start)}–${formatTime(span.end)})`) };
  }

  // --- Player matching (static player data of the web app) -----------------------

  let playerIndex = null;

  function plainName(value) {
    return String(value || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getPlayerIndex() {
    if (playerIndex) return playerIndex;
    const data = repositories.Item.staticData;
    const collection = data && (data._collection || data);
    const all = Array.isArray(collection) ? collection : Object.values(collection || {});
    playerIndex = all.filter(player => player && player.id).map(player => {
      const full = `${player.firstName || ""} ${player.lastName || ""}`.trim();
      return {
        id: player.id,
        rating: player.rating || 0,
        display: player.commonName || full,
        // Strong names first; the first name alone is a weak signal.
        names: [plainName(player.commonName), plainName(player.lastName), plainName(full)].filter(Boolean),
        first: plainName(player.firstName)
      };
    });
    return playerIndex;
  }

  function playerScore(query, entry) {
    let best = 0;
    for (const name of entry.names) {
      if (name === query) return 1;
      const tokens = name.split(" ");
      const queryTokens = query.split(" ");
      if (queryTokens.every(token => tokens.includes(token))) best = Math.max(best, 0.93);
      else if (query.length >= 4 && tokens.some(token => token.startsWith(query))) best = Math.max(best, 0.86); // "kvara"
      if (Math.abs(name.length - query.length) <= 2 && name[0] === query[0]) best = Math.max(best, similarity(query, name) * 0.92);
      for (const token of tokens) {
        if (Math.abs(token.length - query.length) <= 2 && token[0] === query[0]) best = Math.max(best, similarity(query, token) * 0.9);
      }
    }
    if (entry.first === query) best = Math.max(best, 0.8);
    return best;
  }

  function matchPlayer(raw) {
    const query = plainName(raw);
    // Any strong name match counts the same ("Hansen" = Tuva Hansen and Caroline *Graham Hansen*);
    // within a tier the best-rated player wins, because tips are about the cards people trade.
    const tier = score => (score >= 0.9 ? 2 : score >= 0.85 ? 1 : 0);
    const scored = query.length < 3 ? [] : getPlayerIndex()
      .map(entry => ({ entry, score: playerScore(query, entry) }))
      .filter(item => item.score >= 0.6)
      .sort((a, b) => tier(b.score) - tier(a.score) || b.entry.rating - a.entry.rating || b.score - a.score);
    const best = scored[0];
    let status = !best ? "none" : best.score >= 0.85 ? "sure" : "maybe";
    // Another player in the same tier with a similar rating: ask.
    if (status === "sure" && scored.slice(1).some(item => tier(item.score) === tier(best.score) && item.entry.rating >= best.entry.rating - 4)) status = "maybe";
    return {
      raw,
      status,
      player: best ? best.entry : null,
      candidates: scored.slice(0, 8).map(item => item.entry)
    };
  }

  function looksLikeClubTip(text) {
    return String(text).split(/\r?\n/).some(line => PRICE_LINE.test(line));
  }

  // "Hemp-88 <110 / <100pc", "Bisseck-85 skip / <112", "Felix-84 <197 / skip (link)":
  // name, rating, then one price per platform (console / pc; a "pc"/"console" mark overrides the order).
  const RATED_PRICE_LINE = /^(.+?)\s*[-–:]\s*(\d{2})\b\s*(.*?(?:[<≤~]?\s*\d|\bskip\b).*)$/i;

  function parseRatedPriceLine(rawLine, platform) {
    const match = rawLine.replace(/@\w+/g, " ").replace(/[•*_`>]+/g, " ").trim().match(RATED_PRICE_LINE);
    if (!match || /\d/.test(match[1]) || match[1].split(/\s+/).length > 4) return null;
    const rating = +match[2];
    if (rating < 45 || rating > 99) return null;
    const columns = match[3].replace(/\(.*?\)/g, " ").split("/").map(column => column.trim()).filter(Boolean).slice(0, 2);
    if (!columns.length) return null;
    return { name: match[1].trim(), rating, ...pickTipColumn(columns, platform) };
  }

  // The price for your platform out of "console / pc" columns.
  function pickTipColumn(columns, platform) {
    const markOf = column => (/\bpc\b|\dpc\b/i.test(column) ? "pc" : /console|ps[45]?|xbox/i.test(column) ? "console" : null);
    let index = columns.length === 1 ? 0 : platform === "pc" ? 1 : 0;
    const marked = columns.findIndex(column => markOf(column) === platform);
    if (marked >= 0) index = marked;
    else if (columns.length === 2 && markOf(columns[index]) && markOf(columns[index]) !== platform) index = 1 - index;
    const column = columns[index];
    const price = column.match(/(\d+(?:[.,]\d+)?)\s*(k)?/i);
    // Prices in these tips are in thousands ("<110" = 110k).
    const coins = /\bskip\b/i.test(column) || !price ? null : fodderCoins(price[1]);
    // The other platform's price still helps to recognise the card ("Felix-84 <197 / skip").
    const anyPrice = columns.map(text => !/\bskip\b/i.test(text) && text.match(/(\d+(?:[.,]\d+)?)/)).find(Boolean);
    return { coins, skip: !coins, fitCoins: coins || (anyPrice ? fodderCoins(anyPrice[1]) : null) };
  }

  // The same tips without a rating: "Pacho <120 / <105", "Saliba <16 / skip", "Hakimi low 90s / low 80s".
  // Two columns are required: a single "Name <230" stays a follow-up price for an existing snipe list.
  const TIP_PRICE_COLUMN = /^(?:skip|(?:[<≤~]|(?:low|mid|high)\s)?\s*\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:k|s)?\s*(?:pc|console|ps[45]?|xbox)?)$/i;

  function parseUnratedPriceLine(rawLine, platform) {
    if (PRICE_LINE.test(rawLine)) return null; // "Golds <650 / <700" is about quality, not a player
    const line = rawLine.replace(/@\w+/g, " ").replace(/[•*_`>]+/g, " ").trim();
    const at = line.search(/\s*[<≤~]|\s+(?:low|mid|high|skip)\b/i);
    if (at <= 0) return null;
    const name = line.slice(0, at).trim();
    if (/\d/.test(name) || name.split(/\s+/).length > 4 || matchLeague(name)) return null;
    const columns = line.slice(at).replace(/\(.*?\)/g, " ").split("/").map(column => column.trim()).filter(Boolean);
    if (columns.length !== 2 || !columns.every(column => TIP_PRICE_COLUMN.test(column)) || columns.every(column => /^skip$/i.test(column))) return null;
    return { name, rating: null, ...pickTipColumn(columns, platform) };
  }

  // The tip's rating is usually a special (TOTW/promo) of the player: "Hemp-88" while her regular card is 87.
  // The static data only has regular cards, so: the best name match whose regular card is at or below
  // the tip rating; above it = a special of that player.
  function matchRatedPlayer(name, rating) {
    const match = matchPlayer(name);
    if (match.player && match.player.rating > rating) {
      const lower = match.candidates.filter(entry => entry.rating <= rating).sort((a, b) => b.rating - a.rating)[0];
      if (lower) {
        match.player = lower;
        match.candidates = [lower, ...match.candidates.filter(entry => entry !== lower)];
      }
      match.status = "maybe";
    }
    // Lookalikes whose regular card is at or below the tip rating ("Martin": Jon Martín, Lisandro Martínez, …):
    // the card versions decide which one has a card with that rating.
    const query = plainName(name);
    // Exact names ("Martín") before prefixes ("Martínez"), then by rating.
    match.lookalikes = query.length < 3 ? [] : getPlayerIndex()
      .filter(entry => entry.rating <= rating && entry.rating >= rating - 20)
      .map(entry => ({ entry, score: playerScore(query, entry) }))
      .filter(item => item.score >= 0.85)
      .sort((a, b) => (b.score >= 0.9) - (a.score >= 0.9) || b.entry.rating - a.entry.rating)
      .slice(0, 16)
      .map(item => item.entry);
    return match;
  }

  // Regular cards come from the static data; a higher tip rating means a special of that player.
  const isSpecialFor = (player, tipRating) => !!(player && tipRating && tipRating > player.rating);

  // --- Card versions (TOTW, promos) ----------------------------------------------
  // A version's id is the regular id + version × 2^24. The concept search (Club → concept players) on all
  // possible ids returns the versions that exist, with rating and rarity. Not a transfer market search.
  const VERSION_SLOTS = 32;
  const cardVersionCache = new Map(); // regular id -> Promise<[{ definitionId, rating, rarity }]>

  // Holographic cards: EA marks the item ("hyper cosmetics"); FUT Genie (pc) also has a catalogue of them.
  const holoIds = new Set();
  let holoCatalogue = null;
  function loadHoloCatalogue() {
    if (holoCatalogue) return holoCatalogue;
    const dispatcher = window.FutGenieDispatcher;
    if (!dispatcher || typeof dispatcher._galleryHolographicCatalogue !== "function") return Promise.resolve();
    holoCatalogue = Promise.resolve(dispatcher._galleryHolographicCatalogue())
      .then(items => {
        (items || []).forEach(item => { if (Number(item.resourceId) > 0) holoIds.add(Number(item.resourceId)); });
        if (!holoIds.size) holoCatalogue = null; // ask again next time
      })
      .catch(() => { holoCatalogue = null; });
    return holoCatalogue;
  }
  function itemIsHolo(item) {
    try {
      if (typeof item.hasHyperCosmetics === "function" && item.hasHyperCosmetics()) return true;
    } catch (_) {
      // Not known for this item.
    }
    return item.holographic === true;
  }
  const isHolo = version => !!version && (version.holo || holoIds.has(version.definitionId));

  // Versions of several players in one concept search (name lookalikes of a tip line).
  function cardVersionsMany(baseIds) {
    const missing = [...new Set(baseIds)].filter(id => !cardVersionCache.has(id));
    if (missing.length) {
      const request = new Promise(resolve => {
        if (!services.Item || typeof services.Item.searchConceptItems !== "function") return resolve([]);
        const criteria = baseCriteria();
        criteria.defId = missing.flatMap(id => Array.from({ length: VERSION_SLOTS }, (_, version) => id + version * 0x1000000));
        criteria.count = CLUB_PAGE_SIZE;
        criteria.offset = 0;
        const owner = {};
        const timer = window.setTimeout(() => resolve([]), 15000);
        try {
          services.Item.searchConceptItems(criteria).observe(owner, (observable, response) => {
            observable.unobserve(owner);
            window.clearTimeout(timer);
            resolve(response.success && response.response ? response.response.items || [] : []);
          });
        } catch (error) {
          window.clearTimeout(timer);
          resolve([]);
        }
      });
      missing.forEach(baseId => {
        const promise = request.then(items => items
          .filter(item => item && (item.definitionId & 0xFFFFFF) === baseId)
          .map(item => ({ definitionId: item.definitionId, rating: item.rating, rarity: item.rareflag, holo: itemIsHolo(item) }))
          .sort((a, b) => b.rating - a.rating || a.definitionId - b.definitionId));
        cardVersionCache.set(baseId, promise);
        // Failed or empty: ask again next time.
        promise.then(versions => { if (!versions.length) cardVersionCache.delete(baseId); });
      });
    }
    return Promise.all(baseIds.map(id => cardVersionCache.get(id) || Promise.resolve([])))
      .then(lists => new Map(baseIds.map((id, i) => [id, lists[i]])));
  }

  // The version a tip means: its rating, and the Genie price closest to just above the tip price
  // (tips buy a bit under the market). Untradeable versions (no price) only if nothing else fits.
  function versionCost(version, tipCoins) {
    const price = (geniePrice(version.definitionId) || {}).price;
    if (!price) return 50;
    return tipCoins ? Math.abs(Math.log(price / tipCoins) - Math.log(1.06)) : 0;
  }

  function pickVersion(versions, tipRating, tipCoins) {
    const rated = versions.filter(version => version.rating === tipRating);
    // A tip means the normal card; a holo of it only if that's all there is.
    const pool = rated.some(version => !isHolo(version)) ? rated.filter(version => !isHolo(version)) : rated;
    if (!pool.length) return null;
    // Without a tip price ("Svitková 76"): the regular card (id below 2^24) when it has that rating.
    if (!tipCoins) return pool.find(version => version.definitionId < 0x1000000) || [...pool].sort((a, b) => versionCost(a, tipCoins) - versionCost(b, tipCoins))[0];
    return [...pool].sort((a, b) => versionCost(a, tipCoins) - versionCost(b, tipCoins))[0];
  }

  // A priced tip without a rating: the regular card when its Genie price is within 1.5× of the tip's fit,
  // otherwise the normal (non-holo) version closest to the tip price.
  function pickUnratedVersion(versions, baseId, tipCoins) {
    const regular = versions.find(version => version.definitionId === baseId) || null;
    if (!tipCoins) return regular || versions[0] || null;
    const FAR = Math.log(1.5);
    if (regular && versionCost(regular, tipCoins) <= FAR) return regular;
    const best = versions.filter(version => !isHolo(version)).sort((a, b) => versionCost(a, tipCoins) - versionCost(b, tipCoins))[0];
    return best && versionCost(best, tipCoins) <= FAR ? best : regular || best || versions[0] || null;
  }

  function versionLabel(version, baseId) {
    const price = (geniePrice(version.definitionId) || {}).price;
    const kind = version.definitionId === baseId ? "Gewoon" : rarityName(version.rarity);
    return `${isHolo(version) ? "✨ Holo " : ""}${kind} ${version.rating}` + (price ? ` · Genie ${priceFormat.format(price)}` : L(" · geen prijs", " · no price"));
  }

  // The holo twin of a normal version (same rating and rarity), and the normal one of a holo.
  function holoTwin(versions, version) {
    if (!version) return null;
    return versions.find(other => other.definitionId !== version.definitionId && other.rating === version.rating &&
      other.rarity === version.rarity && isHolo(other) !== isHolo(version)) || null;
  }

  function parsePlayerTip(text) {
    const players = [];
    const seen = new Set();
    let skipped = 0;
    const platform = userPlatform();
    String(text || "").split(/\r?\n/).forEach(rawLine => {
      const rated = parseRatedPriceLine(rawLine, platform) || parseUnratedPriceLine(rawLine, platform);
      if (rated) {
        const match = rated.rating ? matchRatedPlayer(rated.name, rated.rating) : matchPlayer(rated.name);
        if (!match.player) {
          skipped++;
          return;
        }
        if (seen.has(match.player.id)) return;
        seen.add(match.player.id);
        players.push(Object.assign(match, { raw: rawLine.trim(), fixedMax: rated.coins, skip: rated.skip, priced: true, tipRating: rated.rating, fitCoins: rated.fitCoins }));
        return;
      }
      if (rawLine.trim().split(/\s+/).length > 10) return; // a sentence, not a list of names
      if (DISCARD_WORD.test(rawLine)) return; // "Discard on bids" is an instruction, not a player
      rawLine.split(/[,;/]/).forEach(part => {
        const line = part.replace(/@\w+/g, "").replace(/[•*_~`>]+/g, " ").replace(/^\s*[-–\d.)]+\s*/, "").trim();
        // "Svitková 76" / "Svitková-76": a name with the card's rating, no price.
        const withRating = line.match(/^([^\d]+?)\s*[-–]?\s*(\d{2})$/);
        if (withRating && +withRating[2] >= 45 && withRating[1].trim().split(/\s+/).length <= 4) {
          const rating = +withRating[2];
          const match = matchRatedPlayer(withRating[1].trim(), rating);
          if (!match.player) {
            skipped++;
            return;
          }
          if (seen.has(match.player.id)) return;
          seen.add(match.player.id);
          players.push(Object.assign(match, { raw: line, tipRating: rating }));
          return;
        }
        if (!line || /\d/.test(line) || /^skip$/i.test(line)) return; // "skip" is a price column, not Oliver Skipp
        const words = line.split(/\s+/);
        if (words.length > 4 || line.length > 32 || /[.!?:]$/.test(line)) return; // prose
        if (matchLeague(line)) return;
        const match = matchPlayer(line);
        if (!match.player) {
          skipped++;
          return;
        }
        if (seen.has(match.player.id)) return;
        seen.add(match.player.id);
        players.push(match);
      });
    });
    // "Discard on bids" / "at discard": bid list at the quick-sell value (see playerMax).
    return { players, skipped, platform, windows: parseWindows(text), discard: DISCARD_WORD.test(String(text || "")) };
  }

  // --- Inventory: what you own per rule, what it cost, what it's worth ----------
  // list.inventory = { updatedAt, rules: { "teamId|level": { untradeable, items: [{ d: definitionId, b: buyPrice }] } } }

  const EA_TAX = 0.05;
  const CLUB_SEARCH_DELAY_MS = 1200;
  const CLUB_PAGE_SIZE = 91;
  const inventoryProgress = new Map(); // listId -> "3/17"

  function itemLevel(item) {
    if (item.isGoldRating && item.isGoldRating()) return "gold";
    if (item.isSilverRating && item.isSilverRating()) return "silver";
    if (item.isBronzeRating && item.isBronzeRating()) return "bronze";
    return item.rating >= 75 ? "gold" : item.rating >= 65 ? "silver" : "bronze";
  }

  // Club search: the same request the Club screen makes (no transfer market search).
  function clubSearchPage(applyFilter, offset) {
    const criteria = baseCriteria();
    applyFilter(criteria);
    criteria.count = CLUB_PAGE_SIZE;
    criteria.offset = offset;
    return new Promise(resolve => {
      const owner = {};
      const timer = window.setTimeout(() => resolve({ items: [], done: true, failed: true }), 15000);
      services.Club.search(criteria).observe(owner, (observable, response) => {
        observable.unobserve(owner);
        window.clearTimeout(timer);
        const items = response.success && response.response ? response.response.items || [] : [];
        try { learnDiscardValues(items); } catch (_) { /* optional */ }
        resolve({ items, done: !response.success || !response.response || response.response.retrievedAll || items.length < CLUB_PAGE_SIZE, failed: !response.success });
      });
    });
  }

  async function clubItems(applyFilter) {
    const items = [];
    for (let offset = 0, page = 0; page < 30; page++, offset += CLUB_PAGE_SIZE) {
      if (page) await new Promise(resolve => window.setTimeout(resolve, CLUB_SEARCH_DELAY_MS));
      const result = await clubSearchPage(applyFilter, offset);
      if (result.failed) throw new Error(L("Club doorzoeken mislukt", "Club search failed"));
      items.push(...result.items);
      if (result.done) break;
    }
    return items;
  }

  function pileItems(pile) {
    const collection = pile && pile._collection;
    if (!collection) return [];
    return (Array.isArray(collection) ? collection : Object.values(collection)).filter(Boolean);
  }

  function auctionOf(item) {
    return item._auction || (item.getAuctionData && item.getAuctionData()) || null;
  }

  // EA keeps the transfer list and unassigned pile cached: without marking them dirty a request
  // returns the old copy (listings stay "active", sales never show). Same as FUT Genie does.
  function markPileDirty(method) {
    try {
      const name = { requestTransferItems: "TRANSFER", requestUnassignedItems: "PURCHASED" }[method];
      const pile = name && typeof ItemPile !== "undefined" ? ItemPile[name] : null;
      if (pile != null && repositories.Item && typeof repositories.Item.setDirty === "function") repositories.Item.setDirty(pile);
    } catch (_) {
      // The cached copy, then.
    }
  }

  // Ask for one pile the way its own screen does; null when the request fails or doesn't exist.
  function requestPile(method) {
    return new Promise(resolve => {
      if (!services.Item || typeof services.Item[method] !== "function") return resolve(null);
      markPileDirty(method);
      const owner = {};
      const timer = window.setTimeout(() => resolve(null), 15000);
      try {
        services.Item[method]().observe(owner, (observable, response) => {
          observable.unobserve(owner);
          window.clearTimeout(timer);
          resolve(response.success && response.response ? response.response.items || [] : null);
        });
      } catch (error) {
        window.clearTimeout(timer);
        resolve(null);
      }
    });
  }

  const wonPrices = new Map(); // item id -> winning bid, for cards still in Transfer Targets

  // Your cards outside the club: transfer list (not yet sold), unassigned, and won cards still in
  // Transfer Targets. Fetched fresh (falls back to what the web app has loaded). Never the market.
  async function itemsOutsideClub() {
    const piles = [
      { method: "requestTransferItems", pile: "transfer", keep: item => { const a = auctionOf(item); return !(a && (a.isSold ? a.isSold() : a.tradeState === "closed")); } },
      { method: "requestUnassignedItems", pile: "unassigned", keep: () => true },
      { method: "requestWatchedItems", pile: "watchlist", keep: item => {
        const a = auctionOf(item);
        if (!a || !(a.isWon ? a.isWon() : a.tradeState === "closed" && a.bidState === "highest")) return false;
        if (a.currentBid > 0) wonPrices.set(item.id, a.currentBid);
        return true;
      } }
    ];
    const items = [];
    for (let i = 0; i < piles.length; i++) {
      if (i) await new Promise(resolve => window.setTimeout(resolve, CLUB_SEARCH_DELAY_MS));
      const fetched = await requestPile(piles[i].method);
      (fetched || pileItems(repositories.Item[piles[i].pile])).filter(Boolean).filter(piles[i].keep).forEach(item => items.push(item));
    }
    return items;
  }

  function addToBucket(bucket, item) {
    if (item.isTradeable && !item.isTradeable()) {
      bucket.untradeable++;
      return;
    }
    const buy = item.lastSalePrice > 0 ? item.lastSalePrice : wonPrices.get(item.id) || 0;
    bucket.items.push({ d: item.definitionId, b: buy });
  }

  function isManagerItem(item) {
    return !!item && (item.isManager ? item.isManager() : item.type === "manager" || item.type === "staff");
  }

  function isCountable(item, seen, managers = false) {
    if (!item || seen.has(item.id) || item.concept) return false;
    if (managers ? !isManagerItem(item) : !item.isPlayer || !item.isPlayer()) return false;
    learnNation(item);
    if (item.isLimitedUse && item.isLimitedUse()) return false; // loans
    seen.add(item.id);
    return true;
  }

  // Filter lists: one club search per rule (nation + quality, league if fixed), positions checked here.
  async function updateFilterInventory(list) {
    inventoryProgress.set(list.id, L("lijsten…", "lists…"));
    listeners.forEach(listener => listener());
    const outside = await itemsOutsideClub();
    const targets = list.rules.filter(rule => rule.enabled !== false);
    const rules = {};
    let failed = false;
    for (let i = 0; i < targets.length; i++) {
      const rule = targets[i];
      inventoryProgress.set(list.id, `${i + 1}/${targets.length}`);
      listeners.forEach(listener => listener());
      await new Promise(resolve => window.setTimeout(resolve, CLUB_SEARCH_DELAY_MS));
      let items;
      try {
        items = await clubItems(criteria => {
          if (rule.kind === "manager") setManagerType(criteria);
          if (rule.level) criteria.level = SearchLevel[rule.level.toUpperCase()];
          if (rule.nation) criteria.nation = rule.nation.id;
          if (rule.leagues.length === 1 && !rule.leaguesOptional) criteria.league = rule.leagues[0].id;
        });
      } catch (error) {
        console.warn("Price Watch:", error);
        failed = true;
        break;
      }
      const bucket = { untradeable: 0, items: [] };
      const seen = new Set();
      items.concat(outside).filter(item => filterMatches(rule, item)).forEach(item => { if (isCountable(item, seen, rule.kind === "manager")) addToBucket(bucket, item); });
      rules[`f${rule.id}`] = bucket;
    }
    inventoryProgress.delete(list.id);
    if (!failed) {
      list.inventory = { updatedAt: Date.now(), rules };
      saveStock();
      fetchGeniePrices(Object.values(rules).flatMap(bucket => bucket.items.map(item => item.d))).then(() => listeners.forEach(listener => listener()));
    } else {
      listeners.forEach(listener => listener());
    }
  }

  async function updateInventory(list) {
    if (inventoryProgress.has(list.id)) return;
    if (list.type === "filters") return updateFilterInventory(list);
    const isPlayers = list.type === "players";
    const isFodder = list.type === "fodder";
    const levels = new Set(isPlayers || isFodder ? [] : LEVELS.filter(level => list.levels[level] && list.levels[level].enabled));
    const rules = {};
    stockRules(list).forEach(rule => { rules[rule.key] = { untradeable: 0, items: [] }; });

    // Cards on the transfer list, unassigned and won in Transfer Targets also count as stock.
    inventoryProgress.set(list.id, L("lijsten…", "lists…"));
    listeners.forEach(listener => listener());
    const transferPile = await itemsOutsideClub();
    const targets = isFodder ? stockRules(list).map(rule => rule.fodder) : isPlayers ? list.players : list.clubs;
    let failed = false;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      inventoryProgress.set(list.id, `${i + 1}/${targets.length}`);
      listeners.forEach(listener => listener());
      if (i) await new Promise(resolve => window.setTimeout(resolve, CLUB_SEARCH_DELAY_MS));

      let items;
      try {
        items = isFodder
          ? await clubItems(criteria => { criteria.ovrMin = target.rating; criteria.ovrMax = target.rating; })
          : isPlayers
            ? await clubItems(criteria => { criteria.defId = [target.definitionId]; })
            : await clubItems(criteria => { criteria.club = target.teamId; });
      } catch (error) {
        console.warn("Price Watch:", error);
        failed = true;
        break;
      }

      const seen = new Set();
      if (isFodder) {
        // Regular (non-special) cards of that rating only.
        const bucket = rules[`r${target.rating}`];
        items.concat(transferPile)
          .filter(item => item && item.rating === target.rating && !(item.isSpecial && item.isSpecial()))
          .forEach(item => { if (isCountable(item, seen)) addToBucket(bucket, item); });
        continue;
      }
      if (isPlayers) {
        const bucket = rules[`p${target.definitionId}`];
        items.concat(transferPile)
          .filter(item => item && item.definitionId === target.definitionId)
          .forEach(item => { if (isCountable(item, seen)) addToBucket(bucket, item); });
        continue;
      }

      items.concat(transferPile.filter(item => item.teamId === target.teamId)).forEach(item => {
        if (!isCountable(item, seen)) return;
        const level = itemLevel(item);
        const bucket = levels.has(level) && rules[`${target.teamId}|${level}`];
        if (bucket) addToBucket(bucket, item);
      });
    }

    inventoryProgress.delete(list.id);
    if (!failed) {
      list.inventory = { updatedAt: Date.now(), rules };
      saveStock();
      const ids = Object.values(rules).flatMap(bucket => bucket.items.map(item => item.d));
      fetchGeniePrices(ids).then(() => listeners.forEach(listener => listener()));
    } else {
      listeners.forEach(listener => listener());
    }
  }

  // EA price steps, used to round the break-even sell price up to a listable price.
  function roundUpToStep(price) {
    const step = price < 1000 ? 50 : price < 10000 ? 100 : price < 50000 ? 250 : price < 100000 ? 500 : 1000;
    return Math.ceil(price / step) * step;
  }

  function summarizeBucket(bucket) {
    if (!bucket) return null;
    const bought = bucket.items.filter(item => item.b > 0);
    const valued = bought.filter(item => geniePrice(item.d));
    const cost = bought.reduce((sum, item) => sum + item.b, 0);
    const valuedCost = valued.reduce((sum, item) => sum + item.b, 0);
    const value = valued.reduce((sum, item) => sum + geniePrice(item.d).price, 0);
    const avgBuy = bought.length ? cost / bought.length : null;
    return {
      owned: bucket.items.length,
      untradeable: bucket.untradeable,
      bought: bought.length,
      cost,
      avgBuy,
      avgValue: valued.length ? value / valued.length : null,
      // Profit if every valued card were sold at its FUT Genie price, after EA tax.
      net: valued.length ? Math.round(value * (1 - EA_TAX) - valuedCost) : null,
      breakEven: avgBuy ? roundUpToStep(avgBuy / (1 - EA_TAX)) : null
    };
  }

  // --- Club index (all leagues known to the web app) -------------------------

  let clubIndex = null;

  function getClubIndex() {
    if (clubIndex) return clubIndex;
    const leagues = factories.DataProvider.getLeagueDP().filter(league => league.id > 0);
    const clubs = [];
    leagues.forEach(league => {
      factories.DataProvider.getTeamDP(league.id).forEach(team => {
        if (team.id > 0) clubs.push({ teamId: team.id, teamName: team.label, leagueId: league.id, leagueName: league.label, norm: normalizeName(team.label) });
      });
    });
    clubIndex = { leagues: leagues.map(league => ({ ...league, short: shortLeague(league.label) })), clubs };
    return clubIndex;
  }

  const NAME_STOPWORDS = new Set(["fc", "cf", "sc", "afc", "club", "the", "al", "de", "ac"]);

  function normalizeName(value) {
    return String(value || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(word => word && !NAME_STOPWORDS.has(word))
      .join(" ");
  }

  // "MLS (USA 1)" -> "mls"; "ROSHN Saudi League (SAU 1)" -> "roshn saudi league"
  function shortLeague(label) {
    return normalizeName(String(label).replace(/\(.*?\)/g, ""));
  }

  const LEAGUE_ALIASES = {
    roshn: 350, saudi: 350, spl: 350, "saudi pro league": 350,
    epl: 13, "premier league": 13, prem: 13,
    laliga: 53, "la liga": 53, "serie a": 31, bundesliga: 19, "ligue 1": 16, eredivisie: 10,
    wsl: 2216, "barclays wsl": 2216, nwsl: 2221, mls: 39
  };

  function levenshtein(a, b) {
    if (a === b) return 0;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  // 0..1 score for how well a name from the tip matches an EA club name.
  function nameScore(query, target) {
    if (!query || !target) return 0;
    if (query === target) return 1;
    let score = similarity(query, target);

    // "boston" vs "boston legacy", "philadelphia union" vs "philadelphia"
    if (target.startsWith(query + " ") || query.startsWith(target + " ")) score = Math.max(score, 0.9);

    const q = query.split(" ");
    const t = target.split(" ");
    const matched = q.filter(word => t.some(other => other === word || (word.length > 3 && similarity(word, other) >= 0.8))).length;
    score = Math.max(score, (2 * matched / (q.length + t.length)) * 0.95);
    return score;
  }

  function matchClub(rawName, leagueId) {
    const query = normalizeName(rawName);
    const { clubs } = getClubIndex();
    const scored = clubs
      .map(club => ({ club, score: nameScore(query, club.norm) * (leagueId && club.leagueId !== leagueId ? 0.9 : 1) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    let status = !best || best.score < MATCH_MAYBE ? "none" : best.score >= MATCH_SURE ? "sure" : "maybe";
    // Two near-identical candidates (e.g. without league context): let the user decide.
    if (status === "sure" && second && best.score - second.score < 0.03 && second.club.teamId !== best.club.teamId) status = "maybe";
    // Best match lives in another league than the tip's heading (e.g. "Portland timbers" under NWSL).
    if (status === "sure" && leagueId && best.club.leagueId !== leagueId) status = "maybe";
    return {
      raw: rawName,
      status,
      club: status === "none" ? null : best.club,
      candidates: scored.slice(0, 8).filter(item => item.score >= 0.35).map(item => item.club)
    };
  }

  function matchLeague(line) {
    const query = normalizeName(line);
    if (!query) return null;
    if (LEAGUE_ALIASES[query]) return LEAGUE_ALIASES[query];
    const { leagues } = getClubIndex();
    let best = null;
    leagues.forEach(league => {
      const score = Math.max(nameScore(query, league.short), league.short.split(" ")[0] === query ? 0.95 : 0);
      if (!best || score > best.score) best = { id: league.id, score };
    });
    return best && best.score >= 0.9 ? best.id : null;
  }

  // --- Tip parser ---------------------------------------------------------------

  function parseCoins(value) {
    if (!value) return null;
    const text = String(value).toLowerCase().replace(/\s+/g, "");
    const thousands = text.endsWith("k");
    const number = parseFloat(text.replace(/k$/, "").replace(",", "."));
    if (!Number.isFinite(number)) return null;
    return Math.round(thousands ? number * 1000 : number);
  }

  // "Golds <650-700", "golds <700/750", "Golds <650 / <700": the second number is the max BIN.
  const PRICE_LINE = /\b(golds?|silvers?|bronzes?)\b[^\d]*(\d[\d.,]*\s*k?)(?:\s*[-–/]\s*[<≤]?\s*(\d[\d.,]*\s*k?))?/i;
  // "SILVER OPTIONS", "Bronzes:", "Gold clubs": the clubs below it are for that quality only.
  const LEVEL_HEADING = /^(golds?|silvers?|bronzes?)(?:\s+(?:options?|clubs?|teams?|list))?$/i;

  const FLIP_UNDER = /(\d[\d.,]*\s*k?)\s*c?(?:\s*[-–]\s*(\d[\d.,]*\s*k?)\s*c?)?\s+(?:below|under)\s+(?:the\s+)?market/i;
  const FLIP_MARKUP = /\blist\s+(?:at\s+|for\s+)?\+\s*(\d[\d.,]*\s*k?)\s*c?(?:\s*[-–]\s*\+?\s*(\d[\d.,]*\s*k?)\s*c?)?/i;

  function levelFromWord(word) {
    const lower = word.toLowerCase();
    return lower.startsWith("gold") ? "gold" : lower.startsWith("silver") ? "silver" : "bronze";
  }

  function parseTip(text) {
    const levels = {
      gold: { enabled: false, max: null, ideal: null },
      silver: { enabled: false, max: null, ideal: null },
      bronze: { enabled: false, max: null, ideal: null }
    };
    const clubs = [];
    let leagueId = null;
    let section = null;
    let sections = false;
    let flip = null;

    String(text || "").split(/\r?\n/).forEach(rawLine => {
      // "buy 50-100c under market and list +300-900c": buy below the market you see, relist higher.
      const under = rawLine.match(FLIP_UNDER);
      if (under) {
        const markup = rawLine.match(FLIP_MARKUP);
        flip = {
          under: parseCoins(under[2]) || parseCoins(under[1]),
          sellLow: markup ? parseCoins(markup[1]) : FLIP_DEFAULT.sellLow,
          sellHigh: markup ? parseCoins(markup[2]) || parseCoins(markup[1]) : FLIP_DEFAULT.sellHigh
        };
      }
      // Every price on the line: "silvers <300-400 and bronzes 150-200".
      const prices = [...rawLine.matchAll(new RegExp(PRICE_LINE.source, "gi"))];
      const line = rawLine.replace(/@\w+/g, "").replace(/[•*_~`>]+/g, " ").replace(/^\s*[-–]\s*/, "").trim();
      if (!line) return;

      if (prices.length) {
        prices.forEach(price => {
          const low = parseCoins(price[2]);
          const high = parseCoins(price[3]);
          // "<650-700": max BIN = upper bound, ideal = lower bound.
          levels[levelFromWord(price[1])] = { enabled: true, max: high && high > low ? high : low, ideal: high && high > low ? low : null };
        });
        // The club can be on the price line itself: "can try rash - women and men RB Leipzig golds <700/750".
        clubs.push(...clubsBeforePrice(line.slice(0, line.search(/\b(golds?|silvers?|bronzes?)\b/i)), leagueId, section));
        return;
      }

      const heading = line.replace(/:$/, "").trim();
      const levelHeading = heading.match(LEVEL_HEADING);
      if (levelHeading) {
        section = levelFromWord(levelHeading[1]);
        sections = true;
        leagueId = null;
        return;
      }

      const words = heading.split(/\s+/);
      if (words.length > 5 || heading.length > 40 || /[.!?]$/.test(heading)) return; // prose

      const league = words.length <= 3 ? matchLeague(heading) : null;
      if (league) {
        leagueId = league;
        return;
      }
      if (line.endsWith(":")) return; // "We have 2 grind options:"
      clubs.push({ ...matchClub(heading, leagueId), leagueContext: leagueId, level: section });
    });

    return { levels, clubs, sections, flip };
  }

  // Club name in front of the quality word on a price line. "women and men RB Leipzig" -> both RB Leipzig teams
  // (the men's and the women's club have the same name in different leagues).
  function clubsBeforePrice(text, leagueId, section) {
    const tail = String(text || "").split(/\s[-–:|]\s|[.!?;,]\s/).pop() || "";
    const both = /\b(wom[ae]n'?s?|ladies|men'?s?|both)\b/i.test(tail);
    const name = tail.replace(/\b(wom[ae]n'?s?|ladies|men'?s?|both|and|&|the)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (!name || name.split(" ").length > 4) return [];
    const match = matchClub(name, leagueId);
    if (!match.club || (match.status !== "sure" && name.split(" ").length < 2)) return [];
    if (!both) return [{ ...match, leagueContext: leagueId, level: section }];
    const twins = getClubIndex().clubs.filter(club => club.norm === match.club.norm);
    if (twins.length < 2) return [{ ...match, leagueContext: leagueId, level: section }];
    return twins.map(club => ({ raw: `${name} (${shortLeague(club.leagueName)})`, status: "sure", club, candidates: match.candidates, leagueContext: leagueId, level: section }));
  }

  // --- Filter tips: nation + league + quality + positions -------------------------
  // "Silver RB England <650/700 ideally prem", "Spanish Golds Liga F / Pos: GK/ST/LB/RB / 700/750c"
  // List: { id, type: "filters", name, createdAt, platform, goal,
  //         rules: [{ id, raw, level, nation: { id, label } | null, leagues: [{ id, label }],
  //                   leaguesOptional, positions: ["GK"], max, ideal, enabled }], done: {} }

  const MIN_BIN = 200;
  const POSITION_IDS = { GK: 0, RWB: 2, RB: 3, CB: 5, LB: 7, LWB: 8, CDM: 10, RM: 12, CM: 14, LM: 16, CAM: 18, CF: 21, RW: 23, ST: 25, LW: 27 };
  const POSITION_WORD = /\b(GK|RWB|RB|CB|LB|LWB|CDM|CM|CAM|RM|LM|RW|LW|CF|ST)\b/gi;
  const DEMONYMS = {
    spanish: "spain", english: "england", french: "france", german: "germany", italian: "italy", dutch: "holland",
    portuguese: "portugal", brazilian: "brazil", argentine: "argentina", argentinian: "argentina", american: "united states",
    belgian: "belgium", scottish: "scotland", welsh: "wales", irish: "republic of ireland", norwegian: "norway",
    swedish: "sweden", danish: "denmark", japanese: "japan", mexican: "mexico", canadian: "canada", australian: "australia",
    croatian: "croatia", polish: "poland", swiss: "switzerland", austrian: "austria", turkish: "turkiye", colombian: "colombia",
    uruguayan: "uruguay", moroccan: "morocco", nigerian: "nigeria", senegalese: "senegal", korean: "korea republic"
  };
  // Prices need 2+ digits or a "k", so "Ligue 1" isn't read as a price.
  const FILTER_PRICE = /(\d{2,}(?:[.,]\d+)?\s*k?|\d+(?:[.,]\d+)?\s*k)\s*c?\b(?:\s*[-–/]\s*(\d{2,}(?:[.,]\d+)?\s*k?|\d+(?:[.,]\d+)?\s*k)\s*c?\b)?/i;

  let nationList = null;

  function getNations() {
    if (!nationList) {
      nationList = factories.DataProvider.getNationDP().filter(nation => nation.id > 0)
        .map(nation => ({ id: nation.id, label: nation.label, plain: plainName(nation.label) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    return nationList;
  }

  function nationByName(name) {
    const nations = getNations();
    const hit = nations.find(nation => nation.plain === name) || nations.find(nation => nation.plain.startsWith(name) || name.startsWith(nation.plain));
    return hit ? { id: hit.id, label: hit.label } : null;
  }

  function leagueLabel(id) {
    const league = getClubIndex().leagues.find(item => item.id === id);
    return league ? league.label.replace(/\s*\(.*\)/, "") : String(id);
  }

  // Nation named inside a chunk ("england wsl" -> England + "wsl").
  function takeNation(chunk) {
    const padded = ` ${chunk} `;
    let best = null;
    getNations().forEach(nation => {
      if (nation.plain.length >= 4 && padded.includes(` ${nation.plain} `) && (!best || nation.plain.length > best.text.length)) {
        best = { nation: { id: nation.id, label: nation.label }, text: nation.plain };
      }
    });
    Object.entries(DEMONYMS).forEach(([word, name]) => {
      if (!padded.includes(` ${word} `) || (best && best.text.length >= word.length)) return;
      const nation = nationByName(name);
      if (nation) best = { nation, text: word };
    });
    return best ? { nation: best.nation, rest: padded.replace(` ${best.text} `, " ").trim() } : { nation: null, rest: chunk };
  }

  function readFilterLine(rule, line) {
    let rest = line.replace(new RegExp(FLAG.source, "gu"), flag => {
      if (!rule.nation) rule.nation = nationFromFlag(flag);
      return " ";
    });
    const price = rest.match(FILTER_PRICE);
    if (price) {
      const low = parseCoins(price[1]);
      const high = parseCoins(price[2]);
      // "<650/700" or "800-850": max BIN = upper bound, ideal = lower bound.
      if (low && !rule.max) {
        rule.max = high && high > low ? high : low;
        rule.ideal = high && high > low ? low : null;
      }
      rest = rest.replace(price[0], " ");
    }
    rest = rest
      .replace(/\b(golds?|silvers?|bronzes?|pos(?:itions?)?|players?|cards?|only|rares?|commons?)\b/gi, " ")
      .replace(POSITION_WORD, word => {
        const position = word.toUpperCase();
        if (!rule.positions.includes(position)) rule.positions.push(position);
        return " ";
      });

    // Everything after "ideally" is a preference: search those leagues first, then without a league.
    const [main, ...preferred] = rest.split(/\b(?:ideally|ideal|pref(?:erably)?|bonus)\b/i);
    [[main, false], [preferred.join(" "), true]].forEach(([part, optional]) => {
      String(part || "").split(/[\/,&+]|\bor\b|\band\b/i).map(plainName).filter(Boolean).forEach(chunk => {
        let leagueId = matchLeague(chunk);
        if (!leagueId) {
          const found = takeNation(chunk);
          if (found.nation && !rule.nation) rule.nation = found.nation;
          leagueId = found.rest ? matchLeague(found.rest) : null;
          if (!leagueId && found.rest) rule.unknown.push(found.rest);
        }
        if (!leagueId || rule.leagues.some(league => league.id === leagueId)) return;
        rule.leagues.push({ id: leagueId, label: leagueLabel(leagueId) });
        if (optional) rule.leaguesOptional = true;
      });
    });
  }

  // --- Group tips: nations/leagues without a price per line --------------------------
  // "Discard only. Gold/Silvers / Italy vs France / England vs Croatia / Can grab a few bronzes with Greece and Denmark"
  // "Discard only here. Top 5 leagues and nations only. ... try fullback, wingers, strikers."
  const TOP5_LEAGUES = [13, 53, 31, 19, 16];
  const TOP5_NATIONS = ["england", "spain", "italy", "germany", "france"];
  const NATION_NAME_ALIASES = { "czech republic": "czechia", netherlands: "holland", holland: "netherlands", usa: "united states", turkey: "turkiye", "south korea": "korea republic", "ivory coast": "cote d ivoire", czechia: "czech republic", ireland: "republic of ireland" };
  const POSITION_GROUPS = [
    [/\bfull ?backs?\b/i, ["LB", "RB"]],
    [/\bwing ?backs?\b/i, ["LWB", "RWB"]],
    [/\b(centre|center) ?backs?\b|\bcbs\b/i, ["CB"]],
    [/\bwingers?\b|\bwide (men|players)\b/i, ["LW", "RW", "LM", "RM"]],
    [/\bstrikers?\b|\bforwards?\b|\bsts\b/i, ["ST"]],
    [/\bkeepers?\b|\bgoal ?keepers?\b|\bgks\b/i, ["GK"]],
    [/\b(defensive|holding) mids?\b|\bcdms\b/i, ["CDM"]],
    [/\battacking mids?\b|\bcams\b/i, ["CAM"]],
    [/\b(central )?mid(fielder)?s\b|\bcms\b/i, ["CM"]]
  ];

  // --- Quick-sell ("discard") values, learned from cards you see ---------------------
  // EA sends item.discardValue with every card (market results, club). Stored per rating of regular players.
  const DISCARD_KEY = "pt_discard_v1";
  const LEVEL_MIN_RATING = { gold: 75, silver: 65, bronze: 1 };
  let discardValues = (() => {
    try {
      return JSON.parse(localStorage.getItem(DISCARD_KEY) || "{}") || {};
    } catch {
      return {};
    }
  })();

  function learnDiscardValues(items) {
    let changed = false;
    (items || []).forEach(item => {
      const value = item && Number(item.discardValue);
      const rating = item && Number(item.rating);
      try { learnPriceFloor(item); } catch (_) { /* optional */ }
      if (!value || !rating || (item.isPlayer && !item.isPlayer()) || (item.isSpecial && item.isSpecial())) return;
      if (discardValues[rating] !== value) {
        discardValues[rating] = value;
        changed = true;
      }
    });
    if (changed) {
      try { localStorage.setItem(DISCARD_KEY, JSON.stringify(discardValues)); } catch (_) { /* memory only */ }
    }
  }

  // Lowest price EA allows for a card (bottom of its price range): you can't buy below it, not even on bids.
  // Gold 75–81s showed "Price range 600 – 10,000" on FUT.GG (FC27); learned per rating when EA sends the limits.
  const PRICE_FLOOR_KEY = "pt_price_floor_v1";
  const DEFAULT_PRICE_FLOOR = { gold: 600 };
  let priceFloors = (() => {
    try {
      return JSON.parse(localStorage.getItem(PRICE_FLOOR_KEY) || "{}") || {};
    } catch {
      return {};
    }
  })();

  function learnPriceFloor(item) {
    const limits = item && (item._itemPriceLimits || item.itemPriceLimits);
    const minimum = limits && Number(limits.minimum);
    const rating = item && Number(item.rating);
    if (!minimum || !rating || (item.isSpecial && item.isSpecial()) || priceFloors[rating] === minimum) return false;
    priceFloors[rating] = minimum;
    try { localStorage.setItem(PRICE_FLOOR_KEY, JSON.stringify(priceFloors)); } catch (_) { /* memory only */ }
    return true;
  }

  function priceFloorFor(rating, level) {
    const quality = level || (rating >= 75 ? "gold" : rating >= 65 ? "silver" : "bronze");
    return (rating && priceFloors[rating]) || DEFAULT_PRICE_FLOOR[quality] || 0;
  }

  // "At discard" in practice: the quick-sell value, but never below the lowest price the market allows.
  function withFloor(value, rating, level) {
    const floor = priceFloorFor(rating, level);
    if (!value) return floor || null;
    return Math.max(value, floor);
  }

  // Quick-sell value of the lowest rating of that quality (75 for gold): the cheapest card in the filter.
  function discardFor(level) {
    const min = LEVEL_MIN_RATING[level] || 1;
    const max = level === "silver" ? 74 : level === "bronze" ? 64 : 99;
    const ratings = Object.keys(discardValues).map(Number).filter(rating => rating >= min && rating <= max).sort((a, b) => a - b);
    // Only when a card at (or just above) the lowest rating was seen: an 82 quick-sells for more than a 75.
    const value = ratings.length && (level === "bronze" || ratings[0] <= min + 1) ? discardValues[ratings[0]] : null;
    return withFloor(value, level === "bronze" ? null : min, level);
  }

  const DISCARD_WORD = /\b(discard|quick ?sell)\b/i;
  const DISCARD_PRICEY_GAP = 200;
  const DISCARD_UNDER_PRICE = 150;

  // Quick-sell value of one rating: exact, else the nearest lower rating of the same quality (never too high).
  function discardForRating(rating) {
    if (!rating) return null;
    if (discardValues[rating]) return withFloor(discardValues[rating], rating);
    const floor = rating >= 75 ? 75 : rating >= 65 ? 65 : 1;
    const lower = Object.keys(discardValues).map(Number).filter(known => known < rating && known >= floor).sort((a, b) => b - a)[0];
    return withFloor(lower ? discardValues[lower] : null, rating);
  }

  // Max BIN of a filter rule: its own, or for "at discard" the learned quick-sell value.
  function ruleMax(rule) {
    if (rule.max) return rule.max;
    return rule.priceNote === "discard" && rule.level && rule.kind !== "manager" ? discardFor(rule.level) : null;
  }

  function nationByAnyName(name) {
    const plain = plainName(name);
    if (!plain) return null;
    const exact = getNations().find(nation => nation.plain === plain);
    if (exact) return { id: exact.id, label: exact.label };
    if (NATION_NAME_ALIASES[plain]) {
      const alias = getNations().find(nation => nation.plain === NATION_NAME_ALIASES[plain]);
      if (alias) return { id: alias.id, label: alias.label };
    }
    if (DEMONYMS[plain]) return nationByName(DEMONYMS[plain]);
    return null;
  }

  // All nations named in a line, in order of appearance.
  function nationsInLine(line) {
    const words = plainName(line).split(" ");
    const found = [];
    for (let i = 0; i < words.length; i++) {
      for (let size = 3; size >= 1; size--) {
        const nation = i + size <= words.length && nationByAnyName(words.slice(i, i + size).join(" "));
        if (nation && plainName(words.slice(i, i + size).join(" ")).length >= 4) {
          if (!found.some(item => item.id === nation.id)) found.push(nation);
          i += size - 1;
          break;
        }
      }
    }
    return found;
  }

  function levelsInText(text) {
    const levels = [];
    (String(text).match(/\b(golds?|silvers?|bronzes?)\b/gi) || []).forEach(word => {
      const level = levelFromWord(word);
      if (!levels.includes(level)) levels.push(level);
    });
    return levels;
  }

  function parseGroupFilterTip(text) {
    const lines = String(text || "").split(/\r?\n/).map(line => line.replace(/@\w+/g, " ").replace(/[•*_~`]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    const matchups = lines.filter(line => /\s(?:vs?\.?|versus)\s/i.test(line) && nationsInLine(line).length >= 2);
    const top5 = /\btop\s*5\b/i.test(text);
    if (!matchups.length && !top5) return null;

    const discard = /\b(discard|quick ?sell|qs)\b/i.test(text);
    const positions = [];
    POSITION_GROUPS.forEach(([pattern, group]) => {
      if (pattern.test(text)) group.forEach(position => { if (!positions.includes(position)) positions.push(position); });
    });
    // Quality named on a line without nations ("Discard only. Gold/Silvers"); gold when the tip names none.
    const general = levelsInText(lines.filter(line => !nationsInLine(line).length).join(" "));
    const levels = general.length ? general : ["gold"];

    const rules = [];
    const add = (level, nation, leagues, extra = {}) => rules.push({
      id: `${Date.now().toString(36)}${rules.length}`,
      raw: `${LEVEL_LABEL[level]}${nation ? ` · ${nation.label}` : ""}${leagues.length ? ` · ${leagues.map(league => league.label).join("/")}` : ""}${positions.length ? ` · ${positions.join("/")}` : ""}${discard ? " · discard" : ""}`,
      level, nation, leagues, leaguesOptional: false, positions: [...positions], max: null, ideal: null, enabled: true, unknown: [],
      ...(discard ? { priceNote: "discard" } : {}), ...extra
    });

    if (matchups.length) {
      const seen = new Set();
      matchups.forEach(line => nationsInLine(line).forEach(nation => {
        if (seen.has(nation.id)) return;
        seen.add(nation.id);
        levels.forEach(level => add(level, nation, []));
      }));
      // "Can grab a few bronzes with Greece and Denmark": extra quality for the nations on that line.
      lines.filter(line => !matchups.includes(line) && levelsInText(line).length && nationsInLine(line).length).forEach(line => {
        levelsInText(line).forEach(level => nationsInLine(line).forEach(nation => {
          if (!rules.some(rule => rule.level === level && rule.nation && rule.nation.id === nation.id)) add(level, nation, []);
        }));
      });
    } else {
      // Top 5 leagues (and nations): one rule per league; the nation rules start unticked (mostly the same players).
      const withLeagues = /\btop\s*5\s+(leagues?|leagues? and nations?)\b|\bleagues?\b/i.test(text);
      const withNations = /\bnations?\b|\bcountr(y|ies)\b/i.test(text);
      levels.forEach(level => {
        if (withLeagues || !withNations) TOP5_LEAGUES.forEach(id => add(level, null, [{ id, label: leagueLabel(id) }]));
        if (withNations) TOP5_NATIONS.forEach(name => {
          const nation = nationByAnyName(name);
          if (nation) add(level, nation, [], { enabled: !withLeagues });
        });
      });
    }
    const platformMatch = String(text || "").match(/(?:^|[\s@])(console|ps[45]?|xbox|pc)\b/i);
    const platform = platformMatch ? (platformMatch[1].toLowerCase() === "pc" ? "pc" : "console") : null;
    return rules.length ? { platform, rules, grouped: true } : null;
  }

  function parseFilterTip(text) {
    const grouped = parseGroupFilterTip(text);
    if (grouped) return grouped;
    const rules = [];
    let current = null;
    const platformMatch = String(text || "").match(/(?:^|[\s@])(console|ps[45]?|xbox|pc)\b/i);
    const platform = platformMatch ? (platformMatch[1].toLowerCase() === "pc" ? "pc" : "console") : null;

    String(text || "").split(/\r?\n/).forEach(rawLine => {
      const line = rawLine.replace(/@\w+/g, " ").replace(/[•*_~`]+/g, " ").replace(/\s+/g, " ").trim();
      if (!line || /^(console|ps[45]?|xbox|pc)$/i.test(line)) return;
      if (/\bmanagers?\b/i.test(line)) {
        const added = parseManagerLine(line, rules);
        current = added.length ? null : current;
        return;
      }
      const level = line.match(/\b(golds?|silvers?|bronzes?)\b/i);
      if (level) {
        // A quality word starts a new rule; the lines after it (positions, price) belong to it.
        const word = level[1].toLowerCase();
        current = {
          id: `${Date.now().toString(36)}${rules.length}`,
          raw: line,
          level: word.startsWith("gold") ? "gold" : word.startsWith("silver") ? "silver" : "bronze",
          nation: null, leagues: [], leaguesOptional: false, positions: [], max: null, ideal: null, enabled: true, unknown: []
        };
        rules.push(current);
      } else if (current) {
        // A follow-up line ("Pos: GK/ST", "<650/700 ideally prem") belongs to the rule above. A heading
        // ("France - Ligue 1") or a sentence ("If Cards sell @ 900") ends it instead.
        const probe = { nation: null, leagues: [], leaguesOptional: false, positions: [], max: null, ideal: null, unknown: [] };
        readFilterLine(probe, line);
        const unknownWords = probe.unknown.join(" ").split(/\s+/).filter(Boolean).length;
        if (unknownWords > 1 || !(probe.positions.length || probe.max || probe.leaguesOptional)) {
          current = null;
          return;
        }
        current.raw += ` · ${line}`;
      } else {
        return;
      }
      readFilterLine(current, line);
    });

    return { platform, rules: rules.filter(rule => rule.nation || rule.leagues.length) };
  }

  // Search steps of one rule: each position × each league (optional leagues end with "any league").
  function filterSteps(rule) {
    const leagues = rule.leagues.length ? (rule.leaguesOptional ? [...rule.leagues, null] : rule.leagues) : [null];
    const positions = rule.positions.length ? rule.positions : [null];
    return positions.flatMap(position => leagues.map(league => ({ position, league, filter: rule })));
  }

  function filterStepLabel(step) {
    return `${step.position || (step.filter && step.filter.kind === "manager" ? "managers" : L("alle posities", "all positions"))} · ${step.league ? step.league.label : L("alle competities", "all leagues")}`;
  }

  function filterRuleTitle(rule) {
    const what = rule.kind === "manager"
      ? `${rule.level ? `${LEVEL_LABEL[rule.level]}e ` : ""}managers`
      : `${LEVEL_LABEL[rule.level]}${rule.positions.length ? ` ${rule.positions.join("/")}` : ""}`;
    return `${what}${rule.nation ? ` · ${rule.nation.label}` : ""}`;
  }

  // Market/club search for managers instead of players.
  function setManagerType(criteria) {
    criteria.type = (typeof SearchType !== "undefined" && (SearchType.STAFF || SearchType.MANAGER)) || "staff";
    criteria.category = (typeof SearchCategory !== "undefined" && SearchCategory.MANAGER) || "manager";
  }

  // "Tunisia managers at discard can also try wales managers at min. price": one rule per "managers".
  // Nation/quality come before the word, the price note after it (until the next nation).
  function parseManagerLine(line, rules) {
    const pieces = line.split(/\bmanagers?\b/i);
    const added = [];
    for (let i = 0; i < pieces.length - 1; i++) {
      const before = plainName(pieces[i]);
      const after = pieces[i + 1];
      // Last nation named before "managers".
      let nation = null;
      const words = before.split(" ");
      for (let start = words.length - 1; start >= 0 && !nation; start--) {
        nation = takeNation(words.slice(start).join(" ")).nation;
      }
      const level = before.match(/\b(golds?|silvers?|bronzes?)\b/);
      const leagueWords = before.split(" ").slice(-3).join(" ");
      const leagueId = matchLeague(takeNation(leagueWords).rest);
      const price = after.match(FILTER_PRICE);
      const low = price ? parseCoins(price[1]) : null;
      const high = price ? parseCoins(price[2]) : null;
      const rule = {
        id: `${Date.now().toString(36)}${rules.length + added.length}`,
        kind: "manager",
        raw: `${level ? `${level[1]} ` : ""}${nation ? nation.label : "?"} managers${after.split(/\b(?:can|also|try|and|or)\b/i)[0].replace(/\s+$/, "")}`,
        level: level ? (level[1].startsWith("gold") ? "gold" : level[1].startsWith("silver") ? "silver" : "bronze") : null,
        nation, leagues: leagueId ? [{ id: leagueId, label: leagueLabel(leagueId) }] : [], leaguesOptional: false, positions: [],
        max: high && high > low ? high : low, ideal: high && high > low ? low : null, enabled: true, unknown: []
      };
      // "at min (price)" = the lowest BIN; "at discard" = the quick-sell value, which you fill in yourself.
      if (!rule.max && /\bmin(?:imum)?\b/i.test(after)) rule.max = MIN_BIN;
      if (!rule.max && /\b(discard|quick ?sell|qs)\b/i.test(after)) rule.priceNote = "discard";
      if (/\bno risk\b/i.test(after)) rule.note = L("geen risico", "no risk");
      if (nation) added.push(rule);
    }
    rules.push(...added);
    return added;
  }

  function positionMatches(item, position) {
    const preferred = item.preferredPosition;
    return typeof preferred === "string" ? preferred.toUpperCase() === position : POSITION_IDS[position] === preferred;
  }

  function filterMatches(rule, item) {
    if (rule.kind === "manager") {
      return isManagerItem(item) && (!rule.level || itemLevel(item) === rule.level) &&
        (!rule.nation || item.nationId === rule.nation.id) &&
        (!rule.leagues.length || rule.leaguesOptional || rule.leagues.some(league => league.id === item.leagueId));
    }
    return !!item && itemLevel(item) === rule.level && !(item.isSpecial && item.isSpecial()) &&
      (!rule.nation || item.nationId === rule.nation.id) &&
      (!rule.leagues.length || rule.leaguesOptional || rule.leagues.some(league => league.id === item.leagueId)) &&
      (!rule.positions.length || rule.positions.some(position => positionMatches(item, position)));
  }

  // --- Run: walk through the rules, one prepared filter screen at a time ----------

  let run = (() => {
    try {
      return JSON.parse(localStorage.getItem(RUN_KEY) || "null");
    } catch {
      return null;
    }
  })();

  function saveRun() {
    try {
      if (run) localStorage.setItem(RUN_KEY, JSON.stringify(run));
      else localStorage.removeItem(RUN_KEY);
    } catch (_) {
      // Run state is kept in memory for this session.
    }
    renderRunBar();
    listeners.forEach(listener => listener());
  }

  // Every completed BIN round raises the min bid by 50 (the first round keeps EA's default, the first restart
  // is 150). Not for bid lists, and not on a card whose max BIN is at or below it.
  function applyRunMinBid(list, rule, criteria) {
    const min = Number(list.fodderBidMin) || 0;
    if (!min || list.mode === "bid") return;
    criteria.minBid = rule.max && min >= rule.max ? 0 : min;
  }

  function prepareRule(list, rule) {
    const criteria = baseCriteria();
    let playerData = null;
    if (rule.fodder) {
      criteria.ovrMin = rule.fodder.rating;
      criteria.ovrMax = rule.fodder.rating;
      criteria.level = rule.fodder.rating >= 75 ? SearchLevel.GOLD : rule.fodder.rating >= 65 ? SearchLevel.SILVER : SearchLevel.BRONZE;
      // Bids: max bid filter; otherwise max buy now.
      if (rule.max) {
        if (list.mode === "bid") criteria.maxBid = rule.max;
        else criteria.maxBuy = rule.max;
      }
      applyRunMinBid(list, rule, criteria);
      openFilters(criteria, null);
      list.done = list.done || {};
      list.done[rule.key] = Date.now();
      saveStock();
      return;
    }
    if (rule.filter) {
      if (rule.filter.kind === "manager") setManagerType(criteria);
      if (rule.filter.level) criteria.level = SearchLevel[rule.filter.level.toUpperCase()];
      if (rule.filter.nation) criteria.nation = rule.filter.nation.id;
      if (rule.league) criteria.league = rule.league.id;
      if (rule.position) criteria.position = rule.position;
      if (rule.max) criteria.maxBuy = rule.max;
      applyRunMinBid(list, rule, criteria);
      openFilters(criteria, null);
      list.done = list.done || {};
      list.done[rule.key] = Date.now();
      saveStock();
      return;
    }
    if (rule.player) {
      const baseId = rule.player.definitionId & 0xFFFFFF;
      const rating = rule.player.rating || 0;
      criteria.maskedDefId = baseId;
      if (rule.player.special) {
        // TOTW/promo version: quality "Special" leaves the regular card out (no level at all if the enum lacks it).
        const special = SearchLevel.SPECIAL || SearchLevel.SP;
        if (special) criteria.level = special;
        if (rule.player.rarity != null) criteria.rarities = [rule.player.rarity];
      } else {
        // The regular card of that quality (no specials).
        criteria.level = rating >= 75 ? SearchLevel.GOLD : rating >= 65 ? SearchLevel.SILVER : SearchLevel.BRONZE;
      }
      playerData = repositories.Item.getStaticDataByDefId(baseId);
    } else {
      if (rule.club.leagueId > 0) criteria.league = rule.club.leagueId;
      criteria.club = rule.club.teamId;
      criteria.level = SearchLevel[rule.level.toUpperCase()];
    }
    if (rule.max) {
      // Fodder cycles in bid mode filter on max bid; BIN mode filters on max buy now.
      if (rule.player && list.mode === "bid") criteria.maxBid = rule.max;
      else criteria.maxBuy = rule.max;
    }
    applyRunMinBid(list, rule, criteria);
    // Holo snipe lists: only holographic cards (FUT Genie's "Holographic only" flag; see installMarketWatch).
    if (rule.player && (list.holo || rule.player.holo)) criteria.__futgenieHoloOnly = true;
    openFilters(criteria, playerData);
    list.done = list.done || {};
    list.done[rule.key] = Date.now();
    saveStock();
  }

  let runLoading = false;
  let runPricesAt = 0;

  function goToRule(listId, index) {
    const list = getStock().find(item => item.id === listId);
    if (!list) return;
    const rules = stockRules(list);
    if (!rules.length) return;
    const clamped = Math.max(0, Math.min(index, rules.length - 1));
    run = { listId, index: clamped };
    saveRun();
    try {
      prepareRule(list, rules[clamped]);
    } catch (error) {
      console.error("Price Watch:", error);
    }
  }

  async function startRun(listId) {
    const list = getStock().find(item => item.id === listId);
    if (!list || runLoading) return;
    // A new run starts with EA's default min bid again; only "Opnieuw" within a run raises it.
    if (list.fodderBidMin) {
      list.fodderBidMin = 0;
      saveStock();
    }
    if (list.type === "players") {
      // Fresh prices first, then "higher cost cards first".
      run = { listId, index: 0 };
      runLoading = true;
      saveRun();
      await fetchGeniePrices(list.players.flatMap(player => player.normalId ? [player.definitionId, player.normalId] : [player.definitionId]));
      runPricesAt = Date.now();
      runLoading = false;
      const price = player => (geniePrice(player.definitionId) || { price: 0 }).price;
      // Fodder cycles: cheapest first. Snipe lists: "higher cost cards first".
      if (list.fodderRating) list.players.sort((a, b) => (a.rating || 0) - (b.rating || 0) || price(a) - price(b));
      else list.players.sort((a, b) => price(b) - price(a));
      saveStock();
    }
    const rules = stockRules(list);
    const firstOpen = rules.findIndex(rule => !(list.done && list.done[rule.key]));
    goToRule(listId, firstOpen >= 0 ? firstOpen : 0);
  }

  function stopRun() {
    // A holo run ends: your own searches afterwards are normal again.
    try {
      const criteria = services.User.getUser().marketSearchCriteria;
      if (criteria) delete criteria.__futgenieHoloOnly;
    } catch (_) {
      // No saved criteria.
    }
    const list = run && getStock().find(item => item.id === run.listId);
    if (list && list.fodderBidMin) {
      list.fodderBidMin = 0;
      saveStock();
    }
    run = null;
    saveRun();
  }

  let runBar = null;
  // One press on ◀ / "Volgende" is one step. A FUT Genie shortcut on these buttons fires two clicks right after
  // each other (a dispatched click plus element.click()), and a double click or double tap also counts once.
  // The wait counts from the END of the step: opening the filter screen can take longer than the wait itself,
  // and Genie's second click only runs after that. A held key (Genie doesn't check for repeats) is one press too.
  const RUN_STEP_GUARD_MS = 300;
  let runStepAt = 0;
  let runKeyHeld = false;
  // On window, so it runs before FUT Genie's listener on document.
  window.addEventListener("keydown", event => { runKeyHeld = event.repeat; }, true);
  window.addEventListener("keyup", () => { runKeyHeld = false; }, true);

  function runStep(action) {
    if (!run || runKeyHeld || Date.now() - runStepAt < RUN_STEP_GUARD_MS) return;
    runStepAt = Date.now();
    try {
      action();
    } finally {
      runStepAt = Date.now();
    }
  }

  function renderRunBar() {
    const list = run && getStock().find(item => item.id === run.listId);
    const rules = list ? stockRules(list) : [];
    if (!list || !rules.length) {
      if (runBar) runBar.remove();
      runBar = null;
      return;
    }

    if (!runBar) {
      runBar = el("div", "pt-run-bar");
      const info = el("div", "pt-run-info");
      const prev = el("button", "pt-run-btn pt-run-prev", "◀");
      const next = el("button", "pt-run-btn pt-run-next", L("Volgende ▶", "Next ▶"));
      const stop = el("button", "pt-run-btn pt-run-stop", "✕");
      // Top or bottom of the screen, so it never sits on EA's Search button (remembered; phone starts at the top).
      const flip = el("button", "pt-run-btn pt-run-flip", "⇅");
      flip.title = L("Balk naar boven/onder verplaatsen", "Move bar to top/bottom");
      const placeBar = () => {
        let top = IS_PHONE;
        try {
          const saved = localStorage.getItem("pt_run_bar_pos");
          if (saved) top = saved === "top";
        } catch (_) {
          // Default position.
        }
        runBar.classList.toggle("pt-run-top", top);
      };
      flip.addEventListener("click", () => {
        try {
          localStorage.setItem("pt_run_bar_pos", runBar.classList.contains("pt-run-top") ? "bottom" : "top");
        } catch (_) {
          // Only for this session.
        }
        placeBar();
      });
      placeBar();
      [prev, next, stop, flip].forEach(button => { button.type = "button"; });
      prev.title = L("Vorige klaarzetten", "Set up previous");
      next.title = L("Volgende club/kwaliteit klaarzetten (zoeken doe je zelf)", "Set up next club/quality (you search yourself)");
      stop.title = L("Stock-ronde stoppen", "Stop stock round");
      prev.addEventListener("click", () => runStep(() => goToRule(run.listId, run.index - 1)));
      // At the last rule "Volgende" starts over at the first one.
      let cycleRefreshing = false;
      next.addEventListener("click", () => runStep(() => {
        if (cycleRefreshing) return;
        const list = getStock().find(item => item.id === run.listId);
        const rules = list ? stockRules(list) : [];
        const atEnd = run.index + 1 >= rules.length;
        if (atEnd && list && list.fodderRatings && !list.watchRun) {
          // Fodder cycle: fetch FUT.GG's cheapest-by-rating list first (a few hundred ms), then the next
          // round uses the cheapest players by the current prices. Falls back to the cached prices.
          cycleRefreshing = true;
          next.disabled = true;
          const listId = run.listId;
          loadFodderCheapest(true); // FUT Genie (pc) in the background
          Promise.race([Promise.all([loadFutggCheapest(true), refreshFutggPrices(true)]), new Promise(resolve => window.setTimeout(resolve, 8000))])
            .catch(() => null)
            .then(() => {
              cycleRefreshing = false;
              next.disabled = false;
              runStepAt = Date.now();
              if (!run || run.listId !== listId) return;
              const current = getStock().find(item => item.id === listId);
              newRound(current, refreshFodderCyclePicks(current));
            });
          return;
        }
        if (atEnd) newRound(list, null);
        else goToRule(run.listId, run.index + 1);
      }));
      const newRound = (list, fresh) => {
        if (!list) return;
        const freshText = !fresh ? "" : fresh.added
          ? L(` · 🔄 ${fresh.added} nieuwe speler${fresh.added === 1 ? "" : "s"} (${fresh.total})`, ` · 🔄 ${fresh.added} new player${fresh.added === 1 ? "" : "s"} (${fresh.total})`)
          : L(` · 🔄 zelfde ${fresh.total} spelers`, ` · 🔄 same ${fresh.total} players`);
        if (list.mode !== "bid") {
          // First completed BIN round -> 150, then 200, 250, etc. Above every max BIN it starts over at 0.
          // (Also with refreshed picks: players that stay in the list would otherwise show EA's cached result.)
          const raised = roundUpToStep((Number(list.fodderBidMin) || 100) + 50);
          const maxes = stockRules(list).map(rule => rule.max || Infinity);
          list.fodderBidMin = raised >= Math.max(...maxes) ? 0 : raised;
          saveStock();
          showToast((list.fodderBidMin ? L(`🔼 Nieuwe ronde: min bid ${priceFormat.format(list.fodderBidMin)}`, `🔼 New round: min bid ${priceFormat.format(list.fodderBidMin)}`) : L("Nieuwe ronde: min bid weer op 0", "New round: min bid back to 0")) + freshText, true);
        } else if (fresh) {
          saveStock();
          showToast(L(`Nieuwe ronde${freshText}`, `New round${freshText}`), true);
        }
        goToRule(run.listId, 0);
      };
      stop.addEventListener("click", stopRun);

      // Lazy flip: the cheapest BIN you saw → the filter becomes "market − under".
      const market = el("div", "pt-run-market");
      const marketInput = el("input", "pt-target-input");
      marketInput.inputMode = "numeric";
      marketInput.placeholder = L("markt", "market");
      marketInput.title = L("Goedkoopste BIN die je nu op de markt ziet", "Cheapest BIN you currently see on the market");
      const marketSet = el("button", "pt-run-btn", "OK");
      const marketBuy = el("button", "pt-run-btn pt-run-buy", L("🔍 Koopfilter", "🔍 Buy filter"));
      const marketClear = el("button", "pt-run-btn", "↺");
      [marketSet, marketBuy, marketClear].forEach(button => { button.type = "button"; });
      marketSet.title = L("Marktprijs opslaan en het koopfilter klaarzetten", "Save market price and set up the buy filter");
      marketBuy.title = L("Koopfilter (markt min je marge) klaarzetten", "Set up buy filter (market minus your margin)");
      marketBuy.addEventListener("click", () => run && goToRule(run.listId, run.index));
      marketClear.title = L("Marktprijs vergeten en de markt opnieuw bekijken", "Forget market price and look at the market again");
      const setMarket = price => {
        const list = run && getStock().find(item => item.id === run.listId);
        const rule = list && stockRules(list)[run.index];
        if (!rule || !rule.club) return;
        list.market = list.market || {};
        if (price) list.market[rule.key] = { price, at: Date.now() };
        else delete list.market[rule.key];
        marketInput.value = "";
        marketInput.blur();
        saveStock();
        goToRule(run.listId, run.index);
      };
      marketSet.addEventListener("click", () => { const price = parsePrice(marketInput.value); if (price) setMarket(price); });
      marketInput.addEventListener("keydown", event => { if (event.key === "Enter") marketSet.click(); });
      marketClear.addEventListener("click", () => setMarket(null));
      market.append(marketInput, marketSet, marketBuy, marketClear);

      // Filter lists: the price a card sells for instantly → max BIN for this filter, remembered; then the next one.
      const sellBox = el("div", "pt-run-market pt-run-sell");
      const sellInput = el("input", "pt-target-input");
      sellInput.inputMode = "numeric";
      sellInput.placeholder = L("verkoop", "sell");
      sellInput.title = L("Prijs waarvoor de kaart direct verkoopt: max BIN = na 5% belasting min je winst-%", "Price the card sells for instantly: max BIN = after 5% tax minus your profit %");
      const sellSave = el("button", "pt-run-btn", "OK ▶");
      const sellClear = el("button", "pt-run-btn", "↺");
      [sellSave, sellClear].forEach(button => { button.type = "button"; });
      sellSave.title = L("Onthouden en de volgende klaarzetten", "Remember and set up the next one");
      sellClear.title = L("Verkoopprijs vergeten (weer de hele markt)", "Forget sell price (whole market again)");
      const setSell = price => {
        const list = run && getStock().find(item => item.id === run.listId);
        const rule = list && stockRules(list)[run.index];
        if (rule && rule.player && list.massBid) {
          rule.player.sell = price || null;
          sellInput.value = "";
          sellInput.blur();
          saveStock();
          return true;
        }
        if (!rule || !rule.filter) return false;
        list.sell = list.sell || {};
        if (price) list.sell[rule.key] = { price, at: Date.now() };
        else delete list.sell[rule.key];
        sellInput.value = "";
        sellInput.blur();
        saveStock();
        return true;
      };
      sellSave.addEventListener("click", () => {
        const price = parsePrice(sellInput.value);
        if (!price || !setSell(price)) return;
        const list = getStock().find(item => item.id === run.listId);
        const rule = list && stockRules(list)[run.index];
        if (rule && list.massBid) {
          // Mass bid: same card again with the new max bid (search it yourself).
          showToast(L(`Onthouden: BIN ${priceFormat.format(price)} → max bod ${rule.max ? priceFormat.format(rule.max) : "—"}${rule.max ? ` (${formatSigned(flipNet(price, rule.max))} na 5%)` : ""}`, `Saved: BIN ${priceFormat.format(price)} → max bid ${rule.max ? priceFormat.format(rule.max) : "—"}${rule.max ? ` (${formatSigned(flipNet(price, rule.max))} after 5%)` : ""}`), true);
          goToRule(run.listId, run.index);
          return;
        }
        if (rule) showToast(L(`Onthouden: verkoop ${priceFormat.format(price)} → koop ≤ ${priceFormat.format(rule.max)} (${formatSigned(flipNet(price, rule.max))})`, `Saved: sell ${priceFormat.format(price)} → buy ≤ ${priceFormat.format(rule.max)} (${formatSigned(flipNet(price, rule.max))})`), true);
        next.click();
      });
      sellInput.addEventListener("keydown", event => { if (event.key === "Enter") sellSave.click(); });
      sellClear.addEventListener("click", () => { if (setSell(null)) goToRule(run.listId, run.index); });
      sellBox.append(sellInput, sellSave, sellClear);
      // Mass bid: EA often shows only cards with 10-20 min left on the first search. Watch ~5, go back,
      // and run the SAME filter again; this button puts that filter back without retyping.
      const again = el("button", "pt-run-btn pt-run-again", L("🔁 Zelfde filter", "🔁 Same filter"));
      again.type = "button";
      again.title = L("Zelfde zoekfilter opnieuw klaarzetten (na 5 op je watch list zetten en terug): dan zie je de veilingen die het eerst aflopen", "Set up the same search filter again (after putting 5 on your watch list and going back): then you see the auctions ending first");
      again.addEventListener("click", () => run && goToRule(run.listId, run.index));
      runBar.append(info, market, sellBox, again, prev, next, flip, stop, el("span", "pt-search-count"));
      updateSearchBadges();
      document.body.appendChild(runBar);
    }

    const rule = rules[Math.min(run.index, rules.length - 1)];
    const info = runBar.querySelector(".pt-run-info");
    info.textContent = "";
    const state = listWindowState(list);
    runBar.dataset.window = state ? state.state : "";

    if (runLoading) {
      info.append(el("div", "pt-run-title", L("Verse FUT Genie-prijzen ophalen…", "Fetching fresh FUT Genie prices…")), el("div", "pt-run-sub", list.name));
    } else if (rule.fodder) {
      const what = list.mode === "bid" ? L("max bod", "max bid") : "max BIN";
      info.append(
        el("div", "pt-run-title", `${rule.fodder.rating}-rated · ${what} ${rule.max ? priceFormat.format(rule.max) : "—"}`),
        el("div", "pt-run-sub", (rule.ideal ? L(`ideaal ≤ ${priceFormat.format(rule.ideal)} · `, `ideal ≤ ${priceFormat.format(rule.ideal)} · `) : "") +
          (rule.max ? L(`winst vanaf verkoop ≥ ${priceFormat.format(roundUpToStep(rule.max / (1 - EA_TAX)))} · `, `profit from sale ≥ ${priceFormat.format(roundUpToStep(rule.max / (1 - EA_TAX)))} · `) : "") +
          `${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else if (rule.player && list.flipSheet) {
      const bids = list.mode === "bid";
      const sell = rule.player.flipSell || 0;
      info.append(
        el("div", "pt-run-title pt-run-big", ft(bids ? "run_bidTitle" : "run_binTitle", { name: rule.player.name, max: rule.max ? priceFormat.format(rule.max) : "—" })),
        el("div", "pt-run-sub", ft("run_sub", { sell: sell ? priceFormat.format(sell) : "—", profit: sell && rule.max ? formatSigned(flipNet(sell, rule.max)) : "—", list: list.name, i: run.index + 1, n: rules.length }))
      );
      if (bids) info.appendChild(el("div", "pt-run-sub pt-mb-steps", ft("run_bidHint")));
    } else if (rule.player && list.massBid) {
      const sell = massBidSell(rule.player);
      const watch = watchListCount
        ? L(`watch list ${watchListCount.n}/${MASS_BID_WATCH_MAX}${watchListCount.n >= MASS_BID_WATCH_MAX ? " (vol)" : ""} om ${formatTime(watchListCount.at)}`, `watch list ${watchListCount.n}/${MASS_BID_WATCH_MAX}${watchListCount.n >= MASS_BID_WATCH_MAX ? " (full)" : ""} at ${formatTime(watchListCount.at)}`)
        : L("watch list: open Transfer Targets om te tellen", "watch list: open Transfer Targets to count");
      info.append(
        el("div", "pt-run-title", L(`🎯 ${rule.player.name} · max bod ${rule.max ? priceFormat.format(rule.max) : "—"}`, `🎯 ${rule.player.name} · max bid ${rule.max ? priceFormat.format(rule.max) : "—"}`)),
        el("div", "pt-run-sub", `BIN ${sell ? priceFormat.format(sell) : "—"} ${rule.player.sell ? L("(jouw)", "(yours)") : L("(FUT.GG, check de markt)", "(FUT.GG, check the market)")} − ${massBidPct(list)}%` +
          (sell && rule.max ? ` = ${formatSigned(flipNet(sell, rule.max))} na 5%` : "") + ` · ${list.name} · ${run.index + 1}/${rules.length}`),
        el("div", "pt-run-sub pt-mb-steps", L(`Zoek → zet 5 op je watch list → terug → 🔁 Zelfde filter → zoek: kaarten die het eerst aflopen · ${watch}`, `Search → put 5 on your watch list → back → 🔁 Same filter → search: cards ending first · ${watch}`))
      );
    } else if (rule.player) {
      const outlook = snipeOutlook(rule);
      info.append(
        el("div", "pt-run-title", `${rule.player.name} · ${list.mode === "bid" ? L("max bod", "max bid") : "max BIN"} ${rule.max ? priceFormat.format(rule.max) : "—"}`),
        el("div", "pt-run-sub", (list.fodderRating
          ? `${rule.player.rating || list.fodderRating}-rated · Genie ${rule.genie ? priceFormat.format(rule.genie.price) : "—"}` + (rule.player.fixedMax ? L(" · jouw doel", " · your target") : L(` · auto (winst ${profitFor(list)}%)`, ` · auto (profit ${profitFor(list)}%)`))
          : list.holo ? L(`✨ alleen holo · max = normale prijs${rule.genie ? "" : " (geen Genie-prijs)"}`, `✨ holo only · max = normal price${rule.genie ? "" : " (no Genie price)"}`)
          : rule.player.fixedMax ? "vaste max BIN" : rule.genie ? L(`Genie ${priceFormat.format(rule.genie.price)} · winst ${profitFor(list)}%`, `Genie ${priceFormat.format(rule.genie.price)} · profit ${profitFor(list)}%`) : L("geen Genie-prijs", "no Genie price")) +
          (outlook ? L(` · winst vanaf verkoop ≥ ${priceFormat.format(outlook.breakEven)}`, ` · profit from sale ≥ ${priceFormat.format(outlook.breakEven)}`) : "") +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else if (rule.filter) {
      info.append(
        el("div", "pt-run-title", `${filterRuleTitle(rule.filter)}${rule.position ? ` · ${rule.position}` : ""} ≤ ${rule.max ? priceFormat.format(rule.max) : "—"}`),
        el("div", "pt-run-sub", `${rule.league ? rule.league.label : L("alle competities", "all leagues")}` + (rule.ideal ? L(` · ideaal ≤ ${priceFormat.format(rule.ideal)}`, ` · ideal ≤ ${priceFormat.format(rule.ideal)}`) : "") +
          (rule.sell ? ` · ${L("verkoop", "sell")} ${priceFormat.format(rule.sell.price)} = ${formatSigned(flipNet(rule.sell.price, rule.max))} ${L("na 5%", "after 5%")}` : L(" · vul in wat direct verkoopt", " · enter what sells instantly")) +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else if (list.flip && rule.market) {
      const { sellLow, sellHigh } = list.flip;
      const low = rule.max + sellLow;
      const high = rule.max + sellHigh;
      const aboveTip = rule.ceiling && rule.market.price > rule.ceiling;
      info.append(
        el("div", "pt-run-title", `${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} · ${L("koop", "buy")} ≤ ${priceFormat.format(rule.max)}`),
        el("div", "pt-run-sub", L(`markt ${priceFormat.format(rule.market.price)} (${rule.market.seen ? `${rule.market.count ? `${rule.market.count}× ` : ""}gezien ` : ""}${formatTime(rule.market.at)}) · `, `market ${priceFormat.format(rule.market.price)} (${rule.market.seen ? `${rule.market.count ? `${rule.market.count}× ` : ""}seen ` : ""}${formatTime(rule.market.at)}) · `) +
          `${L("verkoop", "sell")} ${priceFormat.format(low)}–${priceFormat.format(high)} = ${formatSigned(flipNet(low, rule.max))}…${formatSigned(flipNet(high, rule.max))} ${L("na 5%", "after 5%")}` +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
      if (aboveTip) {
        info.appendChild(el("div", "pt-run-window pt-window-before",
          L(`⚠ markt boven de tip (≤ ${priceFormat.format(rule.ceiling)}): meer risico, de tip raadt deze nu niet aan`, `⚠ market above the tip (≤ ${priceFormat.format(rule.ceiling)}): more risk, the tip doesn't recommend this now`)));
      }
    } else if (list.flip) {
      info.append(
        el("div", "pt-run-title", L(`${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} · markt bekijken (geen max BIN)`, `${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} · view market (no max BIN)`)),
        el("div", "pt-run-sub", L(`Zoek: de goedkoopste BIN wordt de markt (of vul hem in) → koopfilter markt − ${priceFormat.format(list.flip.under)}`, `Search: the cheapest BIN becomes the market (or enter it) → buy filter market − ${priceFormat.format(list.flip.under)}`) +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else {
      info.append(
        el("div", "pt-run-title", `${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} ≤ ${priceFormat.format(rule.max)}`),
        el("div", "pt-run-sub", `${list.name} · ${run.index + 1}/${rules.length}` + (rule.ideal ? L(` · ideaal ≤ ${priceFormat.format(rule.ideal)}`, ` · ideal ≤ ${priceFormat.format(rule.ideal)}`) : ""))
      );
    }
    const marketBox = runBar.querySelector(".pt-run-market");
    marketBox.style.display = list.flip && rule.club && !runLoading ? "" : "none";
    marketBox.lastChild.style.display = rule.market ? "" : "none";
    marketBox.querySelector(".pt-run-buy").style.display = rule.market ? "" : "none";
    const sellBox = runBar.querySelector(".pt-run-sell");
    const massBidRule = !!(rule.player && list.massBid);
    // Flip bid run: the max bid is your Flip buy price, so no "BIN markt" field (that would re-derive it).
    sellBox.style.display = (rule.filter || (massBidRule && !list.flipSheet)) && !runLoading ? "" : "none";
    sellBox.lastChild.style.display = rule.sell || (massBidRule && rule.player.sell) ? "" : "none";
    sellBox.querySelector("input").placeholder = massBidRule ? L("BIN markt", "BIN market") : L("verkoop", "sell");
    sellBox.querySelector("input").title = massBidRule
      ? L("Laagste BIN die je nu op de markt ziet: dat wordt je verkoopprijs, max bod = BIN − je %", "Lowest BIN you currently see on the market: that becomes your sell price, max bid = BIN − your %")
      : L("Prijs waarvoor de kaart direct verkoopt: max BIN = na 5% belasting min je winst-%", "Price the card sells for instantly: max BIN = after 5% tax minus your profit %");
    sellBox.querySelector("button").textContent = massBidRule ? "OK" : "OK ▶";
    runBar.querySelector(".pt-run-again").style.display = massBidRule && !runLoading ? "" : "none";
    if (state) info.appendChild(el("div", `pt-run-window pt-window-${state.state}`, state.text));

    const nextButton = runBar.querySelector(".pt-run-next");
    const atEnd = run.index >= rules.length - 1;
    nextButton.disabled = runLoading || rules.length < 2;
    nextButton.textContent = atEnd ? L(`↻ Opnieuw (1/${rules.length})`, `↻ Again (1/${rules.length})`) : L("Volgende ▶", "Next ▶");
    nextButton.title = atEnd ? L("Terug naar de eerste en opnieuw beginnen", "Back to the first and start over") : L("Volgende klaarzetten (zoeken doe je zelf)", "Set up next (you search yourself)");
    runBar.querySelector(".pt-run-prev").disabled = runLoading || run.index <= 0;
  }

  // Keep the countdown current; during an open window, refresh snipe prices every minute.
  window.setInterval(() => {
    if (!run || !runBar) return;
    const list = getStock().find(item => item.id === run.listId);
    const state = list && listWindowState(list);
    if (list && list.type === "players" && state && state.state === "open" && !runLoading && Date.now() - runPricesAt > 60 * 1000) {
      runPricesAt = Date.now();
      fetchGeniePrices(list.players.map(player => player.definitionId)).then(renderRunBar);
    }
    renderRunBar();
  }, 15 * 1000);

  // "4/10 · gem. 640 · +85" with the full breakdown in the tooltip.
  function inventoryDetail(summary, goal) {
    if (!summary) return null;
    const detail = el("div", "pt-level-detail");
    const reached = goal && summary.owned >= goal;
    detail.appendChild(el("span", reached ? "pt-profit" : "", goal ? `${summary.owned}/${goal}` : `${summary.owned}×`));
    if (summary.avgBuy) detail.appendChild(el("span", "pt-muted", ` · gem. ${priceFormat.format(Math.round(summary.avgBuy))}`));
    if (summary.net !== null && summary.bought) {
      detail.appendChild(el("span", summary.net > 0 ? "pt-profit" : summary.net < 0 ? "pt-loss" : "pt-muted",
        ` · ${summary.net > 0 ? "+" : ""}${priceFormat.format(summary.net)}`));
    }
    detail.title = [
      `${summary.owned} verhandelbaar` + (summary.untradeable ? L(` (+${summary.untradeable} onverhandelbaar, niet meegeteld)`, ` (+${summary.untradeable} untradeable, not counted)`) : ""),
      summary.bought < summary.owned ? L(`${summary.owned - summary.bought} zonder bekende aankoopprijs (bijv. uit packs)`, `${summary.owned - summary.bought} without known purchase price (e.g. from packs)`) : "",
      summary.avgBuy ? L(`Gemiddelde aankoop: ${priceFormat.format(Math.round(summary.avgBuy))}`, `Average purchase: ${priceFormat.format(Math.round(summary.avgBuy))}`) : "",
      summary.avgValue ? L(`Gemiddelde FUT Genie-waarde nu: ${priceFormat.format(Math.round(summary.avgValue))}`, `Average value now: ${priceFormat.format(Math.round(summary.avgValue))}`) : "",
      summary.breakEven ? L(`Winst vanaf verkoopprijs ≥ ${priceFormat.format(summary.breakEven)} (na 5% belasting)`, `Profit from sell price ≥ ${priceFormat.format(summary.breakEven)} (after 5% tax)`) : "",
      summary.net !== null ? L(`Netto als je nu verkoopt: ${summary.net > 0 ? "+" : ""}${priceFormat.format(summary.net)}`, `Net if you sell now: ${summary.net > 0 ? "+" : ""}${priceFormat.format(summary.net)}`) : ""
    ].filter(Boolean).join("\n");
    return detail;
  }

  // ---------------------------------------------------------------------------
  // Fodder screen: market price per rating (FUT Genie), your targets and stock
  // ---------------------------------------------------------------------------
  // State: { from, to, mode: "bid" | "bin", targets: { [rating]: { max, ideal } }, inventory }

  const FODDER_KEY = "pt_fodder_v1";
  const FODDER_LOW_SAMPLE = 15;
  const FUTBIN_CHEAPEST_URL = "https://www.futbin.com/27/squad-building-challenges/cheapest";
  let fodderCache = null;
  let fodderMarket = null; // { prices, lastUpdated, fetchedAt }
  let fodderMarketLoading = false;
  let fodderLastAttempt = 0;
  let fodderInventoryProgress = null;

  function getFodder() {
    if (fodderCache) return fodderCache;
    try {
      fodderCache = JSON.parse(localStorage.getItem(FODDER_KEY) || "null");
    } catch {
      fodderCache = null;
    }
    fodderCache = Object.assign({ from: 82, to: 91, mode: "bid", targets: {}, inventory: null }, fodderCache || {});
    return fodderCache;
  }

  function saveFodder() {
    try {
      localStorage.setItem(FODDER_KEY, JSON.stringify(getFodder()));
    } catch (error) {
      console.warn(L("Price Watch: fodder-instellingen konden niet worden opgeslagen.", "Price Watch: could not save fodder settings."), error);
    }
    listeners.forEach(listener => listener());
  }

  function fodderRatings() {
    const state = getFodder();
    const from = Math.max(45, Math.min(state.from, state.to));
    const to = Math.min(99, Math.max(state.from, state.to));
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  // FUT Genie's aggregated prices per rating ("87-0" = regular cards, "87-3" = specials).
  async function loadFodderMarket(force) {
    const g = genie();
    if (!g || typeof g.getAveragePrices !== "function" || fodderMarketLoading) return;
    if (!force && fodderMarket && Date.now() - fodderMarket.fetchedAt < 10 * 60 * 1000) return;
    if (!force && Date.now() - fodderLastAttempt < 60 * 1000) return; // don't hammer after a failure
    fodderLastAttempt = Date.now();
    if (force) g._averagePricesCache = null; // FUT Genie caches for an hour; ask its server again
    fodderMarketLoading = true;
    listeners.forEach(listener => listener());
    try {
      const result = await Promise.race([g.getAveragePrices(), new Promise(resolve => window.setTimeout(() => resolve(null), 15000))]);
      if (result && result.prices) fodderMarket = { prices: result.prices, lastUpdated: result.lastUpdated, fetchedAt: Date.now() };
    } catch (error) {
      console.warn(L("Price Watch: fodderprijzen ophalen mislukt.", "Price Watch: fetching fodder prices failed."), error);
    } finally {
      fodderMarketLoading = false;
      listeners.forEach(listener => listener());
    }
  }

  const FODDER_MARKET_CHEAPEST = 10;
  function fodderMarketPrice(rating) {
    const entry = fodderMarket && fodderMarket.prices[`${rating}-0`];
    if (entry && entry.min > 0) return entry;
    // Standalone: the fodder price of this rating = the 10 cheapest regular cards (like FUTBIN's fodder
    // price), FUT.GG prices. Lowest, median and average of those 10; all cards would pull in the meta cards.
    const prices = fodderCandidates(rating).filter(card => card.id <= 0xFFFFFF)
      .map(card => (geniePrice(card.id) || {}).price || 0).filter(price => price > 0).sort((a, b) => a - b).slice(0, FODDER_MARKET_CHEAPEST);
    if (!prices.length) return null;
    const mid = prices.length >> 1;
    return { min: prices[0], med: prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2),
      avg: Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length), n: prices.length, futgg: true };
  }

  // --- Cheapest players per rating (like FUTBIN's "cheapest by rating"), from FUT Genie prices ---

  const FODDER_CYCLE_SIZE = 10;
  const FODDER_CYCLE_SPREAD = 1.5; // only players up to 1.5× the cheapest one
  let fodderCheapestAt = 0;
  let fodderCheapestLoading = false;

  function fodderCandidates(rating) {
    return getPlayerIndex().filter(entry => entry.rating === rating);
  }

  // FUT.GG's own "cheapest by rating" list (the page www.fut.gg/cheapest-by-rating, PC). Covers ratings
  // 81–93, 11 players each, incl. specials; FUT.GG caches it only a few seconds, so it is fresher than
  // the per-card feed. Fetched when the Fodder screen opens (max every 30 s) and on "Opnieuw".
  const FUTGG_CHEAPEST_URL_BASE = "https://www.fut.gg/api/fut/market/27/cheapest-by-rating/v2/overview/?platform=";
  const FUTGG_CHEAPEST_FRESH_MS = 5 * 60 * 1000;
  let futggCheapest = null; // { at, byRating: { 87: [{ entry, price, special, rarity }] } }
  let futggCheapestLoading = null;
  let futggCheapestTriedAt = 0;

  function loadFutggCheapest(force) {
    if (futggCheapestLoading) return futggCheapestLoading;
    if (!force && Date.now() - futggCheapestTriedAt < 30 * 1000) return Promise.resolve(false);
    futggCheapestTriedAt = Date.now();
    futggCheapestLoading = futggRequestJson(`${FUTGG_CHEAPEST_URL_BASE}${userPlatform() === "console" ? "ps" : "pc"}&_=${Date.now()}`).then(json => {
      const data = json && json.data;
      if (!data || typeof data !== "object") throw new Error(L("FUT.GG cheapest-by-rating: geen data", "FUT.GG cheapest-by-rating: no data"));
      const byRating = {};
      Object.entries(data).forEach(([rating, players]) => {
        if (!Array.isArray(players)) return;
        byRating[rating] = players
          .filter(player => player && player.eaId > 0 && player.price > 0)
          .map(player => {
            const special = player.eaId > 0xFFFFFF;
            const rarity = Number(String(player.rarityImagePath || "").split("/").pop().split(".")[0]);
            const display = special ? `${player.name} ${player.overall} ${rarityName(rarity)}` : player.name;
            return { entry: { id: player.eaId, display }, price: player.price, special, rarity: Number.isFinite(rarity) ? rarity : null, futgg: true };
          })
          .sort((a, b) => a.price - b.price);
      });
      futggCheapest = { at: Date.now(), byRating };
      return true;
    }).catch(error => {
      console.warn(L("Price Watch: FUT.GG cheapest-by-rating ophalen mislukt; eigen berekening blijft actief.", "Price Watch: fetching FUT.GG cheapest-by-rating failed; own calculation stays active."), error);
      return false;
    }).finally(() => {
      futggCheapestLoading = null;
      listeners.forEach(listener => listener());
    });
    return futggCheapestLoading;
  }

  function futggCheapestFor(rating) {
    if (!futggCheapest || Date.now() - futggCheapest.at > FUTGG_CHEAPEST_FRESH_MS) return null;
    const list = futggCheapest.byRating[rating];
    return list && list.length ? list : null;
  }

  // Cycle entry for a pick; FUT.GG specials search quality Special with their rarity.
  function fodderCyclePlayer(item, rating, target) {
    return {
      definitionId: item.entry.id,
      name: item.entry.display,
      rating,
      fixedMax: target,
      ...(item.special ? { special: true, rarity: item.rarity } : {})
    };
  }

  function cheapestForRating(rating) {
    const fromFutgg = futggCheapestFor(rating);
    if (fromFutgg) return fromFutgg;
    return fodderCandidates(rating)
      .map(entry => ({ entry, price: (geniePrice(entry.id) || {}).price || 0 }))
      .filter(item => item.price > 0)
      .sort((a, b) => a.price - b.price);
  }

  // With a target for this rating: EVERY player whose FUT.GG PC price is at most target × 1.1 (7k → up to
  // 7.7k), cheapest first. The few names at the very top of FUT.GG's list are usually already picked over;
  // a card listed under its price is more likely among the many just above your target.
  const FODDER_TARGET_RANGE = 1.1;

  function cyclePicks(rating) {
    const target = Number((getFodder().targets[rating] || {}).max) || 0;
    if (target > 0) {
      const limit = target * FODDER_TARGET_RANGE;
      const picks = new Map();
      // FUT.GG's cheapest-by-rating list first (freshest price, also specials), then the per-card PC feed.
      (futggCheapestFor(rating) || []).forEach(item => {
        if (item.price <= limit) picks.set(item.entry.id, item);
      });
      fodderCandidates(rating).forEach(entry => {
        if (picks.has(entry.id)) return;
        const price = (geniePrice(entry.id) || {}).price || 0;
        if (price > 0 && price <= limit) picks.set(entry.id, { entry, price });
      });
      return [...picks.values()].sort((a, b) => a.price - b.price);
    }
    const cheapest = cheapestForRating(rating);
    if (!cheapest.length) return [];
    const limit = cheapest[0].price * FODDER_CYCLE_SPREAD;
    return cheapest.filter(item => item.price <= limit).slice(0, FODDER_CYCLE_SIZE);
  }

  // One bulk FUT Genie request for every regular player in the rating range; refreshed every 5 minutes.
  function loadFodderCheapest(force) {
    loadFutggCheapest(force);
    if (!genie()) { if (force) refreshFutggPrices(true); return; } // standalone: the FUT.GG feed has every card
    if (fodderCheapestLoading) return;
    if (!force && Date.now() - fodderCheapestAt < GENIE_REFRESH_MS) return;
    const ids = fodderRatings().flatMap(rating => fodderCandidates(rating).map(entry => entry.id));
    if (!ids.length) return;
    fodderCheapestAt = Date.now();
    fodderCheapestLoading = true;
    listeners.forEach(listener => listener());
    fetchGeniePrices(ids).then(() => {
      fodderCheapestLoading = false;
      listeners.forEach(listener => listener());
    });
  }

  // Start a run over the cheapest players of one or more ratings (lowest rating first, cheapest first
  // within a rating): player search + level + your target for that rating as max.
  function startFodderCycle(ratings) {
    const state = getFodder();
    ratings = [].concat(ratings).filter(rating => cyclePicks(rating).length).sort((a, b) => a - b);
    if (!ratings.length) return false;
    const players = ratings.flatMap(rating => {
      const target = (state.targets[rating] || {}).max || null;
      return cyclePicks(rating).map(item => fodderCyclePlayer(item, rating, target));
    });
    const id = `fodder-r${ratings.join("-")}`;
    const stock = getStock();
    // One combined cycle at a time; single-rating cycles are simply replaced.
    for (let i = stock.length - 1; i >= 0; i--) {
      if (stock[i].id === id || (stock[i].fodderRatings && stock[i].fodderRatings.length > 1)) stock.splice(i, 1);
    }
    stock.push({
      id,
      type: "players",
      fodderRating: ratings[0],
      fodderRatings: ratings,
      mode: state.mode,
      name: L(`${ratings.join("+")}-rated ${ratings.some(rating => (state.targets[rating] || {}).max) ? "rond je doel" : "goedkoopste"}`, `${ratings.join("+")}-rated ${ratings.some(rating => (state.targets[rating] || {}).max) ? "around your target" : "cheapest"}`),
      createdAt: Date.now(),
      profit: null,
      windows: [],
      players,
      done: {}
    });
    saveStock();
    startRun(id);
    return true;
  }

  // "Opnieuw" at the end of a fodder cycle: pick the cheapest players per rating again from the current
  // prices (FUT.GG PC feed, refreshed every minute; FUT Genie on the pc). Only external price data, no
  // EA market search. Returns { added, removed, total } or null when nothing could be priced.
  function refreshFodderCyclePicks(list) {
    if (!list || !list.fodderRatings || list.watchRun) return null;
    const state = getFodder();
    const players = list.fodderRatings.flatMap(rating => {
      const target = (state.targets[rating] || {}).max || null;
      return cyclePicks(rating).map(item => fodderCyclePlayer(item, rating, target));
    });
    if (!players.length) return null;
    const before = new Set((list.players || []).map(player => player.definitionId));
    const after = new Set(players.map(player => player.definitionId));
    const added = players.filter(player => !before.has(player.definitionId)).length;
    const removed = [...before].filter(id => !after.has(id)).length;
    list.players = players;
    list.done = {};
    return { added, removed, total: players.length };
  }

  // The Spelers tab as a run: every watched card (special versions with their rarity), your PC target
  // as max BIN (empty = auto from Genie). A hidden list, rebuilt from the Spelers tab on every start.
  const WATCH_RUN_ID = "watch-run";

  function regularRating(definitionId) {
    try {
      const data = repositories.Item.getStaticDataByDefId(definitionId & 0xFFFFFF);
      return data && data.rating ? data.rating : 99;
    } catch (_) {
      return 99;
    }
  }

  // A special whose version isn't known: regular id with a higher rating ("Tom Bischof 86", saved before
  // the versions loaded).
  const isUnresolvedSpecial = entry => entry.definitionId <= 0xFFFFFF && entry.rating > regularRating(entry.definitionId);

  // Find the exact version of such entries once (concept search, no market): the one with that rating, by
  // Genie price against the target. Left alone when it can't be told apart (e.g. no prices on the phone).
  async function resolveWatchVersions() {
    const unresolved = getWatch().filter(isUnresolvedSpecial);
    if (!unresolved.length) return;
    const byPlayer = await cardVersionsMany(unresolved.map(entry => entry.definitionId));
    await fetchGeniePrices([...byPlayer.values()].flat().map(version => version.definitionId));
    let changed = false;
    unresolved.forEach(entry => {
      const rated = (byPlayer.get(entry.definitionId) || []).filter(version => version.rating === entry.rating);
      const pick = pickVersion(rated, entry.rating, entry.target);
      if (!pick || (rated.length > 1 && !geniePrice(pick.definitionId)) || findWatched(pick.definitionId)) return;
      entry.definitionId = pick.definitionId;
      entry.rarity = pick.rarity;
      entry.name = `${entry.name.replace(/\s+\d{2}$/, "")} ${pick.rating} ${rarityName(pick.rarity)}`;
      changed = true;
    });
    if (changed) saveWatch();
  }

  async function startWatchRun() {
    try {
      await resolveWatchVersions();
    } catch (error) {
      console.warn(L("Price Watch: versies opzoeken mislukt.", "Price Watch: looking up versions failed."), error);
    }
    const players = getWatch().map(entry => ({
      definitionId: entry.definitionId,
      name: entry.name,
      rating: entry.rating,
      // Specials (exact version or not) search quality Special, never the regular gold card.
      ...(entry.definitionId > 0xFFFFFF || isUnresolvedSpecial(entry) ? { special: true, rarity: entry.definitionId > 0xFFFFFF ? entry.rarity : null } : {}),
      fixedMax: entry.target || null
    }));
    if (!players.length) return false;
    const stock = getStock();
    const index = stock.findIndex(list => list.id === WATCH_RUN_ID);
    if (index >= 0) stock.splice(index, 1);
    stock.push({ id: WATCH_RUN_ID, type: "players", watchRun: true, name: L("Spelers", "Players"), createdAt: Date.now(), profit: null, windows: [], players, done: {} });
    saveStock();
    startRun(WATCH_RUN_ID);
    return true;
  }

  // Ratings of the active fodder cycle, to highlight them on the Fodder screen.
  function activeCycleRatings() {
    const list = run && getStock().find(item => item.id === run.listId);
    return list && list.fodderRating ? list.fodderRatings || [list.fodderRating] : [];
  }

  function fodderLevel(rating) {
    return rating >= 75 ? SearchLevel.GOLD : rating >= 65 ? SearchLevel.SILVER : SearchLevel.BRONZE;
  }

  // Market filters for "<rating>-rated regular card", max bid or max buy now. The user searches.
  function prepareFodderSearch(rating, max, mode) {
    const criteria = baseCriteria();
    criteria.ovrMin = rating;
    criteria.ovrMax = rating;
    criteria.level = fodderLevel(rating);
    if (max) {
      if (mode === "bid") criteria.maxBid = max;
      else criteria.maxBuy = max;
    }
    openFilters(criteria, null);
  }

  async function updateFodderInventory() {
    if (fodderInventoryProgress) return;
    const ratings = fodderRatings();
    const rules = {};
    fodderInventoryProgress = L("lijsten…", "lists…");
    listeners.forEach(listener => listener());
    const transferPile = await itemsOutsideClub();
    let failed = false;

    for (let i = 0; i < ratings.length; i++) {
      const rating = ratings[i];
      fodderInventoryProgress = `${i + 1}/${ratings.length}`;
      listeners.forEach(listener => listener());
      if (i) await new Promise(resolve => window.setTimeout(resolve, CLUB_SEARCH_DELAY_MS));
      let items;
      try {
        items = await clubItems(criteria => { criteria.ovrMin = rating; criteria.ovrMax = rating; });
      } catch (error) {
        console.warn("Price Watch:", error);
        failed = true;
        break;
      }
      const bucket = { untradeable: 0, items: [] };
      const seen = new Set();
      items.concat(transferPile)
        .filter(item => item && item.rating === rating && !(item.isSpecial && item.isSpecial()))
        .forEach(item => { if (isCountable(item, seen)) addToBucket(bucket, item); });
      rules[rating] = bucket;
    }

    fodderInventoryProgress = null;
    if (!failed) {
      getFodder().inventory = { updatedAt: Date.now(), rules };
      saveFodder();
      fetchGeniePrices(Object.values(rules).flatMap(bucket => bucket.items.map(item => item.d)))
        .then(() => listeners.forEach(listener => listener()));
    } else {
      listeners.forEach(listener => listener());
    }
  }

  function buildFodderSection(root) {
    const card = el("div", "pt-watch-card pt-fodder-card");
    root.appendChild(card);

    const toolbar = el("div", "pt-watch-toolbar");
    const heading = el("div", "pt-watch-heading");
    const status = el("div", "pt-watch-status");
    heading.append(el("h2", "pt-watch-title", "Fodder"), status);

    const controls = el("div", "pt-stock-list-buttons");
    const range = el("label", "pt-goal");
    const from = el("input", "pt-target-input");
    const to = el("input", "pt-target-input");
    [from, to].forEach(input => { input.inputMode = "numeric"; });
    from.addEventListener("change", () => { getFodder().from = parsePrice(from.value) || 82; saveFodder(); });
    to.addEventListener("change", () => { getFodder().to = parsePrice(to.value) || 91; saveFodder(); });
    range.append(el("span", "pt-muted", "Ratings"), from, el("span", "pt-muted", "t/m"), to);

    const modeLabel = el("label", "pt-goal");
    const mode = el("select", "pt-stock-select pt-mode-select");
    mode.append(new Option(L("Bieden (max bod)", "Bid (max bid)"), "bid"), new Option("Direct kopen (max BIN)", "bin"));
    mode.addEventListener("change", () => { getFodder().mode = mode.value; saveFodder(); });
    modeLabel.append(el("span", "pt-muted", L("Zoeken op", "Search by")), mode);

    const refresh = el("button", "pt-watch-refresh", L("↻ Prijzen", "↻ Prices"));
    const inventory = el("button", "pt-watch-refresh", L("📦 Voorraad bijwerken", "📦 Update stock"));
    const futbin = el("a", "pt-link-btn pt-futbin", "FUTBIN ↗");
    futbin.href = FUTBIN_CHEAPEST_URL;
    futbin.target = "_blank";
    futbin.rel = "noopener";
    futbin.title = L("Goedkoopste spelers per rating op FUTBIN (met namen), om te vergelijken. Let op: zet FUTBIN op PC, anders zie je consoleprijzen.", "Cheapest players per rating on FUTBIN (with names), for comparison. Note: set FUTBIN to PC, otherwise you see console prices.");
    [refresh, inventory].forEach(button => { button.type = "button"; });
    refresh.addEventListener("click", () => {
      loadFodderMarket(true);
      loadFodderCheapest(true);
    });
    inventory.title = L("Telt je gewone kaarten per rating in je club, transferlijst, unassigned en gewonnen transfer targets. Geen transfermarkt-zoekopdrachten.", "Counts your regular cards per rating in your club, transfer list, unassigned and won transfer targets. No transfer market searches.");
    inventory.addEventListener("click", () => updateFodderInventory());
    // Cycle several ratings in one go (the ticked rows), so "Volgende" runs on from 86 into 87.
    const cycleAll = el("button", "pt-watch-refresh pt-cycle-btn", L("🔄 Aangevinkte cyclen", "🔄 Ticked cycles"));
    cycleAll.type = "button";
    cycleAll.addEventListener("click", () => startFodderCycle(cycleSelection()));
    controls.append(range, modeLabel, cycleAll, refresh, inventory, futbin);

    // Ticked ratings; until you tick something yourself: every rating with a target.
    function cycleSelection() {
      const state = getFodder();
      const ratings = fodderRatings();
      return Array.isArray(state.cycleWith)
        ? ratings.filter(rating => state.cycleWith.includes(rating))
        : ratings.filter(rating => (state.targets[rating] || {}).max);
    }
    toolbar.append(heading, controls);

    const table = el("table", "pt-watch-table pt-fodder-table");
    const head = el("tr");
    [["Rating", "pt-col-rating"], [L("Goedkoopste spelers", "Cheapest players"), "pt-col-cheapest"], [L("Mediaan", "Median"), "pt-col-price"], [L("Jouw doel", "Your target"), "pt-col-target"],
      [L("Afstand", "Distance"), "pt-col-distance"], ["", "pt-col-level"], [L("Voorraad", "Stock"), "pt-col-stock"]]
      .forEach(([label, className]) => head.appendChild(el("th", className, label)));
    const thead = el("thead");
    thead.appendChild(head);
    const body = el("tbody");
    table.append(thead, body);
    const totals = el("div", "pt-stock-summary-line pt-fodder-totals");
    card.append(toolbar, table, totals);

    function render() {
      const active = document.activeElement;
      if (active && active.tagName === "INPUT" && active.type !== "checkbox" && card.contains(active)) return; // don't steal focus while typing
      if (card.style.display !== "none") {
        loadFodderMarket(false);
        loadFodderCheapest(false);
      }

      const state = getFodder();
      from.value = state.from;
      to.value = state.to;
      mode.value = state.mode === "bin" ? "bin" : "bid";
      refresh.disabled = fodderMarketLoading;
      inventory.disabled = !!fodderInventoryProgress;
      inventory.textContent = fodderInventoryProgress ? `📦 ${fodderInventoryProgress}` : L("📦 Voorraad bijwerken", "📦 Update stock");
      status.textContent = !genie()
        ? L(`FUT.GG-prijzen (${futggPlatform === "console" ? "console" : "PC"}) per rating: laagste, mediaan en gemiddelde van de 10 goedkoopste gewone kaarten${futggPricesAt ? ` · ${formatTime(futggPricesAt)}` : ""}`, `FUT.GG prices (${futggPlatform === "console" ? "console" : "PC"}) per rating: lowest, median and average of the 10 cheapest regular cards${futggPricesAt ? ` · ${formatTime(futggPricesAt)}` : ""}`)
        : fodderMarketLoading ? L("Fodderprijzen ophalen bij FUT Genie…", "Fetching fodder prices from FUT Genie…")
          : fodderMarket
            ? L(`FUT Genie-marktprijzen (PC) per rating, gewone kaarten · bijgewerkt ${fodderMarket.lastUpdated ? formatDayTime(new Date(fodderMarket.lastUpdated).getTime()) : "onbekend"}`, `FUT Genie market prices (PC) per rating, regular cards · updated ${fodderMarket.lastUpdated ? formatDayTime(new Date(fodderMarket.lastUpdated).getTime()) : "unknown"}`)
            : L("Nog geen fodderprijzen opgehaald.", "No fodder prices fetched yet.");

      body.textContent = "";
      const what = state.mode === "bin" ? "max BIN" : L("max bod", "max bid");
      const selected = cycleSelection();
      const selectedPicks = selected.reduce((sum, rating) => sum + cyclePicks(rating).length, 0);
      cycleAll.disabled = !selectedPicks;
      cycleAll.textContent = selected.length ? L(`🔄 Cyclen ${selected.join("+")} (${selectedPicks})`, `🔄 Cycle ${selected.join("+")} (${selectedPicks})`) : L("🔄 Aangevinkte cyclen", "🔄 Ticked cycles");
      cycleAll.title = L("Loopt de goedkoopste spelers van alle aangevinkte ratings achter elkaar door (laagste rating eerst, per rating goedkoopste eerst), ", "Runs through the cheapest players of all ticked ratings back to back (lowest rating first, cheapest first per rating), ") +
        L("elk met het doel van zijn rating. Zoeken doe je zelf; Volgende ▶ in de balk rechtsonder.", "each with the target of its rating. You search yourself; Next ▶ in the bar at the bottom right.");
      let totalOwned = 0;
      let totalValue = 0;
      fodderRatings().forEach(rating => {
        const row = el("tr");
        const market = fodderMarketPrice(rating);
        const target = state.targets[rating] || {};

        // Cheapest regular players of this rating (FUT Genie per-card prices), like FUTBIN's list.
        const picks = cyclePicks(rating);
        const cheapest = picks.length ? picks[0].price : market ? market.min : null;
        const minCell = el("td", "pt-col-cheapest" + (picks.length ? "" : " pt-missing"));
        if (picks.length) {
          minCell.append(
            el("div", "pt-cheapest-main", `${priceFormat.format(picks[0].price)}`),
            el("div", "pt-level-detail pt-muted", picks.slice(0, 3).map(item => item.entry.display).join(", ") + (picks.length > 3 ? ` +${picks.length - 3}` : ""))
          );
          minCell.title = picks.map(item => `${item.entry.display} · ${priceFormat.format(item.price)}`).join("\n");
        } else {
          minCell.textContent = fodderCheapestLoading ? "…" : market ? priceFormat.format(market.min) : "—";
        }
        const lowSample = market && market.n < FODDER_LOW_SAMPLE;
        const medCell = el("td", "pt-col-price pt-muted" + (market ? "" : " pt-no-med"), market ?`${priceFormat.format(market.med)}${lowSample ? " ⚠️" : ""}` : "—");
        if (market) {
          medCell.title = `Gemiddeld ${priceFormat.format(market.avg)} · ${market.n} waarnemingen` +
            (lowSample ? L("\nWeinig waarnemingen: mediaan is onbetrouwbaar, kijk naar het minimum of FUTBIN.", "\nFew observations: median is unreliable, look at the minimum or FUTBIN.") : "");
        }

        const targetCell = el("td", "pt-col-target");
        const input = el("input", "pt-target-input");
        input.inputMode = "numeric";
        input.placeholder = cheapest ? L(`bijv. ${priceFormat.format(roundDownToStep(cheapest * 0.85))}`, `e.g. ${priceFormat.format(roundDownToStep(cheapest * 0.85))}`) : "—";
        input.value = target.max || "";
        input.title = L(`Je ${what} voor ${rating}-rated`, `Your ${what} for ${rating}-rated`) + (target.ideal ? L(` (ideaal ≤ ${priceFormat.format(target.ideal)})`, ` (ideal ≤ ${priceFormat.format(target.ideal)})`) : "");
        input.addEventListener("change", () => {
          const max = parsePrice(input.value);
          if (max) state.targets[rating] = { ...target, max };
          else delete state.targets[rating];
          saveFodder();
        });
        targetCell.appendChild(input);
        if (target.max) {
          targetCell.appendChild(el("div", "pt-level-detail pt-outlook pt-muted", L(`winst vanaf ≥ ${priceFormat.format(roundUpToStep(target.max / (1 - EA_TAX)))}`, `profit from ≥ ${priceFormat.format(roundUpToStep(target.max / (1 - EA_TAX)))}`)));
        }

        // Distance: cheapest player vs your target (green = the market is at or under your target).
        const distanceCell = el("td", "pt-col-distance");
        const state2 = distanceState(target.max || null, cheapest);
        const pill = el("span");
        distanceBar(pill, state2);
        if (!target.max) pill.title = L("Vul een doel in om de afstand te zien", "Enter a target to see the distance");
        distanceCell.appendChild(pill);
        row.classList.toggle("pt-row-hit", !!target.max && state2.percent != null && state2.percent <= 0);
        row.classList.toggle("pt-row-near", !!target.max && state2.percent != null && state2.percent > 0 && state2.percent <= NEAR_PERCENT);

        const buttonCell = el("td", "pt-col-level");
        const max = target.max || null;
        const cycleActive = activeCycleRatings().includes(rating);
        const cycle = el("button", "pt-level-btn pt-cycle-btn" + (cycleActive ? " pt-current" : ""), picks.length ? L(`🔄 Cyclen (${picks.length})`, `🔄 Cycle (${picks.length})`) : L("🔄 Cyclen", "🔄 Cycle"));
        cycle.type = "button";
        cycle.disabled = !picks.length;
        cycle.title = picks.length
          ? L(`Loop de ${picks.length} goedkoopste ${rating}-rated spelers één voor één door (goedkoopste eerst) met ${max ? `${what} ${priceFormat.format(max)}` : "auto max (5% winst op de Genie-prijs)"}.\nPer speler worden de filters klaargezet; zoeken doe je zelf. Volgende ▶ in de balk rechtsonder.`, `Go through the ${picks.length} cheapest ${rating}-rated players one by one (cheapest first) with ${max ? `${what} ${priceFormat.format(max)}` : "auto max (5% profit on the Genie price)"}.\nFilters are set up per player; you search yourself. Next ▶ in the bar at the bottom right.`)
          : L("Nog geen spelersprijzen voor deze rating (FUT Genie laadt nog, of geen gewone kaarten met prijs).", "No player prices yet for this rating (FUT Genie is still loading, or no regular cards with a price).");
        cycle.addEventListener("click", () => startFodderCycle(rating));
        buttonCell.appendChild(cycle);

        const button = el("button", "pt-icon-btn pt-generic-btn", "🔍");
        button.type = "button";
        button.title = L(`Algemeen: alle ${rating}-rated gewone kaarten · ${max ? `${what} ${priceFormat.format(max)}` : "geen max"} klaarzetten. Zoeken doe je zelf.`, `General: all ${rating}-rated regular cards · set up ${max ? `${what} ${priceFormat.format(max)}` : "no max"}. You search yourself.`);
        button.addEventListener("click", () => {
          try {
            prepareFodderSearch(rating, max, state.mode);
          } catch (error) {
            console.error("Price Watch:", error);
          }
        });
        buttonCell.appendChild(button);

        const stockCell = el("td", "pt-col-stock");
        const bucket = state.inventory && state.inventory.rules[rating];
        const detail = inventoryDetail(summarizeBucket(bucket), null);
        if (detail) stockCell.appendChild(detail);
        if (bucket) {
          totalOwned += bucket.items.length;
          if (cheapest) totalValue += bucket.items.length * cheapest;
        }

        const ratingCell = el("td", "pt-col-rating pt-watch-name");
        const tick = el("input", "pt-cycle-tick");
        tick.type = "checkbox";
        tick.checked = selected.includes(rating);
        tick.title = L("Meenemen in \"Cyclen\" bovenaan", "Include in \"Cycle\" at the top");
        tick.addEventListener("change", () => {
          const current = cycleSelection().filter(other => other !== rating);
          state.cycleWith = tick.checked ? current.concat(rating) : current;
          saveFodder();
        });
        const tickLabel = el("label", "pt-cycle-label");
        tickLabel.append(tick, document.createTextNode(String(rating)));
        ratingCell.appendChild(tickLabel);
        row.append(ratingCell, minCell, medCell, targetCell, distanceCell, buttonCell, stockCell);
        body.appendChild(row);
      });

      totals.textContent = "";
      if (state.inventory) {
        totals.append(
          el("span", "", L(`📦 ${totalOwned} verhandelbare fodderkaarten`, `📦 ${totalOwned} tradeable fodder cards`)),
          el("span", "pt-muted", L(` · waarde op marktminimum ~${priceFormat.format(totalValue)} (na belasting ~${priceFormat.format(Math.round(totalValue * (1 - EA_TAX)))})`, ` · value at market minimum ~${priceFormat.format(totalValue)} (after tax ~${priceFormat.format(Math.round(totalValue * (1 - EA_TAX)))})`)),
          el("span", "pt-muted", L(` · geteld om ${formatTime(state.inventory.updatedAt)}`, ` · counted at ${formatTime(state.inventory.updatedAt)}`))
        );
      } else {
        totals.appendChild(el("span", "pt-muted", L("📦 Klik op \"Voorraad bijwerken\" om je fodder per rating te tellen.", "📦 Click \"Update stock\" to count your fodder per rating.")));
      }
    }

    return render;
  }

  // --- Flip sheet (fodder.gg Price Watch) -------------------------------------------------------
  // A shared fodder.gg watchlist link (fodder.gg/price-watch/<token>) has the last 24 h of low / avg /
  // high / now prices + an hourly trend per card, for console and PC, inside the page (Next.js data).
  // Sheet method: buy at the low (or lower), list a little under the high (avg–high as guide), 5% tax.
  // Only an external page is read; the run prepares market filters, you search and buy yourself.
  const FLIP_KEY = "pt_flip_v1"; // { token, platform, maxPrice, minPct, onlyDeals, alert, sort, lang }
  const FLIP_DATA_KEY = "pt_flip_data_v1"; // last fetched report { at, fetchedAt, console, pc }
  const FLIP_REFRESH_MS = 10 * 60 * 1000;
  const FLIP_RUN_ID = "flip-sheet";
  // 🔨 Check bids: the ticked cards as a bid list (max bid = buy price). It is a mass-bid list
  // (massBid.flip), so EA's search results, Transfer Targets and the bid panel show per card what you
  // may bid at most ("✅ bied X (max Y)", "❌ > max", "🟢 jij hoogste", "🏆 gewonnen").
  const FLIP_BID_ID = "flip-bids";

  function getFlip() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(FLIP_KEY) || "null"); } catch (_) { /* default */ }
    // Min profit default 5% (sheet: tiny profit at low → high means aim lower). Old saved default 2 → 5 once.
    if (state && !state.minPct5) {
      if (state.minPct === 2) state.minPct = 5;
      state.minPct5 = true;
    }
    return Object.assign({ token: "", platform: "pc", maxPrice: 500000, minPct: 5, minPct5: true, onlyDeals: false, alert: false, sort: "score", lang: "en", autoFutbin: true, source: "fodder" }, state || {});
  }
  function saveFlip(state) {
    flipLangCache = null;
    uiLangCache = null;
    try { localStorage.setItem(FLIP_KEY, JSON.stringify(state)); } catch (_) { /* session only */ }
  }
  // --- Flip tab texts, Dutch and English (switch with the NL/EN button) -------------------------------
  // ft("key", { vars }) → text in the chosen language; {name} in a text is filled from vars.
  const FLIP_TEXT = {
    // signals: long (hover) and short (details)
    st_buy: ["Nu op of onder je koopprijs: kopen kan", "At or below your buy price: you can buy"],
    st_near: ["Bijna: hooguit 6% boven je koopprijs", "Almost: at most 6% above your buy price"],
    st_risk: ["Goedkoop, maar riskant: lees eerst de waarschuwing", "Cheap, but risky: read the warning first"],
    st_wait: ["Nog te duur: wachten", "Too expensive for now: wait"],
    st_skip: ["Geen winst na 5% belasting", "No profit after 5% tax"],
    sts_buy: ["Kopen kan", "Buy now"],
    sts_near: ["Bijna", "Almost"],
    sts_risk: ["Riskant", "Risky"],
    sts_wait: ["Te duur", "Too expensive"],
    sts_skip: ["Geen winst", "No profit"],
    // warnings from the price check
    w_fewSales: ["Weinig verkopen: {n} in 24 uur", "Few sales: {n} in 24 hours"],
    w_saleFalling: ["Verkoopprijs daalt: {pct} t.o.v. gisteren", "Sale price falling: {pct} vs yesterday"],
    w_lowSellThrough: ["Slechts {pct} van het aanbod verkoopt", "Only {pct} of listings sell"],
    w_outlierSale: ["Uitschieter genegeerd: verkoop voor {list}", "Outlier ignored: sale at {list}"],
    w_lowOdd: ["Lage prijs {price} was eenmalig (genegeerd)", "Low of {price} was a one-off (ignored)"],
    w_highOdd: ["Hoge prijs {price} is een uitschieter", "High of {price} is an outlier"],
    w_avgOdd: ["Gemiddelde {price} wijkt sterk af", "Average of {price} looks off"],
    w_sparse: ["Weinig data: pas {n} uur", "Little data: only {n} hours"],
    w_crashed: ["Gecrasht: {pct} in 24 uur", "Crashed: {pct} in 24 hours"],
    w_atBottom: ["Op het laagste punt na {pct} daling", "At the day's low after a {pct} drop"],
    w_falling: ["Prijs daalt", "Price is falling"],
    w_restless: ["Prijs schommelt: {low}–{high} in 12 uur", "Price swings: {low}–{high} in 12 hours"],
    // score
    lvl_high: ["goede kans", "good chance"],
    lvl_mid: ["twijfelgeval", "doubtful"],
    lvl_low: ["laten liggen", "skip it"],
    miss_price: ["prijs t.o.v. normaal (nog te weinig historie)", "price vs normal (not enough history yet)"],
    miss_liquidity: ["verkoopsnelheid (klik 📊 Check verkopen)", "sales speed (click 📊 Check sales)"],
    cap_noProfit: ["geen winst na belasting", "no profit after tax"],
    cap_underMin: ["minder winst dan je minimum", "less profit than your minimum"],
    cap_tooExpensive: ["nu te duur om winst te maken", "too expensive now to make a profit"],
    cap_risky: ["riskant volgens de sheet-regels", "risky by the sheet rules"],
    cap_lowData: ["te weinig data", "not enough data"],
    cap_restless: ["prijs schommelt sterk", "price swings a lot"],
    cap_noSales: ["echte verkopen nog niet gecheckt", "real sales not checked yet"],
    ow_lowData: ["Te weinig data voor een betrouwbare score", "Not enough data for a reliable score"],
    ow_restless: ["Prijs schommelt sterk ({pct} in 24 uur)", "Price swings a lot ({pct} in 24 hours)"],
    ow_structural: ["Prijs daalt al dagen", "Price has been falling for days"],
    ow_negTrend: ["Prijs gaat omlaag", "Price is going down"],
    dip_structural: ["daalt al dagen", "falling for days"],
    dip_recovering: ["tijdelijke dip, herstelt", "temporary dip, recovering"],
    dip_below: ["onder het normale niveau", "below its normal level"],
    // toolbar and table
    sortScore: ["Beste kans eerst", "Best chance first"],
    sortSignal: ["Groen eerst", "Green first"],
    sortTitle: ["Beste kans eerst = hoogste score bovenaan (fodder.gg: alleen PC; FUT.GG: elke kaart met FUTBIN-check, daarna de grootste dips). Groen eerst = 🟢 → ⛔.", "Best chance first = highest score on top (fodder.gg: PC only; FUT.GG: every card with a FUTBIN check, then the biggest dips). Green first = 🟢 → ⛔."],
    onlyDeals: ["Alleen 🟢/🟡", "Only 🟢/🟡"],
    refreshTitle: ["Nu ophalen bij fodder.gg (gaat ook vanzelf elke 10 min)", "Fetch fodder.gg now (also happens every 10 min)"],
    alertTitle: ["Pling + melding (en push naar je telefoon) als een kaart nieuw op 🟢 komt. Blijft elke 10 min verversen zolang de web-app open is. Telefoon instellen: 📲 op de Spelers-tab.", "Chime + message (and a push to your phone) when a card turns 🟢. Keeps refreshing every 10 min while the web app is open. Phone setup: 📲 on the Players tab."],
    alertOn: ["Melding aan", "Alerts on"],
    alertOff: ["Melding uit", "Alerts off"],
    alertOnToast: ["🔔 Melding aan: pling + push als een kaart 🟢 wordt", "🔔 Alerts on: chime + push when a card turns 🟢"],
    alertOffToast: ["🔕 Melding uit", "🔕 Alerts off"],
    futbinButton: ["📊 Check echte verkopen", "📊 Check real sales"],
    futbinBusy: ["📊 {done}/{total}… stop", "📊 {done}/{total}… stop"],
    futbinTitle: ["Zoekt voor de 🟢/🟡/🟠-kaarten op FUTBIN op waarvoor ze echt verkocht zijn. Pas daarna kan een kaart 70+ scoren. Eén kaart per paar seconden, max 30 per klik, 3 uur bewaard (na 45 min opnieuw als er ruimte is). Nog eens klikken = stoppen.", "Looks up on FUTBIN what the 🟢/🟡/🟠 cards really sold for. Only then can a card score 70+. One card every few seconds, max 30 per click, remembered for 45 min. Click again = stop."],
    noCardsToCheck: ["Geen 🟢/🟡/🟠-kaarten om te checken.", "No 🟢/🟡/🟠 cards to check."],
    run: ["🔄 Run maken ({n})", "🔄 Start run ({n})"],
    runTitle: ["Maakt een run van de aangevinkte kaarten: per kaart het marktfilter met max. prijs = koopprijs. Zoeken en kopen doe je zelf.", "Makes a run of the ticked cards: a market filter per card with max price = buy price. You search and buy yourself."],
    players: ["+ Spelers ({n})", "+ Players ({n})"],
    bids: ["🔨 Check bids ({n})", "🔨 Check bids ({n})"],
    sel_placeholder: ["☑ Aanvinken…", "☑ Tick…"],
    sel_title: ["Vink in één keer een groep kaarten aan (van wat nu in de tabel staat). Daarna kun je losse vinkjes nog aanpassen.", "Tick a group of cards at once (of what is in the table now). You can still change single ticks afterwards."],
    sel_headTitle: ["Alles aan / alles uit", "All on / all off"],
    sel_default: ["Standaard (🟢/🟡)", "Default (🟢/🟡)"],
    sel_deals: ["🟢/🟡/🟠", "🟢/🟡/🟠"],
    sel_profit: ["Alles met winst (geen ⛔)", "Everything with profit (no ⛔)"],
    sel_top10: ["Top 10 score", "Top 10 score"],
    sel_top20: ["Top 20 score", "Top 20 score"],
    sel_all: ["Alles", "Everything"],
    sel_none: ["Niets", "Nothing"],
    bidsTitle: ["Loop de aangevinkte kaarten één voor één af om te bieden: per kaart het marktfilter met max. bod = je koopprijs. De balk staat bovenin met de max. bod, en in de zoekresultaten en Transfer Targets staat bij elke kaart hoeveel je nog mag bieden. Bieden doe je zelf.", "Go through the ticked cards one by one to bid: a market filter per card with max bid = your buy price. The bar sits on top with the max bid, and search results and Transfer Targets show per card how much you may still bid. You place the bids yourself."],
    bidRunStarted: ["Bied-run met {n} kaart(en) gestart · max. bod = koopprijs", "Bid run with {n} card(s) started · max bid = buy price"],
    run_bidTitle: ["🔨 {name} · max bod {max}", "🔨 {name} · max bid {max}"],
    run_binTitle: ["{name} · max BIN {max}", "{name} · max BIN {max}"],
    run_sub: ["verkoop {sell} → {profit} na 5% · {list} · {i}/{n}", "sell {sell} → {profit} after 5% · {list} · {i}/{n}"],
    run_bidHint: ["Zoek → bied tot je max op veilingen die bijna aflopen. In Transfer Targets staat bij elke kaart je max.", "Search → bid up to your max on auctions ending soon. Transfer Targets shows your max on every card."],
    mb_flipLine: ["Verkoop {sell} (Flip) · max = je Flip-koopprijs", "Sell {sell} (Flip) · max = your Flip buy price"],
    playersTitle: ["Zet de aangevinkte kaarten op de Spelers-tab, met de koopprijs als doel", "Puts the ticked cards on the Players tab, with the buy price as target"],
    settingsTitle: ["Instellingen: fodder.gg-link, max. prijs, min. winst", "Settings: fodder.gg link, max price, min profit"],
    helpTitle: ["Uitleg", "Help"],
    langTitle: ["Taal: Nederlands. Klik voor English.", "Language: English. Klik voor Nederlands."],
    linkLabel: ["fodder.gg-link", "fodder.gg link"],
    linkPlaceholder: ["Plak je fodder.gg/price-watch/… link", "Paste your fodder.gg/price-watch/… link"],
    linkTitle: ["De link van je Price Watch-lijst op fodder.gg. Wordt alleen in deze browser bewaard.", "The link of your Price Watch list on fodder.gg. Only stored in this browser."],
    maxPrice: ["Max. prijs", "Max price"],
    maxPriceTitle: ["Kaarten boven deze prijs verbergen (sheet: onder 500K blijven)", "Hide cards above this price (sheet: stay under 500K)"],
    minPct: ["Min. winst %", "Min profit %"],
    minPctTitle: ["Minimale winst na 5% belasting, als % van je koopprijs", "Minimum profit after 5% tax, as % of your buy price"],
    badLink: ["Dit is geen geldige fodder.gg price-watch-link", "This is not a valid fodder.gg price-watch link"],
    tickFirst: ["Vink eerst kaarten aan.", "Tick some cards first."],
    runStarted: ["Run met {n} kaart(en) gestart · max. prijs = koopprijs", "Run with {n} card(s) started · max price = buy price"],
    playersAdded: ["{n} kaart(en) op de Spelers-tab gezet", "{n} card(s) added to the Players tab"],
    h_score: ["Score", "Score"],
    h_player: ["Speler", "Player"],
    h_now: ["Nu", "Now"],
    h_buy: ["Koop ≤", "Buy ≤"],
    h_sell: ["Verkoop", "Sell"],
    h_profit: ["Winst", "Profit"],
    h_trend: ["Trend", "Trend"],
    rowTitle: ["Klik voor details", "Click for details"],
    searchTitle: ["Zet deze kaart klaar op de transfermarkt: juiste versie{holo}, max. prijs = je koopprijs ({buy}). Shift+klik = zonder max. prijs. Op Zoeken drukken doe je zelf.", "Prepare this card on the transfer market: right version{holo}, max price = your buy price ({buy}). Shift+click = no max price. You press Search yourself."],
    searchHolo: [", alleen holo", ", holo only"],
    searchFailed: ["Transfermarkt openen mislukt: {error}", "Could not open the transfer market: {error}"],
    checked: ["📊 gecheckt", "📊 checked"],
    gapTitle: ["nu {pct} t.o.v. je koopprijs", "now {pct} vs your buy price"],
    badgeTitle: ["Score {score}: {level}. Klik op de rij om te zien waarom.", "Score {score}: {level}. Click the row to see why."],
    profitTitle: ["Koop {buy} → verkoop {sell}, min 5% belasting", "Buy {buy} → sell {sell}, minus 5% tax"],
    trendHistTitle: ["{span} eigen historie · normaal {median} · laagste {low} · gele stip = nu", "{span} own history · normal {median} · lowest {low} · yellow dot = now"],
    trendTodayTitle: ["Nog geen eigen historie: de lijn van vandaag (fodder.gg)", "No own history yet: today's line (fodder.gg)"],
    h24: ["24u", "24h"],
    // status line
    statusNoLink: ["Plak je fodder.gg-link via ⚙.", "Paste your fodder.gg link via ⚙."],
    statusLoading: ["fodder.gg ophalen…", "Loading fodder.gg…"],
    statusData: ["{platform} · {n} kaarten · 🟢 {buy}  🟡 {near}  🟠 {risk} · bijgewerkt {time}", "{platform} · {n} cards · 🟢 {buy}  🟡 {near}  🟠 {risk} · updated {time}"],
    statusError: [" · fout: {error}", " · error: {error}"],
    statusFailed: ["Ophalen mislukt: {error}", "Loading failed: {error}"],
    statusEmpty: ["Nog geen data · klik ↻", "No data yet · click ↻"],
    statusTitle: ["Data van {at}, opgehaald {fetched} (elke 10 min). {history}", "Data from {at}, fetched {fetched} (every 10 min). {history}"],
    histStatus: ["Historie: {n} metingen over {span}, laatste {time}{remote}", "History: {n} points over {span}, last {time}{remote}"],
    histRemote: [" (van je pc)", " (from your pc)"],
    histBuilding: ["Historie: wordt opgebouwd (elke 15 min)", "History: being built (every 15 min)"],
    histNone: ["Historie: nog niets van je pc", "History: nothing from your pc yet"],
    // details
    d_score: ["Score {score} · {level}", "Score {score} · {level}"],
    d_partPrice: ["Prijs t.o.v. normaal", "Price vs normal"],
    d_partProfit: ["Winst", "Profit"],
    d_partLiquidity: ["Verkoopt snel", "Sells quickly"],
    d_partTrend: ["Trend en rust", "Trend & stability"],
    d_partReliability: ["Betrouwbare data", "Reliable data"],
    d_unknown: ["Onbekend: {list}", "Unknown: {list}"],
    d_capped: ["Score begrensd: {list}", "Score capped: {list}"],
    d_price: ["Prijs (PC, fodder.gg)", "Price (PC, fodder.gg)"],
    d_now: ["Nu", "Now"],
    d_status: ["Status", "Status"],
    d_low24: ["Laagste 24u", "Lowest 24h"],
    d_avg24: ["Gemiddeld 24u", "Average 24h"],
    d_high24: ["Hoogste 24u", "Highest 24h"],
    d_change24: ["Verschil 24u", "Change 24h"],
    d_history: ["Historie", "History"],
    d_historyValue: ["{span} · {n} metingen", "{span} · {n} points"],
    d_historyNone: ["nog niet opgebouwd", "not built yet"],
    d_normal: ["Normaal (mediaan)", "Normal (median)"],
    d_histLow: ["Laagste (historie)", "Lowest (history)"],
    d_histHigh: ["Hoogste (historie)", "Highest (history)"],
    d_change72: ["Verschil 72u", "Change 72h"],
    d_verdict: ["Beoordeling", "Verdict"],
    d_sales: ["Echte verkopen (FUTBIN)", "Real sales (FUTBIN)"],
    d_sold24: ["Verkocht 24u", "Sold 24h"],
    d_soldValue: ["{n}× ({pct} van aanbod)", "{n}× ({pct} of listings)"],
    d_p10: ["Koop tot (P10)", "Buy up to (P10)"],
    d_median: ["Middenprijs", "Median price"],
    d_p75: ["Verkoop voor (P75)", "Sell for (P75)"],
    d_p90: ["Duurste 10% (P90)", "Top 10% (P90)"],
    d_vsYesterday: ["T.o.v. gisteren", "Vs yesterday"],
    d_checkedAt: ["Gecheckt om", "Checked at"],
    d_notChecked: ["Nog niet gecheckt. Zonder echte verkopen blijft de score onder 70.", "Not checked yet. Without real sales the score stays below 70."],
    d_checkButton: ["📊 Check verkopen", "📊 Check sales"],
    d_checkTitle: ["Haal de echte verkopen van deze kaart op FUTBIN op", "Get this card's real sales from FUTBIN"],
    d_salesLink: ["Verkopen op FUTBIN ↗", "Sales on FUTBIN ↗"],
    d_searchLink: ["Zoek op FUTBIN ↗", "Search FUTBIN ↗"],
    d_warn: ["Let op", "Watch out"],
    // help
    help_score: ["Score", "Score"],
    help_scoreText: ["0–100: hoe goed de kans nú is. Telt mee: prijs t.o.v. normaal (25%), winst (25%), hoe snel hij verkoopt (20%), trend en rust (20%) en hoe betrouwbaar de data is (10%). Groen 70+ = goede kans · geel = twijfel · grijs = laten liggen. Groen kan pas na 📊 Check echte verkopen.", "0–100: how good the chance is right now. Counts: price vs normal (25%), profit (25%), how fast it sells (20%), trend and stability (20%) and how reliable the data is (10%). Green 70+ = good chance · yellow = doubtful · grey = skip it. Green only after 📊 Check real sales."],
    help_dot: ["Bolletje", "Dot"],
    help_dotText: ["🟢 kopen kan (op je koopprijs) · 🟡 bijna (≤ 6% erboven) · 🟠 goedkoop, maar riskant · ⚪ nog te duur · ⛔ geen winst.", "🟢 buy now (at your buy price) · 🟡 almost (≤ 6% above) · 🟠 cheap, but risky · ⚪ too expensive for now · ⛔ no profit."],
    help_prices: ["Koop ≤ / Verkoop", "Buy ≤ / Sell"],
    help_pricesText: ["Blauw = berekend uit echte FUTBIN-verkopen. Wit = berekend uit de vraagprijzen op fodder.gg (minder zeker).", "Blue = based on real FUTBIN sales. White = based on asking prices on fodder.gg (less certain)."],
    help_trend: ["Trend", "Trend"],
    help_trendText: ["De PC-prijs van de laatste 72 uur, elke 15 min opgeslagen door je pc. Gele stip = nu. Nog geen historie? Dan de lijn van vandaag van fodder.gg.", "The PC price of the last 72 hours, saved by your pc every 15 min. Yellow dot = now. No history yet? Then today's line from fodder.gg."],
    help_futbin: ["Echte verkopen", "Real sales"],
    help_futbinText: ["Uit FUTBIN (PC): verkopen en mediaan per 24 uur over de laatste 72 uur (nieuwste eerst), plus de dagprijzen van de laatste weken. Dalen de echte verkoopprijzen al langer, dan telt een lage prijs niet als kans. ? = geen data voor die periode (dat is iets anders dan 0 verkopen).", "From FUTBIN (PC): sales and median per 24 hours over the last 72 hours (newest first), plus the daily prices of the last weeks. If real sale prices keep falling, a low price doesn't count as a chance. ? = no data for that period (not the same as 0 sales)."],
    help_details: ["Details", "Details"],
    help_detailsText: ["Klik op een rij voor alles: waarom deze score, de prijzen, de echte verkopen en alle waarschuwingen.", "Click a row for everything: why this score, the prices, the real sales and all warnings."],
    help_self: ["Zelf doen", "You decide"],
    help_selfText: ["Zoeken, kopen en verkopen doe je altijd zelf. Let op content en leaks (rond 19:00).", "You always search, buy and sell yourself. Watch out for content and leaks (around 19:00)."],
    // FUTBIN 72 h
    w_young: ["Nieuwe kaart: pas {days} dag(en) op de markt, de prijs zakt vaak nog", "New card: only {days} day(s) on the market, the price often keeps falling"],
    w_fbDownLong: ["Echte verkoopprijzen dalen al langer (FUTBIN)", "Real sale prices have been falling for a while (FUTBIN)"],
    w_fbDemand: ["Minder verkopen dan de dagen ervoor ({pct})", "Fewer sales than the days before ({pct})"],
    cap_fbDownLong: ["echte verkoopprijzen dalen al langer", "real sale prices keep falling"],
    miss_fbHistory: ["verloop van de echte verkopen (te weinig verkopen of data)", "course of the real sales (too few sales or data)"],
    pos_cheapStable: ["Goedkoop, terwijl de echte verkoopprijzen stabiel blijven", "Cheap, while real sale prices hold"],
    pos_salesRecovering: ["Echte verkoopprijzen herstellen", "Real sale prices are recovering"],
    d_used: ["Gebruikt: {list}", "Used: {list}"],
    src_history: ["fodder.gg-historie {span}", "fodder.gg history {span}"],
    src_today: ["fodder.gg vandaag ({hours}u)", "fodder.gg today ({hours}h)"],
    d_normalFb: ["Normaal (FUTBIN 72u)", "Normal (FUTBIN 72h)"],
    src_futgg: ["FUT.GG momentum (24u {m24}, 6u {m6})", "FUT.GG momentum (24h {m24}, 6h {m6})"],
    pos_turning: ["Draait: na de dip loopt de prijs de laatste 6 uur niet meer terug", "Turning: after the dip the price has stopped falling over the last 6 hours"],
    src_noFodder: ["geen fodder.gg-historie", "no fodder.gg history"],
    src_h72: ["FUTBIN-verkopen {hours}u ({sales}×) + {days} dagprijzen", "FUTBIN sales {hours}h ({sales}×) + {days} daily prices"],
    src_basic: ["FUTBIN-verkopen {window}", "FUTBIN sales {window}"],
    src_noFutbin: ["nog geen FUTBIN", "no FUTBIN yet"],
    d_salesWin: ["Verkopen per 24u", "Sales per 24h"],
    d_medianWin: ["Mediaan per 24u", "Median per 24h"],
    d_winTitle: ["Nieuwste eerst: laatste 24u · 24–48u geleden · 48–72u geleden. ? = geen (volledige) data voor die periode", "Newest first: last 24h · 24–48h ago · 48–72h ago. ? = no (complete) data for that period"],
    d_course: ["Verloop verkoopprijs", "Sale price course"],
    course_downLong: ["daalt al langer", "falling for a while"],
    course_down: ["daalt", "falling"],
    course_stable: ["stabiel", "stable"],
    course_recovering: ["herstelt", "recovering"],
    course_up: ["stijgt", "rising"],
    course_unknown: ["onbekend (te weinig verkopen)", "unknown (too few sales)"],
    d_demand: ["Vraag", "Demand"],
    demand_falling: ["daalt: {now} vs {before}/dag ervoor", "falling: {now} vs {before}/day before"],
    demand_rising: ["stijgt: {now} vs {before}/dag ervoor", "rising: {now} vs {before}/day before"],
    demand_steady: ["normaal: {now} vs {before}/dag", "normal: {now} vs {before}/day"],
    demand_unknown: ["onbekend", "unknown"],
    d_week: ["Dagprijs: week vs week ervoor", "Daily price: week vs week before"],
    d_coverage: ["Verkoopdata", "Sales data"],
    d_coverageValue: ["{hours}u van 72u · {days} dagprijzen", "{hours}h of 72h · {days} daily prices"],
    d_noData: ["?", "?"],
    d_oldCheck: ["Oudere check zonder 72-uursdata: check opnieuw.", "Older check without 72-hour data: check again."],
    // FUTBIN checks and alerts
    fbAllFresh: ["FUTBIN: alles is al gecheckt (minder dan 45 min geleden). Wil je toch opnieuw: vink aan en klik 🔁 Recheck.", "FUTBIN: everything was already checked (less than 45 min ago). To check again anyway: tick and click 🔁 Recheck."],
    recheck: ["🔁 Recheck ({n})", "🔁 Recheck ({n})"],
    recheckTitle: ["Check de aangevinkte kaarten opnieuw op FUTBIN, ook als ze net gecheckt zijn (max 30 per klik, één per paar seconden).", "Check the ticked cards on FUTBIN again, also when they were just checked (max 30 per click, one every few seconds)."],
    d_recheckButton: ["🔁 Opnieuw checken", "🔁 Check again"],
    d_recheckTitle: ["Haal de echte verkopen van deze kaart nu opnieuw op bij FUTBIN.", "Fetch this card's real sales from FUTBIN again now."],
    d_staleCheck: ["Check is ouder dan 45 min: wordt nog gebruikt (tot 3 uur). De auto-check ververst belangrijke kaarten (🟢/🟡/🟠, ↩, score 60+) na 45 min, de rest na 2,5 uur.", "Check is older than 45 min: still used (up to 3 hours). The auto check refreshes important cards (🟢/🟡/🟠, ↩, score 60+) after 45 min, the rest after 2.5 hours."],
    d_checkedAgo: ["{time} ({min} min geleden)", "{time} ({min} min ago)"],
    fbStopped: ["FUTBIN gestopt: {error}", "FUTBIN stopped: {error}"],
    fbDone: ["FUTBIN: {n} kaart(en) gecheckt", "FUTBIN: {n} card(s) checked"],
    srcFodder: ["Bron: fodder.gg", "Source: fodder.gg"],
    srcFutggShort: ["FUT.GG momentum", "FUT.GG momentum"],
    filterPh: ["Zoek speler, of filter: score>70 · draait · <100k", "Find a player, or filter: score>70 · turning · <100k"],
    filterTitle: ["Woorden zoeken in naam en kaarttype. Filters: score>70, score<50, <100k, >20k, draait, zakt, gecheckt, groen, holo. Alles moet kloppen.", "Words search name and card type. Filters: score>70, score<50, <100k, >20k, turning, falling, checked, green, holo. All must match."],
    h_24: ["24u", "24h"],
    h_6: ["6u", "6h"],
    h_sales: ["Verkopen", "Sales"],
    t_overview: ["Overzicht", "Overview"],
    t_sales: ["Verkopen", "Sales"],
    t_score: ["Score", "Score"],
    t_prices: ["Prijzen", "Prices"],
    t_warn: ["Let op ({n})", "Warnings ({n})"],
    d_ladder: ["Prijsladder", "Price ladder"],
    d_ladderFb: ["Echte verkopen (FUTBIN 72u): P10–P90, normaal = mediaan.", "Real sales (FUTBIN 72h): P10–P90, normal = median."],
    d_ladderSheet: ["Uit de fodder.gg-sheet van vandaag (laag · gem. · hoog). Na een FUTBIN-check: echte verkopen.", "From today's fodder.gg sheet (low · avg · high). After a FUTBIN check: real sales."],
    d_ladderNone: ["Pas na de FUTBIN-check zijn er koop- en verkoopprijzen.", "Only after the FUTBIN check are there buy and sell prices."],
    d_lNormal: ["normaal", "normal"],
    d_lBuy: ["koop", "buy"],
    d_lSell: ["verkoop", "sell"],
    d_lNow: ["nu", "now"],
    d_lLow: ["laag", "low"],
    d_lAvg: ["gem.", "avg"],
    d_lHigh: ["hoog", "high"],
    d_facts: ["Kort", "In short"],
    d_todo: ["Doen", "Do"],
    d_searchMax: ["🔍 Zoek · max {max}", "🔍 Search · max {max}"],
    d_searchNoMax: ["🔍 Zoek in markt", "🔍 Search the market"],
    srcFutgg: ["Bron: FUT.GG momentum", "Source: FUT.GG momentum"],
    srcTitle: ["Wissel tussen je fodder.gg-lijst en FUT.GG Momentum Trends (special cards, grootste dip eerst). Ze blijven gescheiden: prijzen worden nooit gemengd.", "Switch between your fodder.gg list and FUT.GG Momentum Trends (special cards, biggest dip first). They stay apart: prices are never mixed."],
    st_unk: ["Nog geen FUTBIN-check: geen koop-/verkoopprijs (klik 📊 of wacht op de auto-check)", "No FUTBIN check yet: no buy/sell price (click 📊 or wait for the auto check)"],
    sts_unk: ["Nog checken", "To check"],
    w_mNoFutbin: ["Nog niet op FUTBIN gecheckt", "Not checked on FUTBIN yet"],
    w_mFalling: ["Zakt nog: {pct} in 6 uur", "Still falling: {pct} in 6 hours"],
    m_falling: ["⏬ zakt nog", "⏬ still falling"],
    m_turning: ["↩ draait", "↩ turning"],
    m_none: ["—", "—"],
    h6: ["6u", "6h"],
    d_mPrice: ["FUT.GG momentum", "FUT.GG momentum"],
    d_nowSrc: ["Nu komt uit", "Now comes from"],
    d_nowIndex: ["FUT.GG-prijsindex ({time})", "FUT.GG price index ({time})"],
    d_nowList: ["momentum-lijst", "momentum list"],
    d_nowFodder: ["fodder.gg Nu", "fodder.gg now"],
    d_nowDiff: ["index {pct}", "index {pct}"],
    d_nowFodderOnly: ["fodder.gg (niet in de FUT.GG-index)", "fodder.gg (not in the FUT.GG index)"],
    mPricesAt: [" · prijzen {time}", " · prices {time}"],
    fbCoverage: [" · FUTBIN {n}/{total}", " · FUTBIN {n}/{total}"],
    d_mNotChecked: ["Nog niet gecheckt. Pas met echte verkopen is er een koop- en verkoopprijs.", "Not checked yet. Only real sales give a buy and sell price."],
    d_m24: ["24 uur", "24 hours"],
    d_m6: ["6 uur", "6 hours"],
    d_move: ["Beweging", "Movement"],
    d_futggLink: ["Open op FUT.GG ↗", "Open on FUT.GG ↗"],
    mLoading: ["FUT.GG momentum ophalen… {n} pagina's", "Fetching FUT.GG momentum… {n} pages"],
    mStatus: ["{platform} · FUT.GG momentum · {n} kaarten · 🟢 {buy}  🟡 {near}  🟠 {risk}  ❔ {unk} · bijgewerkt {time}", "{platform} · FUT.GG momentum · {n} cards · 🟢 {buy}  🟡 {near}  🟠 {risk}  ❔ {unk} · updated {time}"],
    mStatusTitle: ["FUT.GG Momentum Trends (special cards), elke 15 min opnieuw zolang dit tabblad open is. Nu = FUT.GG-prijsindex (elke minuut gecontroleerd, op console: de momentum-lijst). Gesorteerd op de grootste daling in 24 uur. Koop/verkoop komen alleen uit echte FUTBIN-verkopen.", "FUT.GG Momentum Trends (special cards), every 15 min while this tab is open. Now = FUT.GG price index (checked every minute; on console: the momentum list). Sorted by the biggest 24-hour drop. Buy/sell come only from real FUTBIN sales."],
    mEmpty: ["Nog geen FUT.GG-data: klik ↻.", "No FUT.GG data yet: click ↻."],
    mEmptyFetch: ["FUT.GG gaf geen kaarten terug", "FUT.GG returned no cards"],
    mTrendTitle: ["Bovenste regel = 6 uur: rood = zakt nog (≤ −2%), groen = draait (24 uur ≤ −3% en 6 uur ≥ 0), het koopmoment. Onderste regel = 24 uur.", "Top line = 6 hours: red = still falling (≤ −2%), green = turning (24 h ≤ −3% and 6 h ≥ 0), the moment to buy. Bottom line = 24 hours."],
    help_momentum: ["FUT.GG momentum", "FUT.GG momentum"],
    help_momentumText: ["Kies bovenaan de bron. Na de FUTBIN-check krijgt een kaart een score uit de echte verkopen van 72 uur (normaal niveau, winst, verkoopbaarheid, verloop) plus de dip en de timing van FUT.GG. FUT.GG momentum toont de special cards met de grootste daling in 24 uur (t.o.v. hetzelfde uur gisteren, dus echte dips en niet het nachtdal). 6 uur zegt of hij nog zakt (⏬) of draait (↩). Pas na de FUTBIN-check is er een koop- en verkoopprijs; elke ronde worden er 40 automatisch gecheckt (eerst ↩ draait, ⏬ zakt nog als laatste).", "Choose the source at the top. After the FUTBIN check a card gets a score from the real sales of 72 hours (normal level, profit, liquidity, course) plus FUT.GG's dip and timing. FUT.GG momentum shows the special cards with the biggest drop in 24 hours (vs the same hour yesterday, so real dips, not the night low). 6 hours tells whether it is still falling (⏬) or turning (↩). Only after the FUTBIN check is there a buy and sell price; each round 40 are checked automatically (↩ turning first, ⏬ still falling last)."],
    fbAutoPaused: ["FUTBIN auto-check gepauzeerd tot {time} (klik 📊 om nu toch te checken)", "FUTBIN auto check paused until {time} (click 📊 to check now anyway)"],
    fbPausedMark: [" · ⏸ auto tot {time}", " · ⏸ auto until {time}"],
    fbPausedTitle: ["De auto-check staat op pauze tot {time} na een FUTBIN-fout. Klik om nu toch te checken (dat beëindigt de pauze).", "The auto check is paused until {time} after a FUTBIN error. Click to check now anyway (that ends the pause)."],
    fbAutoDone: ["FUTBIN auto: {n} kaart(en) bijgewerkt", "FUTBIN auto: {n} card(s) updated"],
    autoFutbin: ["📊 Auto checken (alle kaarten, {n} per ronde)", "📊 Auto-check (all cards, {n} per round)"],
    autoFutbinTitle: ["Na elke verversing van de sheet zoekt hij voor de beste {n} kaarten met winst (op score) vanzelf de echte FUTBIN-verkopen op. Alleen kaarten zonder check of met een check ouder dan 45 min; één per paar seconden. Werkt alleen op de pc met de web-app open. FUT.GG momentum: {m} per ronde met rustige pauzes (5-8 s), eerst ↩ draait, dan andere dips, ⏬ zakt nog, stijgers. Beide lijsten worden op de achtergrond ververst, zodat na verloop van tijd elke kaart gecheckt is (een check telt 3 uur).", "After every sheet refresh it looks up the real FUTBIN sales for the best {n} cards with profit (by score) by itself. Only cards without a check or with one older than 45 min; one every few seconds. Works only on the pc with the web app open. FUT.GG momentum: {m} per round with calm pauses (5-8 s), ↩ turning first, then other dips, ⏬ still falling, risers. Both lists refresh in the background, so in time every card is checked (a check counts 3 hours)."],
    fbMissing: [" · niet gevonden: {list}", " · not found: {list}"],
    hitLine: ["🟢 {name}: nu {now} · koop ≤ {buy} · verkoop {sell} (+{profit})", "🟢 {name}: now {now} · buy ≤ {buy} · sell {sell} (+{profit})"],
    hitSales: [" · FUTBIN {n} verkopen/24u", " · FUTBIN {n} sales/24h"],
    hitTitleOne: ["Flip: kaart op 🟢", "Flip: card turned 🟢"],
    hitTitleMany: ["Flip: {n} kaarten op 🟢", "Flip: {n} cards turned 🟢"]
  };
  let flipLangCache = null;
  function flipLang() {
    return uiLang();
  }
  function ft(key, vars) {
    const entry = FLIP_TEXT[key];
    const text = entry ? entry[flipLang() === "en" ? 1 : 0] : key;
    return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match)) : text;
  }
  // 296000 → "296K", 82500 → "82.5K", 1250000 → "1.25M" (short prices inside sentences).
  function flipShort(value) {
    const number = Math.round(Number(value) || 0);
    if (number >= 1000000) return `${(number / 1000000).toFixed(2).replace(/\.?0+$/, "")}M`;
    if (number >= 100000) return `${Math.round(number / 1000)}K`;
    if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    return String(number);
  }
  const flipPct = (value, digits = 0) => `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;

  function flipTokenFrom(text) {
    const value = String(text || "").trim();
    const match = value.match(/price-watch\/([A-Za-z0-9_-]{8,64})/) || value.match(/^([A-Za-z0-9_-]{8,64})$/);
    return match ? match[1] : "";
  }

  // The page streams its data as self.__next_f.push([1,"<JSON string>"]) chunks; the "report" object
  // is inside one of them. Join the chunks, find "report":{ and cut out the balanced object.
  function parseFodderWatch(html) {
    const chunks = [];
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let match;
    while ((match = re.exec(html))) {
      try { chunks.push(JSON.parse(match[1])); } catch (_) { /* skip a broken chunk */ }
    }
    const text = chunks.join("");
    const start = text.indexOf("\"report\":{");
    if (start < 0) throw new Error(L("fodder.gg: geen prijsdata in de pagina (verlopen of verkeerde link?)", "fodder.gg: no price data in the page (expired or wrong link?)"));
    let i = start + 9;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error("fodder.gg: prijsdata onvolledig");
    const report = JSON.parse(text.slice(start + 9, end + 1));
    const num = value => {
      const n = Number(typeof value === "string" ? value.replace(/^\$/, "") : value); // RSC writes -0 as "$-0"
      return Number.isFinite(n) ? n : 0;
    };
    const cards = list => (Array.isArray(list) ? list : []).map(card => ({
      id: num(card.resourceId),
      rating: num(card.rating),
      name: String(card.name || ""),
      rarity: String(card.rarity || ""),
      holo: !!card.holo,
      low: num(card.low), avg: num(card.avg), high: num(card.high), now: num(card.now),
      change: num(card.change), vsAvg: num(card.vsAvg),
      trend: (Array.isArray(card.trend) ? card.trend : []).map(num).filter(n => n > 0)
    })).filter(card => card.id > 0 && card.now > 0);
    return { from: report.from, at: Date.parse(report.at || report.to) || Date.now(), console: cards(report.console), pc: cards(report.pc) };
  }

  let flipData = null;
  try { flipData = JSON.parse(localStorage.getItem(FLIP_DATA_KEY) || "null"); } catch (_) { flipData = null; }
  let flipLoading = null;
  let flipError = "";

  function loadFlipSheet(force) {
    const state = getFlip();
    if (!state.token) return Promise.resolve(false);
    if (flipLoading) return flipLoading;
    if (!force && flipData && flipData.token === state.token && Date.now() - flipData.fetchedAt < FLIP_REFRESH_MS) return Promise.resolve(false);
    flipError = "";
    flipLoading = futggRequestJson(`https://fodder.gg/price-watch/${state.token}`, true)
      .then(html => {
        flipData = { ...parseFodderWatch(html), token: state.token, fetchedAt: Date.now() };
        try { localStorage.setItem(FLIP_DATA_KEY, JSON.stringify(flipData)); } catch (_) { /* memory only */ }
        recordFlipHistory(flipData);
        checkFlipHits().catch(error => console.warn(L("Price Watch: flip-melding mislukt.", "Price Watch: flip notification failed."), error))
          .then(() => futbinAutoTop("fodder"))
          .catch(error => console.warn(L("Price Watch: FUTBIN auto-check mislukt.", "Price Watch: FUTBIN auto-check failed."), error));
        return true;
      })
      .catch(error => {
        flipError = error && error.message ? error.message : String(error);
        return false;
      })
      .finally(() => {
        flipLoading = null;
        listeners.forEach(listener => listener());
      });
    listeners.forEach(listener => listener());
    return flipLoading;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Buy / sell per card. A low, avg or high far from the hourly trend (one odd sale, a 990K listing,
  // thin PC data) is replaced by the trend's own values and flagged, as the sheet says: skip crazy highs.
  function flipCalc(card, platform) {
    // The sheet looks at the last 12 hours: a card that fell all day is judged on where it is now.
    const last12 = card.trend.slice(-12);
    const mid = median(last12) || card.avg || card.now;
    const core = last12.filter(value => value >= mid * 0.8 && value <= mid * 1.25);
    const lowOdd = card.low < mid * 0.8;
    const coreMax = core.length ? Math.max(...core) : mid;
    // A high above every hourly point (+10%) or far above the middle is one sale/listing, not a sell price.
    const highOdd = card.high > mid * 1.3 || (core.length >= 6 && card.high > coreMax * 1.1);
    const avgOdd = card.avg > 0 && Math.abs(card.avg / mid - 1) > 0.15;
    const low = lowOdd ? (core.length ? Math.min(...core) : mid) : card.low;
    const high = highOdd ? coreMax : card.high;
    const falling = card.trend.length >= 8 && median(card.trend.slice(-4)) < median(card.trend.slice(0, 4)) * 0.92;
    const avg = avgOdd || falling || !card.avg ? Math.min(mid, card.avg || mid) : card.avg;
    let buy = roundDownToStep(low);
    // "Use average–high as guide", but never above what it fetched in the last 12 hours (just under that high).
    let sell = roundDownToStep(Math.min(Math.max(avg, (avg + high) / 2), coreMax * 0.98));
    const warnings = [];
    // Real FUTBIN sales (when checked): buy ≤ P10, sell at P75 of the sold prices. Then the fodder.gg
    // listing quirks (odd low/high/avg, few hourly points) no longer matter.
    const futbin = platform ? futbinSalesFor(card, platform) : null;
    const useFutbin = !!futbin && futbin.salesInBase >= 3;
    let fbRisky = false;
    if (useFutbin) {
      buy = roundDownToStep(futbin.p10);
      sell = roundDownToStep(futbin.p75);
      if (futbin.sales24 < 5) { warnings.push(ft("w_fewSales", { n: futbin.sales24 })); fbRisky = true; }
      const fh = futbin.h72;
      if (fh && fh.state === "downLong") { warnings.push(ft("w_fbDownLong")); fbRisky = true; }
      // New card (TOTW / new content, ≤ 2 days of sales): its price usually keeps settling → never plain 🟢.
      const youngDays = futbinYoung(futbin);
      if (youngDays) { warnings.unshift(ft("w_young", { days: youngDays })); fbRisky = true; }
      else if (futbin.trend != null && futbin.trend <= -0.05) { warnings.push(ft("w_saleFalling", { pct: flipPct(futbin.trend * 100) })); fbRisky = true; }
      if (fh && fh.demand === "falling") warnings.push(ft("w_fbDemand", { pct: flipPct(fh.volume * 100) }));
      if (futbin.listings24 >= 10 && futbin.sellThrough < 0.1) warnings.push(ft("w_lowSellThrough", { pct: `${Math.round(futbin.sellThrough * 100)}%` }));
      if (futbin.outliers.length) warnings.push(ft("w_outlierSale", { list: futbin.outliers.map(flipShort).join(", ") }));
    } else {
      if (lowOdd) warnings.push(ft("w_lowOdd", { price: flipShort(card.low) }));
      if (highOdd) warnings.push(ft("w_highOdd", { price: flipShort(card.high) }));
      if (avgOdd) warnings.push(ft("w_avgOdd", { price: flipShort(card.avg) }));
    }
    const profit = Math.floor(sell * (1 - EA_TAX)) - buy;
    const pct = buy > 0 ? profit / buy * 100 : 0;
    const gap = buy > 0 ? card.now / buy - 1 : 1;
    const sparse = !useFutbin && card.trend.length < 12;
    if (sparse) warnings.push(ft("w_sparse", { n: card.trend.length }));
    // A card that crashed today: its low is the new price, not a deal (fodder.gg's own 24h change).
    const crashed = card.change <= -15;
    if (crashed) warnings.unshift(ft("w_crashed", { pct: flipPct(card.change) }));
    // Now at the day's low after a drop: you'd buy the bottom of a falling line (e.g. 345K → 300K).
    const atBottom = !crashed && card.change <= -8 && card.now <= card.low * 1.01;
    if (atBottom) warnings.unshift(ft("w_atBottom", { pct: `${Math.abs(card.change).toFixed(0)}%` }));
    if (falling) warnings.push(ft("w_falling"));
    // Sheet: "low fluctuation within the last 12 hrs". A card swinging > 20% around its middle (one-off
    // sales already left out) is restless: the low may be a dip you can't sell out of.
    const coreMin = core.length ? Math.min(...core) : mid;
    const restless = core.length >= 6 && (coreMax - coreMin) / mid > 0.2;
    if (restless) warnings.push(ft("w_restless", { low: flipShort(coreMin), high: flipShort(coreMax) }));
    // Thin data or a crazy high (sheet: skip it), a falling or restless price or a crash: never plain green.
    const risky = sparse || (highOdd && !useFutbin) || falling || crashed || atBottom || restless || fbRisky;
    const cheap = gap <= 0.06;
    const status = profit <= 0 ? "skip" : cheap && risky ? "risk" : gap <= 0.02 ? "buy" : cheap ? "near" : "wait";
    return { buy, sell, profit, pct, gap, warnings, status, risky, futbin: useFutbin ? futbin : null };
  }

  // Icon per signal; the texts are st_<status> (long) and sts_<status> (short) in FLIP_TEXT.
  const FLIP_ICON = { buy: "🟢", near: "🟡", risk: "🟠", wait: "⚪", unk: "❔", skip: "⛔" };
  const FLIP_ORDER = { buy: 0, near: 1, risk: 2, wait: 3, unk: 3.5, skip: 4 };

  function flipSparkline(values, up) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "84");
    svg.setAttribute("height", "24");
    svg.setAttribute("class", "pt-flip-spark");
    if (values.length < 2) return svg;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const points = values.map((value, i) => `${(i / (values.length - 1) * 84).toFixed(1)},${(22 - (max > min ? (value - min) / (max - min) : 0.5) * 20).toFixed(1)}`);
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", points.join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", up ? "#27d98b" : "#ff8080");
    line.setAttribute("stroke-width", "1.5");
    svg.appendChild(line);
    return svg;
  }

  // Stored PC history (max 72 h): the price line over real time, dashed = median, dotted = lowest,
  // dot = now. Only what was really recorded is drawn.
  function flipHistoryChart(hist, now, direction) {
    const ns = "http://www.w3.org/2000/svg";
    const width = 110;
    const height = 34;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("class", "pt-flip-spark pt-flip-hist-chart");
    const points = hist.points;
    const first = points[0][0];
    const span = Math.max(1, points[points.length - 1][0] - first);
    const values = points.map(point => point[1]).concat(now);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const y = value => (height - 3 - (max > min ? (value - min) / (max - min) : 0.5) * (height - 6)).toFixed(1);
    const x = time => ((time - first) / span * (width - 6)).toFixed(1);
    const line = (y1, color, dash) => {
      const item = document.createElementNS(ns, "line");
      item.setAttribute("x1", "0");
      item.setAttribute("x2", String(width - 6));
      item.setAttribute("y1", y1);
      item.setAttribute("y2", y1);
      item.setAttribute("stroke", color);
      item.setAttribute("stroke-width", "1");
      item.setAttribute("stroke-dasharray", dash);
      svg.appendChild(item);
    };
    line(y(hist.median), "#9aa6b8", "3 2");
    line(y(hist.low), "#63b3ff", "1 2");
    const path = document.createElementNS(ns, "polyline");
    path.setAttribute("points", points.map(point => `${x(point[0])},${y(point[1])}`).join(" "));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", direction === "neg" ? "#ff8080" : direction === "pos" ? "#27d98b" : "#c9d3e0");
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(width - 3));
    dot.setAttribute("cy", y(now));
    dot.setAttribute("r", "2.5");
    dot.setAttribute("fill", "#f4c95d");
    svg.appendChild(dot);
    return svg;
  }

  // Player entries for a run/watch list; specials get their rarity from EA's concept data (versions).
  async function flipPlayers(rows) {
    const special = rows.filter(row => row.card.id > 0xFFFFFF).map(row => row.card.id & 0xFFFFFF);
    const versions = special.length ? await cardVersionsMany(special) : new Map();
    return rows.map(({ card, calc }) => {
      const player = {
        definitionId: card.id,
        name: `${card.name} ${card.rating} ${card.rarity}${card.holo ? " ✨" : ""}`,
        rating: card.rating,
        fixedMax: calc.buy,
        flipSell: calc.sell
      };
      if (card.id > 0xFFFFFF) {
        const version = (versions.get(card.id & 0xFFFFFF) || []).find(item => item.definitionId === card.id);
        player.special = true;
        player.rarity = version ? version.rarity : null;
      }
      if (card.holo) player.holo = true;
      return player;
    }).sort((a, b) => b.fixedMax - a.fixedMax);
  }

  // 🔍 One flip card on the transfer market: the same filter a run prepares (version via quality Special +
  // rarity, holo-only for holo cards, max BIN = buy price; withoutMax = no price limit). Only fills the
  // filter screen; you press Search yourself.
  async function openFlipSearch(card, calc, withoutMax) {
    const [player] = await flipPlayers([{ card, calc }]);
    const baseId = card.id & 0xFFFFFF;
    const criteria = baseCriteria();
    criteria.maskedDefId = baseId;
    if (player.special) {
      const special = SearchLevel.SPECIAL || SearchLevel.SP;
      if (special) criteria.level = special;
      if (player.rarity != null) criteria.rarities = [player.rarity];
    } else {
      criteria.level = card.rating >= 75 ? SearchLevel.GOLD : card.rating >= 65 ? SearchLevel.SILVER : SearchLevel.BRONZE;
    }
    if (!withoutMax && calc.buy > 0) criteria.maxBuy = calc.buy;
    if (card.holo) criteria.__futgenieHoloOnly = true;
    openFilters(criteria, repositories.Item.getStaticDataByDefId(baseId));
  }

  // "Now" of a fodder.gg card on PC: FUT.GG's price index (republished every few minutes, checked every
  // minute; exact card id incl. holo) instead of fodder.gg's last hourly point. Everything else of the row
  // (list, low/avg/high, hourly trend, sheet buy/sell) stays fodder.gg, and the stored 72 h history keeps
  // fodder.gg's own "now" (recordFlipHistory reads the raw sheet). Not in the index / console: fodder.gg.
  function fodderNow(card, platform) {
    const live = futggPlatform === (platform === "pc" ? "pc" : "console") ? Number(futggPrices[String(card.id)]) : 0;
    return live > 0 ? { ...card, now: live, nowSrc: "index", fodderNow: card.now } : { ...card, nowSrc: "fodder", fodderNow: card.now };
  }

  // Rows for the current link/platform with your max price and min profit (shared by the table and the alert).
  function flipRows(data, state) {
    const cards = data ? data[state.platform] || [] : [];
    return cards
      .map(item => fodderNow(item, state.platform))
      .map(item => ({ card: item, calc: flipCalc(item, state.platform) }))
      .filter(row => !state.maxPrice || row.card.now <= state.maxPrice)
      .map(row => (row.calc.status !== "skip" && row.calc.pct < state.minPct ? { ...row, calc: { ...row.calc, status: "skip" } } : row));
  }

  // 🔔 Flip alert: a card that is newly 🟢 since the previous fetch → pling + toast + ntfy push.
  // The first fetch (after loading the app, or a new link/platform) only takes stock, so it stays quiet.
  let flipAlertSeen = null; // { key, ids: Set }
  async function checkFlipHits() {
    const state = getFlip();
    if (!flipData || flipData.token !== state.token) return;
    const key = `${state.token}|${state.platform}`;
    const greens = flipRows(flipData, state).filter(row => row.calc.status === "buy");
    const ids = new Set(greens.map(row => row.card.id));
    const previous = flipAlertSeen && flipAlertSeen.key === key ? flipAlertSeen.ids : null;
    flipAlertSeen = { key, ids };
    if (!previous || !state.alert) return;
    let fresh = greens.filter(row => !previous.has(row.card.id));
    if (!fresh.length) return;
    // Check new greens against real FUTBIN sales first; only notify what is still green after that.
    const unchecked = fresh.filter(row => futbinNeedsCheck(row.card, state.platform)).map(row => row.card).slice(0, 5);
    if (unchecked.length && !futbinState.busy) {
      await futbinCheckCards(unchecked, state.platform);
      const still = new Set(flipRows(flipData, state).filter(row => row.calc.status === "buy").map(row => row.card.id));
      fresh = flipRows(flipData, state).filter(row => still.has(row.card.id) && fresh.some(item => item.card.id === row.card.id));
      if (!fresh.length) return;
    }
    const lines = fresh.map(({ card, calc }) =>
      ft("hitLine", { name: `${card.name} ${card.rating}${card.holo ? " holo" : ""}`, now: flipShort(card.now), buy: flipShort(calc.buy), sell: flipShort(calc.sell), profit: flipShort(calc.profit) })
      + (calc.futbin ? ft("hitSales", { n: calc.futbin.sales24 }) : ""));
    if (chimeAudio) playChime();
    showToast(lines.join(" · "), true);
    // Push from the pc only (FUT Genie there), so a phone with the app open doesn't send it twice.
    if (pcDevice()) relayCall("notify", { title: fresh.length > 1 ? ft("hitTitleMany", { n: fresh.length }) : ft("hitTitleOne"), text: lines.join("\n") })
      .catch(error => console.warn(L("Price Watch: ntfy-melding mislukt.", "Price Watch: ntfy notification failed."), error));
  }

  // --- Flip price history (PC only, fodder.gg "now") ------------------------------------------------
  // The pc (FUT Genie there) is the only writer: each refreshed fodder.gg sheet gives one snapshot of the
  // PC "now" price per card (EA card id = fodder's resourceId), at most one per 15 min, 72 h kept. FUT.GG
  // prices never go in here. It travels in the existing gist file (price-watch-prices.json, field "h")
  // with the normal 5-minute push; the phone only reads it (pullRelay) and never writes its own.
  // Compact form with one shared time axis:
  //   { v: 1, pf: "pc", u: updatedAt, b: first snapshot (ms), t: [minutes after b], f: fingerprint, q: unit,
  //     c: { eaId: { n: name, r: rating, o: 1 if holo, i: index in t of the first sample, d: [deltas] } } }
  // d holds price differences from the previous sample of that card in units of q (50 when every price
  // is a multiple of 50, else 1: always exact); null = card not in that snapshot. The last 24 h are kept
  // per 15 min, older snapshots one per hour (72 h of ~180 cards stays ~100 KB).
  const HISTORY_KEY = "pt_flip_history_v1";
  const HISTORY_STEP_MS = 15 * 60 * 1000;
  const HISTORY_KEEP_MS = 72 * 60 * 60 * 1000;
  const HISTORY_SAME_MS = 60 * 60 * 1000; // identical prices within an hour = sheet not refreshed yet
  const HISTORY_MAX_CARDS = 250;
  const HISTORY_MAX_BYTES = 150 * 1024; // the gist is read whole on every pull: keep it small
  let flipHistory; // decoded: { updatedAt, times: [ms], cards: Map(id → { name, rating, holo, prices }), fp }
  let historyVersion = 0; // bumps on every change (metrics cache)

  function encodeFlipHistory(history) {
    if (!history || !history.times.length) return null;
    const base = history.times[0];
    let unit = 50;
    history.cards.forEach(card => { if (card.prices.some(price => price % 50)) unit = 1; });
    const c = {};
    history.cards.forEach((card, id) => {
      const first = card.prices.findIndex(price => price > 0);
      if (first < 0) return;
      let last = 0;
      const d = card.prices.slice(first).map(price => {
        if (!(price > 0)) return null;
        const delta = (price - last) / unit;
        last = price;
        return delta;
      });
      while (d.length && d[d.length - 1] === null) d.pop();
      c[id] = { n: card.name, r: card.rating, ...(card.holo ? { o: 1 } : {}), i: first, d };
    });
    return { v: 1, pf: "pc", u: history.updatedAt, b: base, t: history.times.map(time => Math.round((time - base) / 60000)), f: history.fp || "", q: unit, c };
  }

  function decodeFlipHistory(raw) {
    if (!raw || raw.v !== 1 || raw.pf !== "pc" || !Array.isArray(raw.t) || !raw.c || typeof raw.c !== "object") return null;
    const base = Number(raw.b) || 0;
    const unit = Number(raw.q) || 1;
    const times = raw.t.map(minutes => base + Number(minutes) * 60000);
    const cards = new Map();
    Object.entries(raw.c).forEach(([id, entry]) => {
      if (!entry || !Array.isArray(entry.d) || !(Number(id) > 0)) return;
      const prices = new Array(times.length).fill(0);
      let last = 0;
      entry.d.forEach((delta, k) => {
        if (delta == null) return;
        last += (Number(delta) || 0) * unit;
        const index = (Number(entry.i) || 0) + k;
        if (index < times.length && last > 0) prices[index] = last;
      });
      cards.set(Number(id), { name: String(entry.n || ""), rating: Number(entry.r) || 0, holo: !!entry.o, prices });
    });
    return { updatedAt: Number(raw.u) || 0, times, cards, fp: String(raw.f || "") };
  }

  function getFlipHistory() {
    if (flipHistory === undefined) {
      try { flipHistory = decodeFlipHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || "null")); } catch (_) { flipHistory = null; }
    }
    return flipHistory;
  }

  function saveFlipHistory(history) {
    flipHistory = history;
    historyVersion++;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(encodeFlipHistory(history))); } catch (_) { /* memory only */ }
  }

  // Snapshots older than 72 h out, cards without a price left out; then the card and size limits.
  function pruneFlipHistory(history, now = Date.now()) {
    const cut = history.times.findIndex(time => time >= now - HISTORY_KEEP_MS);
    const drop = cut < 0 ? history.times.length : cut;
    if (drop) {
      history.times.splice(0, drop);
      history.cards.forEach(card => card.prices.splice(0, drop));
    }
    // Older than 24 h: one snapshot per clock hour (the first of that hour).
    const hours = new Set();
    const keep = history.times.map(time => {
      if (time >= now - 24 * 60 * 60 * 1000) return true;
      const hour = Math.floor(time / 3600000);
      if (hours.has(hour)) return false;
      hours.add(hour);
      return true;
    });
    if (keep.includes(false)) {
      history.times = history.times.filter((_, i) => keep[i]);
      history.cards.forEach(card => { card.prices = card.prices.filter((_, i) => keep[i]); });
    }
    history.cards.forEach((card, id) => { if (!card.prices.some(price => price > 0)) history.cards.delete(id); });
    if (history.cards.size > HISTORY_MAX_CARDS) {
      // Keep the cards seen most recently (then the ones with the most samples).
      const lastSeen = card => { for (let i = card.prices.length - 1; i >= 0; i--) if (card.prices[i] > 0) return i; return -1; };
      [...history.cards.entries()]
        .sort((a, b) => lastSeen(b[1]) - lastSeen(a[1]) || b[1].prices.filter(Boolean).length - a[1].prices.filter(Boolean).length)
        .slice(HISTORY_MAX_CARDS)
        .forEach(([id]) => history.cards.delete(id));
    }
    // Too big for the gist: drop the oldest snapshots until it fits.
    while (history.times.length > 1 && JSON.stringify(encodeFlipHistory(history)).length > HISTORY_MAX_BYTES) {
      const chunk = Math.max(1, Math.ceil(history.times.length / 20));
      history.times.splice(0, chunk);
      history.cards.forEach(card => card.prices.splice(0, chunk));
      history.cards.forEach((card, id) => { if (!card.prices.some(price => price > 0)) history.cards.delete(id); });
    }
    return history;
  }

  // One snapshot of the PC sheet. Returns true when one was added.
  function recordFlipHistory(data, now = Date.now()) {
    if (!pcDevice() || !data || !Array.isArray(data.pc)) return false; // pc = the only writer, PC prices only
    const cards = data.pc.filter(card => card.id > 0 && card.now > 0);
    if (!cards.length) return false;
    const at = Math.round(Math.min(data.at || data.fetchedAt || now, now) / 60000) * 60000;
    const history = getFlipHistory() || { updatedAt: 0, times: [], cards: new Map(), fp: "" };
    const lastAt = history.times.length ? history.times[history.times.length - 1] : 0;
    if (at <= lastAt || at - lastAt < HISTORY_STEP_MS - 60000) return false; // same data, or < 15 min
    const fp = cards.map(card => `${card.id}:${card.now}`).sort().join(",");
    let hash = 0;
    for (let i = 0; i < fp.length; i++) hash = (hash * 31 + fp.charCodeAt(i)) | 0;
    const fingerprint = `${cards.length}.${(hash >>> 0).toString(36)}`;
    if (fingerprint === history.fp && at - lastAt < HISTORY_SAME_MS) return false;
    history.times.push(at);
    history.cards.forEach(card => card.prices.push(0));
    const index = history.times.length - 1;
    cards.forEach(card => {
      let entry = history.cards.get(card.id);
      // Same id but another rating/holo (should not happen): start over instead of mixing two versions.
      if (!entry || entry.rating !== card.rating || entry.holo !== card.holo) {
        entry = { name: card.name, rating: card.rating, holo: card.holo, prices: new Array(history.times.length).fill(0) };
        history.cards.set(card.id, entry);
      }
      entry.name = card.name;
      entry.prices[index] = card.now;
    });
    history.fp = fingerprint;
    history.updatedAt = now;
    saveFlipHistory(pruneFlipHistory(history, now));
    return true;
  }

  // For the gist (pc) and from the gist (phone; the pc's history replaces the local one when newer).
  function flipHistoryForRelay() {
    const history = getFlipHistory();
    if (!history || !history.times.length) return null;
    pruneFlipHistory(history);
    historyVersion++;
    return encodeFlipHistory(history);
  }
  function syncFlipHistory(raw) {
    if (pcDevice()) return false; // the pc never takes history from the gist
    const incoming = decodeFlipHistory(raw);
    const current = getFlipHistory();
    if (!incoming || (current && current.updatedAt >= incoming.updatedAt)) return false;
    saveFlipHistory(pruneFlipHistory(incoming));
    return true;
  }

  // Pc: keep the sheet fresh in the background for the history (every 15 min, fodder.gg only, never EA).
  function flipHistoryTick() {
    if (!pcDevice() || !getFlip().token || flipLoading) return;
    if (flipData && flipData.token === getFlip().token && Date.now() - flipData.fetchedAt < HISTORY_STEP_MS) return;
    loadFlipSheet(false);
  }

  // --- Opportunity score (PC only) -----------------------------------------------------------------
  // 0–100 from five parts: price position 25%, profit 25%, liquidity 20%, trend & stability 20%, data
  // reliability 10%. Sources stay apart: history and today's hourly trend are fodder.gg PC "now" prices;
  // buy/sell, profit and liquidity come from real FUTBIN sales (Sold for) once checked. FUT.GG isn't used.
  // A part without data counts as 25 (below neutral), so thin data never ranks high, and caps apply:
  // no FUTBIN sales → max 69, risky by the sheet rules (🟠/⚠) → max 60, restless → max 65,
  // reliability < 40 → max 55, now above the price that still pays → max 35, no profit → max 25.
  const OPP_WEIGHTS = { price: 0.25, profit: 0.25, liquidity: 0.2, trend: 0.2, reliability: 0.1 };
  const OPP_MISSING = 25;
  const HOUR_MS = 60 * 60 * 1000;
  const clamp100 = value => Math.max(0, Math.min(100, value));
  let historyMetrics = { version: -1, map: new Map() };

  // Stats of one card's stored history (cached until the history changes). null = no history yet.
  function calculateHistoricalMetrics(id) {
    if (historyMetrics.version !== historyVersion) historyMetrics = { version: historyVersion, map: new Map() };
    if (historyMetrics.map.has(id)) return historyMetrics.map.get(id);
    const history = getFlipHistory();
    const entry = history && history.cards.get(id);
    const points = [];
    if (entry) history.times.forEach((time, i) => { if (entry.prices[i] > 0) points.push([time, entry.prices[i]]); });
    let result = null;
    if (points.length) {
      const values = points.map(point => point[1]);
      const sorted = [...values].sort((a, b) => a - b);
      const first = points[0][0];
      const last = points[points.length - 1][0];
      const current = values[values.length - 1];
      const recent = points.filter(point => point[0] >= last - 24 * HOUR_MS);
      const recentSorted = recent.map(point => point[1]).sort((a, b) => a - b);
      const older = points.filter(point => point[0] < last - 24 * HOUR_MS).map(point => point[1]);
      const median24 = futbinPct(recentSorted, 0.5);
      const medianOlder = older.length >= 4 ? median(older) : null;
      const change24 = last - recent[0][0] >= 20 * HOUR_MS ? current / recent[0][1] - 1 : null;
      const change72 = last - first >= 48 * HOUR_MS ? current / values[0] - 1 : null;
      const tail = recent.slice(-6).map(point => point[1]);
      result = {
        samples: values.length,
        spanMs: last - first,
        lastAt: last,
        current,
        median: futbinPct(sorted, 0.5),
        low: sorted[0],
        high: sorted[sorted.length - 1],
        median24,
        medianOlder,
        change24,
        change72,
        // Spread of the middle 80% of the last 24 h, relative to its median.
        volatility: recentSorted.length >= 6 && median24 ? (futbinPct(recentSorted, 0.9) - futbinPct(recentSorted, 0.1)) / median24 : null,
        // Structural: the last day sits clearly (8%+) under the days before and is still lower than 24 h ago.
        structural: medianOlder != null && median24 < medianOlder * 0.92 && (change24 == null || change24 < 0),
        // Recovering: now 2%+ above the lowest of the last few snapshots and not falling at the last step.
        recovering: tail.length >= 4 && Math.min(...tail) <= current * 0.98 && current >= tail[tail.length - 2],
        points
      };
    }
    historyMetrics.map.set(id, result);
    return result;
  }

  function calculateOpportunityScore(card, calc, platform) {
    if (platform !== "pc") return null; // the history and the score are PC-only
    const hist = calculateHistoricalMetrics(card.id);
    const fb = calc.futbin; // fresh FUTBIN sales (≥ 3) or null
    const fh = fb && fb.h72 ? fb.h72 : null; // FUTBIN 72 h: course of real sale prices and demand
    const fbState = fh ? fh.state : null;
    const now = card.now;
    const missing = [];
    const positives = [];
    const useHist = !!hist && hist.samples >= 4 && hist.spanMs >= 3 * HOUR_MS;
    const today = card.trend; // fodder.gg hourly PC prices since 00:00 UTC (same source as the history)

    // A. Price position: now vs the normal level (72 h history, else today's hourly trend).
    let ref = null;
    if (useHist) ref = { median: hist.median, low: hist.low, high: hist.high };
    else if (today.length >= 6) ref = { median: median(today), low: Math.min(...today), high: Math.max(...today) };
    let price = null;
    if (ref && ref.median > 0) {
      const sMedian = clamp100(50 - (now / ref.median - 1) * 500); // −10% → 100, +10% → 0
      const sRange = ref.high > ref.low ? clamp100((1 - (now - ref.low) / (ref.high - ref.low)) * 100) : 50;
      price = 0.65 * sMedian + 0.35 * sRange;
      // A low fodder.gg price alone is no deal: if the real sale prices keep falling, "cheap" is just the
      // market going down. Cheap while real sales hold or recover is what we look for.
      if (fbState === "downLong") price = Math.min(price, 40);
      else if (fbState === "down") price = Math.min(price, 60);
      else if ((fbState === "stable" || fbState === "recovering") && price >= 60) {
        price = Math.min(100, price + 10);
        positives.push("cheapStable");
      }
    } else missing.push("price");

    // B. Profit potential: buy/sell of the flip calc (FUTBIN P10/P75 when checked), 5% tax. Scored on
    // what you pay now (now, or your buy price when lower): a card far above its buy price isn't a deal yet.
    const net = Math.floor(calc.sell * (1 - EA_TAX)) - calc.buy;
    const roi = calc.buy > 0 ? net / calc.buy * 100 : 0;
    const buyNow = Math.max(calc.buy, now);
    const netNow = Math.floor(calc.sell * (1 - EA_TAX)) - buyNow;
    const roiNow = buyNow > 0 ? netNow / buyNow * 100 : 0;
    let profit = 0;
    if (net > 0 && netNow > 0 && buyNow > 0) {
      const sRoi = clamp100(roiNow / 12 * 100);
      const sNet = clamp100(netNow / 15000 * 100);
      if (fb) {
        // Also selling at the median (not only P75) should still pay.
        const roiMedian = (fb.median * (1 - EA_TAX) - buyNow) / buyNow * 100;
        profit = 0.5 * sRoi + 0.2 * sNet + 0.3 * clamp100((roiMedian + 2) / 8 * 100);
      } else {
        profit = (0.7 * sRoi + 0.3 * sNet) * 0.6; // listing prices, not sales: counted lower
      }
    }

    // C. Liquidity: real sales per 24 h and how much of what is listed sells (FUTBIN only).
    let liquidity = null;
    if (fb) {
      const sSales = clamp100(fb.sales24 / 15 * 100);
      liquidity = fb.listings24 >= 3 ? 0.65 * sSales + 0.35 * clamp100(fb.sellThrough / 0.4 * 100) : sSales;
      // Demand over 72 h: clearly fewer sales than the days before counts against, more sales for.
      if (fh && fh.demand === "falling") liquidity *= 0.75;
      else if (fh && fh.demand === "rising") liquidity = Math.min(100, liquidity * 1.1);
    } else missing.push("liquidity");
    if (fb && !fbState) missing.push("fbHistory");

    // D. Trend & stability: 24 h / 72 h change, temporary dip vs structural fall, swings, FUTBIN sales trend.
    const change24 = useHist && hist.change24 != null ? hist.change24 : card.change / 100;
    const change72 = useHist ? hist.change72 : null;
    const last12 = today.slice(-12);
    const volatility = useHist && hist.volatility != null ? hist.volatility
      : last12.length >= 6 ? (futbinPct([...last12].sort((a, b) => a - b), 0.9) - futbinPct([...last12].sort((a, b) => a - b), 0.1)) / median(last12) : null;
    const structural = useHist && hist.structural;
    const belowNormal = !!ref && now < ref.median * 0.95;
    const recovering = useHist && hist.recovering;
    let trend = 60;
    trend += Math.max(-40, Math.min(15, change24 * 200));
    if (change72 != null) trend += Math.max(-20, Math.min(10, change72 * 100));
    if (structural) trend -= 25;
    else if (belowNormal && recovering) trend += 15;
    else if (belowNormal && change24 > -0.05) trend += 5;
    if (volatility != null) trend -= Math.max(0, Math.min(30, (volatility - 0.08) * 150));
    // Real sale prices over 72 h (FUTBIN); older cached checks only have the day-vs-day trend.
    if (fbState) trend += { downLong: -25, down: -12, stable: 5, recovering: 10, up: 5 }[fbState];
    else if (fb && !fh && fb.trend != null) trend += fb.trend <= -0.05 ? -15 : fb.trend >= 0.03 ? 5 : 0;
    if (fbState === "recovering") positives.push("salesRecovering");
    trend = clamp100(trend);
    const direction = structural || fbState === "downLong" || change24 <= -0.05 || (change72 != null && change72 <= -0.1) ? "neg" : change24 >= 0.03 ? "pos" : "neutral";

    // E. Data reliability: snapshots, span, age of the last snapshot, real sales, hourly points today.
    let reliability = 0;
    if (hist) {
      reliability += Math.min(30, hist.samples / 48 * 30);
      reliability += Math.min(20, hist.spanMs / (24 * HOUR_MS) * 20);
      const age = Date.now() - hist.lastAt;
      reliability += age < 30 * 60000 ? 10 : age < 2 * HOUR_MS ? 5 : 0;
    }
    // Real sales: how many (72 h when known) and how many of the 72 hours the sales data covers.
    if (fb) reliability += fh ? Math.min(20, fh.sales72 / 15 * 20) + Math.min(10, fh.coverH / 72 * 10) : Math.min(25, fb.salesInBase / 10 * 25) + 5;
    reliability += Math.min(10, today.length / 12 * 10);
    reliability = clamp100(reliability);

    const part = value => (value == null ? OPP_MISSING : value);
    let score = OPP_WEIGHTS.price * part(price) + OPP_WEIGHTS.profit * profit + OPP_WEIGHTS.liquidity * part(liquidity)
      + OPP_WEIGHTS.trend * trend + OPP_WEIGHTS.reliability * reliability;
    const caps = [];
    // caps/missing/warnings/dip are codes; the table shows them in your language (cap_*, miss_*, ow_*, dip_*).
    const cap = (max, why) => { if (score > max) { score = max; caps.push(why); } };
    if (net <= 0) cap(25, "noProfit");
    else if (calc.status === "skip") cap(25, "underMin");
    else if (netNow <= 0) cap(35, "tooExpensive");
    if (fbState === "downLong") cap(50, "fbDownLong");
    if (calc.risky) cap(60, "risky");
    if (reliability < 40) cap(55, "lowData");
    const restless = volatility != null && volatility > 0.2;
    if (restless) cap(65, "restless");
    if (!fb) cap(69, "noSales");
    score = Math.round(score);
    const warnings = [];
    if (reliability < 40) warnings.push("lowData");
    if (restless) warnings.push("restless");
    if (direction === "neg" && fbState !== "downLong") warnings.push(structural ? "structural" : "negTrend");
    return {
      score,
      level: score >= 70 ? "high" : score >= 45 ? "mid" : "low",
      parts: { price, profit, liquidity, trend, reliability },
      missing, caps, warnings, direction,
      dip: belowNormal ? (structural ? "structural" : recovering ? "recovering" : "below") : "",
      // Which data was really used (shown under the score in the details).
      sources: {
        fodder: useHist ? { kind: "history", spanMs: hist.spanMs } : today.length ? { kind: "today", hours: today.length } : null,
        futbin: fb ? (fh ? { kind: "h72", hours: fh.coverH, sales: fh.sales72, days: fh.dailyDays } : { kind: "basic", window: fb.window }) : null
      },
      positives, fbState, fh,
      net, roi, netNow, roiNow, volatility, change24, change72, hist
    };
  }

  // Score per row, highest first (no score, e.g. console: after the scored ones, by signal).
  function rankFlipOpportunities(rows, platform) {
    return rows
      .map(row => ({ ...row, opp: calculateOpportunityScore(row.card, row.calc, platform) }))
      .sort((a, b) => (b.opp ? b.opp.score : -1) - (a.opp ? a.opp.score : -1)
        || FLIP_ORDER[a.calc.status] - FLIP_ORDER[b.calc.status] || b.calc.pct - a.calc.pct);
  }

  // FUT.GG momentum cards: the same five parts, but "normal" comes from FUTBIN's real sales of the last
  // 72 h (median per 24 h, P10..P90) instead of the fodder.gg history; FUT.GG adds the dip (24 h) and the
  // timing (6 h). Without a FUTBIN check there is no score (null = ❔). Works for PC and console.
  function calculateMomentumScore(card, calc) {
    const fb = calc.futbin;
    if (!fb) return null;
    const fh = fb.h72 || null;
    const fbState = fh ? fh.state : null;
    const now = card.now;
    const missing = [];
    const positives = [];
    // A. Price position: now vs the real sale prices of the last 72 h.
    const winMedians = fh ? fh.windows.map(w => w.median).filter(value => value > 0) : [];
    const normal = winMedians.length ? median(winMedians) : fb.median;
    let price = null;
    if (normal > 0) {
      const sMedian = clamp100(50 - (now / normal - 1) * 500); // −10% → 100, +10% → 0
      const sRange = fb.p90 > fb.p10 ? clamp100((1 - (now - fb.p10) / (fb.p90 - fb.p10)) * 100) : 50;
      price = 0.65 * sMedian + 0.35 * sRange;
      if (fbState === "downLong") price = Math.min(price, 40);
      else if (fbState === "down") price = Math.min(price, 60);
      else if ((fbState === "stable" || fbState === "recovering") && price >= 60) {
        price = Math.min(100, price + 10);
        positives.push("cheapStable");
      }
    } else missing.push("price");
    // B. Profit (FUTBIN P10/P75, 5% tax), scored on what you pay now; selling at the median should pay too.
    const net = Math.floor(calc.sell * (1 - EA_TAX)) - calc.buy;
    const roi = calc.buy > 0 ? net / calc.buy * 100 : 0;
    const buyNow = Math.max(calc.buy, now);
    const netNow = Math.floor(calc.sell * (1 - EA_TAX)) - buyNow;
    const roiNow = buyNow > 0 ? netNow / buyNow * 100 : 0;
    let profit = 0;
    if (net > 0 && netNow > 0 && buyNow > 0) {
      const roiMedian = (fb.median * (1 - EA_TAX) - buyNow) / buyNow * 100;
      profit = 0.5 * clamp100(roiNow / 12 * 100) + 0.2 * clamp100(netNow / 15000 * 100) + 0.3 * clamp100((roiMedian + 2) / 8 * 100);
    }
    // C. Liquidity: real sales per 24 h, sell-through, demand over 72 h.
    let liquidity = clamp100(fb.sales24 / 15 * 100);
    if (fb.listings24 >= 3) liquidity = 0.65 * liquidity + 0.35 * clamp100(fb.sellThrough / 0.4 * 100);
    if (fh && fh.demand === "falling") liquidity *= 0.75;
    else if (fh && fh.demand === "rising") liquidity = Math.min(100, liquidity * 1.1);
    if (!fbState) missing.push("fbHistory");
    // D. Trend & timing: real sale prices over 72 h (FUTBIN) + FUT.GG 6 h (still falling / turning).
    const volatility = normal > 0 && fb.p90 > fb.p10 ? (fb.p90 - fb.p10) / normal : null;
    let trend = 60;
    if (fbState) trend += { downLong: -25, down: -12, stable: 5, recovering: 10, up: 5 }[fbState];
    else if (fb.trend != null) trend += fb.trend <= -0.05 ? -15 : fb.trend >= 0.03 ? 5 : 0;
    if (fh && fh.vs24 != null) trend += Math.max(-15, Math.min(10, fh.vs24 * 150));
    if (calc.move === "turning") { trend += 15; positives.push("turning"); }
    else if (calc.move === "falling") trend -= 20;
    if (volatility != null) trend -= Math.max(0, Math.min(30, (volatility - 0.15) * 100));
    if (fbState === "recovering") positives.push("salesRecovering");
    trend = clamp100(trend);
    // E. Reliability: how many real sales, how much of the 72 h they cover, daily data, age of the check.
    let reliability = fh ? Math.min(40, fh.sales72 / 15 * 40) + Math.min(25, fh.coverH / 72 * 25) + (fh.dailyDays >= 14 ? 10 : 0)
      : Math.min(40, fb.salesInBase / 10 * 40);
    if (card.m6 != null) reliability += 10;
    reliability += Date.now() - fb.fetchedAt < 30 * 60000 ? 15 : 5;
    reliability = clamp100(reliability);

    let score = OPP_WEIGHTS.price * (price == null ? OPP_MISSING : price) + OPP_WEIGHTS.profit * profit
      + OPP_WEIGHTS.liquidity * liquidity + OPP_WEIGHTS.trend * trend + OPP_WEIGHTS.reliability * reliability;
    const caps = [];
    const cap = (max, why) => { if (score > max) { score = max; caps.push(why); } };
    if (net <= 0) cap(25, "noProfit");
    else if (calc.status === "skip") cap(25, "underMin");
    else if (netNow <= 0) cap(35, "tooExpensive");
    if (fbState === "downLong") cap(50, "fbDownLong");
    if (calc.risky) cap(60, "risky");
    if (reliability < 40) cap(55, "lowData");
    const restless = volatility != null && volatility > 0.35;
    if (restless) cap(65, "restless");
    score = Math.round(score);
    const warnings = [];
    if (reliability < 40) warnings.push("lowData");
    if (restless) warnings.push("restless");
    return {
      score,
      level: score >= 70 ? "high" : score >= 45 ? "mid" : "low",
      parts: { price, profit, liquidity, trend, reliability },
      missing, caps, warnings, direction: calc.move === "falling" || fbState === "downLong" ? "neg" : calc.move === "turning" ? "pos" : "neutral",
      dip: "",
      sources: {
        futgg: { m24: card.m24, m6: card.m6 },
        futbin: fh ? { kind: "h72", hours: fh.coverH, sales: fh.sales72, days: fh.dailyDays } : { kind: "basic", window: fb.window }
      },
      positives, fbState, fh, normal,
      net, roi, netNow, roiNow, volatility, change24: card.m24 / 100, change72: null, hist: null
    };
  }

  // Momentum rows with their score: scored (checked) cards highest first, then the rest by biggest dip.
  function rankMomentum(rows, bySignal) {
    return rows
      .map(row => ({ ...row, opp: calculateMomentumScore(row.card, row.calc) }))
      .sort((a, b) => (bySignal ? FLIP_ORDER[a.calc.status] - FLIP_ORDER[b.calc.status] : 0)
        || (b.opp ? b.opp.score : -1) - (a.opp ? a.opp.score : -1) || a.card.m24 - b.card.m24);
  }

  function formatSpan(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(minutes / 60);
    const h = flipLang() === "en" ? "h" : "u";
    return hours ? `${hours}${h}${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`;
  }

  // --- FUTBIN sales for flip cards ------------------------------------------------------------------
  // fodder.gg's low/avg/high come from listings (what people ask). FUTBIN's sales page lists every
  // auction with "Sold for" (0 = unsold), so P10/P75 of real sales give a buy/sell that actually trade.
  // EA card → FUTBIN page: FUTBIN's search rows show the card image with the exact EA id (specials:
  // players/p<eaId>.png) or the base id (regular/icons: players/<baseId>.png, "Holo" in the row text).
  // Only on your click (or a new 🟢 with 🔔 on): one card at a time, 2.5–4 s apart, cached.
  const FUTBIN_IDS_KEY = "pt_futbin_ids_v1"; // { eaId: "/27/player/23024/andrei-ratiu" }
  const FUTBIN_SALES_KEY = "pt_futbin_sales_v1"; // { "eaId|pc": stats }
  // A check is used for 3 hours (its 24-72 h sales hardly move in that time; "now" comes fresh from the
  // sheet/FUT.GG anyway) and counts as "to refresh" after 45 min: the auto rounds take never-checked
  // cards first, then the oldest checks.
  const FUTBIN_FRESH_MS = 3 * 60 * 60 * 1000;
  const FUTBIN_REFRESH_MS = 45 * 60 * 1000;
  const FUTBIN_BATCH_MAX = 30;
  const futbinState = { busy: false, done: 0, total: 0, error: "", stop: false };

  // Parsed once per key and kept in memory (flipCalc reads it for every row on every render).
  const futbinCache = {};
  function futbinStore(key) {
    if (!futbinCache[key]) {
      try { futbinCache[key] = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (_) { futbinCache[key] = {}; }
    }
    return futbinCache[key];
  }
  function futbinSave(key, value) {
    futbinCache[key] = value;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* memory only */ }
  }
  const futbinPlatform = platform => (platform === "pc" ? "pc" : "ps");

  function futbinSalesFor(card, platform) {
    const entry = futbinStore(FUTBIN_SALES_KEY)[`${card.id}|${futbinPlatform(platform)}`];
    return entry && Date.now() - entry.fetchedAt < FUTBIN_FRESH_MS ? entry : null;
  }

  // Version of the stored analysis: a check made by an older version (e.g. without the 72 h data of v2) is
  // still shown and used until it expires, but counts as "to check again" for 📊 and for the 🔔 alert.
  const FUTBIN_STATS_VERSION = 2;
  // Days a card has been on the market by FUTBIN (daily averages, or the first sale when FUTBIN has every
  // sale). 0 = not new (3+ days, or unknown). New cards (TOTW, new content) still find their price.
  const FUTBIN_YOUNG_DAYS = 2;
  function futbinYoung(stats) {
    const fh = stats && stats.h72;
    if (!fh) return 0;
    const DAY = 24 * 60 * 60 * 1000;
    let days = fh.dailyDays > 0 ? fh.dailyDays : 0;
    if (fh.liveSince && fh.liveCount < FUTBIN_LIVE_CAP) {
      const sinceFirst = Math.max(1, Math.ceil((Date.now() - fh.liveSince) / DAY));
      days = days ? Math.min(days, sinceFirst) : sinceFirst;
    }
    return days > 0 && days <= FUTBIN_YOUNG_DAYS ? days : 0;
  }

  function futbinNeedsCheck(card, platform, refreshMs = FUTBIN_REFRESH_MS) {
    const entry = futbinSalesFor(card, platform);
    return !entry || entry.v !== FUTBIN_STATS_VERSION || Date.now() - entry.fetchedAt >= refreshMs;
  }
  // Auto rounds refresh only what matters every 45 min (🟢/🟡/🟠, ↩ turning, score 60+); every other card
  // after 2.5 h (a check counts 3 h, so there is never a gap). Then the rounds run dry and stay quiet.
  const FUTBIN_REFRESH_LOW_MS = 150 * 60 * 1000;
  const futbinImportant = row => ["buy", "near", "risk"].includes(row.calc.status) || row.calc.move === "turning" || !!(row.opp && row.opp.score >= 60);
  const futbinAutoDue = (row, platform) => futbinNeedsCheck(row.card, platform, futbinImportant(row) ? FUTBIN_REFRESH_MS : FUTBIN_REFRESH_LOW_MS);

  function futbinHtml(url) {
    return futggRequestJson(url, true).then(text => new DOMParser().parseFromString(text, "text/html"));
  }

  // Search the player's name; remember every exact EA id seen on the way (other versions too).
  async function futbinPathFor(card) {
    const ids = futbinStore(FUTBIN_IDS_KEY);
    if (ids[card.id]) return ids[card.id];
    const baseId = card.id & 0xFFFFFF;
    const plain = text => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s-]/g, "");
    const words = card.name.split(/\s+/);
    const queries = [...new Set([card.name, words[words.length - 1], plain(words[words.length - 1])])];
    for (const query of queries) {
      const doc = await futbinHtml(`https://www.futbin.com/players?search=${encodeURIComponent(query)}`);
      let found = null;
      doc.querySelectorAll("tr.player-row").forEach(row => {
        const link = row.querySelector('a[href*="/player/"]');
        if (!link) return;
        const path = link.getAttribute("href").replace(/^https?:\/\/[^/]+/, "");
        const html = row.innerHTML;
        const exact = [...html.matchAll(/\/players\/p(\d+)\.png/g)].map(m => Number(m[1]));
        const base = [...html.matchAll(/\/players\/(\d+)\.png/g)].map(m => Number(m[1]));
        const text = row.textContent.replace(/\s+/g, " ").trim();
        const rating = Number((text.match(/^\d{2}/) || [])[0]) || 0;
        const holo = /\bholo\b/i.test(text) || /holo-animation/.test(html);
        exact.forEach(id => { ids[id] = path; });
        if (exact.includes(card.id)) found = path;
        else if (!found && !exact.length && base.includes(baseId) && holo === card.holo && (!rating || rating === card.rating)) found = path;
      });
      if (found) {
        ids[card.id] = found;
        futbinSave(FUTBIN_IDS_KEY, ids);
        return found;
      }
      futbinSave(FUTBIN_IDS_KEY, ids);
      await new Promise(resolve => window.setTimeout(resolve, 1500 + Math.random() * 1000));
    }
    return null;
  }

  const FUTBIN_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  function futbinDate(text) {
    const match = String(text).trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match || FUTBIN_MONTHS[match[1]] == null) return 0;
    let hour = Number(match[3]) % 12;
    if (match[5].toUpperCase() === "PM") hour += 12;
    const now = new Date();
    const date = new Date(now.getFullYear(), FUTBIN_MONTHS[match[1]], Number(match[2]), hour, Number(match[4]));
    if (date.getTime() > now.getTime() + 2 * 86400000) date.setFullYear(date.getFullYear() - 1);
    return date.getTime();
  }

  function futbinPct(sorted, p) {
    if (!sorted.length) return 0;
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
  }

  // Real sales only; one-off sales far from the middle are dropped before the percentiles (10/90 idea).
  function futbinWindow(rows, from, to) {
    const inWindow = rows.filter(row => row.at >= from && row.at < to);
    const raw = inWindow.filter(row => row.sold > 0).map(row => row.sold).sort((a, b) => a - b);
    const mid = futbinPct(raw, 0.5);
    const odd = value => raw.length >= 5 && (value < mid * 0.75 || value > mid * 1.35);
    const sorted = raw.filter(value => !odd(value));
    return {
      listings: inWindow.length,
      sales: raw.length,
      outliers: raw.filter(odd),
      p10: futbinPct(sorted, 0.1), p25: futbinPct(sorted, 0.25), median: futbinPct(sorted, 0.5), p75: futbinPct(sorted, 0.75), p90: futbinPct(sorted, 0.9)
    };
  }

  // --- 72 h of real FUTBIN sales, from the same sales page (no extra request) -------------------------
  // Next to the auctions table (last ~500 auctions, sold or not) the page carries two charts per platform:
  // "live" = the last 500 real sales with exact times (the same sales as the table's "Sold for", but they
  // reach further back) and "daily" = the average sale price per full day (~7 weeks). Only the chart of
  // the requested platform is read (PC for PC). A 24 h window counts only when the data really reaches
  // back that far; otherwise it is unknown (null), never "0 sales".
  const FUTBIN_LIVE_CAP = 500;
  function futbinCharts(doc, platform) {
    const charts = {};
    doc.querySelectorAll(".sales-graph-wrapper").forEach(wrapper => {
      const kind = wrapper.classList.contains("live") ? "live" : wrapper.classList.contains("daily") ? "daily" : "";
      if (!kind || !wrapper.classList.contains(futbinPlatform(platform))) return;
      const script = wrapper.querySelector("script");
      const text = script ? script.textContent : "";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return;
      try {
        const config = JSON.parse(text.slice(start, end + 1));
        const data = config.series && config.series[0] && Array.isArray(config.series[0].data) ? config.series[0].data : [];
        charts[kind] = data.map(point => [Number(point.x), Number(point.y)])
          .filter(([x, y]) => x > 0 && y > 0).sort((a, b) => a[0] - b[0]);
      } catch (_) { /* this chart is left out */ }
    });
    return charts;
  }

  // Windows 0–24 h, 24–48 h and 48–72 h back from now: sales count and median sale price (live chart),
  // listings and sell-through (table); then the course of the real sale prices and of demand.
  function futbinHistory72(doc, platform, rows, now) {
    const charts = futbinCharts(doc, platform);
    const live = charts.live || [];
    const daily = charts.daily || [];
    if (!live.length && !daily.length) return null;
    const H = 60 * 60 * 1000;
    const complete = live.length > 0 && live.length < FUTBIN_LIVE_CAP; // fewer than 500: every sale FUTBIN has
    const oldest = live.length ? live[0][0] : now;
    const middle = values => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = futbinPct(sorted, 0.5);
      const kept = sorted.length >= 5 ? sorted.filter(value => value >= mid * 0.75 && value <= mid * 1.35) : sorted;
      return kept.length >= 3 ? futbinPct(kept, 0.5) : null;
    };
    // Table times are read as local time: its windows are counted back from its own newest row.
    const tableEnd = rows.length ? Math.max(...rows.map(row => row.at)) + 60000 : 0;
    const tableOldest = rows.length ? Math.min(...rows.map(row => row.at)) : Infinity;
    const windows = [0, 1, 2].map(k => {
      const from = now - (k + 1) * 24 * H;
      const to = now - k * 24 * H;
      const covered = live.length > 0 && (complete || oldest <= from);
      // Partly covered (busy card, 500 sales reach back into this window): its sale prices are real and
      // count for the median (≥ 5 sales), but the number of sales is incomplete, so that stays unknown.
      const partial = !covered && live.length > 0 && oldest < to;
      const prices = covered || partial ? live.filter(([x]) => x >= from && x < to).map(point => point[1]) : [];
      const tableFrom = tableEnd - (k + 1) * 24 * H;
      const inTable = rows.filter(row => row.at >= tableFrom && row.at < tableEnd - k * 24 * H);
      const tableCovered = rows.length > 0 && tableOldest <= tableFrom;
      return {
        covered,
        partial,
        sales: covered ? prices.length : null,
        median: covered || (partial && prices.length >= 5) ? middle(prices) : null,
        listings: tableCovered ? inTable.length : null,
        sellThrough: tableCovered && inTable.length ? inTable.filter(row => row.sold > 0).length / inTable.length : null
      };
    });
    const [w0, w1, w2] = windows;
    const ratio = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);
    const vs24 = ratio(w0.median, w1.median); // last 24 h vs the 24 h before
    const older = w1.median != null ? middle(live.filter(([x]) => x >= now - 72 * H && x < now - 24 * H).map(point => point[1])) : null;
    const vs48 = ratio(w0.median, older); // last 24 h vs the 48 h before
    const step = ratio(w1.median, w2.median); // 24–48 h vs 48–72 h
    const before = w1.covered && w2.covered ? (w1.sales + w2.sales) / 2 : w1.covered ? w1.sales : null;
    const volume = w0.covered && before != null && before >= 2 ? w0.sales / before - 1 : null;
    // Daily averages (full days only): days in a row lower than the day before, and last week vs the week before.
    let daysDown = 0;
    for (let i = daily.length - 1; i > 0 && daily[i][1] < daily[i - 1][1] * 0.99; i--) daysDown++;
    const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
    const week = daily.length >= 14 ? mean(daily.slice(-7).map(point => point[1])) / mean(daily.slice(-14, -7).map(point => point[1])) - 1 : null;
    const dailyLong = daysDown >= 3 && week != null && week <= -0.08;
    let state = null; // null = too few sales or too little data (unknown, not negative)
    if (w0.median != null && w1.median != null) {
      const longDown = (step != null && vs24 <= -0.02 && step <= -0.02 && ratio(w0.median, w2.median) <= -0.06)
        || dailyLong
        || (vs48 != null && vs48 <= -0.1 && volume != null && volume <= -0.3);
      if (longDown) state = "downLong";
      else if (vs24 <= -0.05 || (vs48 != null && vs48 <= -0.06)) state = "down";
      else if (step != null && step <= -0.03 && vs24 >= 0.02) state = "recovering";
      else if (vs24 >= 0.05) state = "up";
      else state = "stable";
    } else if (dailyLong) {
      state = "downLong"; // too few recent sales, but the daily averages clearly keep falling
    }
    return {
      coverH: live.length ? Math.min(72, complete ? 72 : Math.max(0, (now - oldest) / H)) : 0,
      liveCount: live.length,
      liveSince: live.length ? oldest : null,
      dailyDays: daily.length,
      windows, vs24, vs48, step, volume, week, daysDown, state,
      demand: volume == null ? null : volume <= -0.4 ? "falling" : volume >= 0.4 ? "rising" : "steady",
      salesBefore: before,
      sales72: windows.reduce((sum, w) => sum + (w.sales || 0), 0)
    };
  }

  function futbinAnalyse(doc, platform = "pc", now = Date.now()) {
    const rows = [...doc.querySelectorAll("table.auctions-table tbody tr")].map(tr => {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 3) return null;
      const dateEl = tr.querySelector(".sales-date-time") || cells[0];
      const value = cell => Number(String(cell.textContent).replace(/[^\d]/g, "")) || 0;
      return { at: futbinDate(dateEl.textContent), listed: value(cells[1]), sold: value(cells[2]) };
    }).filter(row => row && row.at && row.listed);
    if (!rows.length) return null;
    const newest = Math.max(...rows.map(row => row.at));
    const oldest = Math.min(...rows.map(row => row.at));
    const end = newest + 60000;
    const day = futbinWindow(rows, end - 86400000, end);
    const prev = futbinWindow(rows, end - 2 * 86400000, end - 86400000);
    const twoDays = futbinWindow(rows, end - 2 * 86400000, end);
    const base = day.sales >= 5 ? day : twoDays;
    return {
      window: day.sales >= 5 ? "24u" : "48u",
      sales24: day.sales,
      listings24: day.listings,
      sellThrough: day.listings ? day.sales / day.listings : 0,
      salesPerDay: rows.filter(row => row.sold > 0).length / Math.max(1, (newest - oldest) / 86400000),
      trend: day.sales >= 3 && prev.sales >= 3 && prev.median ? day.median / prev.median - 1 : null,
      p10: base.p10, p25: base.p25, median: base.median, p75: base.p75, p90: base.p90,
      outliers: base.outliers,
      salesInBase: base.sales,
      newest,
      h72: futbinHistory72(doc, platform, rows, now)
    };
  }

  async function futbinCheckCard(card, platform) {
    const path = await futbinPathFor(card);
    if (!path) return { notFound: true };
    await new Promise(resolve => window.setTimeout(resolve, 1200 + Math.random() * 800));
    const salesPath = path.replace("/player/", "/sales/");
    const doc = await futbinHtml(`https://www.futbin.com${salesPath}?platform=${futbinPlatform(platform)}`);
    const stats = futbinAnalyse(doc, platform);
    if (!stats) return { notFound: true };
    const store = futbinStore(FUTBIN_SALES_KEY);
    // Keep the store small: drop entries older than a day.
    Object.keys(store).forEach(key => { if (Date.now() - store[key].fetchedAt > 86400000) delete store[key]; });
    store[`${card.id}|${futbinPlatform(platform)}`] = { ...stats, v: FUTBIN_STATS_VERSION, path: salesPath, fetchedAt: Date.now() };
    futbinSave(FUTBIN_SALES_KEY, store);
    return stats;
  }

  // Check cards one by one (cached ones skipped); stops on the first FUTBIN error (blocked/rate limit).
  // options: { max } = how many at most (default 30), { calm } = longer pauses (5-8 s) for big auto rounds,
  // { force } = check again even when the stored check is still recent.
  // Returns { done, error } of this round only (an old error from an earlier round never counts again).
  async function futbinCheckCards(cards, platform, quiet, options = {}) {
    if (futbinState.busy) return { done: 0, error: "", busy: true };
    if (!quiet) futbinAutoPause = 0; // checking by hand = you want FUTBIN now: the auto pause ends too
    // options.force: 🔁 recheck, also cards that were checked a moment ago.
    const todo = (options.force ? cards : cards.filter(card => futbinNeedsCheck(card, platform))).slice(0, options.max || FUTBIN_BATCH_MAX);
    if (!todo.length) {
      if (!quiet) showToast(ft("fbAllFresh"), true);
      return { done: 0, error: "" };
    }
    Object.assign(futbinState, { busy: true, done: 0, total: todo.length, error: "", stop: false });
    listeners.forEach(listener => listener());
    const missing = [];
    try {
      for (const card of todo) {
        if (futbinState.stop) break;
        const result = await futbinCheckCard(card, platform);
        if (result && result.notFound) missing.push(card.name);
        futbinState.done++;
        listeners.forEach(listener => listener());
        await new Promise(resolve => window.setTimeout(resolve, options.calm ? 5000 + Math.random() * 3000 : 2500 + Math.random() * 1500));
      }
    } catch (error) {
      futbinState.error = error && error.message ? error.message : String(error);
    } finally {
      futbinState.busy = false;
      listeners.forEach(listener => listener());
    }
    if (futbinState.error) showToast(ft("fbStopped", { error: futbinState.error }), false);
    else showToast(ft(quiet ? "fbAutoDone" : "fbDone", { n: futbinState.done }) + (missing.length ? ft("fbMissing", { list: missing.join(", ") }) : ""), !missing.length);
    // An auto round that had to wait for this one (e.g. momentum fetched while the fodder round ran).
    if (futbinAutoWaiting.size) {
      const source = [...futbinAutoWaiting][0];
      futbinAutoWaiting.delete(source);
      window.setTimeout(() => futbinAutoTop(source).catch(error => console.warn(L("Price Watch: FUTBIN auto-check mislukt.", "Price Watch: FUTBIN auto-check failed."), error)), 3000);
    }
    return { done: futbinState.done, error: futbinState.error };
  }

  // Auto (pc with FUT Genie only): after every fetched list a round over the cards whose FUTBIN check is
  // missing or older than 45 min, most important first. Both lists are fetched in the background (fodder.gg
  // every 10 min, FUT.GG every 15 min) while the web app is open, so in time every card of both lists is
  // checked (a check is used for 3 h): 40 per round for both lists, with calm pauses (5-8 s).
  const FUTBIN_AUTO_TOP = 40;
  // FUT.GG momentum: 40 per round with calm pauses (about 6-10 min, well inside the 15-min refresh), in
  // order: turning first (what you can act on), then dips without a label, still-falling cards last.
  const MOMENTUM_AUTO_TOP = 40;
  const MOMENTUM_AUTO_ORDER = { turning: 0, none: 1, falling: 2 };
  let futbinAutoPause = 0;
  const futbinAutoWaiting = new Set(); // sources of auto rounds that wait for the running round
  async function futbinAutoTop(source) {
    const state = getFlip();
    if (!state.autoFutbin || !pcDevice()) return;
    if (futbinState.busy) { futbinAutoWaiting.add(source); return; } // runs right after the current round
    let cards;
    if (source === "futgg") {
      // FUT.GG momentum: the biggest 24h dips (within your max price) - FUTBIN then says if it's a real deal.
      // Every card of the list (within your max price) gets its turn: turning dips, other dips, still
      // falling, risers, then cards FUTBIN already called no profit; within each, never checked first.
      const group = row => (row.calc.status === "skip" ? 4 : row.card.m24 >= 0 ? 3 : MOMENTUM_AUTO_ORDER[row.calc.move || "none"]);
      cards = rankMomentum(momentumRows(state), false).filter(row => futbinAutoDue(row, state.platform))
        .sort((a, b) => group(a) - group(b)
          || (a.calc.futbin ? 1 : 0) - (b.calc.futbin ? 1 : 0) // never checked first, then the old checks
          || a.card.m24 - b.card.m24)
        .slice(0, MOMENTUM_AUTO_TOP).map(row => row.card);
    } else {
      if (!flipData || flipData.token !== state.token) return;
      // Every card of the list: by score, cards without profit (by the sheet) last; never checked first.
      cards = rankFlipOpportunities(flipRows(flipData, state), state.platform)
        .filter(row => futbinAutoDue(row, state.platform))
        .sort((a, b) => (a.calc.status === "skip" ? 1 : 0) - (b.calc.status === "skip" ? 1 : 0)
          || (a.calc.futbin ? 1 : 0) - (b.calc.futbin ? 1 : 0)) // stable: keeps the score order inside
        .slice(0, FUTBIN_AUTO_TOP)
        .map(row => row.card);
    }
    if (!cards.length || Date.now() < futbinAutoPause) return;
    const result = await futbinCheckCards(cards, state.platform, true, { max: source === "futgg" ? MOMENTUM_AUTO_TOP : FUTBIN_AUTO_TOP, calm: true });
    // Only an error in THIS round pauses the auto check: blocked / rate limit (403, 429, Cloudflare) for an
    // hour, anything else (time-out, network) for 10 minutes. Clicking 📊 yourself ends the pause.
    if (result && result.error) {
      const blocked = /HTTP (403|429)|cloudflare|captcha/i.test(result.error);
      futbinAutoPause = Date.now() + (blocked ? 60 : 10) * 60 * 1000;
      showToast(ft("fbAutoPaused", { time: formatTime(futbinAutoPause) }), false);
      listeners.forEach(listener => listener());
    }
  }

  // --- FUT.GG Momentum Trends: second source of the Flip tab (switch fodder.gg <-> FUT.GG) -----------
  // FUT.GG's public momentum list (special cards only, like "Only Special Cards" on the site): per card
  // the price change over 24 h and over 6 h and FUT.GG's current price, for PC or console. The list is
  // always sorted risers -> fallers, so all pages are read (about 18 x 30 cards, one by one). 24 h compares
  // with the same hour yesterday (the day/night rhythm cancels out) = is it a real dip; 6 h = is it still
  // falling or turning. Buy/sell come only from real FUTBIN sales (P10/P75), never from FUT.GG; without a
  // FUTBIN check a card has no buy/sell. Kept apart from fodder.gg (own list, no history/score).
  const MOMENTUM_KEY = "pt_flip_momentum_v1";
  const MOMENTUM_REFRESH_MS = 15 * 60 * 1000;
  const MOMENTUM_MAX_PAGES = 40;
  const MOMENTUM_EXCLUDED = "9,8,6,5,3,2"; // bronze/silver/gold common + rare = "Only Special Cards"
  let momentumData = null; // { pc: { at, cards }, console: { at, cards } }
  try { momentumData = JSON.parse(localStorage.getItem(MOMENTUM_KEY) || "null"); } catch (_) { momentumData = null; }
  let momentumLoading = null;
  let momentumError = "";
  let momentumPages = 0;

  function momentumCard(item) {
    const name = item.commonName || `${item.firstName || ""} ${item.lastName || ""}`.trim() || item.cardName || "?";
    return {
      id: Number(item.eaId) || 0,
      name,
      rating: Number(item.overall) || 0,
      rarity: item.rarityName || "",
      holo: false,
      now: Number(item.currentDbPrice) || 0,
      m24: null,
      m6: null,
      url: typeof item.url === "string" && item.url.startsWith("/players/") ? item.url : "",
      trend: [],
      src: "futgg"
    };
  }

  async function momentumFetch(hours, platform, into) {
    let page = 1;
    while (page && page <= MOMENTUM_MAX_PAGES) {
      const url = `https://www.fut.gg/api/fut/players/v2/momentum/${hours}/?game=27&platform=${platform === "pc" ? "pc" : "ps"}` +
        `&excluded_quality_id=${encodeURIComponent(MOMENTUM_EXCLUDED)}&page=${page}`;
      const json = await futggRequestJson(url);
      (Array.isArray(json && json.data) ? json.data : []).forEach(item => {
        const id = Number(item.eaId) || 0;
        if (!id || item.isSbc || item.isObjective) return;
        const card = into.get(id) || momentumCard(item);
        const value = item.momentumPercentage;
        card[hours === 24 ? "m24" : "m6"] = typeof value === "number" && Number.isFinite(value) ? value : null;
        into.set(id, card);
      });
      momentumPages++;
      listeners.forEach(listener => listener());
      page = json && json.next ? Number(json.next) : 0;
      if (page) await new Promise(resolve => window.setTimeout(resolve, 400 + Math.random() * 400));
    }
  }

  function loadMomentum(force) {
    const state = getFlip();
    if (momentumLoading) return momentumLoading;
    const current = momentumData && momentumData[state.platform];
    if (!force && current && Date.now() - current.at < MOMENTUM_REFRESH_MS) return Promise.resolve(false);
    const platform = state.platform;
    momentumError = "";
    momentumPages = 0;
    momentumLoading = (async () => {
      const cards = new Map();
      await momentumFetch(24, platform, cards);
      await momentumFetch(6, platform, cards);
      const list = [...cards.values()].filter(card => card.now > 0 && card.m24 != null);
      if (!list.length) throw new Error(ft("mEmptyFetch"));
      momentumData = { ...(momentumData || {}), [platform]: { at: Date.now(), cards: list } };
      try { localStorage.setItem(MOMENTUM_KEY, JSON.stringify(momentumData)); } catch (_) { /* memory only */ }
      futbinAutoTop("futgg").catch(error => console.warn(L("Price Watch: FUTBIN auto-check (momentum) mislukt.", "Price Watch: FUTBIN auto-check (momentum) failed."), error));
      return true;
    })()
      .catch(error => {
        momentumError = error && error.message ? error.message : String(error);
        return false;
      })
      .finally(() => {
        momentumLoading = null;
        listeners.forEach(listener => listener());
      });
    listeners.forEach(listener => listener());
    return momentumLoading;
  }

  // Auto check on: both lists are fetched in the background on the pc (not only the one you look at), so
  // the FUTBIN rounds cover both. Fetching itself only happens when a list is due (10 / 15 min).
  window.setInterval(() => {
    try {
      const state = getFlip();
      if (!state.autoFutbin || !pcDevice()) return;
      if (state.token) loadFlipSheet(false);
      loadMomentum(false);
    } catch (error) {
      console.warn(L("Price Watch: achtergrond-verversing mislukt.", "Price Watch: background refresh failed."), error);
    }
  }, 60 * 1000);

  // Buy/sell from FUTBIN only; the momentum decides the label: "still falling" (6 h <= -2%) counts as risky,
  // "turning" (24 h <= -3% and 6 h >= 0) is the moment to look for.
  function momentumCalc(card, platform) {
    const falling = card.m6 != null && card.m6 <= -2;
    const turning = !falling && card.m24 != null && card.m24 <= -3 && card.m6 != null && card.m6 >= 0;
    const move = falling ? "falling" : turning ? "turning" : null;
    const warnings = [];
    if (falling) warnings.push(ft("w_mFalling", { pct: flipPct(card.m6, 1) }));
    const futbin = futbinSalesFor(card, platform);
    if (!futbin || futbin.salesInBase < 3) {
      return { buy: 0, sell: 0, profit: 0, pct: 0, gap: 1, warnings: [ft("w_mNoFutbin"), ...warnings], status: "unk", risky: true, futbin: null, move };
    }
    const buy = roundDownToStep(futbin.p10);
    const sell = roundDownToStep(futbin.p75);
    let fbRisky = false;
    if (futbin.sales24 < 5) { warnings.push(ft("w_fewSales", { n: futbin.sales24 })); fbRisky = true; }
    const fh = futbin.h72;
    if (fh && fh.state === "downLong") { warnings.push(ft("w_fbDownLong")); fbRisky = true; }
    const youngDays = futbinYoung(futbin);
    if (youngDays) { warnings.unshift(ft("w_young", { days: youngDays })); fbRisky = true; }
    else if (futbin.trend != null && futbin.trend <= -0.05) { warnings.push(ft("w_saleFalling", { pct: flipPct(futbin.trend * 100) })); fbRisky = true; }
    if (fh && fh.demand === "falling") warnings.push(ft("w_fbDemand", { pct: flipPct(fh.volume * 100) }));
    if (futbin.listings24 >= 10 && futbin.sellThrough < 0.1) warnings.push(ft("w_lowSellThrough", { pct: `${Math.round(futbin.sellThrough * 100)}%` }));
    if (futbin.outliers.length) warnings.push(ft("w_outlierSale", { list: futbin.outliers.map(flipShort).join(", ") }));
    const profit = Math.floor(sell * (1 - EA_TAX)) - buy;
    const pct = buy > 0 ? profit / buy * 100 : 0;
    const gap = buy > 0 ? card.now / buy - 1 : 1;
    const risky = falling || fbRisky;
    const cheap = gap <= 0.06;
    const status = profit <= 0 ? "skip" : cheap && risky ? "risk" : gap <= 0.02 ? "buy" : cheap ? "near" : "wait";
    return { buy, sell, profit, pct, gap, warnings, status, risky, futbin, move };
  }

  // "Now" of a momentum card: FUT.GG's price index (the same PC feed as the Spelers tab, checked every
  // minute), exact card id only, so it moves between the 15-min list fetches. Console (no feed loaded)
  // and cards missing from the feed keep the price of the momentum list.
  function momentumNow(card, platform) {
    const live = futggPlatform === (platform === "pc" ? "pc" : "console") ? Number(futggPrices[String(card.id)]) : 0;
    return live > 0 ? { ...card, now: live, nowSrc: "index", listNow: card.now } : { ...card, nowSrc: "list", listNow: card.now };
  }

  // Momentum rows for the current platform, biggest 24 h dip first, with your max price and min profit.
  function momentumRows(state) {
    const set = momentumData && momentumData[state.platform];
    return (set ? set.cards : [])
      .map(card => momentumNow(card, state.platform))
      .map(card => ({ card, calc: momentumCalc(card, state.platform) }))
      .filter(row => !state.maxPrice || row.card.now <= state.maxPrice)
      .map(row => (row.calc.buy > 0 && row.calc.status !== "skip" && row.calc.pct < state.minPct ? { ...row, calc: { ...row.calc, status: "skip" } } : row))
      .sort((a, b) => a.card.m24 - b.card.m24);
  }

  let flipOnShow = () => {};
  let flipTimer = 0;

  // Calm layout: per row only what you need to decide (score, price, buy/sell, profit, trend);
  // everything else (score breakdown, fodder.gg prices, FUTBIN sales, all warnings) opens with a click
  // on the row. Settings (link, max price, min profit) and the explanation sit behind ⚙ and ?.
  // All texts come from FLIP_TEXT (ft) and are set on every render, so NL/EN switches at once.
  function buildFlipSection(root) {
    const card = el("div", "pt-watch-card pt-flip-card");
    root.appendChild(card);
    const toolbar = el("div", "pt-watch-toolbar");
    const heading = el("div", "pt-watch-heading");
    const status = el("div", "pt-watch-status");
    heading.append(el("h2", "pt-watch-title", "Flip sheet"), status);

    const button = (text, extra) => {
      const item = el("button", "pt-watch-refresh" + (extra ? ` ${extra}` : ""), text);
      item.type = "button";
      return item;
    };
    const platform = el("select", "pt-stock-select pt-mode-select");
    platform.append(new Option("PC", "pc"), new Option("Console", "console"));
    const sortSelect = el("select", "pt-stock-select pt-mode-select");
    sortSelect.append(new Option("", "score"), new Option("", "signal"));
    const dealsBox = el("label", "pt-goal");
    const onlyDeals = el("input");
    onlyDeals.type = "checkbox";
    const dealsText = el("span", "pt-muted");
    dealsBox.append(onlyDeals, dealsText);
    const refresh = button("↻");
    const alertButton = button("", "pt-flip-alert");
    alertButton.addEventListener("click", () => {
      unlockChime();
      update(state => { state.alert = !state.alert; });
      const on = getFlip().alert;
      showToast(ft(on ? "alertOnToast" : "alertOffToast"), true);
      if (on) loadFlipSheet(false);
    });
    const sourceSelect = el("select", "pt-stock-select pt-mode-select pt-flip-select");
    sourceSelect.append(new Option("", "fodder"), new Option("", "futgg"));
    sourceSelect.addEventListener("change", () => {
      update(state => { state.source = sourceSelect.value; });
      ticked.clear();
      expanded.clear();
      render();
      flipOnShow();
    });
    const futbinButton = button("");
    futbinButton.addEventListener("click", () => {
      if (futbinState.busy) { futbinState.stop = true; return; }
      const state = getFlip();
      const cards = state.source === "futgg"
        // momentum: nothing has a buy price before FUTBIN, so take the biggest dips (as shown)
        ? shown.filter(row => row.calc.status !== "skip" && row.card.m24 < 0).slice(0, FUTBIN_BATCH_MAX).map(row => row.card)
        : shown.filter(row => ["buy", "near", "risk"].includes(row.calc.status)).map(row => row.card);
      if (!cards.length) return showToast(ft("noCardsToCheck"), false);
      futbinCheckCards(cards, state.platform);
    });
    // 🔁 Recheck: the ticked cards again on FUTBIN, also when their check is recent (max 30 per click).
    const recheckButton = button("");
    recheckButton.addEventListener("click", () => {
      if (futbinState.busy) { futbinState.stop = true; return; }
      const cards = shown.filter(isTicked).map(row => row.card);
      if (!cards.length) return showToast(ft("tickFirst"), false);
      futbinCheckCards(cards, getFlip().platform, false, { force: true });
    });
    const runButton = button("", "pt-cycle-btn");
    const bidButton = button("", "pt-cycle-btn");
    const watchButton = button("");
    const settingsButton = button("⚙");
    const helpButton = button("?");
    const langButton = button("", "pt-flip-lang");
    langButton.addEventListener("click", () => {
      update(state => { state.lang = uiLang() === "en" ? "nl" : "en"; });
      showToast(L("Taal: Nederlands. De andere tabs wisselen mee als je Price Watch opnieuw opent.", "Language: English. The other tabs switch too when you reopen Price Watch."), true);
    });
    const controls = el("div", "pt-stock-list-buttons");
    // Tick many cards at once (instead of one by one): presets for the shown rows.
    const SELECTIONS = ["default", "deals", "profit", "top10", "top20", "all", "none"];
    const selectMenu = el("select", "pt-stock-select pt-mode-select pt-flip-select");
    selectMenu.append(new Option("", ""), ...SELECTIONS.map(key => new Option("", key)));
    selectMenu.addEventListener("change", () => {
      const key = selectMenu.value;
      selectMenu.value = "";
      if (key) applySelection(key);
    });
    // Layout C ("pro table"): row 1 = what you look at (source, platform, filter) + FUTBIN progress and the
    // two main actions; row 2 = status on the left, the other tools on the right. The <select>s stay as
    // the state carriers (not in the page); the segmented buttons set them and fire their change event.
    toolbar.className = "pt-fx-toolbar";
    const seg = (values, onPick) => {
      const box = el("div", "pt-fx-seg");
      const buttons = values.map(value => {
        const item = el("button", "pt-fx-seg-btn");
        item.type = "button";
        item.dataset.value = value;
        item.addEventListener("click", () => onPick(value));
        box.appendChild(item);
        return item;
      });
      return { box, buttons };
    };
    const pick = (select, value) => {
      if (select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event("change"));
    };
    const sourceSeg = seg(["fodder", "futgg"], value => pick(sourceSelect, value));
    const platformSeg = seg(["pc", "console"], value => pick(platform, value));
    const sortSeg = seg(["score", "signal"], value => pick(sortSelect, value));
    const filterInput = el("input", "pt-fx-filter");
    filterInput.type = "search";
    filterInput.spellcheck = false;
    filterInput.addEventListener("input", () => { filterText = filterInput.value; render(); });
    futbinButton.className = "pt-fx-cover";
    runButton.className = "pt-fx-btn pt-fx-primary";
    bidButton.className = "pt-fx-btn";
    [recheckButton, watchButton].forEach(item => { item.className = "pt-fx-btn pt-fx-btn-sm"; });
    [refresh, alertButton, settingsButton, helpButton].forEach(item => { item.className = "pt-fx-icon"; });
    langButton.className = "pt-fx-icon pt-fx-lang";
    dealsBox.className = "pt-fx-toggle";
    selectMenu.className = "pt-fx-select pt-flip-select";
    const row1 = el("div", "pt-fx-row");
    row1.append(el("span", "pt-fx-title", "Flip"), sourceSeg.box, platformSeg.box, filterInput, futbinButton, runButton, bidButton);
    const row2 = el("div", "pt-fx-row pt-fx-row2");
    status.className = "pt-watch-status pt-fx-status";
    row2.append(sortSeg.box, dealsBox, selectMenu, recheckButton, watchButton, el("span", "pt-fx-spacer"), refresh, alertButton, settingsButton, helpButton, langButton);
    toolbar.append(row1, row2, status);
    card.appendChild(toolbar);

    // ⚙ Settings (open by itself while there is no link yet).
    const settings = el("div", "pt-flip-panel");
    const link = el("input", "pt-target-input pt-flip-link");
    const field = () => {
      const box = el("label", "pt-goal");
      const input = el("input", "pt-target-input");
      input.inputMode = "numeric";
      const label = el("span", "pt-muted");
      box.append(label, input);
      return { box, input, label };
    };
    const maxPrice = field();
    const minPct = field();
    maxPrice.input.classList.add("pt-flip-max");
    const linkLabel = el("span", "pt-muted");
    const settingsRow = el("div", "pt-stock-list-buttons");
    const autoBox = el("label", "pt-goal");
    const autoCheck = el("input");
    autoCheck.type = "checkbox";
    const autoText = el("span", "pt-muted");
    autoBox.append(autoCheck, autoText);
    autoCheck.addEventListener("change", () => {
      update(state => { state.autoFutbin = autoCheck.checked; });
      if (autoCheck.checked) futbinAutoTop(getFlip().source);
    });
    settingsRow.append(linkLabel, link, maxPrice.box, minPct.box, autoBox);
    settings.appendChild(settingsRow);
    card.appendChild(settings);

    // ? Explanation.
    const help = el("div", "pt-flip-panel pt-flip-help");
    card.appendChild(help);
    let settingsOpen = false;
    let helpOpen = false;
    settingsButton.addEventListener("click", () => { settingsOpen = !settingsOpen; render(); });
    helpButton.addEventListener("click", () => { helpOpen = !helpOpen; render(); });

    const wrap = el("div", "pt-flip-wrap");
    const table = el("table", "pt-watch-table pt-flip-table pt-fx-table");
    const head = el("tr");
    const HEADERS = [["", "pt-col-tick"], ["h_score", "pt-col-score"], ["h_player", "pt-col-name"], ["h_now", "pt-col-num"], ["h_buy", "pt-col-num"],
      ["h_sell", "pt-col-num"], ["h_profit", "pt-col-num"], ["h_24", "pt-col-num pt-col-pct"], ["h_6", "pt-col-num pt-col-pct"], ["h_sales", "pt-col-num pt-col-sales"], ["", "pt-col-more"]];
    const headCells = HEADERS.map(([, cls]) => head.appendChild(el("th", cls)));
    const headTick = el("input");
    headTick.type = "checkbox";
    headTick.addEventListener("change", () => applySelection(headTick.checked ? "all" : "none"));
    headCells[0].appendChild(headTick);
    const thead = el("thead");
    thead.appendChild(head);
    const tbody = el("tbody");
    table.append(thead, tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);

    // Texts that don't depend on the data (set again on every render, for the language switch).
    let textsLang = "";
    function applyTexts() {
      if (textsLang === flipLang()) return;
      textsLang = flipLang();
      sourceSeg.buttons[0].textContent = "fodder.gg";
      sourceSeg.buttons[1].textContent = ft("srcFutggShort");
      sourceSeg.box.title = ft("srcTitle");
      platformSeg.buttons[0].textContent = "PC";
      platformSeg.buttons[1].textContent = "Console";
      sortSeg.buttons[0].textContent = ft("sortScore");
      sortSeg.buttons[1].textContent = ft("sortSignal");
      sortSeg.box.title = ft("sortTitle");
      filterInput.placeholder = ft("filterPh");
      filterInput.title = ft("filterTitle");
      sourceSelect.options[0].textContent = ft("srcFodder");
      sourceSelect.options[1].textContent = ft("srcFutgg");
      sourceSelect.title = ft("srcTitle");
      sortSelect.options[0].textContent = ft("sortScore");
      sortSelect.options[1].textContent = ft("sortSignal");
      sortSelect.title = ft("sortTitle");
      dealsText.textContent = ft("onlyDeals");
      refresh.title = ft("refreshTitle");
      futbinButton.title = ft("futbinTitle");
      recheckButton.title = ft("recheckTitle");
      runButton.title = ft("runTitle");
      bidButton.title = ft("bidsTitle");
      watchButton.title = ft("playersTitle");
      settingsButton.title = ft("settingsTitle");
      helpButton.title = ft("helpTitle");
      langButton.textContent = flipLang() === "en" ? "EN" : "NL";
      langButton.title = ft("langTitle");
      linkLabel.textContent = ft("linkLabel");
      link.placeholder = ft("linkPlaceholder");
      link.title = ft("linkTitle");
      maxPrice.label.textContent = ft("maxPrice");
      maxPrice.input.title = ft("maxPriceTitle");
      minPct.label.textContent = ft("minPct");
      autoText.textContent = ft("autoFutbin", { n: FUTBIN_AUTO_TOP, m: MOMENTUM_AUTO_TOP });
      autoBox.title = ft("autoFutbinTitle", { n: FUTBIN_AUTO_TOP, m: MOMENTUM_AUTO_TOP });
      minPct.input.title = ft("minPctTitle");
      HEADERS.forEach(([key], i) => { if (key) headCells[i].textContent = ft(key); });
      headTick.title = ft("sel_headTitle");
      selectMenu.title = ft("sel_title");
      selectMenu.options[0].textContent = ft("sel_placeholder");
      SELECTIONS.forEach((key, i) => { selectMenu.options[i + 1].textContent = ft(`sel_${key}`); });
      help.textContent = "";
      ["score", "dot", "prices", "trend", "futbin", "momentum", "details", "self"].forEach(key => {
        const line = el("div", "pt-flip-help-line");
        line.append(el("b", "", ft(`help_${key}`)), el("span", "", ft(`help_${key}Text`)));
        help.appendChild(line);
      });
    }

    // Only the cards you ticked/unticked yourself are remembered; all others follow the current signal
    // (🟢/🟡 on, the rest off), also after a refresh or a changed filter.
    const ticked = new Map(); // id -> bool, your own clicks
    const isTicked = row => (ticked.has(row.card.id) ? ticked.get(row.card.id) : row.calc.status === "buy" || row.calc.status === "near");
    const expanded = new Set(); // ids with their details open
    function applySelection(key) {
      if (key === "default") {
        shown.forEach(row => ticked.delete(row.card.id)); // back to following the signal (🟢/🟡)
      } else {
        let pick;
        if (key === "top10" || key === "top20") {
          const best = shown.filter(row => row.calc.status !== "skip" && row.calc.buy > 0)
            .sort((a, b) => (b.opp ? b.opp.score : -1) - (a.opp ? a.opp.score : -1) || b.calc.pct - a.calc.pct)
            .slice(0, key === "top10" ? 10 : 20);
          pick = row => best.includes(row);
        } else {
          pick = {
            deals: row => ["buy", "near", "risk"].includes(row.calc.status),
            profit: row => row.calc.status !== "skip" && row.calc.buy > 0,
            all: () => true,
            none: () => false
          }[key];
        }
        shown.forEach(row => ticked.set(row.card.id, pick(row)));
      }
      render();
    }
    let shown = [];
    // Filter box: words match the name (accents ignored); also score>70, score<50, <100k, >20k, draait,
    // zakt, gecheckt, groen (en: turning, falling, checked, green). All words must match.
    let filterText = "";
    const plainText = text => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    function matchesFilter(row) {
      const words = plainText(filterText).split(/[\s·,;]+/).filter(Boolean);
      const name = plainText(`${row.card.name} ${row.card.rarity} ${row.card.rating}`);
      return words.every(word => {
        let m = word.match(/^score([<>])=?(\d+)$/);
        if (m) return row.opp ? (m[1] === ">" ? row.opp.score >= Number(m[2]) : row.opp.score <= Number(m[2])) : false;
        m = word.match(/^([<>])=?(\d+(?:[.,]\d+)?)(k|m)?$/);
        if (m) {
          const limit = Number(m[2].replace(",", ".")) * (m[3] === "m" ? 1e6 : m[3] === "k" ? 1e3 : 1);
          return m[1] === "<" ? row.card.now <= limit : row.card.now >= limit;
        }
        if (["draait", "turning", "↩"].includes(word)) return row.calc.move === "turning";
        if (["zakt", "falling", "⏬"].includes(word)) return row.calc.move === "falling";
        if (["gecheckt", "checked"].includes(word)) return !!row.calc.futbin;
        if (["groen", "green", "🟢"].includes(word)) return row.calc.status === "buy";
        if (["holo", "✨"].includes(word)) return !!row.card.holo;
        return name.includes(word);
      });
    }
    const detailTab = new Map(); // card id -> open tab in its details

    const update = mutate => {
      const state = getFlip();
      mutate(state);
      saveFlip(state);
      render();
    };
    link.addEventListener("change", () => {
      const token = flipTokenFrom(link.value);
      if (!token && link.value.trim()) {
        showToast(ft("badLink"), false);
        return;
      }
      update(state => { state.token = token; });
      ticked.clear();
      loadFlipSheet(true);
    });
    platform.addEventListener("change", () => { update(state => { state.platform = platform.value; }); ticked.clear(); if (getFlip().source === "futgg") loadMomentum(false); });
    sortSelect.addEventListener("change", () => update(state => { state.sort = sortSelect.value; }));
    maxPrice.input.addEventListener("change", () => update(state => { state.maxPrice = parsePrice(maxPrice.input.value) || 0; }));
    minPct.input.addEventListener("change", () => update(state => {
      const value = Number(String(minPct.input.value).replace(",", "."));
      state.minPct = Number.isFinite(value) ? value : 5;
    }));
    onlyDeals.addEventListener("change", () => update(state => { state.onlyDeals = onlyDeals.checked; }));
    refresh.addEventListener("click", () => (getFlip().source === "futgg" ? loadMomentum(true) : loadFlipSheet(true)));

    // Only cards with a buy price (a momentum card without FUTBIN check has none) go into a run/list.
    const selectedRows = () => shown.filter(row => isTicked(row) && row.calc.buy > 0);
    // Run maken (max BIN = buy price) or 🔨 Check bids (max bid = buy price, bar on top, badges per card).
    const startFlipRun = async (bids, trigger) => {
      const rows = selectedRows();
      if (!rows.length) return showToast(ft("tickFirst"), false);
      trigger.disabled = true;
      try {
        const players = await flipPlayers(rows);
        const state = getFlip();
        const id = bids ? FLIP_BID_ID : FLIP_RUN_ID;
        const stock = getStock();
        const index = stock.findIndex(item => item.id === id);
        if (index >= 0) stock.splice(index, 1);
        const list = {
          id,
          type: "players",
          name: `${bids ? "🔨 Flip bids" : "Flip sheet"}${state.source === "futgg" ? " FUT.GG" : ""} ${state.platform === "pc" ? "PC" : "console"} ${formatTime(Date.now())}`,
          createdAt: Date.now(),
          profit: null,
          windows: [],
          players,
          done: {},
          flipSheet: true
        };
        if (bids) {
          list.mode = "bid";
          list.massBid = { pct: 0, flip: true };
          players.forEach(player => { player.sell = player.flipSell || 0; });
          try { localStorage.setItem("pt_run_bar_pos", "top"); } catch (_) { /* this session only */ }
        }
        stock.unshift(list);
        saveStock();
        await startRun(id);
        if (bids && runBar) runBar.classList.add("pt-run-top");
        showToast(ft(bids ? "bidRunStarted" : "runStarted", { n: players.length }), true);
      } finally {
        trigger.disabled = false;
      }
    };
    runButton.addEventListener("click", () => startFlipRun(false, runButton));
    bidButton.addEventListener("click", () => startFlipRun(true, bidButton));
    watchButton.addEventListener("click", async () => {
      const rows = selectedRows();
      if (!rows.length) return showToast(ft("tickFirst"), false);
      const added = addPlayersToWatch(await flipPlayers(rows));
      showToast(ft("playersAdded", { n: added }), true);
    });

    const money = value => priceFormat.format(Math.round(value));
    const signed = value => `${value > 0 ? "+" : ""}${priceFormat.format(Math.round(value))}`;
    const pctOf = fraction => flipPct(fraction * 100, 1);
    const externalLink = (text, href) => {
      const anchor = el("a", "pt-flip-link-out", text);
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      return anchor;
    };
    const section = (title, extraClass) => {
      const box = el("div", "pt-flip-box" + (extraClass ? ` ${extraClass}` : ""));
      box.appendChild(el("div", "pt-flip-box-title", title));
      return box;
    };
    // One label + value per line, never wrapped (long text is cut off with … and shown on hover).
    const pair = (box, label, value, className, title) => {
      const line = el("div", "pt-flip-kv");
      const left = el("span", "pt-muted pt-flip-kv-label", label);
      left.title = title || label;
      if (title) line.title = title;
      line.append(left, el("span", "pt-flip-kv-value" + (className ? ` ${className}` : ""), value));
      box.appendChild(line);
    };
    const oppWarning = (code, opp) => ft(`ow_${code}`, { pct: opp.volatility != null ? `${Math.round(opp.volatility * 100)}%` : "" });

    // The opened details of one row.
    // Price ladder: every known price of the card on one line (range = all of them), labels above and below.
    function priceLadder(points) {
      const known = points.filter(point => point.value > 0);
      const box = el("div", "pt-fx-ladder");
      if (known.length < 2) return box;
      const low = Math.min(...known.map(point => point.value)) * 0.985;
      const high = Math.max(...known.map(point => point.value)) * 1.015;
      box.appendChild(el("div", "pt-fx-scale"));
      known.forEach(point => {
        const mark = el("div", `pt-fx-mark pt-fx-mark-${point.kind}${point.below ? " pt-fx-below" : ""}`);
        mark.style.left = `${((point.value - low) / (high - low) * 100).toFixed(1)}%`;
        mark.title = `${point.label}: ${money(point.value)}`;
        const text = el("span", "pt-fx-mark-text");
        text.append(el("small", "", point.label), el("b", "", flipShort(point.value)));
        const tickLine = el("i");
        if (point.below) mark.append(tickLine, text); else mark.append(text, tickLine);
        box.appendChild(mark);
      });
      return box;
    }

    function detailRow(row) {
      const { card: item, calc, opp } = row;
      const tr = el("tr", "pt-flip-detail");
      const td = el("td");
      td.colSpan = HEADERS.length;
      const grid = el("div", "pt-flip-detail-grid");
      const panes = {}; // tab -> element

      if (opp) {
        const box = section(ft("d_score", { score: opp.score, level: ft(`lvl_${opp.level}`) }));
        [["d_partPrice", opp.parts.price], ["d_partProfit", opp.parts.profit], ["d_partLiquidity", opp.parts.liquidity],
          ["d_partTrend", opp.parts.trend], ["d_partReliability", opp.parts.reliability]].forEach(([key, value]) => {
          const line = el("div", "pt-flip-bar-line");
          const bar = el("div", "pt-flip-bar");
          const fill = el("span");
          fill.style.width = `${value == null ? 0 : Math.round(value)}%`;
          bar.appendChild(fill);
          line.append(el("span", "pt-muted pt-flip-kv-label", ft(key)), bar, el("span", "pt-flip-bar-value", value == null ? "?" : String(Math.round(value))));
          box.appendChild(line);
        });
        if (opp.missing.length) box.appendChild(el("div", "pt-flip-note", ft("d_unknown", { list: opp.missing.map(code => ft(`miss_${code}`)).join(", ") })));
        if (opp.caps.length) box.appendChild(el("div", "pt-flip-note", ft("d_capped", { list: opp.caps.map(code => ft(`cap_${code}`)).join(", ") })));
        opp.positives.forEach(code => box.appendChild(el("div", "pt-flip-note pt-flip-plus-note", `✓ ${ft(`pos_${code}`)}`)));
        const src = opp.sources;
        const used = [
          src.futgg ? ft("src_futgg", { m24: flipPct(src.futgg.m24, 1), m6: src.futgg.m6 == null ? "?" : flipPct(src.futgg.m6, 1) })
            : !src.fodder ? ft("src_noFodder") : src.fodder.kind === "history" ? ft("src_history", { span: formatSpan(src.fodder.spanMs) }) : ft("src_today", { hours: src.fodder.hours }),
          !src.futbin ? ft("src_noFutbin") : src.futbin.kind === "h72"
            ? ft("src_h72", { hours: Math.round(src.futbin.hours), sales: src.futbin.sales, days: src.futbin.days })
            : ft("src_basic", { window: src.futbin.window })
        ];
        box.appendChild(el("div", "pt-flip-note", ft("d_used", { list: used.join(" · ") })));
        panes.score = box;
      }

      const prices = section(ft(item.src === "futgg" ? "d_mPrice" : "d_price"));
      pair(prices, ft("d_now"), money(item.now), "pt-flip-now");
      pair(prices, ft("d_status"), `${FLIP_ICON[calc.status]} ${ft(`sts_${calc.status}`)}`);
      if (item.src === "futgg") {
        pair(prices, ft("d_nowSrc"), item.nowSrc === "index" ? ft("d_nowIndex", { time: formatTime(futggPricesAt) }) : ft("d_nowList"));
        pair(prices, ft("d_m24"), flipPct(item.m24, 1), item.m24 < 0 ? "pt-flip-minus" : "pt-flip-plus");
        pair(prices, ft("d_m6"), item.m6 == null ? ft("d_noData") : flipPct(item.m6, 1), item.m6 < 0 ? "pt-flip-minus" : item.m6 > 0 ? "pt-flip-plus" : "");
        pair(prices, ft("d_move"), calc.move ? ft(`m_${calc.move}`) : ft("m_none"), calc.move === "falling" ? "pt-flip-minus" : calc.move === "turning" ? "pt-flip-plus" : "");
        if (opp && opp.normal) pair(prices, ft("d_normalFb"), money(opp.normal), "pt-flip-fbval");
        if (item.url) prices.appendChild(externalLink(ft("d_futggLink"), `https://www.fut.gg${item.url}`));
      } else {
      if (item.nowSrc === "index") {
        const diff = item.fodderNow > 0 ? item.now / item.fodderNow - 1 : 0;
        pair(prices, ft("d_nowSrc"), ft("d_nowIndex", { time: formatTime(futggPricesAt) }));
        pair(prices, ft("d_nowFodder"), `${money(item.fodderNow)}${Math.abs(diff) > 0.05 ? ` (${ft("d_nowDiff", { pct: pctOf(diff) })})` : ""}`,
          Math.abs(diff) > 0.05 ? "pt-flip-warn-text" : "");
      } else if (getFlip().platform === "pc") {
        pair(prices, ft("d_nowSrc"), ft("d_nowFodderOnly"));
      }
      pair(prices, ft("d_low24"), money(item.low));
      pair(prices, ft("d_avg24"), money(item.avg));
      pair(prices, ft("d_high24"), money(item.high));
      pair(prices, ft("d_change24"), flipPct(item.change, 1), item.change < 0 ? "pt-flip-minus" : "pt-flip-plus");
      const hist = opp && opp.hist;
      if (hist) {
        pair(prices, ft("d_history"), ft("d_historyValue", { span: formatSpan(hist.spanMs), n: hist.samples }));
        pair(prices, ft("d_normal"), money(hist.median));
        pair(prices, ft("d_histLow"), money(hist.low));
        pair(prices, ft("d_histHigh"), money(hist.high));
        if (opp.change72 != null) pair(prices, ft("d_change72"), pctOf(opp.change72), opp.change72 < 0 ? "pt-flip-minus" : "pt-flip-plus");
        if (opp.dip) pair(prices, ft("d_verdict"), ft(`dip_${opp.dip}`), opp.dip === "structural" ? "pt-flip-minus" : "");
      } else if (getFlip().platform === "pc") {
        pair(prices, ft("d_history"), ft("d_historyNone"));
      }
      }
      // the price line (72 h history, else today's hourly points) now lives here, in the details
      if (item.src !== "futgg") {
        const hist = opp && opp.hist;
        const chart = el("div", "pt-fx-chart");
        chart.appendChild(hist && hist.points.length >= 2 ? flipHistoryChart(hist, item.now, opp.direction)
          : flipSparkline(item.trend, item.trend.length < 2 || item.trend[item.trend.length - 1] >= item.trend[0]));
        chart.title = hist && hist.points.length >= 2 ? ft("trendHistTitle", { span: formatSpan(hist.spanMs), median: money(hist.median), low: money(hist.low) }) : ft("trendTodayTitle");
        prices.insertBefore(chart, prices.children[1] || null);
      }
      panes.prices = prices;

      const sales = section(ft("d_sales"));
      const fb = calc.futbin;
      if (fb) {
        pair(sales, ft("d_sold24"), ft("d_soldValue", { n: fb.sales24, pct: `${Math.round(fb.sellThrough * 100)}%` }));
        pair(sales, ft("d_p10"), money(fb.p10), "pt-flip-fbval");
        pair(sales, ft("d_median"), money(fb.median));
        pair(sales, ft("d_p75"), money(fb.p75), "pt-flip-fbval");
        const fh = fb.h72;
        if (fh) {
          const cell = (w, value) => (value != null ? value : ft("d_noData")); // ? = no (complete) data for that window
          pair(sales, ft("d_salesWin"), fh.windows.map(w => cell(w, w.sales)).join(" · "), "", ft("d_winTitle"));
          pair(sales, ft("d_medianWin"), fh.windows.map(w => cell(w, w.median != null ? flipShort(w.median) : null)).join(" · "), "", ft("d_winTitle"));
          const course = fh.state || "unknown";
          pair(sales, ft("d_course"), ft(`course_${course}`),
            course === "downLong" || course === "down" ? "pt-flip-minus" : course === "recovering" || course === "up" ? "pt-flip-plus" : "");
          pair(sales, ft("d_demand"), fh.demand ? ft(`demand_${fh.demand}`, { now: fh.windows[0].sales, before: String(Math.round(fh.salesBefore * 10) / 10).replace(".", flipLang() === "en" ? "." : ",") }) : ft("demand_unknown"),
            fh.demand === "falling" ? "pt-flip-minus" : fh.demand === "rising" ? "pt-flip-plus" : "");
          if (fh.week != null) pair(sales, ft("d_week"), pctOf(fh.week), fh.week < 0 ? "pt-flip-minus" : "pt-flip-plus");
          pair(sales, ft("d_coverage"), ft("d_coverageValue", { hours: Math.round(fh.coverH), days: fh.dailyDays }), fh.coverH < 72 ? "pt-flip-warn-text" : "");
        } else {
          pair(sales, ft("d_p90"), money(fb.p90));
          if (fb.trend != null) pair(sales, ft("d_vsYesterday"), pctOf(fb.trend), fb.trend < 0 ? "pt-flip-minus" : "pt-flip-plus");
        }
        const stale = futbinNeedsCheck(item, getFlip().platform);
        if (stale) sales.appendChild(el("div", "pt-flip-note", ft(fb.v !== FUTBIN_STATS_VERSION ? "d_oldCheck" : "d_staleCheck")));
        pair(sales, ft("d_checkedAt"), ft("d_checkedAgo", { time: formatTime(fb.fetchedAt), min: Math.round((Date.now() - fb.fetchedAt) / 60000) }), stale ? "pt-flip-warn-text" : "");
        if (!futbinState.busy) {
          const again = button(ft("d_recheckButton"), "pt-flip-small-btn");
          again.title = ft("d_recheckTitle");
          again.addEventListener("click", () => futbinCheckCards([item], getFlip().platform, false, { force: true }));
          sales.appendChild(again);
        }
        sales.appendChild(externalLink(ft("d_salesLink"), `https://www.futbin.com${fb.path}?platform=${futbinPlatform(getFlip().platform)}`));
      } else {
        sales.appendChild(el("div", "pt-flip-note", ft(item.src === "futgg" ? "d_mNotChecked" : "d_notChecked")));
        if (!futbinState.busy) {
          const check = button(ft("d_checkButton"), "pt-flip-small-btn");
          check.title = ft("d_checkTitle");
          check.addEventListener("click", () => futbinCheckCards([item], getFlip().platform));
          sales.appendChild(check);
        }
      }
      sales.appendChild(externalLink(ft("d_searchLink"), `https://www.futbin.com/players?search=${encodeURIComponent(item.name)}`));
      panes.sales = sales;

      const warnings = calc.warnings.concat(opp ? opp.warnings.map(code => oppWarning(code, opp)) : []);
      if (warnings.length) {
        const box = section(ft("d_warn"), "pt-flip-box-warn");
        warnings.forEach(text => box.appendChild(el("div", "pt-flip-warn-line", `⚠ ${text}`)));
        panes.warn = box;
      }

      // Overview: price ladder, the short facts, and what you can do now.
      const overview = el("div", "pt-fx-overview");
      const ladderBox = section(ft("d_ladder"));
      // "normal" on the ladder = real sales (median of the FUTBIN 24 h windows) when checked, else the sheet.
      const fbWindows = fb && fb.h72 ? fb.h72.windows.map(w => w.median).filter(value => value > 0) : [];
      const normal = fb ? (fbWindows.length ? median(fbWindows) : fb.median) : opp && opp.hist ? opp.hist.median : item.avg;
      const points = fb
        ? [{ kind: "edge", label: "P10", value: fb.p10 }, { kind: "normal", label: ft("d_lNormal"), value: normal },
          { kind: "edge", label: "P90", value: fb.p90 }, { kind: "buy", label: ft("d_lBuy"), value: calc.buy, below: true },
          { kind: "sell", label: ft("d_lSell"), value: calc.sell, below: true }, { kind: "now", label: ft("d_lNow"), value: item.now, below: true }]
        : item.src !== "futgg"
          ? [{ kind: "edge", label: ft("d_lLow"), value: item.low }, { kind: "normal", label: ft("d_lAvg"), value: item.avg },
            { kind: "edge", label: ft("d_lHigh"), value: item.high }, { kind: "buy", label: ft("d_lBuy"), value: calc.buy, below: true },
            { kind: "sell", label: ft("d_lSell"), value: calc.sell, below: true }, { kind: "now", label: ft("d_lNow"), value: item.now, below: true }]
          : [];
      if (points.length) ladderBox.appendChild(priceLadder(points));
      else ladderBox.appendChild(el("div", "pt-flip-note", ft("d_mNotChecked")));
      ladderBox.appendChild(el("div", "pt-flip-note", ft(fb ? "d_ladderFb" : item.src === "futgg" ? "d_ladderNone" : "d_ladderSheet")));
      const facts = section(ft("d_facts"));
      const noPrice = !(calc.buy > 0);
      pair(facts, ft("d_status"), `${FLIP_ICON[calc.status]} ${ft(`sts_${calc.status}`)}`);
      pair(facts, ft("h_profit"), noPrice ? "—" : `${signed(calc.profit)} · ${calc.pct.toFixed(1)}%`, noPrice ? "" : calc.profit > 0 ? "pt-flip-plus" : "pt-flip-minus");
      if (opp) pair(facts, ft("h_score"), `${opp.score} · ${ft(`lvl_${opp.level}`)}`);
      if (fb && fb.h72 && fb.h72.state) pair(facts, ft("d_course"), ft(`course_${fb.h72.state}`), ["downLong", "down"].includes(fb.h72.state) ? "pt-flip-minus" : ["recovering", "up"].includes(fb.h72.state) ? "pt-flip-plus" : "");
      pair(facts, ft("d_nowSrc"), item.nowSrc === "index" ? ft("d_nowIndex", { time: formatTime(futggPricesAt) }) : item.src === "futgg" ? ft("d_nowList") : ft("d_nowFodderOnly"));
      pair(facts, "FUTBIN", fb ? ft("d_checkedAgo", { time: formatTime(fb.fetchedAt), min: Math.round((Date.now() - fb.fetchedAt) / 60000) }) : ft("sts_unk"));
      const todo = section(ft("d_todo"));
      const searchNow = el("button", "pt-fx-btn pt-fx-primary pt-fx-wide pt-flip-search", noPrice ? ft("d_searchNoMax") : ft("d_searchMax", { max: flipShort(calc.buy) }));
      searchNow.type = "button";
      searchNow.title = ft("searchTitle", { holo: item.holo ? ft("searchHolo") : "", buy: money(calc.buy) });
      searchNow.addEventListener("click", event => {
        openFlipSearch(item, calc, noPrice || event.shiftKey).catch(error => showToast(ft("searchFailed", { error: error.message }), false));
      });
      todo.appendChild(searchNow);
      if (!futbinState.busy) {
        const again = el("button", "pt-fx-btn pt-fx-wide", ft(fb ? "d_recheckButton" : "d_checkButton"));
        again.type = "button";
        again.title = ft(fb ? "d_recheckTitle" : "d_checkTitle");
        again.addEventListener("click", () => futbinCheckCards([item], getFlip().platform, false, { force: !!fb }));
        todo.appendChild(again);
      }
      const links = el("div", "pt-fx-links");
      links.appendChild(externalLink("FUTBIN ↗", fb ? `https://www.futbin.com${fb.path}?platform=${futbinPlatform(getFlip().platform)}` : `https://www.futbin.com/players?search=${encodeURIComponent(item.name)}`));
      if (item.url) links.appendChild(externalLink("FUT.GG ↗", `https://www.fut.gg${item.url}`));
      todo.appendChild(links);
      overview.append(ladderBox, facts, todo);

      // Tabs: Overzicht · Verkopen · Score · Prijzen · Let op (n). The chosen tab is remembered per card.
      const tabs = [["overview", ft("t_overview"), overview], ["sales", ft("t_sales"), panes.sales], ["score", ft("t_score"), panes.score],
        ["prices", ft("t_prices"), panes.prices], ["warn", ft("t_warn", { n: warnings.length }), panes.warn]].filter(([, , pane]) => pane);
      const active = tabs.some(([key]) => key === detailTab.get(item.id)) ? detailTab.get(item.id) : "overview";
      const bar = el("div", "pt-fx-tabs");
      tabs.forEach(([key, label, pane]) => {
        const tab = el("button", `pt-fx-tab${key === active ? " pt-fx-on" : ""}${key === "warn" ? " pt-fx-tab-warn" : ""}`, label);
        tab.type = "button";
        tab.addEventListener("click", () => {
          detailTab.set(item.id, key);
          bar.querySelectorAll(".pt-fx-tab").forEach(other => other.classList.toggle("pt-fx-on", other === tab));
          tabs.forEach(([, , other]) => { other.style.display = other === pane ? "" : "none"; });
        });
        bar.appendChild(tab);
        pane.classList.add("pt-fx-pane");
        pane.style.display = key === active ? "" : "none";
        grid.appendChild(pane);
      });
      td.append(bar, grid);
      tr.appendChild(td);
      return tr;
    }

    function render() {
      const state = getFlip();
      applyTexts();
      if (document.activeElement !== link) link.value = state.token ? `https://fodder.gg/price-watch/${state.token}` : "";
      platform.value = state.platform;
      if (document.activeElement !== maxPrice.input) maxPrice.input.value = state.maxPrice ? priceFormat.format(state.maxPrice) : "";
      if (document.activeElement !== minPct.input) minPct.input.value = String(state.minPct);
      onlyDeals.checked = !!state.onlyDeals;
      autoCheck.checked = !!state.autoFutbin;
      const momentum = state.source === "futgg";
      sourceSelect.value = momentum ? "futgg" : "fodder";
      sortSelect.value = state.sort === "signal" ? "signal" : "score";
      sortSelect.style.display = state.platform === "pc" || momentum ? "" : "none";
      sourceSeg.buttons.forEach(item => item.classList.toggle("pt-fx-on", item.dataset.value === sourceSelect.value));
      platformSeg.buttons.forEach(item => item.classList.toggle("pt-fx-on", item.dataset.value === state.platform));
      sortSeg.buttons.forEach(item => item.classList.toggle("pt-fx-on", item.dataset.value === sortSelect.value));
      sortSeg.box.style.display = sortSelect.style.display;
      dealsBox.classList.toggle("pt-fx-on", !!state.onlyDeals);
      alertButton.style.display = momentum ? "none" : ""; // the alert stays on the fodder.gg list
      alertButton.textContent = state.alert ? "🔔" : "🔕";
      alertButton.classList.toggle("pt-fx-live", !!state.alert);
      alertButton.title = `${ft(state.alert ? "alertOn" : "alertOff")}. ${ft("alertTitle")}`;
      alertButton.classList.toggle("pt-flip-alert-on", !!state.alert);

      settings.style.display = settingsOpen || (!state.token && !momentum) ? "" : "none";
      settingsButton.classList.toggle("pt-fx-live", settingsOpen);
      help.style.display = helpOpen ? "" : "none";
      helpButton.classList.toggle("pt-fx-live", helpOpen);

      const data = flipData && flipData.token === state.token ? flipData : null;
      const deal = row => !state.onlyDeals || row.calc.status === "buy" || row.calc.status === "near";
      if (momentum) {
        shown = rankMomentum(momentumRows(state).filter(deal), state.sort === "signal"); // score from FUTBIN 72 h
      } else {
        // Score per row (PC), highest first; "green first" (and console, no score) keeps the old order.
        shown = rankFlipOpportunities(flipRows(data, state).filter(deal), state.platform);
        if (state.sort === "signal" || state.platform !== "pc") shown.sort((a, b) => FLIP_ORDER[a.calc.status] - FLIP_ORDER[b.calc.status] || b.calc.pct - a.calc.pct);
      }
      const listSize = shown.length;
      const checkedCount = shown.filter(row => row.calc.futbin).length;
      if (filterText.trim()) shown = shown.filter(matchesFilter);

      // FUTBIN chip: progress of the list (checked / all) and a click = check the real sales now.
      const paused = state.autoFutbin && Date.now() < futbinAutoPause;
      futbinButton.textContent = "";
      futbinButton.classList.toggle("pt-fx-busy", futbinState.busy);
      futbinButton.appendChild(el("span", "pt-fx-cover-label", futbinState.busy
        ? ft("futbinBusy", { done: futbinState.done, total: futbinState.total })
        : `FUTBIN ${checkedCount}/${listSize}${paused ? ft("fbPausedMark", { time: formatTime(futbinAutoPause) }) : ""}`));
      const track = el("span", "pt-fx-track");
      const fill = el("i");
      fill.style.width = `${listSize ? Math.round((futbinState.busy ? futbinState.done / Math.max(1, futbinState.total) : checkedCount / listSize) * 100) : 0}%`;
      track.appendChild(fill);
      futbinButton.appendChild(track);
      futbinButton.title = ft("futbinTitle") + (paused ? ` ${ft("fbPausedTitle", { time: formatTime(futbinAutoPause) })}` : "");

      const count = key => shown.filter(row => row.calc.status === key).length;
      setTabBadge("flip", count("buy"), true);
      const history = getFlipHistory();
      const historyText = state.platform !== "pc" ? ""
        : history && history.times.length
          ? ft("histStatus", { n: history.times.length, span: formatSpan(history.times[history.times.length - 1] - history.times[0]), time: formatTime(history.times[history.times.length - 1]), remote: pcDevice() ? "" : ft("histRemote") })
          : ft(pcDevice() ? "histBuilding" : "histNone");
      status.textContent = !state.token
        ? ft("statusNoLink")
        : flipLoading
          ? ft("statusLoading")
          : data
            ? ft("statusData", { platform: state.platform === "pc" ? "PC" : "Console", n: shown.length, buy: count("buy"), near: count("near"), risk: count("risk"), time: formatTime(data.fetchedAt) })
              + (state.platform === "pc" && futggPricesAt ? ft("mPricesAt", { time: formatTime(futggPricesAt) }) : "")
              + (flipError ? ft("statusError", { error: flipError }) : "")
            : flipError ? ft("statusFailed", { error: flipError }) : ft("statusEmpty");
      status.title = data ? ft("statusTitle", { at: formatTime(data.at), fetched: formatTime(data.fetchedAt), history: historyText }) : "";
      if (momentum) {
        const set = momentumData && momentumData[state.platform];
        status.textContent = momentumLoading
          ? ft("mLoading", { n: momentumPages })
          : set
            ? ft("mStatus", { platform: state.platform === "pc" ? "PC" : "Console", n: shown.length, buy: count("buy"), near: count("near"), risk: count("risk"), unk: count("unk"), time: formatTime(set.at) })
              + (state.platform === "pc" && futggPricesAt ? ft("mPricesAt", { time: formatTime(futggPricesAt) }) : "")
              + (momentumError ? ft("statusError", { error: momentumError }) : "")
            : momentumError ? ft("statusFailed", { error: momentumError }) : ft("mEmpty");
        status.title = ft("mStatusTitle");
      }

      tbody.textContent = "";
      shown.forEach(row => {
        const { card: item, calc, opp } = row;
        const open = expanded.has(item.id);
        const tr = el("tr", `pt-flip-row pt-flip-row-${calc.status}${open ? " pt-flip-open" : ""}`);
        tr.title = ft("rowTitle");
        tr.addEventListener("click", event => {
          if (event.target.closest("input, a, button, select")) return;
          if (open) expanded.delete(item.id); else expanded.add(item.id);
          render();
        });

        const tickCell = el("td", "pt-col-tick");
        const tick = el("input");
        tick.type = "checkbox";
        tick.checked = isTicked(row);
        tick.addEventListener("change", () => { ticked.set(item.id, tick.checked); updateCount(); });
        tickCell.appendChild(tick);

        // Score: number + bar (colour = level); no score: the signal in words. The row's left edge shows the
        // signal colour (🟢 / 🟡 / 🟠).
        const scoreCell = el("td", "pt-col-score");
        scoreCell.title = ft(`st_${calc.status}`) + (calc.buy > 0 && calc.status !== "skip" ? ` · ${ft("gapTitle", { pct: pctOf(calc.gap) })}` : "");
        if (opp) {
          const scoreBox = el("span", `pt-fx-score pt-fx-lvl-${opp.level}`);
          const bar = el("span", "pt-fx-scorebar");
          const fill = el("i");
          fill.style.width = `${opp.score}%`;
          bar.appendChild(fill);
          scoreBox.append(el("b", "pt-opp", String(opp.score)), bar);
          scoreBox.title = ft("badgeTitle", { score: opp.score, level: ft(`lvl_${opp.level}`) });
          scoreCell.appendChild(scoreBox);
        } else {
          scoreCell.appendChild(el("span", "pt-fx-noscore", `${FLIP_ICON[calc.status]} ${ft(`sts_${calc.status}`)}`));
        }

        const nameCell = el("td", "pt-col-name");
        const nameLine = el("div", "pt-fx-name");
        nameLine.append(el("b", "pt-cheapest-main", item.name), el("span", "pt-fx-meta", `${item.rating} · ${item.rarity}`));
        if (item.holo) nameLine.appendChild(el("span", "pt-fx-pill", "✨"));
        if (calc.move) {
          const move = el("span", `pt-fx-pill ${calc.move === "falling" ? "pt-fx-pill-bad" : "pt-fx-pill-good"}`, calc.move === "falling" ? "⏬" : "↩");
          move.title = ft(`m_${calc.move}`);
          nameLine.appendChild(move);
        }
        const warnList = calc.warnings.filter(text => text !== ft("w_mNoFutbin"));
        if (warnList.length && ["buy", "near", "risk"].includes(calc.status)) {
          const warn = el("span", "pt-fx-pill pt-fx-pill-warn", `⚠${warnList.length > 1 ? ` ${warnList.length}` : ""}`);
          warn.title = warnList.join("\n");
          nameLine.appendChild(warn);
        }
        const search = el("button", "pt-fx-search pt-flip-search", "🔍");
        search.type = "button";
        search.title = ft("searchTitle", { holo: item.holo ? ft("searchHolo") : "", buy: money(calc.buy) });
        search.addEventListener("click", event => {
          openFlipSearch(item, calc, event.shiftKey).catch(error => {
            console.error("Price Watch:", error);
            showToast(ft("searchFailed", { error: error.message }), false);
          });
        });
        nameLine.appendChild(search);
        nameCell.appendChild(nameLine);

        const num = (text, className) => el("td", "pt-col-num" + (className ? ` ${className}` : ""), text);
        const pctCell = (value, title) => {
          const cell = num(value == null || !Number.isFinite(value) ? "—" : flipPct(value * 100, 1),
            `pt-col-pct ${value == null || !Number.isFinite(value) ? "pt-muted" : value <= -0.02 ? "pt-flip-minus" : value >= 0.02 ? "pt-flip-plus" : "pt-muted"}`);
          if (title) cell.title = title;
          return cell;
        };
        const noPrice = !(calc.buy > 0);
        const nowCell = num(money(item.now), `pt-flip-now${calc.status === "buy" ? " pt-fx-at" : ""}`);
        nowCell.title = item.nowSrc === "index" ? ft("d_nowIndex", { time: formatTime(futggPricesAt) }) : item.src === "futgg" ? ft("d_nowList") : ft("d_nowFodderOnly");
        const profitCell = num(noPrice ? "—" : signed(calc.profit), noPrice ? "pt-muted" : calc.profit > 0 ? "pt-flip-plus" : "pt-flip-minus");
        profitCell.title = noPrice ? "" : `${ft("profitTitle", { buy: money(calc.buy), sell: money(calc.sell) })} · ${calc.pct.toFixed(1)}%`;
        // 24 h and 6 h: FUT.GG momentum, or fodder.gg (24 h change / history, 6 h from the hourly points).
        const change24 = item.src === "futgg" ? item.m24 / 100 : opp ? opp.change24 : item.change / 100;
        const hours = item.trend || [];
        const change6 = item.src === "futgg" ? (item.m6 == null ? null : item.m6 / 100)
          : hours.length >= 7 && hours[hours.length - 7] > 0 ? hours[hours.length - 1] / hours[hours.length - 7] - 1 : null;
        const salesCell = num(calc.futbin ? String(calc.futbin.sales24) : "—", calc.futbin ? "pt-col-sales" : "pt-col-sales pt-muted");
        if (calc.futbin) salesCell.title = ft("d_soldValue", { n: calc.futbin.sales24, pct: `${Math.round(calc.futbin.sellThrough * 100)}%` });

        tr.append(tickCell, scoreCell, nameCell, nowCell,
          num(noPrice ? "—" : money(calc.buy), "pt-flip-buy" + (noPrice ? " pt-muted" : "")),
          num(noPrice ? "—" : money(calc.sell), noPrice ? "pt-muted" : ""), profitCell,
          pctCell(change24, ft(item.src === "futgg" ? "mTrendTitle" : "trendTodayTitle")), pctCell(change6, item.src === "futgg" ? ft("mTrendTitle") : ""),
          salesCell, (() => { const more = el("td", "pt-col-more"); more.appendChild(el("span", "pt-fx-chev", "›")); return more; })());
        tbody.appendChild(tr);
        if (open) tbody.appendChild(detailRow(row));
      });
      updateCount();
    }
    function updateCount() {
      const count = selectedRows().length;
      headTick.checked = shown.length > 0 && count === shown.length;
      headTick.indeterminate = count > 0 && count < shown.length;
      runButton.textContent = ft("run", { n: count });
      const tickedAll = shown.filter(isTicked).length;
      recheckButton.textContent = ft("recheck", { n: Math.min(tickedAll, FUTBIN_BATCH_MAX) });

      bidButton.textContent = ft("bids", { n: count });
      watchButton.textContent = ft("players", { n: count });
    }

    // Refresh when the tab opens and every 10 minutes while it is visible.
    flipOnShow = () => {
      const source = getFlip().source === "futgg" ? "futgg" : "fodder";
      Promise.resolve(source === "futgg" ? loadMomentum(false) : loadFlipSheet(false))
        .then(fetched => { if (!fetched) return futbinAutoTop(source); }) // a fetch starts its own round
        .catch(error => console.warn(L("Price Watch: FUTBIN auto-check mislukt.", "Price Watch: FUTBIN auto-check failed."), error));
    };
    if (!flipTimer) {
      flipTimer = window.setInterval(() => {
        const visible = document.querySelector(".pt-flip-card");
        // With 🔔 on it keeps refreshing (every 10 min) while the web app is open, on any screen.
        if ((visible && visible.offsetParent) || getFlip().alert) loadFlipSheet(false);
        if (visible && visible.offsetParent && getFlip().source === "futgg") loadMomentum(false); // every 15 min
      }, 60 * 1000);
    }
    return render;
  }

  // --- Tabs on the Price Watch page ----------------------------------------------

  const TAB_KEY = "pt_watch_tab_v1";

  // Small counter on a tab (what needs attention there); 0 or nothing hides it.
  let tabBadges = {};
  function setTabBadge(key, count, good) {
    const button = tabBadges[key];
    const badge = button && button.querySelector(".pt-tab-badge");
    if (!badge) return;
    badge.textContent = count > 0 ? String(count) : "";
    badge.classList.toggle("pt-tab-badge-good", !!good);
  }

  // --- First-use guide ------------------------------------------------------------
  // Shown once, the first time Price Watch opens (pt_guide_v1); "📘 Guide" in the tab bar opens it again.
  // Step 1 picks the language and platform, the rest explains the tabs and the rules in a few lines.
  const GUIDE_KEY = "pt_guide_v1";
  function guideSeen() {
    try { return !!localStorage.getItem(GUIDE_KEY); } catch (_) { return true; }
  }
  function openGuide(root) {
    const old = root.querySelector(".pt-guide");
    if (old) old.remove();
    const startLang = uiLang();
    const startPlatform = getFlip().platform;
    const box = el("div", "pt-guide");
    const card = el("div", "pt-guide-card");
    box.appendChild(card);
    let step = 0;
    const close = () => {
      try { localStorage.setItem(GUIDE_KEY, String(Date.now())); } catch (_) { /* shows again next time */ }
      box.remove();
      const flip = getFlip();
      if (flip.platform !== startPlatform) {
        refreshFutggPrices(true);
        if (flip.source === "futgg") loadMomentum(false);
      }
      if (flip.lang !== startLang) showToast(L("Taal: Nederlands. Alle tabs wisselen mee als je Price Watch opnieuw opent.", "Language: English. All tabs switch too when you reopen Price Watch."), true);
      listeners.forEach(listener => listener());
    };
    const set = mutate => { const state = getFlip(); mutate(state); saveFlip(state); draw(); };
    const pick = (label, on, onClick) => {
      const b = el("button", `pt-guide-pick${on ? " pt-guide-on" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    };
    const row = (icon, title, text) => {
      const line = el("div", "pt-guide-line");
      const textBox = el("div");
      textBox.append(el("b", "", title), el("span", "", text));
      line.append(el("span", "pt-guide-icon", icon), textBox);
      return line;
    };
    const STEPS = [
      () => {
        const flip = getFlip();
        const lang = el("div", "pt-guide-picks");
        lang.append(pick("English", uiLang() === "en", () => set(s => { s.lang = "en"; })), pick("Nederlands", uiLang() === "nl", () => set(s => { s.lang = "nl"; })));
        const platform = el("div", "pt-guide-picks");
        platform.append(pick("💻 PC", flip.platform !== "console", () => set(s => { s.platform = "pc"; })),
          pick("🎮 Console (PlayStation / Xbox)", flip.platform === "console", () => set(s => { s.platform = "console"; })));
        return [L("👋 Welkom bij Price Watch", "👋 Welcome to Price Watch"), [
          el("p", "", L("Price Watch helpt je goedkope kaarten te vinden om te flippen: het toont echte verkopen, een score en een koop- en verkoopprijs. Eerst twee keuzes:", "Price Watch helps you find cheap cards to flip: it shows real sales, a score and a buy and sell price. First two choices:")),
          el("div", "pt-guide-label", L("Taal", "Language")), lang,
          el("div", "pt-guide-label", L("Op welk platform speel je?", "Which platform do you play on?")), platform,
          el("p", "pt-guide-note", L("Prijzen en verkopen komen dan van jouw platform. Console gebruikt de PlayStation-prijzen van FUT.GG en FUTBIN (Xbox zit daar dichtbij). Je kunt dit later wijzigen in Flip → ⚙.", "Prices and sales then come from your platform. Console uses the PlayStation prices from FUT.GG and FUTBIN (Xbox is close to those). You can change this later in Flip → ⚙."))
        ]];
      },
      () => [L("🔁 Begin bij Flip", "🔁 Start with Flip"), [
        row("📡", L("Bron", "Source"), L("Kies FUT.GG (werkt meteen, niets invullen) of fodder.gg (plak je eigen fodder.gg Price Watch-link onder ⚙).", "Pick FUT.GG (works right away, nothing to fill in) or fodder.gg (paste your own fodder.gg Price Watch link under ⚙).")),
        row("⏳", L("Even wachten", "Give it a moment"), L("De lijst laadt vanzelf. Daarna checkt Price Watch op de achtergrond de echte FUTBIN-verkopen. Laat de web app open staan; de eerste ronde duurt een paar minuten.", "The list loads by itself. Then Price Watch checks the real FUTBIN sales in the background. Keep the web app open; the first round takes a few minutes.")),
        row("🟢", L("Bolletje", "Dot"), ft("help_dotText")),
        row("👆", L("Details", "Details"), L("Klik op een rij voor alles: waarom deze score, de echte verkopen en de waarschuwingen. De ? rechtsboven legt elke kolom uit.", "Click a row for everything: why this score, the real sales and the warnings. The ? at the top right explains every column.")),
        row("🆕", L("Nieuwe kaarten", "New cards"), L("Kaarten die net uit zijn worden nooit groen: hun prijs zakt vaak nog hard.", "Cards that just came out are never green: their price often still drops a lot."))
      ]],
      () => [L("🗂 De andere tabs", "🗂 The other tabs"), [
        row("👤", L("Spelers", "Players"), L("Volg spelers met een doelprijs; je ziet hoe ver de markt ervan af zit.", "Follow players with a target price; you see how far the market is from it.")),
        row("🪙", "Fodder", L("Prijzen van goud-fodder per rating (voor SBC's), met een doel per rating.", "Prices of gold fodder per rating (for SBCs), with a target per rating.")),
        row("📋", L("Lijsten", "Lists"), L("Eigen zoek- en biedlijsten; Price Watch zet de filters per kaart klaar.", "Your own search and bid lists; Price Watch sets the filters up per card.")),
        row("📦", "Transfers", L("Je transferlijst: wat je ervoor betaalde, wat het nu waard is en je winst na 5% belasting.", "Your transfer list: what you paid, what it is worth now and your profit after 5% tax."))
      ]],
      () => [L("✅ Goed om te weten", "✅ Good to know"), [
        row("✋", L("Jij drukt zelf", "You press the buttons"), L("🔍-knoppen vullen alleen de zoekfilters van de transfermarkt in. Zoeken, kopen, bieden en listen doe je altijd zelf. Price Watch koopt nooit iets voor je.", "🔍 buttons only fill in the transfer market search filters. You always search, buy, bid and list yourself. Price Watch never buys anything for you.")),
        row("🐢", L("Rustig zoeken", "Search calmly"), L("Zoek niet te snel achter elkaar: EA kan de transfermarkt dan tijdelijk blokkeren.", "Don't search too fast in a row: EA can then block the transfer market for a while.")),
        row("⌨", L("Sneltoetsen", "Hotkeys"), L("Rechtsklik op een knop in de web app → \"Toets toewijzen\". Daarna is één toets één klik.", "Right-click a button in the web app → \"Assign key\". After that one key press is one click.")),
        row("💸", L("Belasting", "Tax"), L("EA houdt 5% in bij elke verkoop; alle winsten in Price Watch zijn al na belasting.", "EA keeps 5% of every sale; all profits in Price Watch are already after tax.")),
        row("🔄", "Updates", L("Nieuwe versies komen vanzelf via Tampermonkey. Deze gids open je weer met 📘 bovenaan.", "New versions arrive by themselves through Tampermonkey. Open this guide again with 📘 at the top."))
      ]]
    ];
    function draw() {
      card.textContent = "";
      const [title, body] = STEPS[step]();
      const head = el("div", "pt-guide-head");
      const skip = el("button", "pt-guide-skip", "✕");
      skip.type = "button";
      skip.title = L("Sluiten", "Close");
      skip.addEventListener("click", close);
      head.append(el("h2", "", title), el("span", "pt-guide-steps", `${step + 1} / ${STEPS.length}`), skip);
      const content = el("div", "pt-guide-body");
      content.append(...body);
      const nav = el("div", "pt-guide-nav");
      if (step > 0) nav.appendChild(pick(L("‹ Terug", "‹ Back"), false, () => { step--; draw(); }));
      nav.appendChild(el("span", "pt-fx-spacer"));
      const last = step === STEPS.length - 1;
      nav.appendChild(pick(last ? L("Aan de slag ✓", "Let's go ✓") : L("Volgende ›", "Next ›"), true, () => { if (last) close(); else { step++; draw(); } }));
      card.append(head, content, nav);
    }
    draw();
    root.appendChild(box);
  }

  function buildTabs(root, sections) {
    const bar = el("div", "pt-tabs");
    const buttons = {};
    const show = name => {
      Object.entries(sections).forEach(([key, section]) => { section.style.display = key === name ? "" : "none"; });
      Object.entries(buttons).forEach(([key, button]) => button.classList.toggle("pt-tab-active", key === name));
      try {
        localStorage.setItem(TAB_KEY, name);
      } catch (_) {
        // Remembering the tab is a convenience only.
      }
      if (name === "flip") flipOnShow();
      if (name === "fodder") {
        loadFodderMarket(false);
        loadFodderCheapest(false);
      }
    };
    [["flip", "Flip"], ["watch", L("Spelers", "Players")], ["fodder", "Fodder"], ["lists", L("Lijsten", "Lists")], ["transfers", "Transfers"]].forEach(([key, label]) => {
      const button = el("button", "pt-tab", label);
      button.type = "button";
      button.appendChild(el("em", "pt-tab-badge"));
      button.addEventListener("click", () => show(key));
      buttons[key] = button;
      bar.appendChild(button);
    });
    tabBadges = buttons;
    const device = el("span", "pt-tab-device");
    const guide = el("button", "pt-tab pt-tab-guide", L("📘 Gids", "📘 Guide"));
    guide.type = "button";
    guide.title = L("Uitleg voor de eerste keer: taal, platform en hoe alles werkt", "First-time guide: language, platform and how everything works");
    guide.addEventListener("click", () => openGuide(root));
    bar.append(el("span", "pt-tab-spacer"), guide, device);
    const drawDevice = () => {
      device.textContent = `${pcDevice() ? "💻 Pc" : L("📱 Telefoon", "📱 Phone")}${futggPricesAt ? L(` · FUT.GG-prijzen ${formatTime(futggPricesAt)}`, ` · FUT.GG prices ${formatTime(futggPricesAt)}`) : ""}`;
      device.title = pcDevice()
        ? L("Dit apparaat is de pc: auto-check, historie, meldingen en sync naar je telefoon draaien hier. Prijzen van FUT.GG.", "This device is the PC: auto-check, history, notifications and sync to your phone run here. Prices from FUT.GG.")
        : L("Dit apparaat leest mee met je pc (prijzen en lijsten via je gist).", "This device follows your PC (prices and lists via your gist).");
    };
    drawDevice();
    listeners.add(drawDevice);
    root.insertBefore(bar, root.firstChild);
    let initial = "flip";
    try {
      initial = localStorage.getItem(TAB_KEY) || "flip";
    } catch (_) {
      // Default tab.
    }
    show(sections[initial] ? initial : "flip");
    if (!guideSeen()) openGuide(root);
    return show;
  }

  // --- Stock UI inside the Price Watch page -------------------------------------

  // "🎯 Biedlijst maken": cards with demand that hold value (tip: up to ~1000c), most expensive first,
  // like the FUTBIN link in the tip (price 300-1000, sorted high to low). Rarity (rare / non-rare) isn't
  // in EA's static data, so check the cards in the list and remove what you don't want.
  function buildMassBidMaker(onCreated) {
    const panel = el("div", "pt-stock-import pt-mb-maker");
    const field = (label, value, title) => {
      const box = el("label", "pt-goal");
      const input = el("input", "pt-target-input");
      input.inputMode = "numeric";
      input.value = value;
      input.title = title;
      box.append(el("span", "pt-muted", label), input);
      return { box, input };
    };
    const ratingFrom = field(L("Rating van", "Rating from"), "75", L("Laagste rating (75+ = goud)", "Lowest rating (75+ = gold)"));
    const ratingTo = field(L("tot", "to"), "83", L("Hoogste rating", "Highest rating"));
    const priceFrom = field(L("Prijs van", "Price from"), "300", L("Laagste FUT.GG PC-prijs", "Lowest FUT.GG PC price"));
    const priceTo = field(L("tot", "to"), "1000", L("Hoogste FUT.GG PC-prijs", "Highest FUT.GG PC price"));
    const count = field(L("Aantal", "Count"), "15", L("Hoeveel kaarten in de lijst (tip: 10–12+)", "How many cards in the list (tip: 10–12+)"));
    const pct = field(L("% onder BIN", "% below BIN"), String(MASS_BID_DEFAULT_PCT), L("Max bod = BIN − dit percentage (tip: 20–25%)", "Max bid = BIN − this percentage (tip: 20–25%)"));
    const make = el("button", "pt-watch-refresh", "Maken");
    make.type = "button";
    make.title = L("Kaarten binnen de rating én de prijsrange (FUT.GG PC), duurste eerst", "Cards within the rating and price range (FUT.GG PC), most expensive first");
    // Fodder bid list: per rating the same players as the fodder cycle (your target × 1.1 on the Fodder
    // screen, else the cheapest). Won ≥10% under the price → "hold" instead of "sell".
    const makeFodder = el("button", "pt-watch-refresh", "Fodder");
    makeFodder.type = "button";
    makeFodder.title = L("Per rating (van–tot) de fodderspelers van het Fodder-scherm (doel × 1,1, anders de goedkoopste); Aantal = max per rating. Prijsrange telt hier niet.", "Per rating (from–to) the fodder players from the Fodder screen (target × 1.1, otherwise the cheapest); Count = max per rating. Price range doesn't apply here.");
    const note = el("div", "pt-watch-status",
      L("Kaarten uit packs met vraag (SBC/meta), duurste eerst. Check zelf de BIN op de markt (vul hem in de run-balk in) en haal kaarten weg die niet lopen. Zoeken, bieden en listen doe je zelf.", "Cards from packs with demand (SBC/meta), most expensive first. Check the BIN on the market yourself (enter it in the run bar) and remove cards that don't sell. You search, bid and list yourself."));
    make.addEventListener("click", () => {
      const num = input => Number(String(input.value).replace(/\D/g, "")) || 0;
      const rLow = Math.max(45, Math.min(num(ratingFrom.input), num(ratingTo.input)));
      const rHigh = Math.min(99, Math.max(num(ratingFrom.input), num(ratingTo.input)));
      const pLow = Math.min(num(priceFrom.input), num(priceTo.input));
      const pHigh = Math.max(num(priceFrom.input), num(priceTo.input));
      const size = Math.max(1, Math.min(60, num(count.input) || 15));
      const picks = getPlayerIndex()
        .filter(entry => entry.rating >= rLow && entry.rating <= rHigh)
        .map(entry => ({ entry, price: (geniePrice(entry.id) || {}).price || 0 }))
        .filter(item => item.price >= pLow && item.price <= pHigh)
        .sort((a, b) => b.price - a.price || b.entry.rating - a.entry.rating)
        .slice(0, size);
      if (!picks.length) {
        showToast(L("Geen kaarten gevonden in die rating/prijs (zijn de FUT.GG-prijzen al geladen?).", "No cards found in that rating/price (are the FUT.GG prices loaded yet?)."), false);
        return;
      }
      const percentage = Number(String(pct.input.value).replace(",", "."));
      getStock().unshift({
        id: `mb${Date.now()}`,
        type: "players",
        mode: "bid",
        massBid: { pct: percentage > 0 && percentage < 90 ? percentage : MASS_BID_DEFAULT_PCT },
        name: L(`🎯 Biedlijst ${rLow}–${rHigh} · ${priceFormat.format(pLow)}–${priceFormat.format(pHigh)}`, `🎯 Bid list ${rLow}–${rHigh} · ${priceFormat.format(pLow)}–${priceFormat.format(pHigh)}`),
        createdAt: Date.now(),
        profit: null,
        windows: [],
        players: picks.map(item => ({ definitionId: item.entry.id, name: item.entry.display, rating: item.entry.rating })),
        done: {}
      });
      saveStock();
      panel.style.display = "none";
      showToast(L(`🎯 Biedlijst gemaakt met ${picks.length} kaarten. Start hem met ▶ Start.`, `🎯 Bid list created with ${picks.length} cards. Start it with ▶ Start.`), true);
      onCreated();
    });
    makeFodder.addEventListener("click", async () => {
      const num = input => Number(String(input.value).replace(/\D/g, "")) || 0;
      const rLow = Math.max(45, Math.min(num(ratingFrom.input), num(ratingTo.input)));
      const rHigh = Math.min(99, Math.max(num(ratingFrom.input), num(ratingTo.input)));
      const size = Math.max(1, Math.min(60, num(count.input) || 15));
      makeFodder.disabled = true;
      try {
        await Promise.race([loadFutggCheapest(true), new Promise(resolve => window.setTimeout(resolve, 8000))]);
      } finally {
        makeFodder.disabled = false;
      }
      const players = [];
      for (let rating = rLow; rating <= rHigh; rating++) {
        cyclePicks(rating).slice(0, size).forEach(item => players.push({ ...fodderCyclePlayer(item, rating, null), fixedMax: null }));
      }
      if (!players.length) {
        showToast(L("Geen fodderspelers gevonden voor die ratings (zijn de FUT.GG-prijzen al geladen?).", "No fodder players found for those ratings (are the FUT.GG prices loaded yet?)."), false);
        return;
      }
      const percentage = Number(String(pct.input.value).replace(",", "."));
      getStock().unshift({
        id: `mb${Date.now()}`,
        type: "players",
        mode: "bid",
        massBid: { pct: percentage > 0 && percentage < 90 ? percentage : MASS_BID_DEFAULT_PCT, fodder: true },
        name: L(`🎯 Fodder-biedlijst ${rLow === rHigh ? rLow : `${rLow}–${rHigh}`}`, `🎯 Fodder bid list ${rLow === rHigh ? rLow : `${rLow}–${rHigh}`}`),
        createdAt: Date.now(),
        profit: null,
        windows: [],
        players,
        done: {}
      });
      saveStock();
      panel.style.display = "none";
      showToast(L(`🎯 Fodder-biedlijst gemaakt met ${players.length} kaarten (≥${MASS_BID_HOLD_PCT}% onder de prijs gewonnen = houden).`, `🎯 Fodder bid list created with ${players.length} cards (won ≥${MASS_BID_HOLD_PCT}% under the price = keep).`), true);
      onCreated();
    });
    const row = el("div", "pt-stock-list-buttons");
    row.append(ratingFrom.box, ratingTo.box, priceFrom.box, priceTo.box, count.box, pct.box, make, makeFodder);
    panel.append(row, note);
    return panel;
  }

  function buildStockSection(root) {
    const card = el("div", "pt-watch-card pt-stock-card");
    root.appendChild(card);

    const toolbar = el("div", "pt-watch-toolbar");
    const heading = el("div", "pt-watch-heading");
    heading.append(
      el("h2", "pt-watch-title", L("Stock-lijsten", "Stock lists")),
      el("div", "pt-watch-status", L("Plak een tip (clubs + prijzen) en loop de zoekopdrachten één voor één door. Zoeken en kopen doe je zelf.", "Paste a tip (clubs + prices) and go through the searches one by one. You search and buy yourself."))
    );
    const importButton = el("button", "pt-watch-refresh", L("+ Tip plakken", "+ Paste tip"));
    importButton.type = "button";
    const massBidButton = el("button", "pt-watch-refresh pt-primary", L("🎯 Biedlijst maken", "🎯 Create bid list"));
    massBidButton.type = "button";
    massBidButton.title = L("Mass bidding: kies kaarten op rating en FUT.GG PC-prijs", "Mass bidding: pick cards by rating and FUT.GG PC price");
    toolbar.append(heading, massBidButton, importButton);

    const importPanel = el("div", "pt-stock-import");
    importPanel.style.display = "none";
    const massBidPanel = buildMassBidMaker(() => renderLists());
    massBidPanel.style.display = "none";
    massBidButton.addEventListener("click", () => { massBidPanel.style.display = massBidPanel.style.display === "none" ? "" : "none"; });
    const lists = el("div", "pt-stock-lists");
    card.append(toolbar, massBidPanel, importPanel, lists);

    let lastTipText = "";

    function switchLink(toPlayers) {
      const link = el("button", "pt-link-btn", toPlayers ? L("Dit is een spelerslijst →", "This is a player list →") : L("Dit is een clublijst →", "This is a club list →"));
      link.type = "button";
      link.addEventListener("click", () => (toPlayers ? showPlayerReviewStep(parsePlayerTip(lastTipText)) : showReviewStep(parseTip(lastTipText))));
      return link;
    }

    function toLocalInput(timestamp) {
      const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000);
      return date.toISOString().slice(0, 16);
    }

    // Editable list of time windows (checkbox + from/to per window, "+ venster" to add one).
    function windowsEditor(initial, addEmptyIfNone) {
      const element = el("div", "pt-windows");
      const rows = [];
      const addRow = (span, checked) => {
        const row = el("label", "pt-stock-level");
        const check = el("input");
        check.type = "checkbox";
        check.checked = checked;
        const start = el("input", "pt-target-input pt-datetime");
        const end = el("input", "pt-target-input pt-datetime");
        start.type = "datetime-local";
        end.type = "datetime-local";
        const from = span ? span.start : Date.now() + 60 * 60 * 1000;
        start.value = toLocalInput(from);
        end.value = toLocalInput(span ? span.end : from + 15 * 60 * 1000);
        [start, end].forEach(input => input.addEventListener("input", () => { check.checked = true; }));
        row.append(check, el("span", "pt-stock-level-name", L("Venster", "Window")), start, el("span", "pt-muted", L("tot", "to")), end);
        if (span && span.timeZone && span.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone) {
          row.appendChild(el("span", "pt-muted", `(omgerekend vanuit ${span.timeZone})`));
        }
        rows.push({ check, start, end });
        element.insertBefore(row, add);
      };
      const add = el("button", "pt-link-btn", L("+ venster", "+ window"));
      add.type = "button";
      add.addEventListener("click", () => addRow(null, true));
      element.appendChild(add);
      (initial || []).forEach(span => addRow(span, true));
      if (!(initial || []).length && addEmptyIfNone) addRow(null, false);
      return {
        element,
        read: () => rows
          .filter(row => row.check.checked)
          .map(row => ({ start: new Date(row.start.value).getTime(), end: new Date(row.end.value).getTime() }))
          .filter(span => span.start && span.end > span.start)
          .sort((a, b) => a.start - b.start)
      };
    }

    function showFodderReviewStep(parsed) {
      importPanel.textContent = "";

      const settings = el("div", "pt-stock-levels");
      const modeLabel = el("label", "pt-stock-level");
      const mode = el("select", "pt-stock-select pt-mode-select");
      mode.append(new Option(L("Bieden (max bod)", "Bid (max bid)"), "bid"), new Option("Direct kopen (max BIN)", "bin"));
      mode.value = parsed.mode;
      modeLabel.append(el("span", "pt-stock-level-name", L("Zoeken op", "Search by")), mode);
      const windows = windowsEditor(parsed.windows, true);
      settings.append(modeLabel, windows.element);

      const table = el("table", "pt-watch-table pt-stock-review");
      const head = el("tr");
      [["", "pt-col-check"], ["Rating", "pt-col-raw"], ["Max", "pt-col-match"], [L("Ideaal", "Ideal"), "pt-col-league"], ["", "pt-col-status"]]
        .forEach(([label, className]) => head.appendChild(el("th", className, label)));
      const thead = el("thead");
      thead.appendChild(head);
      const body = el("tbody");
      table.append(thead, body);

      const rows = parsed.ratings.map(entry => {
        const row = el("tr", "pt-match-sure");
        const check = el("input");
        check.type = "checkbox";
        check.checked = true;
        const max = el("input", "pt-target-input");
        const ideal = el("input", "pt-target-input");
        [max, ideal].forEach(input => { input.inputMode = "numeric"; });
        max.value = entry.max || "";
        ideal.value = entry.ideal || "";
        ideal.placeholder = "—";
        const checkCell = el("td", "pt-col-check");
        checkCell.appendChild(check);
        const maxCell = el("td", "pt-col-match");
        maxCell.appendChild(max);
        const idealCell = el("td", "pt-col-league");
        idealCell.appendChild(ideal);
        row.append(checkCell, el("td", "pt-col-raw pt-watch-name", `${entry.rating}-rated goud`), maxCell, idealCell, el("td", "pt-col-status", "✓"));
        body.appendChild(row);
        return { entry, check, max, ideal };
      });

      const nameInput = el("input", "pt-target-input pt-stock-name");
      nameInput.value = `Fodder ${new Date().toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit" })}`;
      const actions = el("div", "pt-stock-actions");
      const applyToScreen = el("button", "pt-watch-refresh", "Doelen invullen in Fodder-scherm");
      const save = el("button", "pt-link-btn", L("Als aparte fodder-lijst opslaan", "Save as separate fodder list"));
      const back = el("button", "pt-link-btn", L("← Terug", "← Back"));
      [applyToScreen, save, back].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      applyToScreen.addEventListener("click", () => {
        const chosen = rows.filter(row => row.check.checked && parsePrice(row.max.value));
        if (!chosen.length) {
          message.textContent = L("Kies minstens één rating met een max-prijs.", "Pick at least one rating with a max price.");
          return;
        }
        const state = getFodder();
        chosen.forEach(row => { state.targets[row.entry.rating] = { max: parsePrice(row.max.value), ideal: parsePrice(row.ideal.value) }; });
        state.mode = mode.value;
        // Make sure the screen shows every rating from the tip.
        state.from = Math.min(state.from, ...chosen.map(row => row.entry.rating));
        state.to = Math.max(state.to, ...chosen.map(row => row.entry.rating));
        saveFodder();
        importPanel.style.display = "none";
        message.textContent = "";
      });
      save.addEventListener("click", () => {
        const ratings = rows
          .filter(row => row.check.checked && parsePrice(row.max.value))
          .map(row => ({ rating: row.entry.rating, max: parsePrice(row.max.value), ideal: parsePrice(row.ideal.value), enabled: true }));
        if (!ratings.length) {
          message.textContent = L("Kies minstens één rating met een max-prijs.", "Pick at least one rating with a max price.");
          return;
        }
        getStock().unshift({
          id: `s${Date.now()}`,
          type: "fodder",
          name: nameInput.value.trim() || L("Fodder-lijst", "Fodder list"),
          createdAt: Date.now(),
          mode: mode.value,
          windows: windows.read(),
          ratings,
          done: {}
        });
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(applyToScreen, el("span", "pt-muted", L("of", "or")), el("span", "pt-muted", "naam"), nameInput, save, back, message);

      const column = parsed.columnUsed ? L(` · prijzen uit de ${parsed.columnUsed}-kolom (jouw platform)`, ` · prices from the ${parsed.columnUsed} column (your platform)`) : "";
      importPanel.append(
        el("div", "pt-stock-summary", L(`${parsed.ratings.length} ratings gevonden${column} · bedragen in coins (6 = 6.000) · alleen gewone gouden kaarten, geen specials.`, `${parsed.ratings.length} ratings found${column} · amounts in coins (6 = 6,000) · regular gold cards only, no specials.`)),
        settings, table, actions
      );
    }

    function showTargetsStep(targets, windows) {
      importPanel.textContent = "";
      const snipeLists = getStock().filter(list => list.type === "players" && !list.fodderRating && !list.watchRun);

      const listRow = el("div", "pt-stock-actions");
      const listSelect = el("select", "pt-stock-select pt-list-select");
      snipeLists.forEach(list => listSelect.appendChild(new Option(L(`🎯 ${list.name} (${list.players.length} spelers)`, `🎯 ${list.name} (${list.players.length} players)`), list.id)));
      listRow.append(el("span", "pt-muted", L("Toepassen op", "Apply to")), listSelect);

      const windowsBox = el("div");
      const tableBox = el("div");
      let editor = null;
      let rows = [];

      const render = () => {
        const list = snipeLists.find(item => item.id === listSelect.value) || snipeLists[0];
        const assignments = assignTargets(targets, list);

        windowsBox.textContent = "";
        if (windows.length) {
          windowsBox.appendChild(el("div", "pt-muted pt-small", L("Vensters uit de post (worden toegevoegd aan de lijst; vink uit wat je niet wilt):", "Windows from the post (added to the list; untick what you don't want):")));
        }
        editor = windowsEditor(windows, false);
        windowsBox.appendChild(editor.element);

        tableBox.textContent = "";
        const table = el("table", "pt-watch-table pt-stock-review");
        const head = el("tr");
        [["", "pt-col-check"], [L("Uit de post", "From the post"), "pt-col-raw"], [L("Speler", "Player"), "pt-col-match"], ["Max BIN", "pt-col-league"], ["", "pt-col-status"]]
          .forEach(([label, className]) => head.appendChild(el("th", className, label)));
        const thead = el("thead");
        thead.appendChild(head);
        const body = el("tbody");

        rows = assignments.map(({ target, pick, sure, ranked }) => {
          const row = el("tr", `pt-match-${pick ? (sure ? "sure" : "maybe") : "none"}`);
          const check = el("input");
          check.type = "checkbox";
          check.checked = !!pick;
          const select = el("select", "pt-stock-select");
          select.appendChild(new Option("— overslaan —", ""));
          ranked.forEach(candidate => {
            const price = geniePrice(candidate.player.definitionId);
            select.appendChild(new Option(`${candidate.player.name}${price ? ` · Genie ${priceFormat.format(price.price)}` : ""}`, String(candidate.player.definitionId)));
          });
          select.value = pick ? String(pick.player.definitionId) : "";
          const max = el("input", "pt-target-input");
          max.inputMode = "numeric";
          max.value = pick ? pick.coins : targetCoins(target, null);
          const status = el("td", "pt-col-status", pick ? (sure ? "✓" : "?") : "✗");
          status.title = !pick ? L("Geen passende speler in deze lijst", "No matching player in this list")
            : sure ? L(`Gekoppeld op ${pick.reason}`, `Matched on ${pick.reason}`) : L("Twijfel: gekoppeld op prijsniveau, controleer de speler", "Doubtful: matched on price level, check the player");
          select.addEventListener("change", () => {
            check.checked = !!select.value;
            const chosen = ranked.find(candidate => String(candidate.player.definitionId) === select.value);
            if (chosen) max.value = chosen.coins;
            row.className = `pt-match-${select.value ? "sure" : "none"}`;
            status.textContent = select.value ? "✓" : "✗";
          });
          const checkCell = el("td", "pt-col-check");
          checkCell.appendChild(check);
          const selectCell = el("td", "pt-col-match");
          selectCell.appendChild(select);
          const maxCell = el("td", "pt-col-league");
          maxCell.appendChild(max);
          row.append(checkCell, el("td", "pt-col-raw", target.raw), selectCell, maxCell, status);
          body.appendChild(row);
          return { check, select, max };
        });
        table.append(thead, body);
        tableBox.appendChild(table);
      };
      listSelect.addEventListener("change", render);

      const actions = el("div", "pt-stock-actions");
      const apply = el("button", "pt-watch-refresh", "Toepassen");
      const back = el("button", "pt-link-btn", L("← Terug", "← Back"));
      const asNew = el("button", "pt-link-btn", L("Toch als nieuwe spelerslijst →", "Still as a new player list →"));
      [apply, back, asNew].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      asNew.addEventListener("click", () => showPlayerReviewStep(parsePlayerTip(lastTipText)));
      apply.addEventListener("click", () => {
        const list = snipeLists.find(item => item.id === listSelect.value) || snipeLists[0];
        let applied = 0;
        rows.forEach(row => {
          if (!row.check.checked || !row.select.value) return;
          const player = list.players.find(item => String(item.definitionId) === row.select.value);
          const coins = parsePrice(row.max.value);
          if (!player || !coins) return;
          player.fixedMax = coins;
          applied++;
        });
        const added = editor.read().filter(span => !listWindows(list).some(other => other.start === span.start && other.end === span.end));
        list.windows = listWindows(list).concat(added).sort((a, b) => a.start - b.start);
        delete list.window;
        if (!applied && !added.length) {
          message.textContent = L("Niets geselecteerd om toe te passen.", "Nothing selected to apply.");
          return;
        }
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(apply, back, asNew, message);

      importPanel.append(
        el("div", "pt-stock-summary", L(`${targets.length} prijsdoel(en) gevonden. Koppeling op naam, of op vlag + prijs als de nationaliteit bekend is, anders op prijsniveau (controleer de oranje regels).`, `${targets.length} price target(s) found. Matched by name, or by flag + price if the nationality is known, otherwise by price level (check the orange lines).`)),
        listRow, windowsBox, tableBox, actions
      );
      render();
      // Price fit needs current Genie prices; redo the matching once they're in.
      const ids = snipeLists.flatMap(list => list.players.map(player => player.definitionId));
      fetchGeniePrices(ids).then(() => { if (importPanel.contains(listSelect)) render(); });
    }

    function showPlayerReviewStep(parsed) {
      importPanel.textContent = "";

      // Time windows + profit
      const settings = el("div", "pt-stock-levels");
      const windows = windowsEditor(parsed.windows, true);

      const profitLabelEl = el("label", "pt-stock-level");
      const profit = el("input", "pt-target-input");
      profit.inputMode = "numeric";
      profit.placeholder = "auto";
      profit.style.width = "64px";
      profitLabelEl.append(el("span", "pt-stock-level-name", L("Winst", "Profit")), profit,
        el("span", "pt-muted", L(`% na 5% belasting, bij verkoop op de FUT Genie-prijs · leeg = ${DEFAULT_PROFIT}%`, `% after 5% tax, when selling at the FUT Genie price · empty = ${DEFAULT_PROFIT}%`)));
      // Holo snipe: the holo version of each card, for the normal card's price.
      let holoMode = false;
      const holoLabel = el("label", "pt-stock-level");
      const holoCheck = el("input");
      holoCheck.type = "checkbox";
      holoLabel.append(holoCheck, el("span", "pt-stock-level-name", "✨ Holo's"),
        el("span", "pt-muted", L("op de prijs van de normale kaart (max BIN = Genie-prijs van de normale versie)", "on the price of the normal card (max BIN = Genie price of the normal version)")));
      holoCheck.addEventListener("change", () => {
        holoMode = holoCheck.checked;
        rows.forEach(row => row.applyHolo());
      });
      settings.append(windows.element, profitLabelEl, holoLabel);

      // Players
      const table = el("table", "pt-watch-table pt-stock-review");
      const head = el("tr");
      const priced = parsed.players.some(item => item.priced);
      if (priced) table.classList.add("pt-stock-priced");
      [["", "pt-col-check"], [L("Uit de tip", "From the tip"), "pt-col-raw"], [L("Herkend als", "Recognised as"), "pt-col-match"], ["Kaartversie · Genie (PC)", "pt-col-league"],
        ...(priced ? [[`Max BIN (${parsed.platform === "pc" ? "PC" : "console"})`, "pt-col-level"]] : []), ["", "pt-col-status"]]
        .forEach(([label, className]) => head.appendChild(el("th", className, label)));
      const thead = el("thead");
      thead.appendChild(head);
      const body = el("tbody");
      table.append(thead, body);

      const index = getPlayerIndex();
      const rows = parsed.players.map(item => {
        const row = el("tr", `pt-match-${item.status}`);
        const check = el("input");
        check.type = "checkbox";
        check.checked = item.status !== "none" && !item.skip;
        const select = el("select", "pt-stock-select");
        select.appendChild(new Option("— overslaan —", ""));
        item.candidates.forEach(player => select.appendChild(new Option(`${player.display} · ${player.rating}`, String(player.id))));
        // Tip price for your platform; "skip" leaves the card unticked.
        const maxInput = el("input", "pt-target-input");
        maxInput.inputMode = "numeric";
        maxInput.value = item.fixedMax || "";
        maxInput.placeholder = item.skip ? "skip" : "auto";
        const maxCell = el("td", "pt-col-level");
        maxCell.appendChild(maxInput);
        select.value = item.player ? String(item.player.id) : "";
        const priceCell = el("td", "pt-col-league pt-muted");
        const statusCell = el("td", "pt-col-status");
        // Card versions of the chosen player (tips with a rating): a dropdown like "Team of the Week 88 · Genie 103.000".
        const versionSelect = el("select", "pt-stock-select");
        const versionState = { playerId: null, versions: [] };
        const sync = () => {
          const player = index.find(entry => String(entry.id) === select.value) || null;
          if (!player) check.checked = false;
          const entry = player && geniePrice(player.id);
          const special = isSpecialFor(player, item.tipRating);
          if (player && versionState.playerId === player.id && versionState.versions.length) {
            const chosen = versionSelect.value;
            versionSelect.textContent = "";
            // No version with the tip rating (yet): search quality Special for that player.
            if (special) versionSelect.appendChild(new Option(L(`Speciaal ${item.tipRating} · versie onbekend`, `Special ${item.tipRating} · version unknown`), ""));
            versionState.versions.forEach(version => versionSelect.appendChild(new Option(versionLabel(version, player.id), String(version.definitionId))));
            versionSelect.value = chosen;
            if (versionSelect.selectedIndex < 0) versionSelect.selectedIndex = 0;
            if (!priceCell.contains(versionSelect)) {
              priceCell.textContent = "";
              priceCell.appendChild(versionSelect);
            }
          } else {
            // Genie only prices the regular card; a special's price comes from the tip.
            priceCell.textContent = special ? `special ${item.tipRating} (gewoon ${player.rating})${item.priced ? " · versies…" : ""}` : entry ? priceFormat.format(entry.price) : player ? "…" : "";
          }
          statusCell.textContent = !player ? "✗" : item.status === "sure" ? "✓" : "?";
          statusCell.title = !player ? L("Niet herkend / overgeslagen", "Not recognised / skipped") : item.status === "sure" ? "Zeker" : L("Twijfel: controleer of dit de juiste speler is", "Doubtful: check this is the right player");
          return player;
        };
        select.addEventListener("change", () => {
          check.checked = !!select.value;
          item.status = select.value ? "sure" : "none";
          row.className = `pt-match-${item.status}`;
          sync();
          fetchGeniePrices([Number(select.value)]).then(sync);
          if (select.value) loadVersions();
        });
        let firstLoad = true;
        const loadVersions = async () => {
          let player = index.find(entry => String(entry.id) === select.value);
          if (!player) return;
          // First time: also the name lookalikes, and switch to one that has a card with the tip rating.
          const pool = firstLoad && item.tipRating ? [player, ...(item.lookalikes || []).filter(entry => entry.id !== player.id)] : [player];
          firstLoad = false;
          const chosenId = select.value;
          const byPlayer = await cardVersionsMany(pool.map(entry => entry.id));
          if (select.value !== chosenId) return; // another player was chosen meanwhile
          const hasRating = entry => (byPlayer.get(entry.id) || []).some(version => version.rating === item.tipRating);
          const withRating = pool.filter(hasRating);
          // Several lookalikes with such a card: the one whose Genie price fits the tip ("Martin-85 <86" is not
          // Emiliano Martínez's 3.600 regular card). The name match itself gets a small head start.
          if (withRating.length > 1 && item.fitCoins) {
            await fetchGeniePrices(withRating.flatMap(entry => byPlayer.get(entry.id).filter(version => version.rating === item.tipRating).map(version => version.definitionId)));
            const fit = entry => versionCost(pickVersion(byPlayer.get(entry.id), item.tipRating, item.fitCoins), item.fitCoins) - (entry.id === player.id ? 0.1 : 0);
            withRating.sort((a, b) => fit(a) - fit(b));
          }
          if (select.value !== chosenId) return;
          if (withRating.length && withRating[0].id !== player.id) {
            const better = withRating[0];
            if (![...select.options].some(option => option.value === String(better.id))) {
              select.appendChild(new Option(`${better.display} · ${better.rating}`, String(better.id)));
            }
            select.value = String(better.id);
            player = better;
            item.status = "maybe";
            row.className = "pt-match-maybe";
            check.checked = !item.skip;
          }
          const versions = byPlayer.get(player.id) || [];
          await fetchGeniePrices(versions.map(version => version.definitionId));
          if (select.value !== String(player.id)) return;
          // No rating in the tip: the regular card, unless the tip price is far from it and another version fits.
          const pick = item.tipRating ? pickVersion(versions, item.tipRating, parsePrice(maxInput.value) || item.fitCoins)
            : pickUnratedVersion(versions, player.id, parsePrice(maxInput.value) || item.fitCoins);
          versionState.playerId = player.id;
          versionState.versions = versions;
          versionSelect.value = "";
          sync();
          versionSelect.value = pick ? String(pick.definitionId) : "";
          if (versionSelect.selectedIndex < 0) versionSelect.selectedIndex = 0;
          applyHolo();
        };
        // Holo mode: the holo twin of the chosen card, max BIN = the normal card's Genie price.
        const applyHolo = () => {
          if (!versionState.versions.length) return;
          const chosen = versionState.versions.find(entry => String(entry.definitionId) === versionSelect.value) || null;
          const normal = isHolo(chosen) ? holoTwin(versionState.versions, chosen) : chosen;
          const holoCard = normal ? holoTwin(versionState.versions, normal) : null;
          if (holoMode) {
            if (holoCard) {
              versionSelect.value = String(holoCard.definitionId);
              const normalPrice = (geniePrice(normal.definitionId) || {}).price;
              if (normalPrice) maxInput.value = roundDownToStep(normalPrice);
              versionSelect.title = "";
            } else {
              versionSelect.title = L("Geen holo-versie van deze kaart gevonden", "No holo version of this card found");
              check.checked = false;
            }
          } else {
            if (isHolo(chosen) && normal) versionSelect.value = String(normal.definitionId);
            maxInput.value = item.fixedMax || "";
            versionSelect.title = "";
          }
        };
        const checkCell = el("td", "pt-col-check");
        checkCell.appendChild(check);
        const selectCell = el("td", "pt-col-match");
        selectCell.appendChild(select);
        row.append(checkCell, el("td", "pt-col-raw", item.raw), selectCell, priceCell, ...(priced ? [maxCell] : []), statusCell);
        body.appendChild(row);
        sync();
        // The chosen version, when the versions of the selected player are known.
        const version = () => {
          const player = index.find(entry => String(entry.id) === select.value);
          return player && versionState.playerId === player.id
            ? versionState.versions.find(entry => String(entry.definitionId) === versionSelect.value) || null
            : null;
        };
        // The normal card of a chosen holo (its Genie price is the max BIN).
        const normalOf = () => {
          const chosen = version();
          return isHolo(chosen) ? holoTwin(versionState.versions, chosen) : null;
        };
        return { check, select, sync, maxInput, tipRating: item.tipRating, priced: item.priced, loadVersions, version, applyHolo, normalOf };
      });
      fetchGeniePrices(parsed.players.filter(item => item.player).map(item => item.player.id))
        .then(() => rows.forEach(row => row.sync()));
      // Versions one player at a time, with a pause like the club searches.
      (async () => {
        const pricedRows = rows.filter(row => row.select.value);
        await loadHoloCatalogue();
        for (let i = 0; i < pricedRows.length; i++) {
          // The first wait also lets the table reach the page; stop when the review step was left.
          await new Promise(resolve => window.setTimeout(resolve, i ? CLUB_SEARCH_DELAY_MS : 0));
          if (!importPanel.contains(table)) return;
          await pricedRows[i].loadVersions();
        }
      })();

      const nameInput = el("input", "pt-target-input pt-stock-name");
      nameInput.value = `Snipe ${new Date(parsed.windows.length ? parsed.windows[0].start : Date.now()).toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit" })}`;
      const actions = el("div", "pt-stock-actions");
      const save = el("button", "pt-watch-refresh", L("Opslaan als snipe-lijst", "Save as snipe list"));
      const back = el("button", "pt-link-btn", L("← Terug", "← Back"));
      [save, back].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      save.addEventListener("click", () => {
        const seen = new Set();
        const players = rows
          .filter(row => row.check.checked && row.select.value)
          .map(row => ({ player: index.find(entry => String(entry.id) === row.select.value), version: row.version(), normal: row.normalOf(),
            fixedMax: parsePrice(row.maxInput.value), tipRating: row.tipRating }))
          .filter(({ player, version }) => player && !seen.has(version ? version.definitionId : player.id) && seen.add(version ? version.definitionId : player.id))
          .map(({ player, version, normal, fixedMax, tipRating }) => {
            if (version && isHolo(version)) {
              // Holo: its own id, the normal twin's id for the price (max BIN = normal card's Genie price).
              return { definitionId: version.definitionId, name: `${player.display} ${version.rating} ${rarityName(version.rarity)} ✨ Holo`,
                rating: version.rating, special: version.definitionId !== player.id, rarity: version.rarity, holo: true,
                normalId: normal ? normal.definitionId : null, fixedMax: holoMode ? null : fixedMax };
            }
            if (version && version.definitionId !== player.id) {
              // The exact version: its own id (Genie price, stock count) and rarity for the market filter.
              return { definitionId: version.definitionId, name: `${player.display} ${version.rating} ${rarityName(version.rarity)}`,
                rating: version.rating, special: true, rarity: version.rarity, fixedMax };
            }
            if (!version && isSpecialFor(player, tipRating)) {
              return { definitionId: player.id, name: `${player.display} ${tipRating}`, rating: tipRating, special: true, fixedMax };
            }
            return { definitionId: player.id, name: player.display, rating: player.rating, fixedMax };
          });
        if (!players.length) {
          message.textContent = L("Kies minstens één speler.", "Pick at least one player.");
          return;
        }
        const price = player => player.fixedMax || (geniePrice(player.definitionId) || { price: 0 }).price;
        players.sort((a, b) => price(b) - price(a)); // higher cost cards first
        const profitValue = profit.value.trim() === "" ? null : Number(profit.value.replace(",", "."));
        getStock().unshift({
          id: `s${Date.now()}`,
          type: "players",
          name: nameInput.value.trim() || L("Snipe-lijst", "Snipe list"),
          createdAt: Date.now(),
          profit: Number.isFinite(profitValue) ? profitValue : null,
          windows: windows.read(),
          players,
          holo: holoMode || players.some(player => player.holo),
          ...(parsed.discard ? { discard: true, mode: "bid" } : {}),
          done: {}
        });
        saveStock();
        const added = addPlayersToWatch(players);
        showToast(L(`Snipe-lijst opgeslagen · ${added} speler(s) ook op de Spelers-tab gezet`, `Snipe list saved · ${added} player(s) also added to the Players tab`), true);
        importPanel.style.display = "none";
      });
      actions.append(el("span", "pt-muted", L("Naam", "Name")), nameInput, save, back, message);

      const recognised = parsed.players.filter(item => item.status === "sure").length;
      const doubtful = parsed.players.filter(item => item.status === "maybe").length;
      const summary = el("div", "pt-stock-summary", L(`${parsed.players.length} spelers gevonden · ${recognised} zeker · ${doubtful} twijfel (oranje)`, `${parsed.players.length} players found · ${recognised} certain · ${doubtful} doubtful (orange)`) +
        (parsed.skipped ? L(` · ${parsed.skipped} regel(s) zonder speler overgeslagen`, ` · ${parsed.skipped} line(s) without a player skipped`) : "") + L(" · gewone kaart, duurste eerst. ", " · regular card, most expensive first. ") +
        (parsed.discard ? L("🗑️ Discard-tip: bied-lijst, max bod = quick-sell-waarde van de rating (goud nooit onder 600, de laagste marktprijs); duurdere kaarten (> quick-sell + 200) prijs − 150. ", "🗑️ Discard tip: bid list, max bid = quick-sell value of the rating (gold never below 600, the lowest market price); more expensive cards (> quick-sell + 200) price − 150. ") : ""));
      summary.appendChild(switchLink(false));
      importPanel.append(summary, settings, table, actions);
    }

    importButton.addEventListener("click", () => {
      importPanel.style.display = importPanel.style.display === "none" ? "" : "none";
      if (importPanel.style.display === "") showPasteStep();
    });

    function showPasteStep() {
      importPanel.textContent = "";
      const area = el("textarea", "pt-stock-textarea");
      area.placeholder = L("Plak hier het bericht, bijv.\n\nMLS\nChicago Fire\nLA Galaxy\n\nGolds <650-700\nSilvers <600-700", "Paste the message here, e.g.\n\nMLS\nChicago Fire\nLA Galaxy\n\nGolds <650-700\nSilvers <600-700");
      const actions = el("div", "pt-stock-actions");
      const analyse = el("button", "pt-watch-refresh", "Analyseren");
      const cancel = el("button", "pt-link-btn", "Annuleren");
      [analyse, cancel].forEach(button => { button.type = "button"; });
      analyse.addEventListener("click", () => {
        lastTipText = area.value;
        // Read the tip both ways and keep whichever recognises more; price lines ("Golds <700") favour clubs.
        const asClubs = parseTip(area.value);
        const asPlayers = parsePlayerTip(area.value);
        const targets = parseTargetLines(area.value);
        const clubScore = asClubs.clubs.filter(item => item.status === "sure").length + (looksLikeClubTip(area.value) ? 3 : 0);
        const playerScoreTotal = asPlayers.players.filter(item => item.status === "sure").length;
        const snipeLists = getStock().filter(list => list.type === "players" && !list.fodderRating && !list.watchRun);
        const asFodder = parseFodderTip(area.value);
        const asFilters = parseFilterTip(area.value);
        // Rating-based fodder prices ("87s <6 / <6.5").
        if (asPlayers.players.filter(item => item.priced).length >= 2) {
          // Names with rating and prices ("Hemp-88 <110 / <100pc"): a new snipe list with fixed max BINs.
          showPlayerReviewStep(asPlayers);
        } else if (asFilters.grouped) {
          // Nations per match ("Italy vs France") or "Top 5 leagues and nations": filter rules without a price.
          showFilterReviewStep(asFilters);
        } else if (asFodder.ratings.length >= 2) {
          showFodderReviewStep(asFodder);
        } else if (asFilters.rules.some(rule => rule.nation) && !asClubs.sections) {
          // Nation + league + quality + positions ("Silver RB England <650/700 ideally prem").
          showFilterReviewStep(asFilters);
        } else if (targets.length && snipeLists.length && targets.length >= playerScoreTotal && !looksLikeClubTip(area.value)) {
          // A follow-up with prices per card ("<230 🇪🇸") for an existing snipe list.
          showTargetsStep(targets, asPlayers.windows);
        } else if (clubScore > playerScoreTotal) showReviewStep(asClubs);
        else showPlayerReviewStep(asPlayers);
      });
      cancel.addEventListener("click", () => { importPanel.style.display = "none"; });
      actions.append(analyse, cancel);
      importPanel.append(area, actions);
      area.focus();
    }

    function showReviewStep(parsed) {
      importPanel.textContent = "";

      // Price levels
      const levelBox = el("div", "pt-stock-levels");
      const levelInputs = {};
      LEVELS.forEach(level => {
        const box = el("label", "pt-stock-level");
        const check = el("input");
        check.type = "checkbox";
        check.checked = parsed.levels[level].enabled;
        const max = el("input", "pt-target-input");
        max.value = parsed.levels[level].max || "";
        max.placeholder = "max BIN";
        const ideal = el("input", "pt-target-input");
        ideal.value = parsed.levels[level].ideal || "";
        ideal.placeholder = L("ideaal", "ideal");
        [max, ideal].forEach(input => { input.inputMode = "numeric"; input.addEventListener("input", () => { check.checked = !!parsePrice(max.value); }); });
        box.append(check, el("span", "pt-stock-level-name", LEVEL_LABEL[level]), el("span", "pt-muted", "max"), max, el("span", "pt-muted", L("ideaal", "ideal")), ideal);
        levelInputs[level] = { check, max, ideal };
        levelBox.appendChild(box);
      });

      // Lazy flip ("buy 50-100c under market and list +300-900c"): max BIN above = where the market may sit.
      const flipBox = el("label", "pt-stock-level");
      const flipCheck = el("input");
      flipCheck.type = "checkbox";
      flipCheck.checked = !!parsed.flip;
      const flipValues = parsed.flip || FLIP_DEFAULT;
      const flipInput = value => {
        const input = el("input", "pt-target-input");
        input.inputMode = "numeric";
        input.value = value;
        return input;
      };
      const flipUnder = flipInput(flipValues.under);
      const flipLow = flipInput(flipValues.sellLow);
      const flipHigh = flipInput(flipValues.sellHigh);
      flipBox.title = L("Eerst zie je de markt (filter tot de max BIN hierboven). Vul de goedkoopste BIN in de balk in; ", "First you see the market (filtered up to the max BIN above). Enter the cheapest BIN in the bar; ") +
        L("daarna wordt het filter markt min dit bedrag en zie je je verkoopprijzen.", "then the filter becomes market minus this amount and you see your sell prices.");
      flipBox.append(flipCheck, el("span", "pt-stock-level-name", "Lazy flip"), el("span", "pt-muted", L("markt −", "market −")), flipUnder,
        el("span", "pt-muted", L("verkoop +", "sell +")), flipLow, el("span", "pt-muted", L("tot +", "to +")), flipHigh);
      levelBox.appendChild(flipBox);

      // Clubs
      const table = el("table", "pt-watch-table pt-stock-review");
      const head = el("tr");
      [["", "pt-col-check"], [L("Uit de tip", "From the tip"), "pt-col-raw"], [L("Herkend als", "Recognised as"), "pt-col-match"], [L("Competitie", "League"), "pt-col-league"],
        ...(parsed.sections ? [["Kwaliteit", "pt-col-level"]] : []), ["", "pt-col-status"]]
        .forEach(([label, className]) => head.appendChild(el("th", className, label)));
      const thead = el("thead");
      thead.appendChild(head);
      const body = el("tbody");
      table.append(thead, body);

      const rows = parsed.clubs.map(item => {
        const row = el("tr", `pt-match-${item.status}`);
        const check = el("input");
        check.type = "checkbox";
        check.checked = item.status !== "none";
        const select = el("select", "pt-stock-select");
        select.appendChild(new Option("— overslaan —", ""));
        const seen = new Set();
        item.candidates.forEach(club => {
          if (seen.has(club.teamId)) return;
          seen.add(club.teamId);
          select.appendChild(new Option(`${club.teamName} (${club.leagueName.replace(/\s*\(.*\)/, "")})`, String(club.teamId)));
        });
        select.value = item.club ? String(item.club.teamId) : "";
        const league = el("td", "pt-col-league pt-muted");
        const statusCell = el("td", "pt-col-status");
        const sync = () => {
          const club = getClubIndex().clubs.find(c => String(c.teamId) === select.value) || null;
          league.textContent = club ? club.leagueName : "";
          if (!club) check.checked = false;
          statusCell.textContent = !club ? "✗" : item.status === "sure" ? "✓" : "?";
          statusCell.title = !club ? L("Niet herkend / overgeslagen", "Not recognised / skipped") : item.status === "sure" ? "Zeker" : L("Twijfel: controleer of dit de juiste club is", "Unsure: check that this is the right club");
          return club;
        };
        select.addEventListener("change", () => { check.checked = !!select.value; item.status = select.value ? "sure" : "none"; row.className = `pt-match-${item.status}`; sync(); });
        const checkCell = el("td", "pt-col-check");
        checkCell.appendChild(check);
        const selectCell = el("td", "pt-col-match");
        selectCell.appendChild(select);
        // Tip with "SILVER OPTIONS" / "BRONZE OPTIONS" blocks: the club only gets its block's quality.
        const level = el("select", "pt-stock-select");
        level.appendChild(new Option(L("Alle", "All"), ""));
        LEVELS.forEach(value => level.appendChild(new Option(LEVEL_LABEL[value], value)));
        level.value = item.level || "";
        const levelCell = el("td", "pt-col-level");
        levelCell.appendChild(level);
        row.append(checkCell, el("td", "pt-col-raw", item.raw), selectCell, league, ...(parsed.sections ? [levelCell] : []), statusCell);
        body.appendChild(row);
        sync();
        return { check, select, level };
      });

      const nameInput = el("input", "pt-target-input pt-stock-name");
      nameInput.value = `Tip ${new Date().toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit" })}`;
      const actions = el("div", "pt-stock-actions");
      const save = el("button", "pt-watch-refresh", L("Opslaan als stock-lijst", "Save as stock list"));
      const back = el("button", "pt-link-btn", L("← Terug", "← Back"));
      [save, back].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      save.addEventListener("click", () => {
        const levels = {};
        LEVELS.forEach(level => {
          const input = levelInputs[level];
          const max = parsePrice(input.max.value);
          levels[level] = { enabled: input.check.checked && !!max, max, ideal: parsePrice(input.ideal.value) };
        });
        // A club in both the silver and the bronze block becomes one club with both qualities.
        const byTeam = new Map();
        rows.filter(row => row.check.checked && row.select.value).forEach(row => {
          const club = getClubIndex().clubs.find(c => String(c.teamId) === row.select.value);
          if (!club) return;
          const level = parsed.sections ? row.level.value || null : null;
          const known = byTeam.get(club.teamId);
          if (!known) {
            const { teamId, teamName, leagueId, leagueName } = club;
            byTeam.set(teamId, { teamId, teamName, leagueId, leagueName, ...(level ? { levels: [level] } : {}) });
          } else if (!level) delete known.levels;
          else if (known.levels && !known.levels.includes(level)) known.levels.push(level);
        });
        const clubs = [...byTeam.values()];
        if (!clubs.length || !LEVELS.some(level => levels[level].enabled)) {
          message.textContent = L("Kies minstens één club en één kwaliteit met een max BIN.", "Pick at least one club and one quality with a max BIN.");
          return;
        }
        const missing = LEVELS.filter(level => !levels[level].enabled && clubs.some(club => club.levels && club.levels.includes(level)));
        if (missing.length) {
          message.textContent = L(`Vul ook een max BIN in voor ${missing.map(level => LEVEL_LABEL[level]).join(" en ")}.`, `Also enter a max BIN for ${missing.map(level => LEVEL_LABEL[level]).join(" and ")}.`);
          return;
        }
        const under = parsePrice(flipUnder.value);
        const sellLow = parsePrice(flipLow.value);
        const flip = flipCheck.checked && under && sellLow
          ? { under, sellLow, sellHigh: Math.max(sellLow, parsePrice(flipHigh.value) || sellLow) }
          : null;
        getStock().unshift({ id: `s${Date.now()}`, name: nameInput.value.trim() || L("Stock-lijst", "Stock list"), createdAt: Date.now(), levels, clubs, done: {},
          ...(flip ? { flip, market: {} } : {}) });
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(el("span", "pt-muted", L("Naam", "Name")), nameInput, save, back, message);

      const recognised = parsed.clubs.filter(item => item.status === "sure").length;
      const doubtful = parsed.clubs.filter(item => item.status === "maybe").length;
      const summary = el("div", "pt-stock-summary", L(`${parsed.clubs.length} clubs gevonden · ${recognised} zeker · ${doubtful} twijfel (oranje) · controleer en sla op. `, `${parsed.clubs.length} clubs found · ${recognised} sure · ${doubtful} unsure (orange) · check and save. `));
      summary.appendChild(switchLink(true));
      importPanel.append(summary, levelBox, table, actions);
    }

    // Editor for one filter rule (review step and saved lists share it). Calls onChange after each edit.
    function filterRuleEditor(rule, onChange) {
      const box = el("div", "pt-filter-edit");

      const level = el("select", "pt-stock-select pt-mode-select");
      if (rule.kind === "manager") level.appendChild(new Option(L("Alle kwaliteiten", "All qualities"), ""));
      LEVELS.forEach(value => level.appendChild(new Option(LEVEL_LABEL[value], value)));
      level.value = rule.level || "";
      let discardHint = () => {};
      level.addEventListener("change", () => { rule.level = level.value || null; discardHint(); onChange(); });

      const positions = el("input", "pt-target-input pt-filter-positions");
      positions.value = rule.positions.join("/");
      positions.placeholder = L("alle posities", "all positions");
      positions.title = L("Posities, gescheiden door / (bijv. GK/LB/RB). Leeg = alle posities.", "Positions, separated by / (e.g. GK/LB/RB). Empty = all positions.");
      positions.addEventListener("change", () => {
        rule.positions = [...new Set((positions.value.toUpperCase().match(POSITION_WORD) || []))];
        positions.value = rule.positions.join("/");
        onChange();
      });

      const nation = el("select", "pt-stock-select pt-filter-nation");
      nation.appendChild(new Option(L("— alle landen —", "— all countries —"), ""));
      getNations().forEach(item => nation.appendChild(new Option(item.label, String(item.id))));
      nation.value = rule.nation ? String(rule.nation.id) : "";
      nation.addEventListener("change", () => {
        const item = getNations().find(entry => String(entry.id) === nation.value);
        rule.nation = item ? { id: item.id, label: item.label } : null;
        onChange();
      });

      const leagues = el("span", "pt-filter-leagues");
      const drawLeagues = () => {
        leagues.textContent = "";
        rule.leagues.forEach(league => {
          const chip = el("button", "pt-link-btn pt-filter-chip", `${league.label} ✕`);
          chip.type = "button";
          chip.title = "Competitie weghalen";
          chip.addEventListener("click", () => {
            rule.leagues = rule.leagues.filter(other => other.id !== league.id);
            if (!rule.leagues.length) rule.leaguesOptional = false;
            drawLeagues();
            onChange();
          });
          leagues.appendChild(chip);
        });
        const add = el("select", "pt-stock-select pt-filter-add");
        add.appendChild(new Option(rule.leagues.length ? "+ competitie" : L("alle competities (+ kiezen)", "all leagues (+ pick)"), ""));
        getClubIndex().leagues.filter(league => !rule.leagues.some(other => other.id === league.id))
          .forEach(league => add.appendChild(new Option(league.label.replace(/\s*\(.*\)/, ""), String(league.id))));
        add.addEventListener("change", () => {
          const id = Number(add.value);
          if (!id) return;
          rule.leagues.push({ id, label: leagueLabel(id) });
          drawLeagues();
          onChange();
        });
        leagues.appendChild(add);
        if (rule.leagues.length) {
          const optionalLabel = el("label", "pt-muted pt-filter-optional");
          const optional = el("input");
          optional.type = "checkbox";
          optional.checked = !!rule.leaguesOptional;
          optional.addEventListener("change", () => { rule.leaguesOptional = optional.checked; onChange(); });
          optionalLabel.title = L("Aan = eerst in deze competitie(s) zoeken, daarna nog één keer zonder competitie (\"ideally prem\")", "On = search these league(s) first, then once more without a league (\"ideally prem\")");
          optionalLabel.append(optional, document.createTextNode(L(" ideaal, ook zonder", " ideal, also without")));
          leagues.appendChild(optionalLabel);
        }
      };
      drawLeagues();

      const max = el("input", "pt-target-input");
      const ideal = el("input", "pt-target-input");
      [max, ideal].forEach(input => { input.inputMode = "numeric"; });
      max.value = rule.max || "";
      max.placeholder = "max BIN";
      discardHint = () => {
        if (rule.priceNote !== "discard") return;
        const learned = rule.kind !== "manager" && rule.level ? discardFor(rule.level) : null;
        max.placeholder = learned ? `discard ${priceFormat.format(learned)}` : "quick-sell";
        max.title = learned
          ? L(`"At discard": leeg = quick-sell-waarde van de laagste ${LEVEL_LABEL[rule.level].toLowerCase()}e rating (${priceFormat.format(learned)}, geleerd uit kaarten die je zag). Vul zelf iets in om dat te overschrijven.`, `"At discard": empty = quick-sell value of the lowest ${LEVEL_LABEL[rule.level].toLowerCase()} rating (${priceFormat.format(learned)}, learned from cards you saw). Enter something yourself to override it.`)
          : L("\"At discard\": quick-sell-waarde nog onbekend. Zoek één keer op de markt naar deze kwaliteit (laagste rating, bv. 75 goud) of vul hem zelf in.", "\"At discard\": quick-sell value not known yet. Search the market once for this quality (lowest rating, e.g. 75 gold) or enter it yourself.");
      };
      discardHint();
      ideal.value = rule.ideal || "";
      ideal.placeholder = L("ideaal", "ideal");
      max.addEventListener("change", () => { rule.max = parsePrice(max.value); onChange(); });
      ideal.addEventListener("change", () => { rule.ideal = parsePrice(ideal.value); onChange(); });

      if (rule.kind === "manager") positions.style.display = "none";
      box.append(level, positions, nation, leagues, el("span", "pt-muted", "max"), max, el("span", "pt-muted", L("ideaal", "ideal")), ideal);
      return box;
    }

    function showFilterReviewStep(parsed) {
      importPanel.textContent = "";
      const rules = parsed.rules;
      const container = el("div", "pt-filter-review");
      const draw = () => {
        container.textContent = "";
        rules.forEach(rule => {
          const row = el("div", `pt-filter-rule pt-match-${(rule.nation || rule.leagues.length) && ruleMax(rule) ? "sure" : "maybe"}`);
          const head = el("label", "pt-filter-raw");
          const check = el("input");
          check.type = "checkbox";
          check.checked = rule.enabled !== false;
          check.addEventListener("change", () => { rule.enabled = check.checked; });
          head.append(check, el("span", "", ` ${rule.raw}`));
          const steps = el("div", "pt-muted pt-small");
          const updateSteps = () => {
            const count = filterSteps(rule).length;
            steps.textContent = L(`${count} zoekopdracht${count === 1 ? "" : "en"}: `, `${count} search${count === 1 ? "" : "es"}: `) + filterSteps(rule).map(filterStepLabel).join(" · ") +
              (rule.unknown && rule.unknown.length ? L(` · niet herkend: "${rule.unknown.join("\", \"")}"`, ` · not recognised: "${rule.unknown.join("\", \"")}"`) : "") +
              (rule.max ? "" : ruleMax(rule) ? L(` · max = discard ${priceFormat.format(ruleMax(rule))} (quick-sell, nooit onder de laagste marktprijs)`, ` · max = discard ${priceFormat.format(ruleMax(rule))} (quick-sell, never below the lowest market price)`) : L(" · geen max BIN: je ziet de hele markt", " · no max BIN: you see the whole market")) +
              (rule.priceNote === "discard" && !ruleMax(rule) ? L(" · ⚠ \"at discard\": quick-sell-waarde nog onbekend — zoek één keer naar deze kwaliteit op de markt, of vul hem zelf in", " · ⚠ \"at discard\": quick-sell value not known yet — search the market once for this quality, or enter it yourself") : "") +
              (rule.note ? ` · ${rule.note}` : "");
          };
          updateSteps();
          row.append(head, filterRuleEditor(rule, updateSteps), steps);
          container.appendChild(row);
        });
      };
      draw();

      const nameInput = el("input", "pt-target-input pt-stock-name");
      nameInput.value = `Filters ${new Date().toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit" })}`;
      const actions = el("div", "pt-stock-actions");
      const save = el("button", "pt-watch-refresh", L("Opslaan als filterlijst", "Save as filter list"));
      const back = el("button", "pt-link-btn", L("← Terug", "← Back"));
      [save, back].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      save.addEventListener("click", () => {
        // Without a max BIN the filter shows the whole market (tips like "if buy now isn't profitable, move on").
        const chosen = rules.filter(rule => rule.enabled !== false && (rule.nation || rule.leagues.length));
        if (!chosen.length) {
          message.textContent = L("Kies minstens één regel met een land (of competitie).", "Pick at least one rule with a country (or league).");
          return;
        }
        chosen.forEach(rule => { delete rule.unknown; });
        getStock().unshift({
          id: `s${Date.now()}`,
          type: "filters",
          name: nameInput.value.trim() || "Filterlijst",
          createdAt: Date.now(),
          platform: parsed.platform,
          rules: chosen,
          done: {}
        });
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(el("span", "pt-muted", L("Naam", "Name")), nameInput, save, back, message);

      const summary = el("div", "pt-stock-summary", L(`${rules.length} filterregel(s) gevonden · per positie en competitie wordt één transfermarkt-filter klaargezet (zoeken doe je zelf) · controleer en sla op.`, `${rules.length} filter rule(s) found · one transfer market filter is prepared per position and league (you search yourself) · check and save.`));
      importPanel.append(summary);
      if (parsed.platform === "console" && userPlatform() === "pc") {
        importPanel.appendChild(el("div", "pt-stock-summary pt-loss", L("⚠ Deze prijzen zijn voor console (@console). Op PC liggen ze vaak anders: pas max/ideaal zo nodig aan.", "⚠ These prices are for console (@console). On PC they often differ: adjust max/ideal if needed.")));
      }
      importPanel.append(container, actions);
    }

    function buildFilterGrid(list, rules, active) {
      const wrap = el("div", "pt-filter-review");
      list.rules.forEach(rule => {
        const row = el("div", "pt-filter-rule" + (rule.enabled === false ? " pt-filter-off" : ""));
        const head = el("div", "pt-filter-head");
        const check = el("input");
        check.type = "checkbox";
        check.checked = rule.enabled !== false;
        check.title = L("Regel meenemen in de ronde", "Include rule in the round");
        check.addEventListener("change", () => { rule.enabled = check.checked; saveStock(); });
        head.append(check, el("span", "pt-watch-name", ` ${filterRuleTitle(rule)}`));
        const detail = inventoryDetail(summarizeBucket(list.inventory && list.inventory.rules[`f${rule.id}`]), list.goal);
        if (detail) head.appendChild(detail);

        const steps = el("div", "pt-filter-steps");
        rules.forEach((step, index) => {
          if (step.filter !== rule) return;
          const done = list.done && list.done[step.key];
          const current = active && run.index === index;
          const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""),
            `${done ? "✓ " : "🔍 "}${filterStepLabel(step)}`);
          button.type = "button";
          button.title = L(`${filterRuleTitle(rule)} · ${filterStepLabel(step)} · max BIN ${ruleMax(rule) ? priceFormat.format(ruleMax(rule)) : "—"}${!rule.max && ruleMax(rule) ? " (quick-sell)" : ""} klaarzetten`, `${filterRuleTitle(rule)} · ${filterStepLabel(step)} · max BIN ${ruleMax(rule) ? priceFormat.format(ruleMax(rule)) : "—"}${!rule.max && ruleMax(rule) ? " (quick-sell)" : ""} ready`) +
            (done ? L(` (eerder om ${formatTime(done)})`, ` (earlier at ${formatTime(done)})`) : "");
          button.addEventListener("click", () => goToRule(list.id, index));
          steps.appendChild(button);
        });
        row.append(head, filterRuleEditor(rule, saveStock), steps);
        wrap.appendChild(row);
      });
      return wrap;
    }

    function buildFodderGrid(list, rules, active) {
      const grid = el("table", "pt-watch-table pt-stock-grid pt-snipe-grid");
      const head = el("tr");
      const what = list.mode === "bid" ? L("Max bod", "Max bid") : "Max BIN";
      [["Rating", "pt-col-name"], [what, "pt-col-target"], [L("Ideaal", "Ideal"), "pt-col-price"], ["", "pt-col-level"], [L("Voorraad", "Stock"), "pt-col-stock"]]
        .forEach(([label, className]) => head.appendChild(el("th", className, label)));
      const thead = el("thead");
      thead.appendChild(head);
      const body = el("tbody");

      rules.forEach((rule, index) => {
        const { fodder } = rule;
        const row = el("tr");

        const maxCell = el("td", "pt-col-target");
        const maxInput = el("input", "pt-target-input");
        maxInput.inputMode = "numeric";
        maxInput.value = fodder.max || "";
        maxInput.addEventListener("change", () => { fodder.max = parsePrice(maxInput.value); saveStock(); });
        maxCell.appendChild(maxInput);
        if (fodder.max) {
          maxCell.appendChild(el("div", "pt-level-detail pt-outlook pt-muted", L(`winst vanaf verkoop ≥ ${priceFormat.format(roundUpToStep(fodder.max / (1 - EA_TAX)))}`, `profit from sale ≥ ${priceFormat.format(roundUpToStep(fodder.max / (1 - EA_TAX)))}`)));
        }

        const idealCell = el("td", "pt-col-price");
        const idealInput = el("input", "pt-target-input");
        idealInput.inputMode = "numeric";
        idealInput.placeholder = "—";
        idealInput.value = fodder.ideal || "";
        idealInput.addEventListener("change", () => { fodder.ideal = parsePrice(idealInput.value); saveStock(); });
        idealCell.appendChild(idealInput);

        const done = list.done && list.done[rule.key];
        const current = active && run.index === index;
        const buttonCell = el("td", "pt-col-level");
        const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""), done ? L("✓ klaargezet", "✓ ready") : L("🔍 klaarzetten", "🔍 set up"));
        button.type = "button";
        button.title = L(`${fodder.rating}-rated goud · ${what.toLowerCase()} ${fodder.max ? priceFormat.format(fodder.max) : "—"} klaarzetten`, `${fodder.rating}-rated gold · ${what.toLowerCase()} ${fodder.max ? priceFormat.format(fodder.max) : "—"} set up`) + (done ? L(` (eerder om ${formatTime(done)})`, ` (earlier at ${formatTime(done)})`) : "");
        button.addEventListener("click", () => goToRule(list.id, index));
        buttonCell.appendChild(button);

        const stockCell = el("td", "pt-col-stock");
        const detail = inventoryDetail(summarizeBucket(list.inventory && list.inventory.rules[rule.key]), null);
        if (detail) stockCell.appendChild(detail);

        row.append(el("td", "pt-col-name pt-watch-name", `${fodder.rating}-rated goud`), maxCell, idealCell, buttonCell, stockCell);
        body.appendChild(row);
      });

      grid.append(thead, body);
      return grid;
    }

    function buildPlayerGrid(list, rules, active) {
      const grid = el("table", "pt-watch-table pt-stock-grid pt-snipe-grid");
      const head = el("tr");
      [[L("Speler", "Player"), "pt-col-name"], ["Rating", "pt-col-rating"], [L("Prijs (PC)", "Price (PC)"), "pt-col-price"], [list.massBid ? L("BIN → max bod", "BIN → max bid") : "Max BIN", "pt-col-target"], ["", "pt-col-level"], [L("Voorraad", "Stock"), "pt-col-stock"]]
        .forEach(([label, className]) => head.appendChild(el("th", className, label)));
      const thead = el("thead");
      thead.appendChild(head);
      const body = el("tbody");

      rules.forEach((rule, index) => {
        const { player } = rule;
        const row = el("tr");
        const genieCell = el("td", "pt-col-price" + (rule.genie ? "" : " pt-missing"), rule.genie ? priceFormat.format(rule.genie.price) : "—");

        // Fixed max BIN overrides the automatic "Genie − margin" value.
        const maxCell = el("td", "pt-col-target");
        const maxInput = el("input", "pt-target-input");
        maxInput.inputMode = "numeric";
        if (list.massBid) {
          // Mass bid: the BIN you saw is the sell price; max bid follows from it.
          const fallback = (geniePrice(player.definitionId) || {}).price || 0;
          maxInput.value = player.sell || "";
          maxInput.placeholder = fallback ? `BIN ${priceFormat.format(fallback)}` : "BIN";
          maxInput.title = L("Laagste BIN die je op de markt ziet (leeg = FUT.GG PC-prijs). Max bod = BIN − je %.", "Lowest BIN you see on the market (empty = FUT.GG PC price). Max bid = BIN − your %.");
          maxInput.addEventListener("change", () => { player.sell = parsePrice(maxInput.value); saveStock(); });
          maxCell.append(maxInput, el("div", "pt-level-detail pt-outlook", rule.max
            ? L(`max bod ${priceFormat.format(rule.max)} · ${formatSigned(flipNet(massBidSell(player), rule.max))} na 5%`, `max bid ${priceFormat.format(rule.max)} · ${formatSigned(flipNet(massBidSell(player), rule.max))} after 5%`)
            : L("geen prijs", "no price")));
        } else {
        maxInput.value = player.fixedMax || "";
        maxInput.placeholder = rule.max && !player.fixedMax ? `auto ${priceFormat.format(rule.max)}` : "auto";
        maxInput.title = L(`Leeg = automatisch (zodat verkoop op de FUT Genie-prijs ${profitFor(list)}% winst geeft na belasting). Vul een bedrag in om het vast te zetten.`, `Empty = automatic (so selling at the FUT Genie price gives ${profitFor(list)}% profit after tax). Enter an amount to fix it.`);
        maxInput.addEventListener("change", () => { player.fixedMax = parsePrice(maxInput.value); saveStock(); });
        maxCell.appendChild(maxInput);
        const outlook = snipeOutlook(rule);
        if (outlook) {
          const line = el("div", "pt-level-detail pt-outlook");
          line.appendChild(el("span", "pt-muted", L(`winst vanaf ≥ ${priceFormat.format(outlook.breakEven)}`, `profit from ≥ ${priceFormat.format(outlook.breakEven)}`)));
          if (outlook.atGenie !== null) {
            line.appendChild(el("span", outlook.atGenie > 0 ? "pt-profit" : "pt-loss",
              L(` · ${outlook.atGenie > 0 ? "+" : ""}${priceFormat.format(outlook.atGenie)} op Genie`, ` · ${outlook.atGenie > 0 ? "+" : ""}${priceFormat.format(outlook.atGenie)} at Genie`)));
          }
          line.title = [
            L(`Kopen voor ${priceFormat.format(rule.max)}: je moet minimaal ${priceFormat.format(outlook.breakEven)} vragen om na 5% belasting quitte te spelen.`, `Buy for ${priceFormat.format(rule.max)}: you need to ask at least ${priceFormat.format(outlook.breakEven)} to break even after 5% tax.`),
            outlook.atGenie !== null ? L(`Verkoop je op de huidige FUT Genie-prijs (${priceFormat.format(rule.genie.price)}), dan is dat ${outlook.atGenie > 0 ? "+" : ""}${priceFormat.format(outlook.atGenie)} na belasting.`, `If you sell at the current FUT Genie price (${priceFormat.format(rule.genie.price)}), that is ${outlook.atGenie > 0 ? "+" : ""}${priceFormat.format(outlook.atGenie)} after tax.`) : "",
            L("Let op: de Genie-prijs kan achterlopen op de markt als prijzen snel bewegen.", "Note: the Genie price can lag behind the market when prices move fast.")
          ].filter(Boolean).join("\n");
          maxCell.appendChild(line);
        }
        }

        const done = list.done && list.done[rule.key];
        const current = active && run.index === index;
        const buttonCell = el("td", "pt-col-level");
        const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""), done ? L("✓ klaargezet", "✓ ready") : L("🔍 klaarzetten", "🔍 set up"));
        button.type = "button";
        button.title = L(`${player.name} · ${list.mode === "bid" ? L("max bod", "max bid") : "max BIN"} ${rule.max ? priceFormat.format(rule.max) : "—"} klaarzetten`, `${player.name} · ${list.mode === "bid" ? L("max bod", "max bid") : "max BIN"} ${rule.max ? priceFormat.format(rule.max) : "—"} set up`) + (done ? L(` (eerder om ${formatTime(done)})`, ` (earlier at ${formatTime(done)})`) : "");
        button.addEventListener("click", () => goToRule(list.id, index));
        buttonCell.appendChild(button);

        const stockCell = el("td", "pt-col-stock");
        const detail = inventoryDetail(summarizeBucket(list.inventory && list.inventory.rules[rule.key]), null);
        if (detail) stockCell.appendChild(detail);

        row.append(el("td", "pt-col-name pt-watch-name", player.name), el("td", "pt-col-rating", String(player.rating || "")), genieCell, maxCell, buttonCell, stockCell);
        body.appendChild(row);
      });

      grid.append(thead, body);
      return grid;
    }

    function renderLists() {
      // Don't rebuild while you're typing in one of the list inputs (would steal focus).
      const active = document.activeElement;
      if (active && active.tagName === "INPUT" && lists.contains(active)) return;
      lists.textContent = "";
      // Fodder cycles live on the Fodder tab, not between your own lists.
      const all = getStock().filter(list => !list.fodderRating && !list.watchRun);
      if (!all.length) {
        lists.appendChild(el("div", "pt-watch-empty", L("Nog geen stock-lijsten. Klik op \"+ Tip plakken\".", "No stock lists yet. Click \"+ Paste tip\".")));
        return;
      }

      all.forEach(list => {
        const rules = stockRules(list);
        const doneCount = rules.filter(rule => list.done && list.done[rule.key]).length;
        const isPlayers = list.type === "players";
        const isFodder = list.type === "fodder";
        const isFilters = list.type === "filters";
        const levels = isPlayers || isFodder || isFilters ? [] : LEVELS.filter(level => list.levels[level] && list.levels[level].enabled);
        const active = run && run.listId === list.id;

        const box = el("div", "pt-stock-list" + (active ? " pt-active" : ""));
        const header = el("div", "pt-stock-list-head");
        const title = el("div");
        title.append(
          el("div", "pt-stock-list-name", (isFodder ? "🧱 " : isPlayers ? "🎯 " : isFilters ? "🔎 " : "📦 ") + list.name),
          el("div", "pt-watch-status", isFilters
            ? L(`${list.rules.length} filterregels · ${rules.length} zoekopdrachten`, `${list.rules.length} filter rules · ${rules.length} searches`) + (list.platform === "console" ? L(" · prijzen uit een console-tip", " · prices from a console tip") : "") + L(` · ${doneCount}/${rules.length} klaargezet`, ` · ${doneCount}/${rules.length} set up`)
            : isFodder
            ? L(`${rules.length} ratings · ${list.mode === "bid" ? L("bieden (max bod)", "bid (max bid)") : "direct kopen (max BIN)"} · ${doneCount}/${rules.length} klaargezet`, `${rules.length} ratings · ${list.mode === "bid" ? L("bieden (max bod)", "bid (max bid)") : "buy now (max BIN)"} · ${doneCount}/${rules.length} set up`)
            : isPlayers
            ? L(`${list.players.length} spelers · winst ${profitLabel(list)} na belasting · ${doneCount}/${rules.length} klaargezet`, `${list.players.length} players · profit ${profitLabel(list)} after tax · ${doneCount}/${rules.length} set up`)
            : `${list.clubs.length} clubs · ${levels.map(level => `${LEVEL_LABEL[level]} ≤ ${priceFormat.format(list.levels[level].max)}`).join(" · ")}` +
              (list.flip ? L(` · lazy flip: markt − ${priceFormat.format(list.flip.under)}, verkoop +${priceFormat.format(list.flip.sellLow)}–${priceFormat.format(list.flip.sellHigh)}`, ` · lazy flip: market − ${priceFormat.format(list.flip.under)}, sell +${priceFormat.format(list.flip.sellLow)}–${priceFormat.format(list.flip.sellHigh)}`) : "") +
              L(` · ${doneCount}/${rules.length} klaargezet`, ` · ${doneCount}/${rules.length} set up`))
        );
        const state = listWindowState(list);
        if (state) title.appendChild(el("div", `pt-run-window pt-window-${state.state}`, state.text));

        // Inventory totals over all rules of this list.
        const summaries = (isFilters ? list.rules.map(rule => `f${rule.id}`) : rules.map(rule => rule.key))
          .map(key => summarizeBucket(list.inventory && list.inventory.rules[key])).filter(Boolean);
        const progress = inventoryProgress.get(list.id);
        const stockLine = el("div", "pt-stock-summary-line");
        if (progress) {
          stockLine.textContent = `📦 Club doorzoeken… ${progress}`;
        } else if (list.inventory) {
          const owned = summaries.reduce((sum, s) => sum + s.owned, 0);
          const cost = summaries.reduce((sum, s) => sum + s.cost, 0);
          const netValues = summaries.filter(s => s.net !== null);
          const net = netValues.reduce((sum, s) => sum + s.net, 0);
          stockLine.append(
            el("span", "", L(`📦 ${owned} kaarten · geïnvesteerd ${priceFormat.format(cost)}`, `📦 ${owned} cards · invested ${priceFormat.format(cost)}`)),
            el("span", "pt-muted", L(" · netto bij verkoop nu (na 5% belasting): ", " · net if sold now (after 5% tax): ")),
            el("span", net > 0 ? "pt-profit" : net < 0 ? "pt-loss" : "", netValues.length ? `${net > 0 ? "+" : ""}${priceFormat.format(net)}` : "—"),
            el("span", "pt-muted", L(` · bijgewerkt om ${formatTime(list.inventory.updatedAt)}`, ` · updated at ${formatTime(list.inventory.updatedAt)}`))
          );
        } else {
          stockLine.appendChild(el("span", "pt-muted", L("📦 Nog geen voorraad geteld. Klik op \"Voorraad bijwerken\".", "📦 No stock counted yet. Click \"Update stock\".")));
        }
        title.appendChild(stockLine);

        const buttons = el("div", "pt-stock-list-buttons");
        // Stock lists: target count per cell. Snipe lists: margin under the FUT Genie price.
        const goalLabel = el("label", "pt-goal");
        const goal = el("input", "pt-target-input");
        goal.inputMode = "numeric";
        if (isFodder) {
          // Fodder lists: switch between bidding and buy now.
          const mode = el("select", "pt-stock-select pt-mode-select");
          mode.append(new Option(L("Bieden", "Bid"), "bid"), new Option("Direct kopen", "bin"));
          mode.value = list.mode === "bin" ? "bin" : "bid";
          mode.title = L("Bieden zet het max bod-filter, direct kopen het max BIN-filter", "Bid sets the max bid filter, buy now sets the max BIN filter");
          mode.addEventListener("change", () => { list.mode = mode.value; saveStock(); });
          goalLabel.append(el("span", "pt-muted", L("Zoeken op", "Search by")), mode);
        } else if (isPlayers && list.massBid) {
          goal.placeholder = String(MASS_BID_DEFAULT_PCT);
          goal.value = list.massBid.pct || "";
          goal.title = L("Hoeveel procent je onder de laagste BIN biedt (tip: 20–25%, liever nog lager)", "How many percent below the lowest BIN you bid (tip: 20–25%, preferably even lower)");
          goal.addEventListener("change", () => {
            const value = Number(goal.value.replace(",", "."));
            list.massBid.pct = value > 0 && value < 90 ? value : MASS_BID_DEFAULT_PCT;
            saveStock();
          });
          goalLabel.append(el("span", "pt-muted", L("% onder BIN", "% below BIN")), goal);
        } else if (isPlayers) {
          goal.placeholder = "auto";
          goal.value = Number.isFinite(list.profit) ? list.profit : "";
          goal.title = L(`Gewenste winst na 5% EA-belasting als je verkoopt op de FUT Genie-prijs (leeg = ${DEFAULT_PROFIT}%). Vaste max BIN per speler gaat altijd voor.`, `Desired profit after 5% EA tax when you sell at the FUT Genie price (empty = ${DEFAULT_PROFIT}%). A fixed max BIN per player always takes priority.`);
          goal.addEventListener("change", () => {
            const value = goal.value.trim() === "" ? null : Number(goal.value.replace(",", "."));
            list.profit = Number.isFinite(value) ? value : null;
            saveStock();
          });
          goalLabel.append(el("span", "pt-muted", L("Winst %", "Profit %")), goal);
        } else {
          goal.placeholder = "—";
          goal.value = list.goal || "";
          goal.title = isFilters ? L("Hoeveel kaarten je per filterregel wilt stocken", "How many cards you want to stock per filter rule") : L("Hoeveel kaarten je per club en kwaliteit wilt stocken", "How many cards you want to stock per club and quality");
          goal.addEventListener("change", () => { list.goal = parsePrice(goal.value); saveStock(); });
          goalLabel.append(el("span", "pt-muted", isFilters ? L("Doel per regel", "Target per rule") : L("Doel per vakje", "Target per slot")), goal);
        }
        const inventory = el("button", "pt-watch-refresh", progress ? `📦 ${progress}` : L("📦 Voorraad bijwerken", "📦 Update stock"));
        inventory.disabled = !!progress;
        inventory.title = isFodder
          ? L("Telt je gewone gouden kaarten per rating in je club, transferlijst, unassigned en gewonnen transfer targets. Geen transfermarkt-zoekopdrachten.", "Counts your regular gold cards per rating in your club, transfer list, unassigned and won transfer targets. No transfer market searches.")
          : isFilters
          ? L("Telt per filterregel je kaarten (land, kwaliteit, competitie, positie) in je club, transferlijst, unassigned en gewonnen transfer targets. Geen transfermarkt-zoekopdrachten.", "Counts your cards per filter rule (country, quality, league, position) in your club, transfer list, unassigned and won transfer targets. No transfer market searches.")
          : isPlayers
          ? L("Zoekt deze spelers in je club, transferlijst, unassigned en gewonnen transfer targets (met korte pauzes). Geen transfermarkt-zoekopdrachten.", "Looks up these players in your club, transfer list, unassigned and won transfer targets (with short pauses). No transfer market searches.")
          : L("Doorzoekt je club per club in deze lijst, plus transferlijst, unassigned en gewonnen transfer targets (met korte pauzes). Geen transfermarkt-zoekopdrachten.", "Searches your club per club in this list, plus transfer list, unassigned and won transfer targets (with short pauses). No transfer market searches.");
        inventory.addEventListener("click", () => updateInventory(list));
        const start = el("button", "pt-watch-refresh", active ? "▶ Verder" : doneCount ? "▶ Verder" : "▶ Start");
        const reset = el("button", "pt-link-btn", "↺ Reset");
        const remove = el("button", "pt-link-btn pt-danger", L("Verwijderen", "Delete"));
        // Snipe lists: put the players on the Spelers tab (your max BIN as their target).
        const toWatch = el("button", "pt-link-btn", L("➕ Naar Spelers", "➕ To Players"));
        toWatch.title = L("Zet deze spelers op de Spelers-tab, met de vaste max BIN als PC-instapdoel", "Put these players on the Players tab, with the fixed max BIN as the PC entry target");
        toWatch.addEventListener("click", () => {
          const added = addPlayersToWatch(list.players);
          flashButton(toWatch, `✓ ${added} erbij`, true, L("Op de Spelers-tab gezet", "Put on the Players tab"), L("➕ Naar Spelers", "➕ To Players"), toWatch.title);
        });
        // Holo snipe: only holographic cards, max BIN = the normal card's FUT Genie price.
        const holo = el("button", "pt-link-btn" + (list.holo ? " pt-holo-on" : ""), list.holo ? L("✨ Alleen holo: aan", "✨ Holo only: on") : L("✨ Alleen holo", "✨ Holo only"));
        holo.title = L("Zoekt alleen holografische kaarten, met de prijs van de normale kaart (FUT Genie) als max BIN. ", "Searches only holographic cards, using the price of the regular card (FUT Genie) as max BIN. ") +
          L("Zelfde extra zoekfilter als FUT Genie's \"Holographic only\"; die zit niet in EA's eigen app.", "Same extra search filter as FUT Genie's \"Holographic only\"; it isn't in EA's own app.");
        holo.addEventListener("click", () => {
          list.holo = !list.holo;
          if (list.holo) showToast(L("✨ Alleen holo staat aan. Let op: dit filter zit niet in EA's eigen app (FUT Genie waarschuwt er ook voor); gebruik het met mate.", "✨ Holo only is on. Note: this filter isn't in EA's own app (FUT Genie warns about it too); use it sparingly."), true);
          saveStock();
        });
        // Mass bid on/off: bid mode, max bid = BIN - %.
        const massBid = el("button", "pt-link-btn" + (list.massBid ? " pt-holo-on" : ""), list.massBid ? L("🎯 Mass bid: aan", "🎯 Mass bid: on") : "🎯 Mass bid");
        massBid.title = L("Biedlijst: zoekt op max bod = laagste BIN − je %, en laat bij elke veiling zien of je bod nog past. Bieden doe je zelf.", "Bid list: searches on max bid = lowest BIN − your %, and shows on each auction whether your bid still fits. You place the bids yourself.");
        massBid.addEventListener("click", () => {
          if (list.massBid) {
            delete list.massBid;
            delete list.mode;
          } else {
            list.massBid = { pct: MASS_BID_DEFAULT_PCT };
            list.mode = "bid";
            list.holo = false;
          }
          saveStock();
        });
        [inventory, start, reset, remove, toWatch, holo, massBid].forEach(button => { button.type = "button"; });
        start.addEventListener("click", () => startRun(list.id));
        reset.addEventListener("click", () => { list.done = {}; saveStock(); });
        // Two-step delete instead of a blocking confirm() dialog.
        remove.addEventListener("click", () => {
          if (remove.dataset.armed === "1") {
            getStock().splice(getStock().indexOf(list), 1);
            if (run && run.listId === list.id) stopRun();
            saveStock();
            return;
          }
          remove.dataset.armed = "1";
          remove.textContent = "Zeker weten?";
          window.setTimeout(() => {
            if (!remove.isConnected) return;
            remove.dataset.armed = "";
            remove.textContent = L("Verwijderen", "Delete");
          }, 3000);
        });
        buttons.append(goalLabel, inventory, start, ...(isPlayers ? [toWatch] : []), ...(isPlayers && !list.fodderRating ? [massBid] : []),
          ...(isPlayers && !list.fodderRating && !list.massBid ? [holo] : []), reset, remove);
        header.append(title, buttons);

        if (isFodder) {
          box.append(header, buildFodderGrid(list, rules, active));
          lists.appendChild(box);
          return;
        }
        if (isFilters) {
          box.append(header, buildFilterGrid(list, rules, active));
          lists.appendChild(box);
          return;
        }
        if (isPlayers) {
          box.append(header, buildPlayerGrid(list, rules, active));
          lists.appendChild(box);
          return;
        }

        const grid = el("table", "pt-watch-table pt-stock-grid");
        const head = el("tr");
        head.append(el("th", "", "Club"), el("th", "", L("Competitie", "League")));
        levels.forEach(level => head.appendChild(el("th", "pt-col-level", LEVEL_LABEL[level])));
        const thead = el("thead");
        thead.appendChild(head);
        const body = el("tbody");
        list.clubs.forEach(club => {
          const row = el("tr");
          row.append(el("td", "pt-watch-name", club.teamName), el("td", "pt-muted", club.leagueName.replace(/\s*\(.*\)/, "")));
          levels.forEach(level => {
            if (!clubHasLevel(club, level)) {
              row.appendChild(el("td", "pt-col-level pt-muted", "–"));
              return;
            }
            const key = `${club.teamId}|${level}`;
            const index = rules.findIndex(rule => rule.key === key);
            const done = list.done && list.done[key];
            const current = active && run.index === index;
            const cell = el("td", "pt-col-level");
            const rule = rules[index];
            const aboveTip = rule.market && rule.ceiling && rule.market.price > rule.ceiling;
            const label = !list.flip ? `≤ ${priceFormat.format(rule.max)}`
              : rule.market ? L(`${aboveTip ? "⚠ " : ""}koop ≤ ${priceFormat.format(rule.max)}`, `${aboveTip ? "⚠ " : ""}buy ≤ ${priceFormat.format(rule.max)}`) : L("👀 markt", "👀 market");
            const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""),
              `${done ? "✓ " : list.flip && !rule.market ? "" : "🔍 "}${label}`);
            button.type = "button";
            button.title = `${club.teamName} · ${LEVEL_LABEL[level]} · ` +
              (rule.max ? L(`max BIN ${priceFormat.format(rule.max)} klaarzetten`, `Set up max BIN ${priceFormat.format(rule.max)}`) : L("markt bekijken (zonder max BIN)", "view market (without max BIN)")) +
              (rule.market ? L(` (markt ${priceFormat.format(rule.market.price)} om ${formatTime(rule.market.at)})`, ` (market ${priceFormat.format(rule.market.price)} at ${formatTime(rule.market.at)})`) : "") +
              (aboveTip ? L(` – boven de tip (≤ ${priceFormat.format(rule.ceiling)})`, ` – above the tip (≤ ${priceFormat.format(rule.ceiling)})`) : "") +
              (done ? L(` (eerder klaargezet om ${formatTime(done)})`, ` (earlier set up at ${formatTime(done)})`) : "");
            button.addEventListener("click", () => goToRule(list.id, index));
            cell.appendChild(button);

            const detail = inventoryDetail(summarizeBucket(list.inventory && list.inventory.rules[key]), list.goal);
            if (detail) cell.appendChild(detail);
            row.appendChild(cell);
          });
          body.appendChild(row);
        });
        grid.append(thead, body);

        box.append(header, grid);
        lists.appendChild(box);
      });
    }

    return renderLists;
  }

  // EA-style view + controller so the page lives in the normal navigation stack.
  function definePageClasses() {
    function PriceWatchView() {
      return EAView.call(this) || this;
    }
    __extends(PriceWatchView, EAView);
    PriceWatchView.prototype._generate = function () {
      if (this._generated) return;
      const root = el("div", "ut-content pt-watch-view");
      this.__root = root;
      this.render = buildPage(root);
      this._generated = true;
    };
    PriceWatchView.prototype.destroyGeneratedElements = function () {
      DOMKit.remove(this.__root);
      this.__root = null;
    };

    function PriceWatchViewController() {
      return EAViewController.call(this) || this;
    }
    __extends(PriceWatchViewController, EAViewController);
    PriceWatchViewController.prototype._getViewInstanceFromData = function () {
      return new PriceWatchView();
    };
    PriceWatchViewController.prototype.getNavigationTitle = function () {
      return "Price Watch";
    };
    PriceWatchViewController.prototype.viewDidAppear = function () {
      EAViewController.prototype.viewDidAppear.apply(this, arguments);
      const view = this.getView();
      this._ptListener = () => view.render();
      listeners.add(this._ptListener);
      this._ptTimer = window.setInterval(() => refreshGeniePrices(false), 30 * 1000);
      view.render();
      refreshGeniePrices(false);
    };
    PriceWatchViewController.prototype.viewWillDisappear = function () {
      EAViewController.prototype.viewWillDisappear.apply(this, arguments);
      listeners.delete(this._ptListener);
      window.clearInterval(this._ptTimer);
    };

    return PriceWatchViewController;
  }

  // ---------------------------------------------------------------------------
  // Sidebar tab (same mechanism FUT Genie uses for its own tab)
  // ---------------------------------------------------------------------------

  let PriceWatchViewController = null;

  function findTabBarController() {
    const app = getAppMain();
    if (!app || typeof app.getRootViewController !== "function") return null;
    const queue = [app.getRootViewController()];
    const seen = new Set();
    for (let guard = 0; queue.length && guard < 500; guard++) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const children = node.childViewControllers;
      if (Array.isArray(children) && children.some(child => child && child.tabBarItem)) return node;
      if (Array.isArray(children)) queue.push(...children);
      ["currentController", "rootController", "presentedViewController", "_gameViewController", "gameController"]
        .forEach(key => { if (node[key] && typeof node[key] === "object") queue.push(node[key]); });
    }
    return null;
  }

  function installTab() {
    const tabBar = findTabBarController();
    if (!tabBar || !tabBar.initialized) return false;
    const children = tabBar.childViewControllers;
    const ours = children.find(child => child.tabBarItem && child.tabBarItem.getTag && child.tabBarItem.getTag() === TAB_TAG);
    if (ours) {
      // Another script (e.g. Paletools on the phone) may redraw the bar from its own list: put ours back.
      const node = typeof ours.tabBarItem.getRootElement === "function" ? ours.tabBarItem.getRootElement() : null;
      if (node && !node.isConnected) {
        const selected = tabBar.currentController;
        const view = tabBar.getView();
        view.setTabItems(children.map(child => child.tabBarItem));
        if (typeof view.layoutSubviews === "function") view.layoutSubviews();
        const selectedIndex = children.indexOf(selected);
        if (selectedIndex >= 0 && typeof view.setSelectedIndex === "function") view.setSelectedIndex(selectedIndex);
      }
      return true;
    }

    PriceWatchViewController = PriceWatchViewController || definePageClasses();
    const controller = new PriceWatchViewController();
    controller.init();
    const navigation = new UTGameFlowNavigationController(null);
    navigation.initWithRootController(controller);
    const item = new UTTabBarItemView();
    item.init();
    item.setTag(TAB_TAG);
    item.setText(window.innerWidth > 700 ? "Price Watch" : "Watch");
    item.addClass("icon-transfer");
    item.addClass("pt-watch-tab");
    navigation.tabBarItem = item;

    const selected = tabBar.currentController || children[0];
    tabBar.addChildViewController(navigation);
    const added = children.indexOf(navigation);
    if (added >= 0) children.splice(added, 1);
    const indexOfTag = tag => children.findIndex(child =>
      child.tabBarItem && child.tabBarItem.getTag && child.tabBarItem.getTag() === tag);
    // Desktop: just above Settings. Phone: Settings is the cog at the top and the bottom bar is full,
    // so go right after Transfers (otherwise the tab ends up off-screen behind other scripts' tabs).
    const settingsIndex = indexOfTag(UTGameTabBarController.TabTag.SETTINGS);
    const transfersIndex = indexOfTag(UTGameTabBarController.TabTag.TRANSFERS);
    const insertAt = settingsIndex >= 0 && window.innerWidth > 700 ? settingsIndex
      : transfersIndex >= 0 ? transfersIndex + 1 : children.length;
    children.splice(insertAt, 0, navigation);

    const view = tabBar.getView();
    view.setTabItems(children.map(child => child.tabBarItem));
    if (typeof view.layoutSubviews === "function") view.layoutSubviews();
    const selectedIndex = children.indexOf(selected);
    if (selectedIndex >= 0 && typeof view.setSelectedIndex === "function") view.setSelectedIndex(selectedIndex);
    return true;
  }

  // ---------------------------------------------------------------------------
  // "+ Price Watch" button in item detail panels
  // ---------------------------------------------------------------------------

  const PANEL_HOOKS = [
    ["UTDefaultActionPanelView", "render"],
    ["UTAuctionActionPanelView", "render"],
    ["UTTransferActionPanelView", "render"],
    ["UTDuplicateLoanActionPanelView", "render"],
    ["UTDiscardedItemActionPanelView", "render"],
    ["UTSlotActionPanelView", "setItem"]
  ];

  function watchButtonState(button, item) {
    const watched = !!findWatched(item.definitionId);
    button.textContent = watched ? "✓ In Price Watch" : "+ Price Watch";
    button.classList.toggle("pt-watching", watched);
    button.title = watched ? L("Klik om uit je Price Watch te halen", "Click to remove from your Price Watch") : L("Voeg deze kaart toe aan je Price Watch", "Add this card to your Price Watch");
  }

  function addWatchButton(panel, item) {
    if (!item || typeof item.isPlayer !== "function" || !item.isPlayer() || !item.definitionId) return;
    learnNation(item);
    let root;
    try {
      root = panel.getRootElement();
    } catch {
      return;
    }
    if (!root) return;

    let button = root.querySelector(".pt-watch-add");
    if (!button) {
      button = el("button", "btn-standard pt-watch-add");
      button.type = "button";
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const current = button.__ptItem;
        if (!current) return;
        if (findWatched(current.definitionId)) removeWatched(current.definitionId);
        else {
          addWatched({
            definitionId: current.definitionId,
            name: playerNameFor(current.definitionId, current.displayName),
            rating: current.rating,
            rarity: current.rareflag,
            resourceId: Number(current.resourceId) || null
          });
        }
        watchButtonState(button, current);
      });
      const group = root.querySelector(".ut-button-group") || root;
      group.appendChild(button);
    }
    button.__ptItem = item;
    watchButtonState(button, item);
    addLowestButton(root, item);
    addProfitInfo(root, item);
  }

  // "🏷️ Laagste prijs" in the item panel: only searches when you click it (a few searches for this exact
  // card, each just below the cheapest BIN found), then shows the cheapest prices with their counts.
  function addLowestButton(root, item) {
    let wrap = root.querySelector(".pt-lowest-wrap");
    if (!wrap) {
      wrap = el("div", "pt-lowest-wrap");
      const button = el("button", "btn-standard pt-lowest-panel", L("🏷️ Laagste prijs", "🏷️ Lowest price"));
      button.type = "button";
      button.title = L("Handmatige live BIN-scan: maximaal 3 EA-zoekopdrachten met 12–18s pauze. Bij de apparaatlimiet: klik binnen 30s nogmaals voor een eenmalige bevestigde uitzondering.", "Manual live BIN scan: at most 3 EA searches with a 12–18s pause. At the device limit: click again within 30s for a one-time confirmed exception.");
      const out = el("div", "pt-lowest-out");
      wrap.append(button, out);
      wrap.__ptShow = () => {
        const current = wrap.__ptItem;
        const result = current && lastLowest[current.definitionId];
        out.textContent = !result ? "" : result.counts.length
          ? `${formatLowestCounts(current.definitionId)} · ${formatDayTime(result.at)}`
          : L(`Niets te koop gevonden · ${formatDayTime(result.at)}`, `Nothing for sale found · ${formatDayTime(result.at)}`);
      };
      let lastClick = 0;
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const current = wrap.__ptItem;
        if (!current || Date.now() - lastClick < 600) return;
        lastClick = Date.now();
        if (marketBusy) {
          showToast(L("Er loopt nog een zoekopdracht – even wachten", "A search is still running – wait a moment"), false);
          return;
        }
        button.disabled = true;
        out.textContent = L("Zoeken…", "Searching…");
        try {
          await findLowestPrice(current.definitionId, search => { out.textContent = L(`Zoeken ${search}…`, `Searching ${search}…`); });
          if (wrap.__ptItem === current) wrap.__ptShow();
          listeners.forEach(listener => listener());
        } catch (error) {
          console.warn(L("Price Watch: laagste prijs zoeken mislukt.", "Price Watch: searching lowest price failed."), error);
          out.textContent = L(`Zoeken mislukt: ${error.message}`, `Search failed: ${error.message}`);
        } finally {
          button.disabled = false;
        }
      });
      (root.querySelector(".ut-button-group") || root).appendChild(wrap);
    }
    wrap.__ptItem = item;
    wrap.__ptShow();
  }

  function hookPanels() {
    PANEL_HOOKS.forEach(([className, method]) => {
      const Panel = window[className];
      if (!Panel || !Panel.prototype[method] || Panel.prototype[method].__ptWatchHooked) return;
      const original = Panel.prototype[method];
      const hooked = function (item) {
        const result = original.apply(this, arguments);
        try {
          addWatchButton(this, item);
        } catch (error) {
          console.warn(L("Price Watch: knop toevoegen mislukt.", "Price Watch: adding button failed."), error);
        }
        try {
          if (className === "UTAuctionActionPanelView") addMassBidPanel(this, item);
        } catch (error) {
          console.warn(L("Price Watch: biedlijst-regel bij bieden mislukt.", "Price Watch: bid list row on bidding failed."), error);
        }
        return result;
      };
      hooked.__ptWatchHooked = true;
      Panel.prototype[method] = hooked;
    });
    const QuickList = window.UTQuickListPanelViewController;
    if (QuickList && QuickList.prototype.renderView && !QuickList.prototype.renderView.__ptQuickList) {
      const original = QuickList.prototype.renderView;
      const hooked = function () {
        const result = original.apply(this, arguments);
        try {
          addQuickListMarkup(this);
        } catch (error) {
          console.warn(L("Price Watch: opslag-knoppen bij listen mislukt.", "Price Watch: save buttons on listing failed."), error);
        }
        return result;
      };
      hooked.__ptQuickList = true;
      QuickList.prototype.renderView = hooked;
    }
    const Cell = window.UTItemTableCellView;
    if (Cell && Cell.prototype.render && !Cell.prototype.render.__ptTransferRow) {
      const original = Cell.prototype.render;
      const hooked = function (data) {
        const result = original.apply(this, arguments);
        try {
          addTransferRowInfo(this, (typeof this.getData === "function" && this.getData()) || data);
        } catch (error) {
          console.warn(L("Price Watch: winst bij kaart op transferlijst mislukt.", "Price Watch: profit on transfer list card failed."), error);
        }
        try {
          addMassBidBadge(this, (typeof this.getData === "function" && this.getData()) || data);
        } catch (error) {
          console.warn(L("Price Watch: biedlijst-badge mislukt.", "Price Watch: bid list badge failed."), error);
        }
        return result;
      };
      hooked.__ptTransferRow = true;
      Cell.prototype.render = hooked;
    }
    const TransferList = window.UTTransferListViewController;
    if (TransferList && TransferList.prototype._renderView && !TransferList.prototype._renderView.__ptSummary) {
      const original = TransferList.prototype._renderView;
      const hooked = function () {
        const result = original.apply(this, arguments);
        try {
          transferListController = this;
          addTransferSummary(this);
        } catch (error) {
          console.warn(L("Price Watch: transferlijst-overzicht mislukt.", "Price Watch: transfer list overview failed."), error);
        }
        return result;
      };
      hooked.__ptSummary = true;
      TransferList.prototype._renderView = hooked;
    }
  }

  // --- Overview on EA's own transfer list (phone; FUT Genie has its own on the pc) ------------------
  // At the top what the list brings in and what you make on it after tax; on each card bought, BIN,
  // profit after tax and the FUT Genie price (via your pc), with ⚠ when your BIN is above it.
  let lastTransferItems = [];
  let transferItemIds = new Set();
  let transferListController = null;

  function rememberTransferItems(items) {
    rememberBought(items);
    lastTransferItems = items;
    transferItemIds = new Set(items.map(item => item.id).filter(Boolean));
    if (transferListController) addTransferSummary(transferListController);
  }

  // Listed or expired: its BIN. Sold: what it sold for. Not listed: the FUT Genie price, if known.
  function transferRowFacts(item) {
    const auction = auctionOf(item) || {};
    const state = auction.tradeState;
    const sold = state === "closed";
    const listed = state === "active" || state === "expired";
    const market = (geniePrice(item.definitionId, item.resourceId) || {}).price || 0;
    const price = sold ? auction.currentBid || auction.buyNowPrice || 0 : listed ? auction.buyNowPrice || 0 : market;
    const bought = boughtPrice(item);
    try { learnDiscardValues([item]); } catch (_) { /* optional */ }
    return { sold, listed, market, price, bought, net: bought && price ? netProfit(price, bought) : null, quickSell: Number(item.discardValue) || 0 };
  }

  function addTransferSummary(controller) {
    const view = typeof controller.getView === "function" ? controller.getView() : null;
    const root = view && typeof view.getRootElement === "function" ? view.getRootElement() : null;
    if (!root) return;
    let box = root.querySelector(".pt-tl-summary");
    if (genie() || !lastTransferItems.length) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = el("div", "pt-tl-summary");
      const list = root.querySelector(".sectioned-item-list");
      if (list && list.parentNode) list.parentNode.insertBefore(box, list);
      else root.insertBefore(box, root.firstChild);
    }
    const rows = lastTransferItems.map(transferRowFacts);
    const open = rows.filter(row => !row.sold);
    const sold = rows.filter(row => row.sold);
    const sum = (list, value) => list.reduce((total, row) => total + (value(row) || 0), 0);
    const after = price => Math.floor(price * (1 - EA_TAX));
    const tile = (label, value, profit, note) => {
      const node = el("div", "pt-tl-tile");
      node.append(el("div", "pt-tl-tile-label", label), el("div", profit == null ? "pt-tl-tile-value" : `pt-tl-tile-value ${profit >= 0 ? "pt-pos" : "pt-neg"}`, value));
      if (note) node.appendChild(el("div", "pt-tl-tile-note", note));
      return node;
    };
    const openKnown = open.filter(row => row.net != null);
    const soldKnown = sold.filter(row => row.net != null);
    const openProfit = sum(openKnown, row => row.net);
    const soldProfit = sum(soldKnown, row => row.net);
    const noPrice = open.filter(row => !row.price).length;
    const missing = (part, all) => (part.length < all.length ? L(`${part.length} van ${all.length} met aankoopprijs`, `${part.length} of ${all.length} with purchase price`) : "na tax");
    box.textContent = "";
    box.append(
      tile("Mogelijke opbrengst", priceFormat.format(sum(open, row => after(row.price))), null, noPrice ? L(`na tax · ${noPrice} zonder prijs`, `after tax · ${noPrice} without price`) : "na tax"),
      tile(L("Mogelijke winst", "Possible profit"), signedCoins(openProfit), openProfit, missing(openKnown, open)),
      tile(L("Verkocht (opbrengst)", "Sold (revenue)"), priceFormat.format(sum(sold, row => after(row.price))), null, L(`${sold.length} kaart(en), na tax`, `${sold.length} card(s), after tax`)),
      tile(L("Verkocht (winst)", "Sold (profit)"), signedCoins(soldProfit), soldProfit, missing(soldKnown, sold)),
      tile(L("Quick sell totaal", "Quick sell total"), priceFormat.format(sum(rows, row => row.quickSell))),
      tile(L("Quick sell niet verkocht", "Quick sell not sold"), priceFormat.format(sum(open, row => row.quickSell))));
  }

  // "35.3k", like FUT Genie's list.
  function shortCoins(value) {
    if (value >= 1e6) return `${+(value / 1e6).toFixed(2)}M`;
    return value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(value);
  }

  // Like FUT Genie: top right the profit after tax (sold: what you made, listed: at your BIN, not listed:
  // at the FUT Genie price), ⚠ when it's a loss. Under the stats of a card that isn't listed: FUT Genie
  // price and what you paid; a listed card has EA's prices there, so that goes under the badge.
  function addTransferRowInfo(cell, item) {
    const root = typeof cell.getRootElement === "function" ? cell.getRootElement() : null;
    if (!root) return;
    root.querySelectorAll(".pt-tl-badge, .pt-tl-row").forEach(node => node.remove());
    if (genie() || !item || !transferItemIds.has(item.id)) return;
    const row = transferRowFacts(item);
    const over = row.listed && row.market > 0 && row.price > row.market;
    const coin = () => el("span", "pt-coin");
    const badge = el("div", "pt-tl-badge");
    if (row.net != null) {
      const profit = el("div", row.net >= 0 ? "pt-pos" : "pt-neg", `${row.net >= 0 ? "+" : "⚠ "}${priceFormat.format(Math.abs(row.net))}`);
      profit.appendChild(coin());
      badge.appendChild(profit);
    }
    if ((row.listed || row.sold) && row.market) badge.append(el("div", over ? "pt-tl-badge-sub pt-neg" : "pt-tl-badge-sub", `${over ? L("⚠ boven ", "⚠ above ") : ""}Genie ${shortCoins(row.market)}`));
    if ((row.listed || row.sold) && !row.bought) badge.append(el("div", "pt-tl-badge-sub", L("aankoopprijs onbekend", "purchase price unknown")));
    if (badge.childNodes.length) {
      if (getComputedStyle(root).position === "static") root.style.position = "relative";
      root.appendChild(badge);
    }
    if (row.listed || row.sold) return;
    const line = el("div", "pt-tl-row");
    if (row.market) line.append(el("span", "pt-tl-genie", shortCoins(row.market)), coin(), " Genie");
    if (row.bought) line.append(row.market ? " · " : "", L(`gekocht ${shortCoins(row.bought)}`, `bought ${shortCoins(row.bought)}`));
    if (line.childNodes.length) (root.querySelector(".entityContainer") || root).appendChild(line);
  }

  // In EA's "List on Transfer Market" panel. With FUT Genie (pc) only what it lacks: BIN = what you paid
  // + 10% / 15% / 20% / your own %. Without it (Safari on the phone) also what FUT Genie has: the price
  // (FUT Genie via your pc, or the lowest BIN when you tap), −10% / +5% / +10% on the BIN in the field,
  // break even, and the profit after tax at that BIN. Start price is always one step below. You press List.
  const QUICK_LIST_PCTS = [10, 15, 20];

  // Mass bid: "sell instantly" - BIN = the sell price of the list (your BIN or FUT.GG), start one step
  // below. You check the market and press List yourself, one card at a time.
  function addMassBidSell(actions, view, item, bought) {
    let row = actions.querySelector(".pt-ql-mb");
    const info = massBidInfo(item);
    if (row && (row.__ptItem !== item || !info)) {
      row.remove();
      row = null;
    }
    if (!info || !info.sell || row) return;
    row = el("div", "panelActionRow pt-ql pt-ql-mb");
    row.__ptItem = item;
    const hold = massBidHold(info, bought);
    const button = el("button", "pt-ql-btn pt-ql-gold", `${hold ? L("📦 Liever houden · ", "📦 Better to keep · ") : "🎯 "}${L("Verkoop", "Sell")} ${priceFormat.format(info.sell)}${bought ? ` (${formatSigned(flipNet(info.sell, bought))})` : ""}`);
    button.type = "button";
    button.title = (hold ? L(`Fodder ≥${MASS_BID_HOLD_PCT}% onder de prijs gekocht: de tip zegt houden. `, `Fodder bought ≥${MASS_BID_HOLD_PCT}% below the price: the tip says keep. `) : "") +
      L(`Buy Now = verkoopprijs van "${info.list.name}" (${info.player.sell ? "jouw BIN" : "FUT.GG PC"}). Check eerst de markt; list één kaart tegelijk.`, `Buy Now = sell price of "${info.list.name}" (${info.player.sell ? "your BIN" : "FUT.GG PC"}). Check the market first; list one card at a time.`);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const bin = Math.max(200, roundUpToStep(info.sell));
      view.setBuyNowValue(bin);
      let start = 0;
      try {
        start = window.UTCurrencyInputControl.getIncrementBelowVal(bin);
      } catch (_) {
        // Own ladder below.
      }
      view.setBidValue(start > 0 ? start : Math.max(150, priceStepBelow(bin)));
    });
    row.appendChild(button);
    actions.insertBefore(row, actions.firstChild);
  }

  function addQuickListMarkup(controller) {
    const view = controller && typeof controller.getView === "function" ? controller.getView() : null;
    const actions = view && view.__panelActions;
    const item = controller.item;
    if (!actions || !item || typeof view.setBuyNowValue !== "function") return;
    const bought = item.lastSalePrice > 0 ? item.lastSalePrice : 0;
    const full = !genie();
    addMassBidSell(actions, view, item, bought);
    let row = actions.querySelector(".pt-ql:not(.pt-ql-mb)");
    if (row && (row.__ptItem !== item || row.__ptFull !== full)) {
      row.remove();
      row = null;
    }
    if (!bought && !full) return;
    if (row) return void row.__ptRefresh();

    row = el("div", "panelActionRow pt-ql");
    row.__ptItem = item;
    row.__ptFull = full;
    const binNow = () => Number(view._buyNowNumericStepper && view._buyNowNumericStepper.getValue && view._buyNowNumericStepper.getValue()) || 0;
    const profit = el("div", "pt-ql-profit");
    const showProfit = () => {
      profit.textContent = "";
      const bin = binNow();
      if (!bin || !bought || !full) return;
      const net = netProfit(bin, bought);
      profit.append(L(`Winst na tax bij BIN ${priceFormat.format(bin)}: `, `Profit after tax at BIN ${priceFormat.format(bin)}: `), el("span", net >= 0 ? "pt-pos" : "pt-neg", signedCoins(net)));
    };
    const setBin = price => {
      const bin = Math.max(200, roundUpToStep(price));
      view.setBuyNowValue(bin);
      let start = 0;
      try {
        start = window.UTCurrencyInputControl.getIncrementBelowVal(binNow() || bin);
      } catch (_) {
        // Our own price ladder below.
      }
      view.setBidValue(start > 0 ? start : Math.max(150, priceStepBelow(binNow() || bin)));
      showProfit();
    };
    const button = (label, title, onClick) => {
      const node = el("button", "pt-ql-btn", label);
      node.type = "button";
      if (title) node.title = title;
      node.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        onClick(node);
      });
      return node;
    };
    const grid = (columns, ...children) => {
      const node = el("div", "pt-ql-buttons");
      node.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
      node.append(...children);
      return node;
    };

    let refreshPrice = () => {};
    if (full) {
      // The price: FUT Genie from your pc when it sent one for this card, otherwise search when you tap.
      const priceButton = button("", "", async node => {
        const known = (geniePrice(item.definitionId, item.resourceId) || {}).price;
        if (known) return setBin(known);
        if (marketBusy) return;
        node.disabled = true;
        try {
          const lowest = await findLowestPrice(item.definitionId, search => { node.textContent = L(`Zoeken ${search}…`, `Searching ${search}…`); });
          if (lowest) setBin(Math.max(200, priceStepBelow(lowest)));
          else showToast(L("Geen enkele listing gevonden voor deze kaart.", "No listing found for this card."), false);
        } catch (error) {
          showToast(L(`Laagste BIN zoeken mislukt: ${error.message}`, `Lowest BIN search failed: ${error.message}`), false);
        } finally {
          node.disabled = false;
          refreshPrice();
        }
      });
      priceButton.classList.add("pt-ql-gold");
      refreshPrice = () => {
        const entry = geniePrice(item.definitionId, item.resourceId);
        if (entry) {
          const source = entry._market ? L("Laagste BIN", "Lowest BIN") : L("Genie-prijs", "Genie price");
          priceButton.textContent = `${source} ${priceFormat.format(entry.price)}`;
          priceButton.title = `Buy Now = ${source.toLowerCase()} (${formatDayTime(Number(entry._fetchedAt) || Date.now())})`;
        } else {
          priceButton.textContent = L("🏷️ Laagste BIN zoeken", "🏷️ Search lowest BIN");
          button.title = L("Gebruikt beschikbare referentieprijs; zonder prijs kun je handmatig een live BIN-scan starten (max 3 EA-zoekopdrachten).", "Uses the available reference price; without a price you can start a manual live BIN scan (max 3 EA searches).");
        }
      };
      refreshPrice();
      const breakEven = button("Break even", L("Buy Now waarbij je na 5% tax precies je aankoopprijs terugkrijgt", "Buy Now at which you get exactly your purchase price back after 5% tax"), () => setBin(bought / (1 - EA_TAX)));
      breakEven.classList.add("pt-ql-gold");
      row.appendChild(bought ? grid(2, priceButton, breakEven) : grid(1, priceButton));
      row.appendChild(grid(3, ...[[-10, 0.9], [5, 1.05], [10, 1.1]].map(([pct, factor]) =>
        button(`${pct > 0 ? "+" : ""}${pct}%`, L(`Buy Now in het veld ${pct > 0 ? "+" : ""}${pct}%`, `Buy Now in the field ${pct > 0 ? "+" : ""}${pct}%`), () => { if (binNow()) setBin(binNow() * factor); }))));
    }

    if (bought) {
      const pcts = QUICK_LIST_PCTS.map(pct => button(`+${pct}%`, L(`Buy Now = aankoopprijs + ${pct}%`, `Buy Now = purchase price + ${pct}%`), () => setBin(bought * (1 + pct / 100))));
      // Own %: applied when you finish typing (Enter / Done / leaving the field).
      const customBox = el("label", "pt-ql-btn pt-ql-custom-box");
      const custom = el("input", "pt-ql-custom");
      custom.inputMode = "decimal";
      custom.enterKeyHint = "done";
      const saved = relistSettings().pct;
      custom.value = QUICK_LIST_PCTS.includes(saved) ? "" : String(saved);
      custom.placeholder = "eigen";
      customBox.append(custom, el("span", "pt-ql-suffix", "%"));
      const applyCustom = () => {
        const pct = Number(String(custom.value).replace(",", "."));
        if (!custom.value || !Number.isFinite(pct) || pct <= -50 || pct > 500) return;
        writeJson(RELIST_KEY, { ...relistSettings(), pct });
        setBin(bought * (1 + pct / 100));
      };
      custom.addEventListener("change", applyCustom);
      custom.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        custom.blur();
        applyCustom();
      });
      row.append(el("div", "pt-ql-title", L(`Op je aankoopprijs (${priceFormat.format(bought)})`, `On your purchase price (${priceFormat.format(bought)})`)), grid(4, ...pcts, customBox));
    }
    row.appendChild(profit);

    const listButton = actions.querySelector("button.call-to-action");
    if (listButton && listButton.parentNode === actions) actions.insertBefore(row, listButton);
    else actions.appendChild(row);
    // Typing or +/- in EA's BIN field: profit follows.
    try {
      const input = view._buyNowNumericStepper.getInput();
      if (input && typeof input.addTarget === "function" && window.EventType && !input.__ptProfit) {
        input.__ptProfit = true;
        input.addTarget(view, () => { const current = actions.querySelector(".pt-ql:not(.pt-ql-mb)"); if (current) current.__ptRefresh(); }, window.EventType.CHANGE);
      }
    } catch (_) {
      // Profit then follows our buttons only.
    }
    if (!actions.__ptProfitBound) {
      actions.__ptProfitBound = true;
      const refresh = () => { const current = actions.querySelector(".pt-ql:not(.pt-ql-mb)"); if (current) current.__ptRefresh(); };
      actions.addEventListener("input", event => { if (!event.target.closest(".pt-ql")) refresh(); });
      actions.addEventListener("click", () => window.setTimeout(refresh, 50));
    }
    row.__ptRefresh = () => {
      refreshPrice();
      showProfit();
    };
    row.__ptRefresh();
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  // --- Hotkeys (like FUT Genie): right-click a button → "Toets toewijzen" → press a key ------------------
  // The key then clicks that button whenever it is on screen: ONE press = ONE click (held keys / auto
  // repeat are ignored, never in a text field). It only presses what you could press yourself; nothing
  // runs on its own. A button is recognised by its text (prices and other numbers left out, so "Buy Now
  // for 2,000" stays the same button) plus its EA style classes.
  const HOTKEY_KEY = "pt_hotkeys_v1";
  const HOTKEY_DIALOGS = ".ea-dialog-view, .view-modal-container, .ui-dialog-type-message, .ut-popup";
  const HOTKEY_TARGETS = "button, .btn-standard, .ut-tab-bar-item, .ut-navigation-button-control, [role='button']";
  function getHotkeys() {
    try { const list = JSON.parse(localStorage.getItem(HOTKEY_KEY) || "[]"); return Array.isArray(list) ? list : []; } catch (_) { return []; }
  }
  function saveHotkeys(list) {
    try { localStorage.setItem(HOTKEY_KEY, JSON.stringify(list)); } catch (_) { /* this session only */ }
  }
  const HOTKEY_CLASS_SKIP = /^(pt-hk-|pt-fx-on|pt-fx-live|selected|active|focus|hover|disabled|pressed)/;
  const hotkeyClasses = node => [...node.classList].filter(name => !HOTKEY_CLASS_SKIP.test(name)).sort();
  // Text of the button (numbers left out); an icon-only button (EA's ‹ back arrow) is known by its classes.
  const hotkeyLabel = node => {
    const text = String(node.textContent || node.getAttribute("aria-label") || node.title || "")
      .replace(/[\d.,]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (text) return text;
    const classes = hotkeyClasses(node);
    return classes.length ? `#${classes.join(".")}` : "";
  };
  const HOTKEY_ICON_NAMES = { "#ut-navigation-button-control": L("‹ Terug", "‹ Back") };
  const hotkeyName = node => {
    const text = String(node.textContent || node.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return text || HOTKEY_ICON_NAMES[hotkeyLabel(node)] || "Icoonknop";
  };
  function hotkeyCombo(event) {
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && key.length > 1 && "Shift", key].filter(Boolean).join("+");
  }
  const HOTKEY_NAMES = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", " ": "Spatie", Backspace: "⌫" };
  const hotkeyShow = combo => combo.split("+").map(part => HOTKEY_NAMES[part] || part).join("+");
  const hotkeyVisible = node => {
    if (!node.isConnected || node.disabled || node.classList.contains("disabled")) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  // The button on screen now for a binding: same text and (most of) the same classes; a button in an open
  // dialog wins (e.g. "Ok" of the buy confirmation), then the first one on the page.
  // Same-looking buttons on one screen (the four "+" of the price filter): which one by position, counted
  // over all of them (also disabled / hidden ones), so "the 4th +" stays the Buy Now max "+".
  const hotkeySiblings = (label, classes) => [...document.querySelectorAll(HOTKEY_TARGETS)]
    .filter(node => !node.closest(".pt-hk-menu, .pt-hk-panel") && hotkeyLabel(node) === label
      && hotkeyClasses(node).join(" ") === classes.join(" "));
  function hotkeyFind(binding) {
    if (binding.nth != null) {
      const same = hotkeySiblings(binding.label, binding.classes);
      if (same.length === binding.of) {
        const node = same[binding.nth];
        return node && hotkeyVisible(node) ? node : null;
      }
    }
    const candidates = [...document.querySelectorAll(HOTKEY_TARGETS)]
      .filter(node => !node.closest(".pt-hk-menu, .pt-hk-panel") && hotkeyLabel(node) === binding.label && hotkeyVisible(node));
    const fit = node => { const have = hotkeyClasses(node); return binding.classes.filter(name => have.includes(name)).length; };
    candidates.sort((a, b) => fit(b) - fit(a));
    const best = candidates.filter(node => fit(node) === (candidates.length ? fit(candidates[0]) : 0));
    return best.find(node => node.closest(HOTKEY_DIALOGS)) || best[0] || null;
  }
  function hotkeyPress(node) {
    const rect = node.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    try { node.dispatchEvent(new PointerEvent("pointerdown", at)); } catch (_) { /* older browser */ }
    node.dispatchEvent(new MouseEvent("mousedown", at));
    try { node.dispatchEvent(new PointerEvent("pointerup", at)); } catch (_) { /* older browser */ }
    node.dispatchEvent(new MouseEvent("mouseup", at));
    node.dispatchEvent(new MouseEvent("click", at));
    node.classList.add("pt-hk-flash");
    window.setTimeout(() => node.classList.remove("pt-hk-flash"), 250);
  }

  // Subtle key label in the corner of every button that has a key (a layer on top of the page, so EA's
  // own button styles and icons stay untouched). Redrawn twice a second and on scroll/resize.
  const hotkeyLayer = el("div", "pt-hk-layer");
  const hotkeyTags = new Map(); // node -> tag
  function drawHotkeyTags() {
    if (!hotkeyLayer.isConnected && document.body) document.body.appendChild(hotkeyLayer);
    const want = new Map();
    getHotkeys().forEach(binding => {
      let nodes;
      if (binding.nth != null) {
        const same = hotkeySiblings(binding.label, binding.classes);
        nodes = same.length === binding.of && same[binding.nth] ? [same[binding.nth]] : [];
      } else {
        const node = hotkeyFind(binding); // the button this key would press now
        nodes = node ? [node] : [];
      }
      nodes.forEach(node => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > window.innerHeight) return;
        // Only a button that is really on top right now (not one of a screen that is sliding away / covered).
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!hit || !(hit === node || node.contains(hit))) return;
        want.set(node, { text: hotkeyShow(binding.combo), rect });
      });
    });
    hotkeyTags.forEach((tag, node) => { if (!want.has(node)) { tag.remove(); hotkeyTags.delete(node); } });
    want.forEach(({ text, rect }, node) => {
      let tag = hotkeyTags.get(node);
      if (!tag) { tag = el("span", "pt-hk-tag"); hotkeyLayer.appendChild(tag); hotkeyTags.set(node, tag); }
      if (tag.textContent !== text) tag.textContent = text;
      const left = `${Math.round(rect.right - 4)}px`;
      const top = `${Math.round(rect.top + 3)}px`;
      if (tag.style.left !== left) tag.style.left = left;
      if (tag.style.top !== top) tag.style.top = top;
    });
  }
  // Redraw as soon as the page changes (screen switch, animation) — at most once per frame — plus a slow
  // safety tick. Tags are hidden at once on every click/key, so a leaving screen never keeps them.
  let hotkeyDrawQueued = false;
  const queueHotkeyTags = () => {
    if (hotkeyDrawQueued) return;
    hotkeyDrawQueued = true;
    window.requestAnimationFrame(() => { hotkeyDrawQueued = false; drawHotkeyTags(); });
  };
  const hideHotkeyTags = () => { hotkeyTags.forEach(tag => tag.remove()); hotkeyTags.clear(); queueHotkeyTags(); };
  new MutationObserver(records => {
    if (records.every(record => hotkeyLayer.contains(record.target))) return; // our own tags moving
    queueHotkeyTags();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "disabled"] });
  ["transitionend", "animationend", "resize"].forEach(type => window.addEventListener(type, queueHotkeyTags, true));
  window.addEventListener("scroll", queueHotkeyTags, true);
  ["pointerdown", "keydown"].forEach(type => window.addEventListener(type, () => window.setTimeout(hideHotkeyTags, 0), true));
  window.setInterval(drawHotkeyTags, 400);

  let hotkeyCapture = null; // { label, classes, name } while waiting for the key to assign
  let hotkeyMenu = null;
  function closeHotkeyMenu() {
    if (hotkeyMenu) hotkeyMenu.remove();
    hotkeyMenu = null;
  }
  function openHotkeyPanel() {
    document.querySelectorAll(".pt-hk-panel").forEach(node => node.remove());
    const panel = el("div", "pt-hk-panel");
    const draw = () => {
      panel.textContent = "";
      const head = el("div", "pt-hk-head");
      head.append(el("b", "", L("⌨ Sneltoetsen", "⌨ Hotkeys")), el("span", "pt-hk-sub", L("Rechtsklik op een knop → Toets toewijzen", "Right-click a button → Assign key")));
      const close = el("button", "pt-hk-x", "✕");
      close.type = "button";
      close.addEventListener("click", () => panel.remove());
      head.appendChild(close);
      panel.appendChild(head);
      const list = getHotkeys();
      if (!list.length) panel.appendChild(el("div", "pt-hk-empty", L("Nog geen sneltoetsen.", "No hotkeys yet.")));
      list.forEach((binding, i) => {
        const line = el("div", "pt-hk-line");
        const remove = el("button", "pt-hk-x", "✕");
        remove.type = "button";
        remove.title = L("Verwijderen", "Delete");
        remove.addEventListener("click", () => { const next = getHotkeys(); next.splice(i, 1); saveHotkeys(next); draw(); });
        line.append(el("kbd", "", hotkeyShow(binding.combo)), el("span", "", binding.name || binding.label), remove);
        panel.appendChild(line);
      });
    };
    draw();
    document.body.appendChild(panel);
  }
  // Right-click on a button: EA's buttons react to the right mouse button as if it were a left click (a
  // right-click on "List Now" would list the card!). So the right button never reaches a button: every
  // right-button pointer/mouse event on a button is stopped here (capture, before EA and before FUT Genie's
  // own hotkey menu), and the right-click only opens our "Toets toewijzen" menu.
  // One right-click = one menu: pointerup and contextmenu both belong to the same press ("gesture").
  let hotkeyGesture = 0;
  let hotkeyGestureAt = 0;
  let hotkeyOpenedGesture = -1;
  const hotkeyOpenOnce = (target, x, y) => {
    if (hotkeyOpenedGesture === hotkeyGesture) return;
    hotkeyOpenedGesture = hotkeyGesture;
    openHotkeyMenuFor(target, x, y, null);
  };
  const hotkeyRightTarget = event => {
    if (event.button !== 2 || !(event.target instanceof Element)) return null;
    const target = event.target.closest(HOTKEY_TARGETS);
    return target && !target.closest(".pt-hk-menu, .pt-hk-panel") ? target : null;
  };
  ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick", "click"].forEach(type => {
    window.addEventListener(type, event => {
      const target = hotkeyRightTarget(event);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === "pointerdown") { hotkeyGesture++; hotkeyGestureAt = Date.now(); }
      if (type === "pointerup") {
        const x = event.clientX;
        const y = event.clientY;
        window.setTimeout(() => hotkeyOpenOnce(target, x, y), 0);
      }
    }, true);
  });
  window.addEventListener("contextmenu", event => {
    if (!(event.target instanceof Element) || !event.target.closest(HOTKEY_TARGETS) || event.target.closest(".pt-hk-menu, .pt-hk-panel")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (Date.now() - hotkeyGestureAt > 1500) hotkeyGesture++; // menu key / no pointer events: a new press
    hotkeyOpenOnce(event.target, event.clientX, event.clientY);
  }, true);
  function openHotkeyMenuFor(node, clientX, clientY, event) {
    const target = node instanceof Element ? node.closest(HOTKEY_TARGETS) : null;
    if (!target || target.closest(".pt-hk-menu, .pt-hk-panel")) return;
    const label = hotkeyLabel(target);
    if (!label) return;
    if (event) event.preventDefault();
    closeHotkeyMenu();
    event = { clientX, clientY };
    const classes = hotkeyClasses(target);
    // Position only for look-alikes side by side (the price "+" buttons); not when one of them sits in a
    // dialog (then the dialog's button is meant, like "Ok" of the buy confirmation).
    const same = hotkeySiblings(label, classes);
    const inDialog = node => !!node.closest(HOTKEY_DIALOGS);
    const nth = same.length > 1 && !same.some(inDialog) ? same.indexOf(target) : -1;
    const name = hotkeyName(target) + (nth >= 0 ? L(` (${nth + 1} van ${same.length})`, ` (${nth + 1} of ${same.length})`) : "");
    const bound = getHotkeys().filter(binding => binding.label === label && (binding.nth ?? null) === (nth >= 0 ? nth : null));
    hotkeyMenu = el("div", "pt-hk-menu");
    hotkeyMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
    hotkeyMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 140)}px`;
    const item = (text, action) => {
      const node = el("button", "pt-hk-item", text);
      node.type = "button";
      node.addEventListener("click", () => { closeHotkeyMenu(); action(); });
      hotkeyMenu.appendChild(node);
    };
    hotkeyMenu.appendChild(el("div", "pt-hk-title", name || label));
    item(bound.length ? L(`⌨ Andere toets (nu ${bound.map(b => hotkeyShow(b.combo)).join(", ")})`, `⌨ Other key (now ${bound.map(b => hotkeyShow(b.combo)).join(", ")})`) : L("⌨ Toets toewijzen", "⌨ Assign key"), () => {
      hotkeyCapture = { label, classes, name, nth: nth >= 0 ? nth : null, of: nth >= 0 ? same.length : null };
      showToast(L(`Druk nu op de toets voor "${name || label}" (Esc = annuleren)`, `Press the key for "${name || label}" now (Esc = cancel)`), true);
    });
    if (bound.length) item(L("✕ Toets verwijderen", "✕ Remove key"), () => { saveHotkeys(getHotkeys().filter(binding => !bound.some(b => b.combo === binding.combo))); showToast(L("Sneltoets verwijderd", "Hotkey removed"), true); });
    item(L("☰ Alle sneltoetsen…", "☰ All hotkeys…"), openHotkeyPanel);
    document.body.appendChild(hotkeyMenu);
  }
  document.addEventListener("mousedown", event => {
    if (hotkeyMenu && !(event.target instanceof Element && event.target.closest(".pt-hk-menu"))) closeHotkeyMenu();
  }, true);
  // Capture phase on window: runs before EA's own handlers, and a key you assigned here is not passed on
  // (so FUT Genie, if it has the same key, does not click a second time).
  window.addEventListener("keydown", event => {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    if (hotkeyCapture) {
      event.preventDefault();
      event.stopPropagation();
      const capture = hotkeyCapture;
      hotkeyCapture = null;
      if (event.key === "Escape") return void showToast("Toewijzen geannuleerd", false);
      const combo = hotkeyCombo(event);
      // one key = one button: the key leaves any other button, this button keeps only the new key
      const sameButton = binding => binding.label === capture.label && (binding.nth ?? null) === capture.nth;
      const next = getHotkeys().filter(binding => binding.combo !== combo && !sameButton(binding));
      next.push({ combo, label: capture.label, classes: capture.classes, name: capture.name, nth: capture.nth, of: capture.of });
      saveHotkeys(next);
      drawHotkeyTags();
      showToast(`"${capture.name || capture.label}" = ${hotkeyShow(combo)}${genie() ? L(" · deze toets gaat nu voor op FUT Genie", " · this key now takes priority over FUT Genie") : ""}`, true);
      return;
    }
    if (event.repeat || event.metaKey) return; // held key: never a second click
    const focus = document.activeElement;
    // In a price field (EA's numbers) only the keys you type a price with stay in the field; a letter or
    // Enter is a hotkey (the field is left first, so EA keeps the price you typed). Other text fields:
    // every key is typing.
    const priceField = focus && focus.tagName === "INPUT" && (focus.closest(".price-filter, .ut-numeric-input-spinner-control")
      || focus.inputMode === "numeric" || /^(number|tel)$/.test(focus.type) || /numeric|number|price/i.test(focus.className));
    const typingKey = /^[0-9.,\-]$/.test(event.key) || ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(event.key);
    if (focus && (focus.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName)) && !(priceField && !typingKey)) return;
    if (hotkeyMenu && event.key === "Escape") return void closeHotkeyMenu();
    const combo = hotkeyCombo(event);
    const binding = getHotkeys().find(item => item.combo === combo);
    if (!binding) return;
    const button = hotkeyFind(binding);
    event.preventDefault();
    event.stopPropagation();
    if (priceField && focus) focus.blur();
    if (!button) return void showToast(L(`${hotkeyShow(combo)}: "${binding.name || binding.label}" staat niet op dit scherm`, `${hotkeyShow(combo)}: "${binding.name || binding.label}" is not on this screen`), false);
    hotkeyPress(button);
  }, true);

  const CSS = `
/* Page: dark card on top of EA's bright background, never wider than the viewport. */
.pt-watch-view {
  box-sizing: border-box;
  width: 100%;
  min-height: 100%;
  padding: 24px;
  overflow-y: auto;
}

// Language for the Tampermonkey part below (gist, ntfy, QR, request bridge): same setting as the page
// (pt_flip_v1.lang, English by default). priceWatchMain has its own L inside.
function L(nl, en) {
  try {
    const saved = JSON.parse(window.localStorage.getItem("pt_flip_v1") || "null");
    return saved && saved.lang === "nl" ? nl : en;
  } catch (_) {
    return en;
  }
}

.pt-watch-card {
  box-sizing: border-box;
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 24px 12px;
  background: rgba(12, 17, 25, .94);
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
  color: #e8ecf2;
}

.pt-watch-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 20px;
  margin-bottom: 16px;
}

.pt-watch-title { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #fff; }
.pt-watch-status { font-size: 13px; color: #9aa6b8; }
.pt-watch-version { margin-left: 10px; font-size: 12px; font-weight: 600; color: #6b7789; vertical-align: middle; }

.pt-watch-refresh {
  flex: 0 0 auto;
  padding: 8px 14px;
  cursor: pointer;
  background: #1c2735;
  border: 1px solid #3a4a5e;
  border-radius: 6px;
  color: #e8ecf2;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
}

.pt-watch-refresh:hover:not(:disabled) { border-color: #63b3ff; color: #fff; }
.pt-watch-refresh:disabled { opacity: .5; cursor: default; }

/* Table */
.pt-watch-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 15px;
}

.pt-watch-table th {
  padding: 8px 10px;
  text-align: left;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: #8d9aae;
  border-bottom: 1px solid rgba(255, 255, 255, .14);
  white-space: nowrap;
}

.pt-watch-table td {
  height: 44px;
  padding: 4px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, .06);
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pt-watch-table tbody tr:nth-child(even) { background: rgba(255, 255, 255, .025); }
.pt-watch-table tbody tr:hover { background: rgba(99, 179, 255, .08); }

.pt-watch-table .pt-col-name     { width: 27%; }
.pt-watch-table .pt-col-rating   { width: 7%; text-align: center; }
.pt-watch-table .pt-col-rarity   { width: 18%; }
.pt-watch-table .pt-col-price    { width: 15%; text-align: right; }
.pt-watch-table .pt-col-target   { width: 14%; padding-left: 24px; }
.pt-watch-table .pt-col-distance { width: 15%; text-align: right; }
.pt-watch-table .pt-col-remove   { width: 4%; text-align: right; }

.pt-watch-table td.pt-col-rating { font-weight: 700; }
.pt-watch-table td.pt-col-rarity { color: #aab5c5; }
.pt-watch-table td.pt-col-price  { font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; overflow: visible; white-space: nowrap; }
.pt-watch-table .pt-price-value { white-space: nowrap; }
.pt-watch-table .pt-price-live-bin { display: block; margin-top: 2px; color: #7dd3fc; font-size: 10px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
.pt-watch-table .pt-price-live-bin.pt-live-uncertain { color: #f3c969; }
.pt-watch-table .pt-price-source { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 20px; box-sizing: border-box; margin-left: 5px; min-width: 20px; height: 15px; padding: 0 3px; border: 1px solid #526174; border-radius: 4px; color: #aebdd0; font-size: 9px; font-weight: 800; line-height: 1; vertical-align: 2px; }
.pt-watch-table .pt-price-source[title^="FUT.GG"] { color: #78d6ff; border-color: #287ca4; }
.pt-watch-table td.pt-missing    { color: #6b7789; font-weight: 400; }

.pt-watch-table .pt-sortable { cursor: pointer; user-select: none; }
.pt-watch-table .pt-sortable:hover,
.pt-watch-table .pt-sortable.pt-sorted { color: #63b3ff; }
.pt-watch-table .pt-sortable::after { content: " ⇅"; opacity: .6; }
.pt-watch-table .pt-sortable.pt-sorted::after { content: " ▲"; opacity: 1; }

.pt-name-wrap { display: flex; align-items: center; min-width: 0; }
.pt-watch-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 700;
  color: #fff;
}

.pt-watch-view .pt-target-input {
  width: 100%;
  max-width: 130px;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid #3a4a5e;
  border-radius: 5px;
  background: #0a0f16;
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.pt-watch-view .pt-target-input:focus { outline: none; border-color: #63b3ff; }

/* Distance as a coloured pill */
.pt-watch-view .pt-distance {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: #8d9aae;
}

.pt-watch-view .pt-distance.pt-hit  { color: #27d98b; background: rgba(39, 217, 139, .14); font-weight: 700; }
.pt-watch-view .pt-distance.pt-near { color: #f3c969; background: rgba(243, 201, 105, .14); font-weight: 700; }
.pt-watch-view .pt-distance.pt-far  { color: #ff8080; background: rgba(255, 112, 112, .12); font-weight: 600; }

/* Small icon buttons */
.pt-watch-view .pt-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  margin-left: 6px;
  padding: 0;
  cursor: pointer;
  background: transparent;
  border: 1px solid #3a4a5e;
  border-radius: 5px;
  color: #63b3ff;
  font-size: 12px;
  line-height: 1;
}

.pt-watch-view .pt-icon-btn + .pt-icon-btn { margin-left: 4px; }
.pt-watch-view .pt-icon-btn:hover { color: #fff; border-color: #63b3ff; }
.pt-watch-view .pt-transfer-search:hover { border-color: #27d98b; background: rgba(39, 217, 139, .12); }
.pt-watch-view .pt-remove { margin-left: 0; color: #ff8080; font-size: 16px; }
.pt-watch-view .pt-remove:hover { border-color: #ff7070; color: #fff; background: rgba(255, 112, 112, .15); }
.pt-watch-view .pt-icon-btn.pt-ok    { color: #27d98b; border-color: #27d98b; }
.pt-watch-view .pt-icon-btn.pt-error { color: #ff7070; border-color: #ff7070; }

.pt-watch-empty { padding: 40px 0 32px; text-align: center; color: #9aa6b8; font-size: 15px; }

.pt-watch-add.pt-watching { opacity: .8; }
.pt-lowest-wrap { display: flex; flex-direction: column; gap: 4px; }
.pt-lowest-out { font-size: 13px; line-height: 1.4; color: #e8e8e8; text-align: center; padding: 0 6px; }
.pt-lowest-out:empty { display: none; }
.pt-transfer-card .pt-tl-block { margin: 14px 0; padding: 12px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; }
.pt-tl-title { margin: 0 0 8px; font-size: 15px; }
.pt-tl-line { font-size: 13px; margin: 6px 0; }
.pt-tl-sales { font-size: 13px; }
.pt-tl-sale { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.pt-relist-go { margin-top: 10px; }
.pt-pos { color: #5fd38d; }
.pt-neg { color: #ff7b7b; }
.pt-profit-info { font-size: 13px; padding: 6px 4px; text-align: center; }
.pt-tl-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px; }
.pt-tl-tile { padding: 8px 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; background: rgba(0,0,0,.25); }
.pt-tl-tile-label { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #9aa6b8; }
.pt-tl-tile-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
.pt-tl-tile-note { font-size: 11px; color: #9aa6b8; }
.pt-tl-row { font-size: 12px; margin-top: 4px; line-height: 1.3; white-space: normal; }
.pt-tl-tile-label { font-size: 12px; }
.pt-tl-tile-value { font-size: 22px; }
.pt-tl-badge { position: absolute; top: 8px; right: 14px; z-index: 2; text-align: right; font-size: 15px; font-weight: 700; line-height: 1.25; pointer-events: none; }
.pt-tl-badge-sub { font-size: 11px; font-weight: 600; color: #9aa6b8; }
.pt-mb-badge { font-size: 12px; font-weight: 700; margin-top: 4px; line-height: 1.3; white-space: normal; color: #cfd8e6; }
.pt-mb-badge.pt-mb-ok { color: #6be38f; }
.pt-mb-badge.pt-mb-over { color: #ff7b7b; opacity: 1; }
.pt-mb-badge.pt-mb-highest { color: #7fc8ff; }
.pt-mb-badge.pt-mb-won { color: #ffd76a; }
.pt-mb-badge.pt-mb-lost { color: #9aa6b8; }
.pt-mb-left { color: #ffd76a; }
.listFUTItem.pt-mb-over:not(.pt-mb-tilerow), li.pt-mb-over:not(.pt-mb-tilerow) { opacity: .55; }
.pt-mb-tilerow { position: relative; }
.pt-mb-tilerow.pt-mb-over > :not(.pt-mb-badge) { opacity: .4; }
.pt-mb-badge.pt-mb-tile { position: absolute; left: 4px; right: 4px; bottom: 4px; z-index: 5; margin: 0; padding: 4px 6px; border-radius: 6px;
  background: rgba(8, 12, 20, .94); font-size: 11px; line-height: 1.35; white-space: nowrap; text-align: center; pointer-events: none; }
.pt-mb-tile .pt-mb-tile-main { overflow: hidden; text-overflow: ellipsis; }
.pt-mb-tile.pt-mb-over { border: 1px solid #ff7b7b; }
.pt-mb-tile.pt-mb-ok { border: 1px solid #6be38f; }
.pt-mb-tile.pt-mb-highest { border: 1px solid #7fc8ff; }
.pt-session-bar { position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 100000; display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: #b86b00; color: #fff; font: 600 14px/1.3 sans-serif; border-radius: 0 0 10px 10px; box-shadow: 0 4px 16px rgba(0,0,0,.5); max-width: 92vw; }
.pt-session-bar.pt-session-blocked { background: #b3261e; }
.pt-session-bar button { border: 0; border-radius: 6px; padding: 6px 10px; font: inherit; cursor: pointer; background: #fff; color: #222; }
.pt-session-pill { position: fixed; left: 8px; bottom: 8px; z-index: 99999; border: 0; border-radius: 14px; padding: 5px 11px; font: 600 12px/1.3 sans-serif; cursor: pointer; color: #fff; background: #2f6b3a; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
.pt-session-pill.pt-session-old { background: #8a6d1a; }
.pt-session-pill.pt-session-reload { background: #b86b00; font-size: 14px; padding: 8px 14px; animation: pt-mb-pulse 1s ease-in-out infinite; }
.pt-session-pill.pt-session-late { background: #b3261e; }
.pt-mb-hot { box-shadow: inset 0 0 0 3px #6be38f; animation: pt-mb-pulse 1s ease-in-out infinite; }
@keyframes pt-mb-pulse { 50% { box-shadow: inset 0 0 0 3px rgba(107, 227, 143, .25); } }
.pt-mb-panel { margin: 8px 10px; padding: 8px 10px; border-radius: 6px; background: rgba(0, 0, 0, .35); font-size: 14px; font-weight: 700; color: #cfd8e6; }
.pt-mb-panel.pt-mb-ok { border-left: 4px solid #6be38f; }
.pt-mb-panel.pt-mb-over { border-left: 4px solid #ff7b7b; }
.pt-mb-panel.pt-mb-highest { border-left: 4px solid #7fc8ff; }
.pt-mb-panel-sub { font-size: 12px; font-weight: 500; color: #9aa6b8; margin-top: 3px; }
.pt-mb-steps { color: #ffd76a; }
.pt-tl-badge-sub.pt-neg { color: #ff7b7b; }
.pt-coin { display: inline-block; width: .85em; height: .85em; margin-left: 3px; vertical-align: -1px; border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #ffe9a0, #d6a92c 60%, #9c7414); box-shadow: inset 0 0 0 1px rgba(0,0,0,.35); }
.pt-tl-genie { color: #f0c94d; font-weight: 700; }
.pt-tl-row { font-size: 14px; }
.pt-ql { display: block; padding: 8px 0; }
.pt-ql-title { font-size: 13px; margin-bottom: 6px; color: #9aa6b8; }
.pt-ql-buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.pt-ql-btn { display: flex; align-items: center; justify-content: center; height: 44px; margin: 0; padding: 0 6px; box-sizing: border-box;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.28); border-radius: 8px; color: #fff; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
.pt-ql-btn:active { background: rgba(255,255,255,.16); }
.pt-ql-custom-box { gap: 2px; cursor: text; }
.pt-ql-custom { width: 100%; min-width: 0; background: transparent; border: 0; color: #fff; font: inherit; text-align: right; outline: none; }
.pt-ql-suffix { color: #9aa6b8; }
.pt-ql-profit { font-size: 14px; margin-top: 8px; }
.pt-ql-profit:empty { display: none; }
.pt-ql-buttons + .pt-ql-buttons { margin-top: 8px; }
.pt-ql-title { margin-top: 10px; }
.pt-ql-gold { border-color: rgba(214,178,74,.75); color: #f0c94d; background: rgba(214,178,74,.08); }
.pt-ql-btn:disabled { opacity: .6; }
.pt-search-count { font-size: 12px; padding: 0 6px; white-space: nowrap; opacity: .85; }
.pt-search-count.pt-search-hot { color: #ff7b7b; opacity: 1; font-weight: bold; }

/* Stock lists */
.pt-stock-card { margin-top: 20px; }
.pt-watch-view .pt-muted { color: #8d9aae; }

.pt-watch-view .pt-holo-on { color: #e7b6ff; font-weight: 700; }
.pt-link-btn {
  padding: 6px 10px;
  cursor: pointer;
  background: transparent;
  border: 0;
  color: #8d9aae;
  font: inherit;
  font-size: 13px;
}

.pt-link-btn:hover { color: #fff; }
.pt-link-btn.pt-danger:hover,
.pt-link-btn.pt-danger[data-armed="1"] { color: #ff8080; }

.pt-stock-import {
  margin-bottom: 18px;
  padding: 16px;
  background: rgba(255, 255, 255, .03);
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 8px;
}

.pt-stock-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 220px;
  padding: 10px 12px;
  border: 1px solid #3a4a5e;
  border-radius: 6px;
  background: #0a0f16;
  color: #e8ecf2;
  font: inherit;
  font-size: 14px;
  line-height: 1.45;
  resize: vertical;
}

.pt-stock-textarea:focus { outline: none; border-color: #63b3ff; }

.pt-stock-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.pt-stock-actions .pt-stock-name { max-width: 220px; }
.pt-stock-summary { margin-bottom: 12px; font-size: 14px; color: #c9d2de; }

.pt-stock-levels { display: flex; flex-wrap: wrap; gap: 10px 24px; margin-bottom: 14px; }
.pt-stock-level { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.pt-stock-level .pt-target-input { width: 90px; }
.pt-stock-level-name { min-width: 46px; font-weight: 700; color: #fff; }
.pt-filter-review { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.pt-filter-rule { border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 8px 10px; }
.pt-filter-rule.pt-filter-off { opacity: 0.55; }
.pt-filter-raw, .pt-filter-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; color: #fff; }
.pt-filter-edit { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-bottom: 6px; }
.pt-filter-edit .pt-target-input { width: 84px; }
.pt-filter-edit .pt-filter-positions { width: 130px; }
.pt-filter-leagues { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; }
.pt-filter-chip { padding: 2px 6px; }
.pt-filter-optional { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.pt-filter-steps { display: flex; flex-wrap: wrap; gap: 6px; }

.pt-stock-review .pt-col-check  { width: 5%; }
.pt-stock-review .pt-col-raw    { width: 25%; color: #c9d2de; }
.pt-stock-review .pt-col-match  { width: 38%; }
.pt-stock-review .pt-col-league { width: 26%; }
.pt-stock-review .pt-col-status { width: 6%; text-align: center; font-weight: 700; }
/* Snipe tips with prices: version dropdown + max BIN column. */
.pt-stock-review.pt-stock-priced .pt-col-raw    { width: 21%; }
.pt-stock-review.pt-stock-priced .pt-col-match  { width: 22%; }
.pt-stock-review.pt-stock-priced .pt-col-league { width: 32%; }
.pt-stock-review.pt-stock-priced .pt-col-level  { width: 14%; }
.pt-stock-review.pt-stock-priced .pt-col-level .pt-target-input { box-sizing: border-box; width: 100%; }
.pt-stock-review tr.pt-match-sure .pt-col-status  { color: #27d98b; }
.pt-stock-review tr.pt-match-maybe { background: rgba(243, 201, 105, .08) !important; }
.pt-stock-review tr.pt-match-maybe .pt-col-status { color: #f3c969; }
.pt-stock-review tr.pt-match-none  { opacity: .6; }
.pt-stock-review tr.pt-match-none .pt-col-status  { color: #ff8080; }

.pt-stock-select {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #3a4a5e;
  border-radius: 5px;
  background: #0a0f16;
  color: #fff;
  font: inherit;
  font-size: 14px;
}

.pt-stock-list {
  margin-top: 12px;
  padding: 12px 14px 4px;
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 8px;
}

.pt-stock-list.pt-active { border-color: rgba(99, 179, 255, .5); }

.pt-stock-list-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.pt-stock-list-name { font-size: 17px; font-weight: 700; color: #fff; }
.pt-stock-list-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

.pt-stock-grid .pt-col-level { width: 18%; text-align: center; }
.pt-stock-grid td { height: auto; padding-top: 7px; padding-bottom: 7px; }

.pt-stock-summary-line { margin-top: 4px; font-size: 13px; }
.pt-watch-view .pt-profit { color: #27d98b; font-weight: 700; }
.pt-watch-view .pt-loss { color: #ff8080; font-weight: 700; }

.pt-goal { display: flex; align-items: center; gap: 6px; margin-right: 6px; font-size: 13px; }
.pt-goal .pt-target-input { width: 56px; text-align: center; }

.pt-level-detail {
  margin-top: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: help;
}

.pt-level-btn {
  min-width: 96px;
  padding: 5px 10px;
  cursor: pointer;
  background: #1c2735;
  border: 1px solid #3a4a5e;
  border-radius: 999px;
  color: #e8ecf2;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.pt-level-btn:hover { border-color: #27d98b; color: #fff; }
.pt-level-btn.pt-done { color: #27d98b; border-color: rgba(39, 217, 139, .4); background: rgba(39, 217, 139, .08); }
.pt-level-btn.pt-current { border-color: #63b3ff; box-shadow: 0 0 0 2px rgba(99, 179, 255, .35); }

/* Floating run bar: visible on every screen while a stock run is active */
.pt-run-bar {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 40px);
  padding: 10px 12px 10px 16px;
  background: rgba(12, 17, 25, .97);
  border: 1px solid rgba(99, 179, 255, .5);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  color: #e8ecf2;
  font-size: 14px;
}

.pt-run-info { min-width: 0; margin-right: 6px; }
.pt-run-title { font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pt-run-sub { font-size: 12px; color: #8d9aae; white-space: nowrap; }
.pt-run-title.pt-run-big { font-size: 16px; }
.pt-run-market { display: flex; gap: 4px; align-items: center; flex: 0 0 auto; }
.pt-run-market .pt-target-input { width: 70px; }
@media (max-width: 700px) { .pt-run-bar { flex-wrap: wrap; } .pt-run-info { flex: 1 1 100%; } }
/* At the top: below the safe area of the phone (notch), clear of EA's Search button at the bottom. */
.pt-run-bar.pt-run-top { top: calc(env(safe-area-inset-top, 0px) + 8px); bottom: auto; }

.pt-run-btn {
  flex: 0 0 auto;
  padding: 7px 12px;
  cursor: pointer;
  background: #1c2735;
  border: 1px solid #3a4a5e;
  border-radius: 6px;
  color: #e8ecf2;
  font: inherit;
  font-weight: 600;
}

.pt-run-window { margin-top: 3px; font-size: 12px; font-weight: 700; }
.pt-window-before { color: #f3c969; }
.pt-window-open { color: #27d98b; }
.pt-window-after { color: #8d9aae; font-weight: 400; }
.pt-run-bar[data-window="open"] { border-color: #27d98b; box-shadow: 0 0 0 2px rgba(39, 217, 139, .35), 0 10px 30px rgba(0, 0, 0, .45); }

.pt-watch-view .pt-datetime { width: 190px; color-scheme: dark; }
.pt-snipe-grid .pt-col-stock { width: 21%; }
.pt-snipe-grid .pt-col-target { width: 22%; }
.pt-snipe-grid td { overflow: visible; }
.pt-outlook { text-align: left; }
.pt-windows { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
.pt-watch-view .pt-small { font-size: 12px; margin-bottom: 6px; }
.pt-list-select { width: auto; min-width: 260px; }
.pt-watch-view .pt-mode-select { width: auto; min-width: 140px; padding: 5px 8px; }

/* Tabs: Spelers | Fodder | Lijsten */
.pt-tabs {
  display: flex;
  gap: 6px;
  max-width: 1280px;
  margin: 0 auto 14px;
}

.pt-tab {
  padding: 9px 18px;
  cursor: pointer;
  background: rgba(12, 17, 25, .85);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 8px;
  color: #aab5c5;
  font: inherit;
  font-size: 14px;
  font-weight: 700;
}

.pt-tab:hover { color: #fff; border-color: #63b3ff; }
.pt-tab.pt-tab-active { color: #fff; background: #1c2735; border-color: #63b3ff; }
.pt-watch-view .pt-tabs + .pt-watch-card,
.pt-watch-view .pt-stock-card,
.pt-watch-view .pt-fodder-card { margin-top: 0; }

/* Flip sheet (fodder.gg) */
.pt-watch-view .pt-flip-card { margin-top: 0; }
.pt-watch-view .pt-flip-link { width: 320px; }
.pt-watch-view .pt-flip-max { width: 90px; }
.pt-flip-alert-on { border-color: #27d98b; color: #fff; background: #1d4f3a; }
/* ---- Flip tab, layout C (pro table) ---- */
.pt-watch-view .pt-flip-card { background: linear-gradient(180deg, rgba(19, 29, 49, .94), rgba(11, 18, 31, .97)); border: 1px solid rgba(148, 178, 230, .18); border-radius: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, .40), inset 0 1px 0 rgba(255, 255, 255, .04); padding: 14px 14px 10px; }
.pt-flip-card .pt-fx-toolbar { display: grid; gap: 10px; margin-bottom: 10px; }
.pt-flip-card .pt-fx-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pt-flip-card .pt-fx-row2 { gap: 8px; }
.pt-flip-card .pt-fx-spacer { flex: 1; }
.pt-flip-card .pt-fx-title { font-size: 22px; font-weight: 800; letter-spacing: .3px; color: #e8eef9; margin-right: 2px; }
.pt-flip-card .pt-fx-status { font-size: 12px; color: #8392ab; margin: 0; padding-left: 2px; }
.pt-flip-card .pt-fx-seg { display: inline-flex; padding: 3px; gap: 2px; background: rgba(0, 0, 0, .28); border: 1px solid rgba(148, 178, 230, .12); border-radius: 10px; }
.pt-flip-card button.pt-fx-seg-btn { appearance: none; border: 0; background: none; color: #8392ab; font: 600 13px/1 inherit; font-family: inherit; padding: 7px 12px; border-radius: 7px; cursor: pointer; text-transform: none; min-height: 0; height: auto; }
.pt-flip-card button.pt-fx-seg-btn:hover { color: #e8eef9; }
.pt-flip-card button.pt-fx-seg-btn.pt-fx-on { color: #e8eef9; background: #182339; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 2px 8px rgba(0, 0, 0, .3); }
.pt-flip-card input.pt-fx-filter { flex: 1; min-width: 220px; height: 34px; padding: 0 12px; border-radius: 10px; border: 1px solid rgba(148, 178, 230, .12); background: rgba(0, 0, 0, .3); color: #e8eef9; font: 13px inherit; font-family: inherit; outline: none; }
.pt-flip-card input.pt-fx-filter:focus { border-color: rgba(76, 180, 255, .55); }
.pt-flip-card input.pt-fx-filter::placeholder { color: #56637b; }
.pt-flip-card button.pt-fx-cover { appearance: none; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid rgba(148, 178, 230, .14); background: rgba(255, 255, 255, .02); color: #8392ab; font: 600 12.5px inherit; font-family: inherit; cursor: pointer; white-space: nowrap; text-transform: none; }
.pt-flip-card button.pt-fx-cover:hover { border-color: rgba(76, 180, 255, .5); color: #e8eef9; }
.pt-flip-card .pt-fx-cover.pt-fx-busy { color: #e8eef9; border-color: rgba(76, 180, 255, .45); }
.pt-flip-card .pt-fx-track { width: 80px; height: 5px; border-radius: 999px; background: rgba(255, 255, 255, .08); overflow: hidden; display: inline-block; }
.pt-flip-card .pt-fx-track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #4cb4ff, #2fe39a); }
.pt-flip-card button.pt-fx-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 9px; border: 1px solid rgba(148, 178, 230, .2); background: rgba(255, 255, 255, .03); color: #e8eef9; font: 600 13px inherit; font-family: inherit; cursor: pointer; white-space: nowrap; text-transform: none; }
.pt-flip-card button.pt-fx-btn:hover:not(:disabled) { border-color: #4cb4ff; }
.pt-flip-card button.pt-fx-btn:disabled { opacity: .5; cursor: default; }
.pt-flip-card button.pt-fx-primary { background: linear-gradient(180deg, #58bcff, #2f97e6); border-color: transparent; color: #04111f; }
.pt-flip-card button.pt-fx-btn-sm { height: 30px; padding: 0 11px; font-size: 12.5px; }
.pt-flip-card button.pt-fx-wide { width: 100%; }
.pt-flip-card button.pt-fx-icon { appearance: none; width: 30px; height: 30px; padding: 0; display: inline-grid; place-items: center; border-radius: 8px; border: 1px solid rgba(148, 178, 230, .12); background: rgba(255, 255, 255, .02); color: #8392ab; font: 600 13px inherit; font-family: inherit; cursor: pointer; }
.pt-flip-card button.pt-fx-icon:hover, .pt-flip-card button.pt-fx-icon.pt-fx-live { color: #e8eef9; border-color: rgba(76, 180, 255, .45); }
.pt-flip-card button.pt-fx-lang { width: auto; padding: 0 9px; }
.pt-flip-card label.pt-fx-toggle { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 999px; border: 1px solid rgba(148, 178, 230, .12); color: #8392ab; font-size: 12.5px; cursor: pointer; }
.pt-flip-card label.pt-fx-toggle.pt-fx-on { color: #e8eef9; border-color: rgba(76, 180, 255, .45); background: rgba(76, 180, 255, .12); }
.pt-flip-card label.pt-fx-toggle input { accent-color: #4cb4ff; margin: 0; }
.pt-flip-card select.pt-fx-select { height: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid rgba(148, 178, 230, .12); background: rgba(0, 0, 0, .3); color: #8392ab; font: 12.5px inherit; font-family: inherit; }
.pt-flip-card .pt-fx-table { min-width: 900px; font-size: 13px; border-collapse: separate; border-spacing: 0; }
.pt-flip-card .pt-fx-table th { font-size: 10.5px; letter-spacing: 1px; text-transform: uppercase; color: #56637b; font-weight: 700; padding: 8px 10px; border-bottom: 1px solid rgba(148, 178, 230, .10); background: rgba(7, 12, 22, .45); }
.pt-flip-card .pt-fx-table td { padding: 7px 10px; height: auto; border-bottom: 1px solid rgba(148, 178, 230, .08); vertical-align: middle; }
.pt-flip-card .pt-fx-table input[type="checkbox"] { accent-color: #4cb4ff; }
.pt-flip-card .pt-fx-table .pt-col-tick { width: 32px; }
.pt-flip-card .pt-fx-table .pt-col-score { width: 104px; white-space: nowrap; overflow: visible; }
.pt-flip-card .pt-fx-table .pt-col-name { width: auto; }
.pt-flip-card .pt-fx-table .pt-col-num { width: 82px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pt-flip-card .pt-fx-table .pt-col-pct { width: 58px; }
.pt-flip-card .pt-fx-table .pt-col-sales { width: 70px; }
.pt-flip-card .pt-fx-table .pt-col-more { width: 24px; text-align: center; color: #56637b; font-size: 16px; }
.pt-flip-card .pt-fx-chev { display: inline-block; transition: transform .15s; }
.pt-flip-card .pt-flip-row.pt-flip-open .pt-fx-chev { transform: rotate(90deg); color: #4cb4ff; }
@media (prefers-reduced-motion: reduce) { .pt-flip-card .pt-fx-chev { transition: none; } }
.pt-flip-card .pt-flip-row:hover td { background: rgba(255, 255, 255, .025); }
.pt-flip-card .pt-flip-row.pt-flip-open td { background: rgba(76, 180, 255, .07); border-bottom-color: transparent; }
.pt-flip-card .pt-flip-row-buy td:first-child { box-shadow: inset 3px 0 0 #2fe39a; }
.pt-flip-card .pt-flip-row-near td:first-child { box-shadow: inset 3px 0 0 #f5c451; }
.pt-flip-card .pt-flip-row-risk td:first-child { box-shadow: inset 3px 0 0 #ff9f5a; }
.pt-flip-card .pt-flip-row-buy td { background: rgba(47, 227, 154, .045); }
.pt-flip-card .pt-fx-score { display: inline-flex; align-items: center; gap: 7px; }
.pt-flip-card .pt-fx-score b.pt-opp { all: unset; font-weight: 800; font-size: 13.5px; min-width: 20px; text-align: right; font-variant-numeric: tabular-nums; color: #e8eef9; }
.pt-flip-card .pt-fx-scorebar { width: 54px; height: 6px; border-radius: 999px; background: rgba(255, 255, 255, .08); overflow: hidden; display: inline-block; }
.pt-flip-card .pt-fx-scorebar i { display: block; height: 100%; border-radius: inherit; background: #6d7a91; }
.pt-flip-card .pt-fx-lvl-high .pt-fx-scorebar i { background: #2fe39a; }
.pt-flip-card .pt-fx-lvl-mid .pt-fx-scorebar i { background: #f5c451; }
.pt-flip-card .pt-fx-noscore { font-size: 12px; color: #56637b; }
.pt-flip-card .pt-fx-name { display: flex; align-items: center; gap: 7px; min-width: 0; flex-wrap: nowrap; white-space: nowrap; }
.pt-flip-card .pt-fx-name b { overflow: hidden; text-overflow: ellipsis; }
.pt-flip-card .pt-fx-name .pt-fx-meta { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pt-flip-card .pt-fx-name b { color: #e8eef9; font-weight: 700; }
.pt-flip-card .pt-fx-meta { color: #8392ab; font-size: 12.5px; }
.pt-flip-card .pt-fx-pill { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid rgba(148, 178, 230, .18); color: #8392ab; }
.pt-flip-card .pt-fx-pill-good { color: #2fe39a; border-color: rgba(47, 227, 154, .4); background: rgba(47, 227, 154, .12); }
.pt-flip-card .pt-fx-pill-bad { color: #ff6b7d; border-color: rgba(255, 107, 125, .4); background: rgba(255, 107, 125, .1); }
.pt-flip-card .pt-fx-pill-warn { color: #ff9f5a; border-color: rgba(255, 159, 90, .35); }
.pt-flip-card button.pt-fx-search { appearance: none; width: 24px; height: 22px; padding: 0; border-radius: 6px; border: 1px solid rgba(148, 178, 230, .12); background: none; font-size: 11px; cursor: pointer; opacity: .7; }
.pt-flip-card button.pt-fx-search:hover { opacity: 1; border-color: #4cb4ff; }
.pt-flip-card .pt-flip-now { color: #e8eef9; font-weight: 700; }
.pt-flip-card .pt-fx-at { color: #2fe39a; }
.pt-flip-card .pt-flip-buy { color: #4cb4ff; font-weight: 700; }
.pt-flip-card .pt-flip-plus { color: #2fe39a; }
.pt-flip-card .pt-flip-minus { color: #ff6b7d; }
.pt-flip-card .pt-flip-detail td { padding: 4px 10px 14px; background: rgba(76, 180, 255, .07); border-bottom: 1px solid rgba(148, 178, 230, .1); }
.pt-flip-card .pt-fx-tabs { display: flex; gap: 4px; margin: 2px 0 10px; flex-wrap: wrap; }
.pt-flip-card button.pt-fx-tab { appearance: none; font: 600 12px inherit; font-family: inherit; padding: 6px 11px; border-radius: 8px; color: #8392ab; border: 1px solid transparent; background: none; cursor: pointer; text-transform: none; }
.pt-flip-card button.pt-fx-tab:hover { color: #e8eef9; }
.pt-flip-card button.pt-fx-tab.pt-fx-on { color: #e8eef9; background: #182339; border-color: rgba(148, 178, 230, .14); }
.pt-flip-card button.pt-fx-tab-warn { color: #ff9f5a; }
.pt-flip-card .pt-flip-detail-grid { display: block; }
.pt-flip-card .pt-fx-overview { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 12px; }
.pt-flip-card .pt-flip-box { background: rgba(7, 12, 22, .65); border: 1px solid rgba(148, 178, 230, .1); border-radius: 12px; padding: 12px 14px; }
.pt-flip-card .pt-flip-box-title { font-size: 10.5px; letter-spacing: 1.1px; text-transform: uppercase; color: #8392ab; font-weight: 700; margin-bottom: 8px; }
.pt-flip-card .pt-fx-pane.pt-flip-box { max-width: 640px; }
.pt-flip-card .pt-fx-ladder { position: relative; height: 82px; margin: 4px 18px 6px; }
.pt-flip-card .pt-fx-scale { position: absolute; left: 0; right: 0; top: 37px; height: 8px; border-radius: 999px; background: linear-gradient(90deg, rgba(47, 227, 154, .55), rgba(76, 180, 255, .35) 45%, rgba(245, 196, 81, .45)); }
.pt-flip-card .pt-fx-mark { position: absolute; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; white-space: nowrap; }
.pt-flip-card .pt-fx-mark.pt-fx-below { top: 33px; }
.pt-flip-card .pt-fx-mark i { display: block; width: 2px; height: 14px; background: #8392ab; }
.pt-flip-card .pt-fx-mark-text { display: flex; flex-direction: column; align-items: center; line-height: 1.15; }
.pt-flip-card .pt-fx-mark-text small { font-size: 10.5px; color: #8392ab; }
.pt-flip-card .pt-fx-mark-text b { font-size: 12.5px; color: #e8eef9; }
.pt-flip-card .pt-fx-mark-buy i, .pt-flip-card .pt-fx-mark-buy b { background: #4cb4ff; color: #4cb4ff; }
.pt-flip-card .pt-fx-mark-buy b { background: none; }
.pt-flip-card .pt-fx-mark-sell i { background: #2fe39a; }
.pt-flip-card .pt-fx-mark-sell b { color: #2fe39a; }
.pt-flip-card .pt-fx-mark-now i { width: 3px; height: 20px; background: #e8eef9; border-radius: 2px; margin-top: -4px; }
.pt-flip-card .pt-fx-mark-now b { color: #e8eef9; }
.pt-flip-card .pt-fx-links { display: flex; gap: 14px; margin-top: 8px; }
.pt-flip-card .pt-flip-box > button + button { margin-top: 8px; }
.pt-flip-card .pt-fx-chart { margin: 2px 0 8px; }
@media (max-width: 1100px) { .pt-flip-card .pt-fx-overview { grid-template-columns: 1fr; } }
/* ---- hotkeys ---- */
.pt-hk-menu { position: fixed; z-index: 100000; min-width: 210px; padding: 6px; border-radius: 12px; background: #0e1626; border: 1px solid rgba(148, 178, 230, .22); box-shadow: 0 18px 50px rgba(0, 0, 0, .55); font-family: inherit; }
.pt-hk-title { padding: 6px 10px 8px; font-size: 11px; letter-spacing: .8px; text-transform: uppercase; color: #8392ab; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.pt-hk-item { appearance: none; display: block; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-radius: 8px; background: none; color: #e8eef9; font: 600 13px inherit; font-family: inherit; cursor: pointer; text-transform: none; }
button.pt-hk-item:hover { background: rgba(76, 180, 255, .14); }
.pt-hk-panel { position: fixed; z-index: 100000; right: 18px; bottom: 18px; width: 320px; max-height: 60vh; overflow: auto; padding: 12px; border-radius: 14px; background: #0e1626; border: 1px solid rgba(148, 178, 230, .22); box-shadow: 0 18px 50px rgba(0, 0, 0, .55); color: #e8eef9; font-size: 13px; }
.pt-hk-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pt-hk-sub { flex: 1; font-size: 11.5px; color: #8392ab; }
.pt-hk-line { display: flex; align-items: center; gap: 10px; padding: 6px 2px; border-top: 1px solid rgba(148, 178, 230, .1); }
.pt-hk-line span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-hk-line kbd { min-width: 28px; padding: 2px 7px; border-radius: 6px; border: 1px solid rgba(148, 178, 230, .3); background: rgba(0, 0, 0, .3); font: 700 12px inherit; font-family: inherit; text-align: center; }
.pt-hk-empty { color: #8392ab; padding: 6px 2px; }
button.pt-hk-x { appearance: none; border: 0; background: none; color: #8392ab; cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 6px; }
button.pt-hk-x:hover { color: #ff6b7d; background: rgba(255, 107, 125, .1); }
.pt-hk-flash { outline: 2px solid #4cb4ff !important; outline-offset: 2px; }
.pt-hk-layer { position: fixed; inset: 0; z-index: 99990; pointer-events: none; }
.pt-hk-tag { position: fixed; transform: translateX(-100%); padding: 0 4px; min-width: 10px; height: 14px; line-height: 14px; border-radius: 4px; background: rgba(8, 12, 20, .72); border: 1px solid rgba(76, 180, 255, .45); color: #9fd6ff; font: 700 9.5px/14px system-ui, sans-serif; letter-spacing: .3px; text-align: center; white-space: nowrap; opacity: .85; }

/* ==== Price Watch theme C: all tabs like the Flip tab ==== */
.pt-watch-view { --c-bg: #0e1626; --c-panel: rgba(7, 12, 22, .65); --c-line: rgba(148, 178, 230, .10); --c-line2: rgba(148, 178, 230, .20);
  --c-text: #e8eef9; --c-muted: #8392ab; --c-faint: #56637b; --c-accent: #4cb4ff; --c-good: #2fe39a; --c-warn: #f5c451; --c-risk: #ff9f5a; --c-bad: #ff6b7d; }
.pt-watch-view .pt-tabs { display: flex; align-items: center; gap: 2px; max-width: 1280px; margin: 0 auto 12px; padding: 0 6px; border-bottom: 1px solid var(--c-line); background: none; }
.pt-watch-view button.pt-tab { appearance: none; position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px 11px; margin: 0; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--c-muted); font: 700 14px inherit; font-family: inherit; letter-spacing: .3px; cursor: pointer; text-transform: none; }
.pt-watch-view button.pt-tab:hover { color: var(--c-text); background: none; }
.pt-watch-view button.pt-tab.pt-tab-active { color: var(--c-text); border-bottom-color: var(--c-accent); background: none; }
.pt-watch-view .pt-tab-badge { font-style: normal; font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 999px; background: rgba(255, 255, 255, .08); color: var(--c-muted); }
.pt-watch-view .pt-tab-badge:empty { display: none; }
.pt-watch-view .pt-tab-badge-good { background: rgba(47, 227, 154, .14); color: var(--c-good); }
.pt-watch-view .pt-tab-spacer { flex: 1; }
.pt-watch-view .pt-tab-device { font-size: 12px; color: var(--c-muted); padding: 0 4px; white-space: nowrap; }
.pt-watch-view button.pt-tab.pt-tab-guide { font-size: 12px; padding: 6px 10px; }
.pt-guide { position: fixed; inset: 0; z-index: 9990; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(4, 8, 16, .72); }
.pt-guide-card { width: min(620px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: linear-gradient(180deg, #16223a, #0c1424); border: 1px solid rgba(148, 178, 230, .25); border-radius: 16px; box-shadow: 0 30px 80px rgba(0, 0, 0, .55); padding: 18px 20px 16px; color: #dfe7f2; font-size: 14px; line-height: 1.45; text-align: left; }
.pt-guide-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.pt-guide-head h2 { margin: 0; font-size: 19px; color: #fff; flex: 1; }
.pt-guide-steps { font-size: 12px; color: #8d9aae; }
.pt-guide button { appearance: none; font: inherit; cursor: pointer; }
.pt-guide-skip { border: 0; background: none; color: #8d9aae; font-size: 16px; padding: 2px 6px; }
.pt-guide-skip:hover { color: #fff; }
.pt-guide-body p { margin: 0 0 10px; }
.pt-guide-label { font-size: 12px; font-weight: 700; color: #8d9aae; text-transform: uppercase; letter-spacing: .4px; margin: 10px 0 6px; }
.pt-guide-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.pt-guide-pick { border: 1px solid rgba(148, 178, 230, .25); background: rgba(7, 12, 22, .6); color: #dfe7f2; border-radius: 10px; padding: 8px 14px; font-weight: 700; }
.pt-guide-pick:hover { border-color: #63b3ff; }
.pt-guide-pick.pt-guide-on { border-color: #27d98b; background: rgba(39, 217, 139, .16); color: #fff; }
.pt-guide-note { font-size: 12px; color: #8d9aae; margin-top: 12px !important; }
.pt-guide-line { display: grid; grid-template-columns: 28px 1fr; gap: 8px; padding: 8px 0; border-top: 1px solid rgba(148, 178, 230, .10); }
.pt-guide-line:first-child { border-top: 0; }
.pt-guide-icon { font-size: 18px; text-align: center; }
.pt-guide-line b { display: block; color: #fff; margin-bottom: 2px; }
.pt-guide-nav { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.pt-guide .pt-fx-spacer { flex: 1; }
.pt-watch-view .pt-watch-card { max-width: 1280px; background: linear-gradient(180deg, rgba(19, 29, 49, .94), rgba(11, 18, 31, .97)); border: 1px solid rgba(148, 178, 230, .18); border-radius: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, .40), inset 0 1px 0 rgba(255, 255, 255, .04); padding: 14px 16px 12px; color: var(--c-text); }
.pt-watch-view .pt-watch-toolbar { gap: 10px 14px; margin-bottom: 12px; align-items: center; }
.pt-watch-view .pt-watch-title { font-size: 22px; font-weight: 800; letter-spacing: .3px; color: var(--c-text); margin: 0 0 2px; }
.pt-watch-view .pt-watch-status { font-size: 12px; color: var(--c-muted); }
.pt-watch-view button.pt-watch-refresh { height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--c-line2); background: rgba(255, 255, 255, .03); color: var(--c-text); font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.pt-watch-view button.pt-watch-refresh:hover:not(:disabled) { border-color: var(--c-accent); color: #fff; }
.pt-watch-view button.pt-watch-refresh.pt-primary, .pt-watch-view button.pt-watch-refresh.pt-cycle-btn:not(.pt-fx-btn) { background: linear-gradient(180deg, #58bcff, #2f97e6); border-color: transparent; color: #04111f; }
.pt-watch-view button.pt-level-btn.pt-cycle-btn { height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(76, 180, 255, .4); background: rgba(76, 180, 255, .12); color: var(--c-text); font-size: 12.5px; font-weight: 600; }
.pt-watch-view button.pt-level-btn.pt-cycle-btn.pt-current { background: linear-gradient(180deg, #58bcff, #2f97e6); color: #04111f; border-color: transparent; }
.pt-watch-view button.pt-icon-btn { width: 26px; height: 24px; border-radius: 7px; border: 1px solid var(--c-line); background: none; color: var(--c-muted); }
.pt-watch-view button.pt-icon-btn:hover { border-color: var(--c-accent); color: var(--c-text); }
.pt-watch-view button.pt-link-btn { color: var(--c-accent); }
.pt-watch-view select.pt-stock-select, .pt-watch-view input.pt-target-input { height: 30px; border-radius: 8px; border: 1px solid var(--c-line2); background: rgba(0, 0, 0, .3); color: var(--c-text); font-size: 13px; }
.pt-watch-view input.pt-target-input:focus, .pt-watch-view select.pt-stock-select:focus { border-color: rgba(76, 180, 255, .55); outline: none; }
.pt-watch-view .pt-goal { color: var(--c-muted); font-size: 12.5px; }
.pt-watch-view .pt-watch-table { font-size: 13.5px; border-collapse: separate; border-spacing: 0; }
.pt-watch-view .pt-watch-table th { font-size: 10.5px; letter-spacing: 1px; color: var(--c-faint); padding: 8px 10px; border-bottom: 1px solid var(--c-line); background: rgba(7, 12, 22, .45); }
.pt-watch-view .pt-watch-table td { height: auto; padding: 8px 10px; border-bottom: 1px solid rgba(148, 178, 230, .08); }
.pt-watch-view .pt-watch-table tbody tr:nth-child(even) { background: none; }
.pt-watch-view .pt-watch-table tbody tr:hover td { background: rgba(255, 255, 255, .025); }
.pt-watch-view .pt-watch-table tbody tr.pt-row-hit td { background: rgba(47, 227, 154, .045); }
.pt-watch-view .pt-watch-table tbody tr.pt-row-hit td:first-child { box-shadow: inset 3px 0 0 var(--c-good); }
.pt-watch-view .pt-watch-table tbody tr.pt-row-near td:first-child { box-shadow: inset 3px 0 0 var(--c-warn); }
.pt-watch-view .pt-watch-table td.pt-col-price { color: var(--c-text); }
.pt-watch-view .pt-watch-table td.pt-col-rarity, .pt-watch-view .pt-muted { color: var(--c-muted); }
.pt-watch-view .pt-dist { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; background: none; border: 0; padding: 0; }
.pt-watch-view .pt-dist-track { width: 72px; height: 6px; border-radius: 999px; background: rgba(255, 255, 255, .08); overflow: hidden; display: inline-block; }
.pt-watch-view .pt-dist-track i { display: block; height: 100%; border-radius: inherit; background: #6d7a91; }
.pt-watch-view .pt-dist-text { min-width: 52px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--c-muted); }
.pt-watch-view .pt-dist.pt-hit .pt-dist-track i { background: var(--c-good); }
.pt-watch-view .pt-dist.pt-hit .pt-dist-text { color: var(--c-good); }
.pt-watch-view .pt-dist.pt-near .pt-dist-track i { background: var(--c-warn); }
.pt-watch-view .pt-dist.pt-near .pt-dist-text { color: var(--c-warn); }
.pt-watch-view .pt-fodder-table td.pt-col-rating { font-weight: 800; }
.pt-watch-view .pt-fodder-table td.pt-col-rating::before { content: none; }
.pt-watch-view .pt-tl-block, .pt-watch-view .pt-stock-import, .pt-watch-view .pt-stock-summary, .pt-watch-view .pt-flip-panel:not(.pt-flip-help) { background: var(--c-panel); border: 1px solid var(--c-line); border-radius: 12px; padding: 12px 14px; }
.pt-watch-view .pt-tl-block { margin-bottom: 12px; }
.pt-watch-view .pt-tl-title { font-size: 10.5px; letter-spacing: 1.1px; text-transform: uppercase; color: var(--c-muted); font-weight: 700; }
.pt-watch-view .pt-tl-sale { border-bottom-color: var(--c-line); padding: 6px 0; }
.pt-watch-view .pt-tl-tile { border-color: var(--c-line); border-radius: 12px; background: rgba(255, 255, 255, .02); }
.pt-watch-view .pt-stock-levels, .pt-watch-view .pt-windows { gap: 8px; }
.pt-watch-view .pt-stock-level { border-radius: 10px; border-color: var(--c-line); background: rgba(255, 255, 255, .02); }

.pt-flip-panel { margin: 4px 0 10px; padding: 10px 12px; background: #121a25; border: 1px solid rgba(255, 255, 255, .07); border-radius: 8px; }
.pt-flip-help { display: grid; gap: 6px; font-size: 13px; color: #c9d3e0; }
.pt-flip-help-line { display: grid; grid-template-columns: 120px 1fr; gap: 10px; }
.pt-flip-help-line b { color: #fff; }
.pt-flip-wrap { overflow-x: auto; }
.pt-flip-table { min-width: 820px; font-size: 14px; }
.pt-flip-table td { height: auto; padding-top: 8px; padding-bottom: 8px; vertical-align: middle; }
.pt-flip-table .pt-col-tick { width: 3%; }
.pt-flip-table .pt-col-score { width: 9%; white-space: nowrap; overflow: visible; }
.pt-flip-table .pt-col-name { width: 31%; }
.pt-flip-table .pt-col-num { width: 10%; text-align: right; font-variant-numeric: tabular-nums; }
.pt-flip-table .pt-col-spark { width: 14%; text-align: center; overflow: visible; }
.pt-flip-table .pt-col-more { width: 3%; text-align: center; color: #9aa6b8; font-size: 16px; }
.pt-flip-row:hover .pt-col-more { color: #fff; }
.pt-flip-row { cursor: pointer; }
.pt-flip-row:hover td { background: rgba(255, 255, 255, .03); }
.pt-flip-open td { background: rgba(99, 179, 255, .06); border-bottom-color: transparent; }
.pt-flip-dot { display: inline-block; width: 20px; font-size: 12px; }
.pt-opp { display: inline-block; min-width: 30px; padding: 2px 6px; border-radius: 6px; font-weight: 800; text-align: center; font-variant-numeric: tabular-nums; }
.pt-opp-high { color: #27d98b; background: rgba(39, 217, 139, .16); border: 1px solid rgba(39, 217, 139, .45); }
.pt-opp-mid { color: #f4c95d; background: rgba(244, 201, 93, .10); border: 1px solid rgba(244, 201, 93, .30); }
.pt-opp-low { color: #9aa6b8; background: rgba(154, 166, 184, .08); border: 1px solid rgba(154, 166, 184, .25); }
.pt-flip-sub { font-size: 12px; color: #8a96a8; margin-top: 1px; }
.pt-flip-fb-mark { color: #63b3ff; }
.pt-flip-warn { margin-top: 2px; color: #f4a35d; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.pt-flip-pct { font-size: 12px; font-weight: 600; opacity: .75; }
.pt-flip-trend { font-size: 11px; margin-top: 1px; white-space: nowrap; }
.pt-flip-now { color: #f4c95d; font-weight: 700; }
.pt-flip-buy { color: #fff; font-weight: 700; }
.pt-flip-fbval { color: #63b3ff !important; }
.pt-flip-plus { color: #27d98b; font-weight: 700; }
.pt-flip-minus { color: #ff8080; }
.pt-flip-row-buy td { background: rgba(39, 217, 139, .06); }
.pt-flip-row-skip td, .pt-flip-row-wait td { color: #9aa6b8; }
.pt-flip-row-skip td { opacity: .6; }
.pt-flip-detail td { padding: 4px 8px 14px; background: rgba(99, 179, 255, .06); white-space: normal; overflow: visible; height: auto; }
.pt-flip-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.pt-flip-box { padding: 10px 12px; background: #0f1621; border: 1px solid rgba(255, 255, 255, .07); border-radius: 8px; font-size: 13px; }
.pt-flip-box-title { margin-bottom: 6px; font-weight: 700; color: #fff; }
.pt-flip-box-warn { border-color: rgba(244, 163, 93, .35); }
.pt-flip-kv { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 2px 0; }
.pt-flip-kv-label { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pt-flip-kv-value { flex: 0 0 auto; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.pt-flip-bar-line { display: grid; grid-template-columns: minmax(0, 1fr) 80px 26px; align-items: center; gap: 8px; padding: 2px 0; }
.pt-flip-lang { min-width: 64px; }
.pt-watch-view .pt-flip-select { width: auto; min-width: 120px; }
.pt-flip-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pt-flip-name-line .pt-cheapest-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pt-flip-search { flex: 0 0 auto; }
.pt-flip-bar { height: 6px; background: rgba(255, 255, 255, .08); border-radius: 3px; overflow: hidden; }
.pt-flip-bar span { display: block; height: 100%; background: #63b3ff; border-radius: 3px; }
.pt-flip-bar-value { text-align: right; font-variant-numeric: tabular-nums; color: #c9d3e0; }
.pt-flip-note { margin-top: 6px; font-size: 12px; color: #9aa6b8; }
.pt-flip-warn-line { padding: 2px 0; color: #f4a35d; }
.pt-flip-warn-text { color: #f4a35d; }
.pt-flip-plus-note { color: #27d98b; }
.pt-watch-view a.pt-flip-link-out { display: inline-block; margin-top: 6px; margin-right: 12px; color: #63b3ff; text-decoration: none; font-size: 12px; }
.pt-watch-view a.pt-flip-link-out:hover { color: #fff; }
.pt-flip-small-btn { margin-top: 6px; padding: 4px 10px; font-size: 12px; }
@media (max-width: 700px) {
  .pt-watch-view .pt-flip-link { width: 100%; }
  .pt-flip-help-line { grid-template-columns: 1fr; gap: 0; }
  .pt-flip-table { min-width: 560px; }
  .pt-flip-table .pt-col-spark { display: none; }
  .pt-flip-table .pt-col-name { width: 34%; }
  .pt-flip-detail-grid { grid-template-columns: 1fr; position: sticky; left: 0; width: calc(100vw - 44px); max-width: calc(100vw - 44px); }
}

/* Fodder table */
.pt-fodder-table .pt-col-rating   { width: 7%; text-align: center; font-size: 16px; }
.pt-fodder-table .pt-col-cheapest { width: 22%; }
.pt-fodder-table .pt-col-price    { width: 9%; text-align: right; }
.pt-fodder-table .pt-col-target   { width: 16%; padding-left: 24px; }
.pt-fodder-table .pt-col-distance { width: 12%; text-align: right; }
.pt-fodder-table .pt-col-level    { width: 16%; text-align: center; white-space: nowrap; }
.pt-fodder-table .pt-col-stock    { width: 18%; }
.pt-cheapest-main { font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
.pt-fodder-table td.pt-col-cheapest { cursor: help; }
.pt-fodder-table .pt-cycle-btn { min-width: 0; }
.pt-fodder-table .pt-cycle-label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.pt-fodder-table .pt-cycle-tick { margin: 0; accent-color: #27d98b; }
.pt-fodder-table .pt-generic-btn { margin-left: 6px; }
.pt-fodder-table td { height: auto; padding-top: 7px; padding-bottom: 7px; overflow: visible; }
.pt-fodder-totals { margin-top: 12px; }
.pt-goal .pt-target-input + .pt-muted + .pt-target-input { width: 56px; }
.pt-watch-view a.pt-futbin { text-decoration: none; color: #63b3ff; }
.pt-watch-view a.pt-futbin:hover { color: #fff; }
.pt-snipe-grid .pt-col-level { width: 16%; }

.pt-run-btn:hover:not(:disabled) { border-color: #63b3ff; color: #fff; }
.pt-run-btn:disabled { opacity: .4; cursor: default; }
.pt-run-next { background: #1d4f3a; border-color: #27d98b; }
.pt-run-stop { color: #ff8080; }

/* Transfer to the phone */
.pt-watch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pt-transfer {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 32px;
  margin-bottom: 16px;
  padding: 14px 16px;
  background: rgba(255, 255, 255, .03);
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 8px;
}
.pt-transfer-part { flex: 1 1 260px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; font-size: 13px; }
.pt-transfer-title { font-size: 14px; font-weight: 700; color: #fff; }
.pt-transfer-qr svg { display: block; width: 260px; max-width: 100%; height: auto; border-radius: 6px; }
.pt-transfer-input {
  box-sizing: border-box;
  width: 100%;
  padding: 8px;
  border: 1px solid #3a4a5e;
  border-radius: 5px;
  background: #0a0f16;
  color: #fff;
  font: 13px/1.4 monospace;
  resize: vertical;
}
.pt-watch-table td.pt-transferred { color: #c9d3e0; }
.pt-watch-table td.pt-market { color: #7fe3b4; }
.pt-icon-btn.pt-lowest { min-width: 28px; }
.pt-picker {
  position: fixed;
  inset: 0;
  z-index: 100001;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.pt-picker-sheet {
  width: min(520px, 100%);
  max-height: 70vh;
  overflow-y: auto;
  padding: 8px 8px calc(env(safe-area-inset-bottom, 0px) + 8px);
  background: #141c27;
  border-radius: 12px 12px 0 0;
}
.pt-picker-option {
  display: block;
  width: 100%;
  padding: 13px 14px;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid #263243;
  color: #e8edf3;
  font: inherit;
  font-size: 15px;
}
.pt-picker-option:disabled { color: #5d6a7c; }
.pt-picker-current { color: #27d98b; font-weight: 700; }
.pt-picker-cancel { color: #8d9aae; text-align: center; border-bottom: 0; }

.pt-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 100000;
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  padding: 12px 16px;
  background: #0c1119;
  border: 1px solid #27d98b;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .5);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.pt-toast.pt-error { border-color: #ff6b6b; }

/* Phone: compact card, no rarity column, inputs at 16px so iOS doesn't zoom in */
@media (max-width: 700px) {
  .pt-watch-view { padding: 8px 6px 80px; }
  .pt-watch-card { padding: 12px 10px 8px; border-radius: 8px; }
  .pt-tabs { gap: 6px; }
  .pt-tab { padding: 8px 12px; font-size: 13px; }
  .pt-watch-title { font-size: 18px; }
  .pt-watch-status { font-size: 12px; }
  .pt-watch-refresh { padding: 7px 10px; font-size: 13px; }
  .pt-watch-table { font-size: 13px; }
  .pt-watch-table th { padding: 6px 4px; font-size: 10px; letter-spacing: 0; }
  .pt-watch-table td { height: 40px; padding: 4px; }
  .pt-players-table .pt-col-rarity { display: none; }
  .pt-players-table .pt-col-name     { width: 31%; }
  .pt-players-table .pt-col-rating   { width: 9%; }
  .pt-players-table .pt-col-price    { width: 17%; }
  .pt-players-table .pt-col-target   { width: 22%; padding-left: 6px; }
  .pt-players-table .pt-col-distance { width: 15%; }
  .pt-players-table .pt-col-remove   { width: 6%; }
  .pt-players-table td.pt-col-distance { white-space: normal; line-height: 1.2; }
  .pt-players-table .pt-distance { font-size: 11px; padding: 2px 4px; }
  /* Fodder: every rating is a small block instead of a table row that doesn't fit */
  .pt-fodder-table, .pt-fodder-table tbody { display: block; width: 100%; }
  .pt-fodder-table thead { display: none; }
  .pt-fodder-table tr {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr) auto;
    grid-template-areas: "rating cheapest cheapest" "target distance level" "stock stock stock" "price price price";
    gap: 6px 8px;
    align-items: center;
    padding: 10px 4px;
    border-bottom: 1px solid rgba(255, 255, 255, .1);
  }
  .pt-fodder-table td { display: block; width: auto; height: auto; padding: 0; border: 0; white-space: normal; overflow: visible; text-align: left; }
  .pt-fodder-table td.pt-col-rating { grid-area: rating; width: auto; text-align: left; }
  .pt-fodder-table td.pt-col-cheapest { grid-area: cheapest; width: auto; }
  .pt-fodder-table td.pt-col-target { grid-area: target; width: auto; padding-left: 0; }
  .pt-fodder-table td.pt-col-distance { grid-area: distance; width: auto; text-align: left; }
  .pt-fodder-table td.pt-col-level { grid-area: level; width: auto; text-align: right; }
  .pt-fodder-table td.pt-col-stock { grid-area: stock; width: auto; }
  .pt-fodder-table td.pt-col-price { grid-area: price; width: auto; text-align: left; font-weight: 400; color: #8d9aae; }
  .pt-fodder-table td.pt-col-price::before { content: "Mediaan "; }
  .pt-fodder-table td.pt-no-med, .pt-fodder-table td.pt-col-stock:empty { display: none; }
  .pt-fodder-table .pt-level-detail { margin-top: 2px; white-space: normal; }
  .pt-fodder-table .pt-distance { font-size: 11px; padding: 2px 6px; }
  .pt-fodder-table .pt-level-btn { padding: 6px 9px; font-size: 13px; }
  .pt-fodder-table .pt-target-input::placeholder { font-size: 12px; }
  .pt-watch-table .pt-sortable::after { content: ""; }
  .pt-watch-table .pt-sortable.pt-sorted::after { content: " ▲"; }
  .pt-name-wrap .pt-icon-btn:not(.pt-transfer-search):not(.pt-lowest) { display: none; }
  .pt-watch-view .pt-target-input,
  .pt-transfer-input { font-size: 16px; }
  .pt-watch-view .pt-target-input { padding: 4px 5px; }
  .pt-transfer { padding: 10px; }
  .pt-toast { top: 70px; bottom: auto; }
}
`;

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Bootstrapping: wait for the EA app, then keep the tab installed
  // ---------------------------------------------------------------------------

  function appReady() {
    return typeof getAppMain === "function" && !!getAppMain() && window.services && window.repositories && window.factories &&
      typeof EAViewController === "function" && typeof EAView === "function" &&
      typeof UTGameFlowNavigationController === "function" && typeof UTTabBarItemView === "function" &&
      typeof __extends === "function";
  }

  let migrated = false;

  // iPhone: the EA app swallows the click that should follow a tap, so our buttons never fire. Turn a real
  // tap (finger didn't move) on our own controls into a click ourselves, and cancel the native one.
  if ("ontouchstart" in window) {
    const OUR_AREAS = ".pt-watch-view, .pt-run-bar, .pt-toast, .pt-watch-add, .pt-lowest-wrap, .pt-picker, .pt-ql";
    function openSelectPicker(select) {
      document.querySelectorAll(".pt-picker").forEach(old => old.remove());
      const overlay = el("div", "pt-picker");
      const sheet = el("div", "pt-picker-sheet");
      Array.from(select.options).forEach(option => {
        const choice = el("button", "pt-picker-option" + (option.selected ? " pt-picker-current" : ""), option.textContent);
        choice.type = "button";
        choice.disabled = option.disabled;
        choice.addEventListener("click", () => {
          overlay.remove();
          if (select.value === option.value) return;
          select.value = option.value;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        sheet.appendChild(choice);
      });
      const cancel = el("button", "pt-picker-option pt-picker-cancel", "Annuleren");
      cancel.type = "button";
      cancel.addEventListener("click", () => overlay.remove());
      sheet.appendChild(cancel);
      overlay.appendChild(sheet);
      document.body.appendChild(overlay);
      const current = sheet.querySelector(".pt-picker-current");
      if (current) current.scrollIntoView({ block: "center" });
    }
    const TAPPABLE = "button, a[href], label, .pt-sortable, input[type=checkbox], input[type=radio]";
    let start = null;
    // iOS can't always cancel the native click (touchend not cancelable, e.g. just after scrolling): it then
    // follows our own click, and one tap would count twice. Swallow it.
    const NATIVE_CLICK_MS = 700;
    let ownClick = false;
    let swallowClicksUntil = 0;
    document.addEventListener("click", event => {
      if (ownClick || Date.now() >= swallowClicksUntil) return;
      if (!(event.target instanceof Element) || !event.target.closest(OUR_AREAS)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    document.addEventListener("touchstart", event => {
      const touch = event.touches[0];
      start = touch && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
    }, { capture: true, passive: true });
    document.addEventListener("touchend", event => {
      const touch = event.changedTouches[0];
      const from = start;
      start = null;
      if (!from || !touch || Math.abs(touch.clientX - from.x) > 10 || Math.abs(touch.clientY - from.y) > 10) return;
      // Text fields and dropdowns (often inside a label): focus them ourselves, which opens the keyboard or the
      // picker, instead of turning the tap into a click on the label.
      const field = event.target instanceof Element ? event.target.closest("input, select, textarea") : null;
      // iOS won't open a dropdown's own picker here (focus() doesn't either): show our own list of its options.
      if (field && field.tagName === "SELECT" && field.closest(OUR_AREAS) && !field.disabled) {
        event.preventDefault();
        openSelectPicker(field);
        return;
      }
      if (field && !/^(checkbox|radio|button|submit)$/.test(field.type)) {
        if (field.closest(OUR_AREAS) && !field.disabled && document.activeElement !== field) field.focus();
        return;
      }
      const target = event.target instanceof Element ? event.target.closest(TAPPABLE) : null;
      if (!target || !target.closest(OUR_AREAS) || target.disabled) return;
      event.preventDefault();
      ownClick = true;
      target.click();
      ownClick = false;
      swallowClicksUntil = Date.now() + NATIVE_CLICK_MS;
    }, { capture: true, passive: false });
  }

  // Phone: a tap inside the Price Watch card that lands on EA's click shield means the shield was left
  // up. Lower it. Anything else on top (EA's own screens, popups, buttons) is left alone.
  if (IS_PHONE) {
    let lastBlockReport = 0;
    window.addEventListener("touchend", event => {
      const touch = event.changedTouches && event.changedTouches[0];
      const card = document.querySelector(".pt-watch-view .pt-watch-card:not([style*='display: none'])");
      if (!touch || !card) return;
      const rect = card.getBoundingClientRect();
      if (touch.clientX < rect.left || touch.clientX > rect.right || touch.clientY < rect.top || touch.clientY > rect.bottom) return;
      const hit = document.elementFromPoint(touch.clientX, touch.clientY);
      if (!hit || card.contains(hit) || hit.closest(".pt-toast")) return;
      const isShield = element => /shield/i.test(typeof element.className === "string" ? element.className : "");
      let shield = hit;
      while (shield && !isShield(shield)) shield = shield.parentElement;
      if (!shield) return;
      // Only when Price Watch itself is under the shield: EA shows it on its own screens while loading.
      const below = (document.elementsFromPoint ? document.elementsFromPoint(touch.clientX, touch.clientY) : [])
        .find(element => { let node = element; while (node && !isShield(node)) node = node.parentElement; return !node; });
      if (!below || !card.contains(below)) return;
      lowerClickShield();
      if (Date.now() - lastBlockReport < 5000) return;
      lastBlockReport = Date.now();
      const name = `${hit.tagName.toLowerCase()}${hit.className && typeof hit.className === "string" ? "." + hit.className.trim().split(/\s+/).join(".") : ""}`;
      showToast(L(`Tik geblokkeerd door ${name} – opgeruimd, probeer opnieuw`, `Tap blocked by ${name} – cleared, try again`), false);
    }, true);
  }

  // On the phone (no console to look at) say what's happening: loaded, tab added, or what failed.
  const startedAt = Date.now();
  let tabReported = false;
  let waitReported = false;
  function report(text, ok) {
    if (IS_PHONE && !tabReported) showToast(`Price Watch v${SCRIPT_VERSION}: ${text}`, ok);
  }
  report(L("geladen, wacht op de web app…", "loaded, waiting for the web app…"), true);

  function tick() {
    // Pc with FUT Genie: prices to the gist (and target pushes) also while EA isn't logged in, e.g. after a
    // refresh once you're playing the game. Genie gets its prices from its own server, not from EA.
    if (!relayStarted && pcDevice()) {
      addStyles();
      startRelay();
    }
    if (!appReady()) {
      // Stuck on the login screen with listings running: nobody is watching them.
      if (Date.now() - startedAt > 2 * 60 * 1000 && getListingEnds().length) noteLoggedOut();
      if (Date.now() - startedAt > 45000 && !waitReported) {
        report(L("EA-app nog niet gevonden (nog niet ingelogd?)", "EA app not found yet (not logged in yet?)"), false);
        waitReported = true;
      }
      return;
    }
    addStyles();
    hookPanels();
    try {
      const installed = installTab();
      const tabNode = document.querySelector(".pt-watch-tab");
      const rect = tabNode ? tabNode.getBoundingClientRect() : null;
      const visible = !!rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth &&
        rect.bottom > 0 && rect.top < window.innerHeight;
      if (installed && tabNode && !visible && !waitReported && Date.now() - startedAt > 20000) {
        const parent = tabNode.parentElement;
        const siblings = parent ? [...parent.children].map(child => child.textContent.trim() || child.className).join("|") : "?";
        report(`knop onderin verborgen (${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}, ` +
          L(`${getComputedStyle(tabNode).display}, in ${parent ? parent.className : "?"}: ${siblings}). Staat Paletools aan? Dat tekent de balk opnieuw.`, `${getComputedStyle(tabNode).display}, in ${parent ? parent.className : "?"}: ${siblings}). Is Paletools on? It redraws the bar.`), false);
        waitReported = true;
      }
      if (installed && visible && !tabReported) {
        report(L("tab \"Watch\" staat onderin na Transfers", "tab \"Watch\" is at the bottom after Transfers"), true);
        tabReported = true;
      } else if (installed && !visible && !waitReported && Date.now() - startedAt > 20000) {
        // Diagnose for the phone: what is in the bottom bar instead?
        const bar = [...document.querySelectorAll(".ut-tab-bar-item, nav button")]
          .map(button => button.textContent.trim()).filter(Boolean).join(", ");
        report(L(`tab gemaakt maar niet zichtbaar. Balk: ${bar || "?"}`, `tab created but not visible. Bar: ${bar || "?"}`), false);
        waitReported = true;
      } else if (!installed && !waitReported && Date.now() - startedAt > 60000) {
        report(L("tabbalk van de app niet gevonden", "app tab bar not found"), false);
        waitReported = true;
      }
    } catch (error) {
      console.warn(L("Price Watch: tab toevoegen mislukt.", "Price Watch: adding tab failed."), error);
      if (!tabReported && Date.now() - startedAt > 45000) {
        report(L(`tab toevoegen mislukt – ${error.message}`, `adding tab failed – ${error.message}`), false);
        tabReported = true;
      }
    }
    if (!migrated && findTabBarController()) {
      migrated = true;
      renderRunBar(); // resume a stock run after a page refresh
      installMarketWatch();
      installMinBidWrap();
      installListingWatch();
      installNotificationLog();
      returnToTargets();
      installOneClickBuyNow();
      startClubRise();
      importPendingTransfer();
      // Pc: send list + prices to the gist every 5 min. Phone: read them every 2 min.
      startRelay();
      migrateFromPaletools().catch(error => console.warn(L("Price Watch: overnemen uit Paletools mislukt.", "Price Watch: importing from Paletools failed."), error));
    }
  }

  // The tab bar is rebuilt after login / when returning to the game view; re-check regularly.
  window.setInterval(tick, 1500);
  tick();
}

// Live via your pc: reads and writes your secret GitHub gist. Runs in Tampermonkey's part, so the EA page
// never sees the GitHub token (only on the pc that sends); GM_xmlhttpRequest makes the requests.
(() => {
  const TOKEN_KEY = "github_gist_token";
  const RAW_KEY = "github_gist_raw_url";

  // The FUT Genie login of v2.0.x is gone: remove its stored session.
  try {
    if (typeof GM_deleteValue === "function") GM_deleteValue("futgenie_auth");
  } catch (_) {
    // Nothing stored.
  }

  function getValue(key) {
    try {
      return typeof GM_getValue === "function" ? GM_getValue(key, null) : null;
    } catch {
      return null;
    }
  }

  function setValue(key, value) {
    if (typeof GM_setValue !== "function") throw new Error(L("Tampermonkey-opslag niet beschikbaar", "Tampermonkey storage not available"));
    if (value == null && typeof GM_deleteValue === "function") GM_deleteValue(key);
    else GM_setValue(key, value);
  }

  function request(method, url, body, headers) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error(L("Tampermonkey staat geen verzoeken toe (GM_xmlhttpRequest ontbreekt)", "Tampermonkey doesn't allow requests (GM_xmlhttpRequest missing)")));
        return;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(headers || {}) },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 20000,
        onload: response => {
          let json = null;
          try {
            json = JSON.parse(response.responseText);
          } catch (_) {
            // Not JSON (raw file or error page).
          }
          resolve({ status: response.status, json, text: String(response.responseText || "") });
        },
        onerror: () => reject(new Error(L("GitHub niet bereikbaar", "GitHub not reachable"))),
        ontimeout: () => reject(new Error(L("GitHub antwoordt niet (time-out)", "GitHub not responding (timeout)")))
      });
    });
  }

  // Push to your phone via ntfy.sh: a message to your own topic, which the ntfy app on the phone
  // subscribes to. Works while the phone is locked. Only names and prices are sent.
  const NTFY_KEY = "ntfy_topic";
  const NTFY_TOPIC = /^[\w-]{8,64}$/;

  function notify(title, text) {
    const topic = getValue(NTFY_KEY);
    if (!topic) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `https://ntfy.sh/${encodeURIComponent(topic)}`,
        // Header values must be plain ASCII; the emoji goes in as a tag ("dart" = 🎯).
        headers: { Title: String(title || "Price Watch").replace(/[^\x20-\x7e]/g, ""), Tags: "dart" },
        data: String(text || ""),
        timeout: 15000,
        onload: response => (response.status < 300 ? resolve(true) : reject(new Error(`ntfy ${response.status}`))),
        onerror: () => reject(new Error(L("ntfy.sh niet bereikbaar", "ntfy.sh not reachable"))),
        ontimeout: () => reject(new Error(L("ntfy.sh antwoordt niet (time-out)", "ntfy.sh not responding (timeout)")))
      });
    });
  }

  function githubError(response) {
    const message = response.json && response.json.message;
    if (response.status === 401) return L("token ongeldig of verlopen", "token invalid or expired");
    if (response.status === 404) return L("gist niet gevonden (of token mist het recht \"gist\")", "gist not found (or token lacks the \"gist\" permission)");
    if (response.status === 403 && /rate limit/i.test(message || "")) return L("te veel verzoeken bij GitHub, even wachten", "too many requests to GitHub, wait a moment");
    return `${response.status}${message ? ` ${message}` : ""}`;
  }

  const auth = token => ({ Authorization: `Bearer ${token}` });
  const gistUrl = gistId => `https://api.github.com/gists/${encodeURIComponent(gistId)}`;

  async function setToken(token, gistId) {
    if (!/^(ghp_|github_pat_)\w+$/.test(token || "")) throw new Error(L("Dat lijkt geen GitHub-token (begint met ghp_ of github_pat_)", "That doesn't look like a GitHub token (starts with ghp_ or github_pat_)"));
    const response = await request("GET", gistUrl(gistId), undefined, auth(token));
    if (response.status !== 200) throw new Error(L(`Token werkt niet met deze gist: ${githubError(response)}`, `Token doesn't work with this gist: ${githubError(response)}`));
    setValue(TOKEN_KEY, token);
  }

  async function push(gistId, file, content) {
    const token = getValue(TOKEN_KEY);
    if (!token) throw new Error(L("geen token op dit apparaat", "no token on this device"));
    const response = await request("PATCH", gistUrl(gistId), { files: { [file]: { content } } },
      { ...auth(token), "Content-Type": "application/json" });
    if (response.status !== 200) throw new Error(L(`versturen mislukt: ${githubError(response)}`, `sending failed: ${githubError(response)}`));
    const sent = response.json && response.json.files && response.json.files[file];
    if (sent && sent.raw_url) setValue(RAW_KEY, rawBase(sent.raw_url));
  }

  // ".../raw/<version>/<file>" → ".../raw/": the gist's raw folder, the newest version of every file.
  const rawBase = url => String(url || "").replace(/\/raw\/.*$/, "/raw/");

  // The API first (always the newest version); the raw file as a fallback when GitHub limits the API.
  // With a token (also on the phone) the API allows far more requests. null: the file isn't there yet.
  async function pull(gistId, file) {
    const token = getValue(TOKEN_KEY);
    const response = await request("GET", `${gistUrl(gistId)}?t=${Date.now()}`, undefined, token ? auth(token) : undefined);
    if (response.status === 200 && response.json && response.json.files) {
      const found = response.json.files[file];
      if (!found) return null;
      const owner = response.json.owner && response.json.owner.login;
      if (owner) setValue(RAW_KEY, `https://gist.githubusercontent.com/${owner}/${gistId}/raw/`);
      if (!found.truncated) return found.content;
      const raw = await request("GET", found.raw_url);
      if (raw.status === 200) return raw.text;
      throw new Error(L(`ophalen mislukt: ${githubError(raw)}`, `fetching failed: ${githubError(raw)}`));
    }
    const rawUrl = rawBase(getValue(RAW_KEY));
    if (response.status === 403 && rawUrl) {
      const raw = await request("GET", `${rawUrl}${encodeURIComponent(file)}?t=${Date.now()}`);
      if (raw.status === 200) return raw.text;
    }
    throw new Error(L(`ophalen mislukt: ${githubError(response)}`, `fetching failed: ${githubError(response)}`));
  }

  // Pc → phone: the token as a QR code linking to "…/web-app/#pwt=TOKEN&pwg=GIST". Drawn here into the
  // page's empty box, so the token doesn't pass through the page's events.
  function drawTokenQr(targetId, base, gistId) {
    const token = getValue(TOKEN_KEY);
    if (!token) throw new Error(L("geen token op deze pc", "no token on this PC"));
    if (typeof qrcode !== "function") throw new Error(L("QR-bibliotheek niet geladen", "QR library not loaded"));
    const box = document.getElementById(targetId);
    if (!box || !/^https:\/\/www\.(ea|easports)\.com\//.test(base || "")) throw new Error(L("onbekende pagina", "unknown page"));
    const qr = qrcode(0, "L");
    qr.addData(`${base}#pwt=${token}${gistId ? `&pwg=${encodeURIComponent(gistId)}` : ""}`);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    return true;
  }

  // Phone: opened from that QR code. Take the token out of the address right away, check it, then store it.
  const TOKEN_PARAM = /[#&?]pwt=((?:ghp_|github_pat_)\w+)(?:&pwg=([0-9a-f]{20,40}))?/i;
  const tokenLink = String(location.href).match(TOKEN_PARAM);
  if (tokenLink) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_) {
      // The address keeps the link; it is still stored below.
    }
    const tell = data => document.dispatchEvent(new CustomEvent("pt-relay-token", { detail: JSON.stringify(data) }));
    const gistId = tokenLink[2] || "";
    (gistId ? setToken(tokenLink[1], gistId) : Promise.reject(new Error(L("geen gist in de link", "no gist in the link")))).then(() => tell({ ok: true, gistId }), error => tell({ ok: false, error: error.message }));
  }

  async function handle(message) {
    switch (message.type) {
      case "status":
        return { hasToken: !!getValue(TOKEN_KEY) };
      case "setToken":
        await setToken(message.token, message.gistId);
        return { hasToken: true };
      case "clearToken":
        setValue(TOKEN_KEY, null);
        return { hasToken: false };
      case "push":
        await push(message.gistId, message.file, message.content);
        return true;
      case "pull":
        return pull(message.gistId, message.file);
      case "tokenQr":
        return drawTokenQr(message.targetId, message.base, message.gistId);
      case "ntfyStatus":
        return { topic: getValue(NTFY_KEY) || "" };
      case "setNtfy": {
        const topic = String(message.topic || "").trim();
        if (topic && !NTFY_TOPIC.test(topic)) throw new Error(L("topic: 8–64 tekens, alleen letters, cijfers, - en _", "topic: 8–64 characters, only letters, digits, - and _"));
        setValue(NTFY_KEY, topic || null);
        return { topic };
      }
      case "notify":
        return notify(message.title, message.text);
      default:
        throw new Error(L(`onbekend verzoek ${message.type}`, `unknown request ${message.type}`));
    }
  }

  document.addEventListener("pt-relay-request", event => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    const reply = data => document.dispatchEvent(new CustomEvent("pt-relay-response", { detail: JSON.stringify({ id: message.id, ...data }) }));
    handle(message).then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message }));
  });
})();

// FUT.GG request bridge: run GM_xmlhttpRequest in the Tampermonkey sandbox, not in the
// injected EA page context. Only allow the exact FUT.GG R2 host to avoid turning this into an
// arbitrary cross-origin request proxy.
try {
  document.addEventListener("pt-futgg-request", event => {
    let request;
    try { request = JSON.parse(event.detail); } catch (_) { return; }
    const reply = payload => document.dispatchEvent(new CustomEvent("pt-futgg-response", { detail: JSON.stringify({ id: request && request.id, ...payload }) }));
    if (!request || typeof request.id !== "string" || typeof request.url !== "string") return;
    let parsed;
    try { parsed = new URL(request.url); } catch (_) { reply({ ok: false, error: "Ongeldige FUT.GG URL" }); return; }
    const cheapestApi = parsed.hostname === "www.fut.gg" && (parsed.pathname.startsWith("/api/fut/market/27/cheapest-by-rating/") ||
      /^\/api\/fut\/players\/v2\/momentum\/(6|12|24)\/$/.test(parsed.pathname)); // + Momentum Trends (Flip source)
    // fodder.gg Price Watch page of a shared watchlist (the token is the user's own link).
    const fodderWatch = parsed.hostname === "fodder.gg" && /^\/price-watch\/[A-Za-z0-9_-]{8,64}$/.test(parsed.pathname);
    // FUTBIN player search and a player's sales page (flip check), nothing else on futbin.com.
    const futbinPage = parsed.hostname === "www.futbin.com" &&
      ((parsed.pathname === "/players" && /^[?]search=[^&]+$/.test(parsed.search)) ||
       (/^[/]\d{2}[/]sales[/]\d+[/][a-z0-9-]+$/.test(parsed.pathname) && /^[?]platform=(pc|ps)$/.test(parsed.search)));
    const htmlPage = fodderWatch || futbinPage;
    if (parsed.protocol !== "https:" || (parsed.hostname !== "r2.fut.gg" && !cheapestApi && !htmlPage)) {
      reply({ ok: false, error: L("Geblokkeerde URL: alleen https://r2.fut.gg, FUT.GG cheapest-by-rating/momentum, fodder.gg price-watch en FUTBIN zoeken/sales toegestaan", "Blocked URL: only https://r2.fut.gg, FUT.GG cheapest-by-rating/momentum, fodder.gg price-watch and FUTBIN search/sales are allowed") });
      return;
    }
    if (typeof GM_xmlhttpRequest !== "function") {
      reply({ ok: false, error: L("GM_xmlhttpRequest ontbreekt in Tampermonkey-sandbox; controleer userscript-manager en @grant", "GM_xmlhttpRequest missing in the Tampermonkey sandbox; check the userscript manager and @grant") });
      return;
    }
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: parsed.href,
        headers: { "Accept": htmlPage ? "text/html" : "application/json", "Cache-Control": "no-cache" },
        anonymous: htmlPage, // no fodder.gg/FUTBIN cookies needed; both pages are public
        onload: response => reply({ ok: true, status: response.status, responseText: response.responseText }),
        onerror: () => reply({ ok: false, error: L("Netwerkfout bij FUT.GG (GM_xmlhttpRequest onerror)", "Network error at FUT.GG (GM_xmlhttpRequest onerror)") }),
        ontimeout: () => reply({ ok: false, error: L("Time-out bij FUT.GG (GM_xmlhttpRequest)", "Time-out at FUT.GG (GM_xmlhttpRequest)") }),
        timeout: 20000
      });
    } catch (error) {
      reply({ ok: false, error: `GM_xmlhttpRequest startfout: ${error && error.message ? error.message : String(error)}` });
    }
  });
} catch (error) {
  console.warn(L("Price Watch: FUT.GG-verzoekbrug kon niet worden gestart", "Price Watch: FUT.GG request bridge could not be started"), error);
}

// Run inside the page itself (not Tampermonkey's sandbox), so the EA app's objects are reachable on
// every browser, including Safari on iOS.
(() => {
  const version = typeof GM_info !== "undefined" && GM_info.script ? GM_info.script.version : "";
  const script = document.createElement("script");
  script.textContent = `(${priceWatchMain.toString()})(${JSON.stringify(version)});`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
  // Inline scripts run synchronously; if the page blocked it, run here instead.
  if (!document.documentElement.hasAttribute("data-pt-price-watch")) priceWatchMain(version);
})();

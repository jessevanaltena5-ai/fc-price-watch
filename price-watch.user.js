// ==UserScript==
// @name         FC Price Watch
// @namespace    local.fc.price-watch
// @version      2.18.1
// @description  Eigen Price Watch-tab in de FC web app met FUT Genie-prijzen, PC-instapdoel, afstand (kleur + sortering), kopieerknop, transfermarkt-knop (vult alleen filters in), een "+ Price Watch"-knop bij elke kaart en stock-lijsten (tip plakken → club/kwaliteit/max BIN klaarzetten). Lijst + prijzen overzetten naar je telefoon via QR-code.
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
// @require      https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js
// @updateURL    https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/price-watch.user.js
// @downloadURL  https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/price-watch.user.js
// ==/UserScript==

function priceWatchMain(SCRIPT_VERSION) {
  "use strict";

  const APP_GUARD = "__fcPriceWatch";
  if (window[APP_GUARD]) return;
  window[APP_GUARD] = true;
  document.documentElement.setAttribute("data-pt-price-watch", SCRIPT_VERSION || "1");
  const IS_PHONE = window.innerWidth <= 700;

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
      console.warn("Price Watch: lijst kon niet worden opgeslagen.", error);
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
    if (added) console.info(`Price Watch: ${added} speler(s) overgenomen uit Paletools.`);
  }

  // ---------------------------------------------------------------------------
  // FUT Genie prices (via the FUT Genie extension; no EA market searches)
  // ---------------------------------------------------------------------------

  let genieRequestedAt = 0;
  let genieLoading = false;
  let genieRefetch = false;

  function genie() {
    const g = window.FutGenie;
    return g && typeof g.fetchBulkPrices === "function" ? g : null;
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

  function geniePrice(definitionId) {
    const g = genie();
    const entry = g && g._cachedPrices ? g._cachedPrices[definitionId] : null;
    if (entry && entry.price > 0) return entry;
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
        showToast("Price Watch: token van je pc opgeslagen. Wis de link nog uit de geschiedenis van Safari.", true);
      } else {
        showToast(`Price Watch: token niet opgeslagen – ${message.error}`, false);
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
    else pending.reject(new Error(message.error || "onbekende fout"));
  });

  function relayCall(type, data) {
    return new Promise((resolve, reject) => {
      const id = ++relaySeq;
      relayPending.set(id, { resolve, reject });
      document.dispatchEvent(new CustomEvent("pt-relay-request", { detail: JSON.stringify({ id, type, ...data }) }));
      window.setTimeout(() => {
        if (relayPending.delete(id)) reject(new Error("geen antwoord van Tampermonkey"));
      }, 30000);
    });
  }

  // Phone: are the prices from the pc recent enough to count as live?
  function relayFresh() {
    return !genie() && Date.now() - (getRelay().pricesAt || 0) < RELAY_FRESH_MS;
  }

  // The list as it goes into the gist, to see whether it changed since the last sync.
  function listJsonNow() {
    return JSON.stringify(buildTransferData().w);
  }

  // Devices without FUT Genie read prices; on a big screen only once FUT Genie had time to load.
  function relayReader(force) {
    return !genie() && (force || IS_PHONE || Date.now() - startedAt >= 20000);
  }

  // Pc: fresh FUT Genie prices for the list, then into the gist. "l" tells the phone which of its own
  // lists the pc has taken over, so the phone doesn't fall back to the pc's older list in the meantime.
  async function pushRelay(force) {
    const relay = getRelay();
    if (!genie() || relayBusy || !relay.hasToken || !relay.gistId) return;
    if (!force && Date.now() - (relay.sentAt || 0) < RELAY_PUSH_MS) return;
    relayBusy = true;
    try {
      await fetchGeniePrices(getWatch().map(entry => entry.definitionId));
      const data = { ...buildTransferData(), l: relay.phoneListAt || 0 };
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
    if (!genie() || relayBusy || !relay.hasToken || !relay.gistId) return;
    if (!force && Date.now() - (relay.phoneCheckedAt || 0) < RELAY_LIST_CHECK_MS) return;
    relayBusy = true;
    let changed = false;
    try {
      const data = JSON.parse(await relayCall("pull", { gistId: relay.gistId, file: RELAY_LIST_FILE }));
      if (data && Array.isArray(data.w) && data.t > (relay.phoneListAt || 0)) {
        if (JSON.stringify(data.w) !== listJsonNow()) {
          const result = applyTransfer({ t: data.t, w: data.w, p: {} });
          showToast(`Price Watch: lijst van je telefoon overgenomen (${result.players} spelers).`, true);
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
      if (!data || !Array.isArray(data.w)) throw new Error("nog geen prijzen van je pc in de gist");
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
      Object.entries(data.p || {}).forEach(([id, value]) => {
        if (Array.isArray(value) && value[0] > 0) store[id] = value;
      });
      try {
        localStorage.setItem(REMOTE_KEY, JSON.stringify(store));
      } catch (_) {
        // Kept in memory for this session.
      }
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
      await pushRelay(false);
      await pullRelay(false);
      await pushPhoneList(false);
    }, 30 * 1000);
  }

  // --- Lowest market price, only without FUT Genie (phone) and only when you tap the button ---
  // Searches the market for this exact card, then again just below the cheapest BIN found, until
  // nothing cheaper turns up. Max MARKET_MAX_SEARCHES searches per tap, with a pause in between.

  const MARKET_KEY = "pt_market_v1";
  const MARKET_MAX_SEARCHES = 6;
  const MARKET_PAUSE_MS = [1600, 2600];
  let marketPrices = null;
  let marketBusy = false;
  let marketBusySince = 0;

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
      if (!observable || typeof observable.observe !== "function") throw new Error("EA-zoekfunctie niet beschikbaar");
      const context = {};
      const timeout = window.setTimeout(() => {
        try {
          observable.unobserve(context);
        } catch (_) {
          // Already done.
        }
        reject(new Error("EA antwoordt niet (time-out)"));
      }, 15000);
      observable.observe(context, (sender, response) => {
        window.clearTimeout(timeout);
        sender.unobserve(context);
        if (!response || !response.success) {
          reject(new Error(`EA weigert de zoekopdracht${response && response.status ? ` (${response.status})` : ""} – even wachten`));
          return;
        }
        const items = (response.data && response.data.items) || [];
        const prices = items.map(item => {
          const auction = typeof item.getAuctionData === "function" ? item.getAuctionData() : item._auction;
          return auction && auction.buyNowPrice;
        }).filter(price => price > 0);
        resolve(prices.length ? Math.min(...prices) : null);
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
    if (marketBusy) throw new Error("Er loopt al een zoekopdracht");
    marketBusy = true;
    marketBusySince = Date.now();
    try {
      let lowest = null;
      for (let search = 1; search <= MARKET_MAX_SEARCHES; search++) {
        if (search > 1) {
          const [min, max] = MARKET_PAUSE_MS;
          await new Promise(resolve => window.setTimeout(resolve, min + Math.random() * (max - min)));
        }
        if (onProgress) onProgress(search, lowest);
        const below = lowest ? priceStepBelow(lowest) : null;
        if (below !== null && below < 150) break;
        const cheapest = await searchMarketOnce(definitionId, below);
        if (cheapest === null) break; // nothing cheaper: `lowest` is the lowest BIN
        lowest = cheapest;
      }
      if (lowest) {
        getMarketPrices()[definitionId] = [lowest, Date.now()];
        try {
          localStorage.setItem(MARKET_KEY, JSON.stringify(getMarketPrices()));
        } catch (_) {
          // Kept in memory for this session.
        }
      }
      return lowest;
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
    if (!g || !unique.length) return Promise.resolve(false);

    const startedAt = Date.now();
    try {
      g.fetchBulkPrices(unique);
    } catch (error) {
      console.warn("Price Watch: FUT Genie-prijzen ophalen mislukt.", error);
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
    if (!genie()) {
      // Phone: the refresh button sends a changed list (with token) and reads the prices your pc put in the gist.
      if (force) pushPhoneList(false).then(() => pullRelay(true));
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

  const SEARCH_TITLE = "Transfermarkt voorbereiden: speler + rarity + max BIN = instapdoel (Shift+klik: zonder max BIN). Zoeken doe je zelf.";

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
    if (!nav) throw new Error("Transfers-navigatie niet gevonden");

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
      }
    } catch (_) {
      // Holo stays on our criteria only.
    }
    if (playerData) controller.viewmodel.setPlayerData(playerData);
    nav.pushViewController(controller);
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

  function distanceState(target, current) {
    if (target === null || current === null) {
      return { percent: null, text: "—", className: "pt-distance", title: target === null ? "Vul een PC-instapdoel in om de afstand te berekenen" : "Nog geen FUT Genie-prijs" };
    }

    const delta = current - target;
    const percent = (delta / target) * 100;
    const sign = delta > 0 ? "+" : "";
    const text = `${sign}${priceFormat.format(delta)} (${sign}${percent.toFixed(1)}%)`;

    if (delta <= 0) {
      return { percent, text, className: "pt-distance pt-hit", title: "Instapdoel bereikt: huidige prijs is op of onder je doelprijs" };
    }
    if (percent <= NEAR_PERCENT) {
      return { percent, text, className: "pt-distance pt-near", title: `Bijna op je instapdoel: maximaal ${NEAR_PERCENT}% erboven` };
    }
    return { percent, text, className: "pt-distance pt-far", title: `Huidige prijs ligt meer dan ${NEAR_PERCENT}% boven je instapdoel` };
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
    if (!match) throw new Error("Geen geldige overzetcode (die begint met PW1.)");
    let bytes = fromBase64Url(match[2]);
    if (match[1] === "z") {
      if (typeof DecompressionStream !== "function") throw new Error("Deze browser kan de code niet uitpakken (update iOS)");
      bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || !Array.isArray(data.w)) throw new Error("De code bevat geen Price Watch-lijst");
    return data;
  }

  function buildTransferData() {
    const now = Date.now();
    const watch = getWatch();
    const prices = {};
    watch.forEach(entry => {
      const price = geniePrice(entry.definitionId);
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
    return `${result.players} speler(s) overgezet, ${result.priced} met prijs (van ${formatDayTime(result.at)}).`;
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
    part.appendChild(el("div", "pt-transfer-title", "Pushmelding op je telefoon (ntfy)"));
    const info = el("div", "pt-muted");
    const topic = el("input", "pt-transfer-input");
    topic.type = "text";
    topic.autocomplete = "off";
    topic.placeholder = "jouw topic, bijv. pw-k8f3x9q2m7";
    const save = el("button", "pt-watch-refresh", "Opslaan");
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
        ? `Aan: zakt een speler na een prijsupdate tot zijn doel, dan stuurt deze pc een melding naar topic "${current}".`
        : "Uit. Kies een lange, willekeurige topic-naam (iedereen die hem kent kan meelezen) en klik op Opslaan.") +
        " Op je iPhone: installeer de app ntfy, tik op + en abonneer je op precies dezelfde topic." +
        (genie() ? "" : " Let op: alleen een pc met FUT Genie verstuurt meldingen.");
    };
    const randomTopic = () => `pw-${Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => "abcdefghijkmnpqrstuvwxyz23456789"[byte % 32]).join("")}`;
    const call = (type, data, done) => {
      result.textContent = "…";
      relayCall(type, data).then(value => { result.textContent = done(value) || ""; render(); }, error => { result.textContent = `Mislukt: ${error.message}`; });
    };
    save.addEventListener("click", () => call("setNtfy", { topic: topic.value.trim() }, value => { current = value.topic; return current ? "Opgeslagen." : "Uitgezet."; }));
    off.addEventListener("click", () => call("setNtfy", { topic: "" }, () => { current = ""; topic.value = randomTopic(); return "Uitgezet."; }));
    test.addEventListener("click", () => call("notify", { title: "Price Watch test", text: "Zo ziet een melding eruit als een speler op doel zit." },
      sent => (sent ? "Verstuurd – komt hij binnen op je telefoon?" : "Geen topic ingesteld.")));
    panel.__ptOpen = () => {
      relayCall("ntfyStatus", {}).then(status => {
        current = status.topic || "";
        topic.value = current || randomTopic();
        render();
      }, error => { info.textContent = `Tampermonkey antwoordt niet: ${error.message}`; });
    };
    return panel;
  }

  function buildTransferPanel() {
    const panel = el("div", "pt-transfer");

    const send = el("div", "pt-transfer-part");
    send.appendChild(el("div", "pt-transfer-title", "Naar je telefoon"));
    const qrBox = el("div", "pt-transfer-qr");
    const sendInfo = el("div", "pt-muted");
    const copy = el("button", "pt-watch-refresh", "📋 Kopieer code");
    copy.type = "button";
    send.append(qrBox, sendInfo, copy);

    const receive = el("div", "pt-transfer-part");
    receive.appendChild(el("div", "pt-transfer-title", "Code plakken"));
    const area = el("textarea", "pt-transfer-input");
    area.placeholder = "PW1.…";
    area.rows = 3;
    const apply = el("button", "pt-watch-refresh", "Overnemen");
    apply.type = "button";
    const receiveInfo = el("div", "pt-muted",
      "Vervangt de lijst op dit apparaat door die uit de code (doelen + FUT Genie-prijzen van dat moment).");
    receive.append(area, apply, receiveInfo);
    panel.append(send, receive);

    // Live via your pc: the pc (with FUT Genie) writes list + prices to your gist, the phone reads it.
    const live = el("div", "pt-transfer-part");
    live.appendChild(el("div", "pt-transfer-title", "Live via je pc (GitHub gist)"));
    const liveInfo = el("div", "pt-muted");
    const gist = el("input", "pt-transfer-input");
    gist.type = "text";
    gist.placeholder = "Link of id van je geheime gist";
    const token = el("input", "pt-transfer-input");
    token.type = "password";
    token.autocomplete = "off";
    token.placeholder = "GitHub-token (alleen recht: gist)";
    const saveToken = el("button", "pt-watch-refresh", "Token opslaan");
    saveToken.type = "button";
    const sendNow = el("button", "pt-watch-refresh", "↑ Nu versturen");
    sendNow.type = "button";
    const clearToken = el("button", "pt-watch-refresh", "Token wissen");
    clearToken.type = "button";
    const pullNow = el("button", "pt-watch-refresh", "↓ Nu ophalen");
    pullNow.type = "button";
    // The token to the phone as a QR code. Tampermonkey's part draws it, so the token never reaches this page.
    const tokenQr = el("button", "pt-watch-refresh", "📱 Token naar telefoon");
    tokenQr.type = "button";
    const tokenQrBox = el("div", "pt-transfer-qr");
    tokenQrBox.id = "pt-token-qr";
    const tokenQrInfo = el("div", "pt-muted");
    let tokenQrTimer = 0;
    const hideTokenQr = () => {
      window.clearTimeout(tokenQrTimer);
      tokenQrBox.textContent = "";
      tokenQrInfo.textContent = "";
      tokenQr.textContent = "📱 Token naar telefoon";
    };
    live.append(liveInfo, gist, token, saveToken, sendNow, clearToken, pullNow, tokenQr, tokenQrBox, tokenQrInfo);
    panel.prepend(live);

    const renderLive = () => {
      const relay = getRelay();
      const pc = !!genie();
      if (document.activeElement !== gist) gist.value = relay.gistId || "";
      token.style.display = relay.hasToken ? "none" : "";
      saveToken.style.display = relay.hasToken ? "none" : "";
      sendNow.textContent = pc ? "↑ Nu versturen" : "↑ Lijst naar pc";
      sendNow.style.display = relay.hasToken ? "" : "none";
      clearToken.style.display = relay.hasToken ? "" : "none";
      pullNow.style.display = pc ? "none" : "";
      tokenQr.style.display = pc && relay.hasToken ? "" : "none";
      if (!(pc && relay.hasToken) && tokenQrBox.firstChild) hideTokenQr();
      const error = relay.error ? ` Laatste fout: ${relay.error}` : "";
      const phoneList = relay.hasToken
        ? " Wijzig je hier de lijst, dan gaat die binnen een halve minuut naar je pc, die hem overneemt en er prijzen bij zoekt." +
          (relay.listSentAt ? ` Laatst verstuurd: ${formatDayTime(relay.listSentAt)}.` : "")
        : " Wil je hier een lijst maken voor je pc? Vul dan hier hetzelfde GitHub-token in.";
      liveInfo.textContent = pc
        ? relay.hasToken
          ? "Deze pc zet elke 5 minuten je lijst + FUT Genie-prijzen in de gist (zolang de web app openstaat)" +
            " en neemt elke minuut een nieuwe lijst van je telefoon over." +
            (relay.sentAt ? ` Laatst: ${formatDayTime(relay.sentAt)}.` : "") + error
          : "Vul een GitHub-token in (alleen het recht \"gist\"); die blijft in Tampermonkey op deze pc." + error
        : (relay.pricesAt
          ? `Prijzen van je pc: ${formatDayTime(relay.pricesAt)}${relayFresh() ? " (live)" : " – staat de web app op je pc open?"}.`
          : "Wacht op prijzen van je pc. Zet daar eerst het token in.") + phoneList + error;
    };
    gist.addEventListener("change", () => {
      const id = gistIdFrom(gist.value);
      saveRelay({ gistId: id, listJson: "", error: id ? "" : "Geen geldige gist-link" });
    });
    saveToken.addEventListener("click", async () => {
      saveToken.disabled = true;
      try {
        await relayCall("setToken", { token: token.value.trim(), gistId: getRelay().gistId });
        token.value = "";
        saveRelay({ hasToken: true, error: "" });
        if (genie()) pushRelay(true);
      } catch (error) {
        saveRelay({ error: error.message });
      }
      saveToken.disabled = false;
    });
    clearToken.addEventListener("click", async () => {
      await relayCall("clearToken", {}).catch(() => {});
      saveRelay({ hasToken: false, error: "" });
    });
    sendNow.addEventListener("click", () => (genie() ? pushRelay(true) : pushPhoneList(true)));
    pullNow.addEventListener("click", () => pullRelay(true));
    tokenQr.addEventListener("click", async () => {
      if (tokenQrBox.firstChild) {
        hideTokenQr();
        return;
      }
      tokenQr.disabled = true;
      try {
        await relayCall("tokenQr", { targetId: tokenQrBox.id, base: `${location.origin}${location.pathname}`, gistId: getRelay().gistId });
        tokenQr.textContent = "Verberg QR-code";
        tokenQrInfo.textContent = "Scan met de camera van je iPhone: Price Watch daar slaat het token op. " +
          "Het token staat in deze link, wis hem daarna uit de geschiedenis van Safari. De code verdwijnt na 2 minuten.";
        tokenQrTimer = window.setTimeout(hideTokenQr, 2 * 60 * 1000);
      } catch (error) {
        hideTokenQr();
        tokenQrInfo.textContent = `Geen QR-code: ${error.message}`;
      }
      tokenQr.disabled = false;
    });
    listeners.add(renderLive);

    let code = "";
    copy.addEventListener("click", async () => {
      const ok = await copyText(code);
      flashButton(copy, ok ? "✓ Gekopieerd" : "Kopiëren mislukt", ok, "", "📋 Kopieer code", "");
    });
    apply.addEventListener("click", async () => {
      try {
        receiveInfo.textContent = transferSummary(applyTransfer(await decodeTransfer(area.value)));
        area.value = "";
      } catch (error) {
        receiveInfo.textContent = `Overnemen mislukt: ${error.message}`;
      }
    });

    panel.__ptOpen = async () => {
      renderLive();
      const data = buildTransferData();
      code = await encodeTransfer(data);
      const url = `${location.origin}${location.pathname}#pw=${code}`;
      qrBox.textContent = "";
      try {
        if (!(await loadQrLibrary())) throw new Error("QR-bibliotheek niet geladen");
        const qr = window.qrcode(0, "L");
        qr.addData(url);
        qr.make();
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      } catch (error) {
        qrBox.appendChild(el("div", "pt-muted", `Geen QR-code (${error.message}). Gebruik "Kopieer code" en plak hem op je telefoon.`));
      }
      sendInfo.textContent = `${data.w.length} speler(s), ${Object.keys(data.p).length} met prijs. ` +
        "Scan met de camera van je iPhone: Safari opent de web app en neemt de lijst over. Prijzen zijn die van nu; zet opnieuw over voor verse prijzen.";
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
      .catch(error => showToast(`Price Watch: overzetten mislukt – ${error.message}`, false));
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
      const price = (geniePrice(entry.definitionId) || {}).price;
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
    const text = newlyHit.map(({ entry, price }) => `${entry.name}: ${priceFormat.format(price)} (doel ${priceFormat.format(entry.target)})`);
    showToast(`🎯 Op doel: ${text.join(" · ")}`, true);
    // Push to the phone (ntfy) only from the pc with FUT Genie, so a phone with the app open doesn't send it twice.
    if (genie()) relayCall("notify", { title: newlyHit.length > 1 ? `${newlyHit.length} spelers op doel` : "Speler op doel", text: text.join("\n") })
      .catch(error => console.warn("Price Watch: ntfy-melding mislukt.", error));
  }
  // Seed once the first prices are in; after that every update (Genie on the pc, the gist on the phone) counts.
  listeners.add(() => {
    if (!atTarget && !getWatch().some(entry => geniePrice(entry.definitionId))) return;
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
    const refresh = el("button", "pt-watch-refresh", "↻ Prijzen verversen");
    refresh.type = "button";
    refresh.addEventListener("click", () => refreshGeniePrices(true));
    const transfer = el("button", "pt-watch-refresh", "⇄ Overzetten");
    transfer.type = "button";
    transfer.title = "Lijst + prijzen naar je telefoon (QR-code) of een code van je pc plakken";
    const walk = el("button", "pt-watch-refresh", "▶ Alles afgaan");
    walk.type = "button";
    walk.title = "Zet speler na speler klaar op de transfermarkt (balk met \"Volgende\"): jouw PC-instapdoel als max BIN, leeg = auto uit de Genie-prijs. Duurste eerst.";
    walk.addEventListener("click", async () => {
      if (!(await startWatchRun())) showToast("Nog geen spelers om af te gaan.", false);
    });
    const chime = el("button", "pt-watch-refresh");
    chime.type = "button";
    const showChime = () => {
      chime.textContent = chimeOn() ? "🔔" : "🔕";
      chime.title = chimeOn() ? "Pling als een speler na een prijsupdate op je doel zit (klik om uit te zetten)" : "Pling staat uit (klik om aan te zetten)";
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
    const push = el("button", "pt-watch-refresh", "📲");
    push.type = "button";
    push.title = "Pushmelding op je telefoon (ntfy) als een speler op doel zit, ook als hij vergrendeld is";
    const actions = el("div", "pt-watch-actions");
    actions.append(walk, chime, push, transfer, refresh);
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
      ["Speler", "pt-col-name"],
      ["Rating", "pt-col-rating"],
      ["Rarity", "pt-col-rarity"],
      ["Genie (PC)", "pt-col-price"],
      ["PC-instapdoel", "pt-col-target"],
      ["Afstand", "pt-col-distance pt-sortable"],
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
      "Nog geen spelers. Open een spelerskaart (club, transfermarkt, transfer list, SBC) en klik op \"+ Price Watch\".");

    card.append(toolbar, pushPanel, transferPanel, table, empty);

    const rowsById = new Map();

    function makeRow(entry) {
      const row = el("tr");
      const nameCell = el("td", "pt-col-name");
      const name = el("span", "pt-watch-name", entry.name);
      name.title = entry.name;
      const copy = el("button", "pt-icon-btn", "📋");
      copy.type = "button";
      copy.title = "Kopieer spelersnaam";
      copy.addEventListener("click", async () => {
        const ok = await copyText(entry.name);
        flashButton(copy, ok ? "✓" : "!", ok, ok ? `Gekopieerd: ${entry.name}` : "Kopiëren mislukt", "📋", "Kopieer spelersnaam");
      });
      const search = el("button", "pt-icon-btn pt-transfer-search", "🔍");
      search.type = "button";
      search.title = SEARCH_TITLE;
      search.addEventListener("click", event => {
        try {
          openPreparedSearch(entry, event.shiftKey ? null : entry.target);
        } catch (error) {
          console.error("Price Watch:", error);
          flashButton(search, "⚠️", false, `Fout: ${error.message}`, "🔍", SEARCH_TITLE);
          showToast(`Transfermarkt openen mislukt – ${error.message}`, false);
        }
      });
      const LOWEST_TITLE = "Zoek de laagste BIN op de transfermarkt (een paar zoekopdrachten, alleen als je hier tikt)";
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
        if (marketBusy && Date.now() - marketBusySince < 60000) {
          showToast(`Er loopt nog een zoekopdracht (${Math.round((Date.now() - marketBusySince) / 1000)}s) – even wachten`, false);
          return;
        }
        marketBusy = false; // a search stuck for over a minute: release it
        lowest.textContent = "…";
        showToast(`${entry.name}: laagste prijs zoeken…`, true);
        try {
          const price = await findLowestPrice(entry.definitionId, search => { lowest.textContent = `${search}…`; });
          flashButton(lowest, price ? "✓" : "–", true, price ? `Laagste BIN: ${priceFormat.format(price)}` : "Niets te koop gevonden", "🏷️", LOWEST_TITLE);
          // Phones show no tooltips: say the result on screen.
          const state = distanceState(entry.target, price);
          showToast(price
            ? `${entry.name}: laagste BIN ${priceFormat.format(price)}` + (entry.target ? ` · afstand tot doel ${state.text}` : "")
            : `${entry.name}: niets te koop gevonden`, true);
          listeners.forEach(listener => listener());
        } catch (error) {
          console.warn("Price Watch: laagste prijs zoeken mislukt.", error);
          flashButton(lowest, "⚠️", false, error.message, "🏷️", LOWEST_TITLE);
          showToast(`${entry.name}: zoeken mislukt – ${error.message}`, false);
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
      const targetCell = el("td", "pt-col-target");
      const input = el("input", "pt-target-input");
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "Bijv. 50000";
      input.value = entry.target ? String(entry.target) : "";
      input.setAttribute("aria-label", `PC-instapdoel ${entry.name}`);
      targetCell.appendChild(input);

      const distanceCell = el("td", "pt-col-distance");
      const distance = el("span", "pt-distance", "—");
      distanceCell.appendChild(distance);

      const removeCell = el("td", "pt-col-remove");
      const remove = el("button", "pt-icon-btn pt-remove", "×");
      remove.type = "button";
      remove.title = `Verwijder ${entry.name} uit Price Watch`;
      remove.addEventListener("click", () => removeWatched(entry.definitionId));
      removeCell.appendChild(remove);

      row.append(nameCell, el("td", "pt-col-rating", String(entry.rating || "")),
        el("td", "pt-col-rarity", entry.rarity != null ? rarityName(entry.rarity) : ""), priceCell, targetCell, distanceCell, removeCell);

      const update = () => {
        const genieEntry = geniePrice(entry.definitionId);
        const price = genieEntry ? genieEntry.price : null;
        priceCell.textContent = price !== null ? priceFormat.format(price) : "—";
        priceCell.classList.toggle("pt-missing", price === null);
        lowest.style.display = genie() || relayFresh() ? "none" : "";
        priceCell.classList.toggle("pt-transferred", !!(genieEntry && genieEntry._transferred));
        priceCell.classList.toggle("pt-market", !!(genieEntry && genieEntry._market));
        priceCell.title = genieEntry
          ? genieEntry._market
            ? `Laagste BIN op de markt (zelf gezocht) · ${formatDayTime(Number(genieEntry._fetchedAt))}`
            : genieEntry._transferred
            ? `FUT Genie (PC), overgezet · prijs van ${formatDayTime(Number(genieEntry._fetchedAt) || Date.now())}`
            : `FUT Genie (PC), opgehaald om ${formatTime(Number(genieEntry._fetchedAt) || Date.now())}`
          : genie() ? "Nog geen FUT Genie-prijs voor deze kaart" : "FUT Genie is niet geladen en er is geen overgezette prijs";

        const state = distanceState(entry.target, price);
        row.__ptPercent = state.percent;
        distance.textContent = state.text;
        distance.className = state.className;
        distance.title = state.title;
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
        ? "Gesorteerd op afstand tot je instapdoel (klik: volgorde van toevoegen)"
        : "Klik om te sorteren op afstand tot je instapdoel";

      table.style.display = list.length ? "" : "none";
      empty.style.display = list.length ? "none" : "";

      // Phone: the refresh button reads the gist (prices from your pc).
      const relay = getRelay();
      const live = genie() || relayFresh();
      refresh.disabled = genie() ? genieLoading : relayBusy;
      const priceHeader = headRow.querySelector(".pt-col-price");
      priceHeader.textContent = live ? "Genie (PC)" : "Prijs";
      priceHeader.title = live ? "" : "Groen = laagste BIN die je zelf zocht (🏷️), wit = van je pc";
      const hits = list.filter(entry => (rowsById.get(entry.definitionId).row.__ptPercent ?? Infinity) <= 0).length;
      const summary = `${list.length} speler(s)` + (hits ? ` · ${hits} op of onder doel` : "");
      if (genie()) {
        status.textContent = genieLoading
          ? `${summary} · prijzen ophalen bij FUT Genie…`
          : genieRequestedAt
            ? `${summary} · FUT Genie (PC) opgehaald om ${formatTime(genieRequestedAt)} · ververst elke 5 min`
            : summary;
        return;
      }
      const pricesFrom = transferredAt(list.map(entry => entry.definitionId));
      const relayError = relay.error ? ` · gist: ${relay.error}` : "";
      status.textContent = relayBusy
        ? `${summary} · prijzen van je pc ophalen…`
        : relayFresh()
          ? `${summary} · FUT Genie via je pc · prijzen van ${formatTime(relay.pricesAt)} · ververst elke 2 min` + relayError
          : relay.pricesAt
            ? `${summary} · laatste prijzen van je pc: ${formatDayTime(relay.pricesAt)} (web app op je pc dicht?) · tik 🏷️ voor nu` + relayError
            : (pricesFrom
              ? `${summary} · prijzen overgezet van je pc (${formatDayTime(pricesFrom)}) · tik 🏷️ voor nu`
              : `${summary} · nog geen prijzen: zet op je pc "Live via je pc" aan (⇄ Overzetten) · tik 🏷️ voor nu`) + relayError;
    }

    const renderStock = buildStockSection(root);
    const renderFodder = buildFodderSection(root);
    buildTabs(root, {
      watch: card,
      fodder: root.querySelector(".pt-fodder-card"),
      lists: root.querySelector(".pt-stock-card")
    });
    return () => {
      renderRows();
      renderStock();
      renderFodder();
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
      console.warn("Price Watch: stock-lijsten konden niet worden opgeslagen.", error);
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
    const maxBuy = (criteria && criteria.maxBuy) || (shown && shown.maxBuy) || 0;
    if (!maxBuy || minBid < maxBuy) return;
    if (criteria) criteria.minBid = 0;
    if (shown) {
      const input = inputs[0];
      input.value = "";
      ["input", "change", "blur"].forEach(type => input.dispatchEvent(new Event(type, { bubbles: true })));
    }
    showToast("Min bid weer op 0 (bereikte je max BIN)", true);
  }

  let minBidWrapInstalled = false;

  function installMinBidWrap() {
    if (minBidWrapInstalled) return;
    minBidWrapInstalled = true;
    document.addEventListener("keydown", event => {
      if (event.key !== "ArrowRight") return;
      // After FUT Genie has raised the value.
      window.setTimeout(() => {
        try {
          wrapMinBid();
        } catch (error) {
          console.warn("Price Watch: min bid terugzetten mislukt.", error);
        }
      }, 80);
    });
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
  let ownTransferPoll = false;
  let lastTransferLoad = 0;

  function getSeenTrades() {
    try {
      const value = JSON.parse(localStorage.getItem(LISTING_SEEN_KEY));
      return Array.isArray(value) ? new Set(value) : null;
    } catch {
      return null;
    }
  }

  // quiet: you loaded the list yourself (you see it), or the first time ever: only remember.
  function reportTransferChanges(items, quiet) {
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
      else sold.push({ name: playerNameFor(item.definitionId, (item._staticData && item._staticData.name) || "item"), price: auction.currentBid || auction.buyNowPrice || 0 });
    });
    try {
      localStorage.setItem(LISTING_SEEN_KEY, JSON.stringify([...now])); // only what's still in the list
    } catch (_) {
      // Reported again next time.
    }
    if (quiet || !seen || (!sold.length && !expired)) return;
    const parts = [];
    if (sold.length) {
      const total = sold.reduce((sum, sale) => sum + sale.price, 0);
      parts.push(`💰 ${sold.length} verkocht: ${sold.slice(0, 5).map(sale => `${sale.name} ${priceFormat.format(sale.price)}`).join(", ")}${sold.length > 5 ? ", …" : ""}` +
        ` (+${priceFormat.format(Math.floor(total * 0.95))} na tax)`);
    }
    if (expired) parts.push(`⏰ ${expired === 1 ? "1 kaart" : `${expired} kaarten`} niet verkocht – opnieuw listen`);
    if (chimeOn()) playChime();
    showToast(`Transferlijst: ${parts.join(" · ")}`, true);
    // Looking at this tab: the toast is enough. Elsewhere: also on your phone.
    if (document.hidden || !document.hasFocus()) {
      const title = sold.length && expired ? "Verkocht + verlopen" : sold.length ? `${sold.length} verkocht` : "Transferlijst verlopen";
      relayCall("notify", { title, text: parts.join("\n") }).catch(error => console.warn("Price Watch: ntfy-melding mislukt.", error));
    }
  }

  function scheduleListingPoll(delay) {
    window.clearTimeout(listingPollTimer);
    listingPollTimer = null;
    if (delay == null) {
      if (!getListingEnds().length) return; // nothing listed: nothing to watch
      delay = LISTING_POLL_MS;
    }
    listingPollTimer = window.setTimeout(() => pollTransferList(), delay);
  }

  // One request covers the whole list, and never more than one a minute however many listings end.
  // Ended listings wait in dueGroups; when the list can't be loaded (logged out) you still hear them.
  async function pollTransferList() {
    const wait = lastTransferLoad + LISTING_MIN_GAP_MS - Date.now();
    if (wait > 0) return scheduleListingPoll(dueGroups.length ? wait : null);
    const due = dueGroups;
    dueGroups = [];
    lastTransferLoad = Date.now();
    ownTransferPoll = true;
    const items = await requestPile("requestTransferItems");
    ownTransferPoll = false;
    if (!items) {
      if (due.length) listingAlert({ count: due.reduce((sum, group) => sum + group.count, 0) });
      return scheduleListingPoll();
    }
    // The wrapper in installListingWatch did the rest; a listing at 0 seconds: look again in a minute.
    if (items.some(item => { const a = auctionOf(item); return a && a.tradeState === "active" && !(Number(a.expires) > 0); })) scheduleListingPoll(LISTING_MIN_GAP_MS + 2000);
    else scheduleListingPoll();
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
    scheduleListingPoll(0);
  }

  // Fallback when the transfer list can't be loaded: only the timer is known.
  function listingAlert(group) {
    const what = group.count === 1 ? "1 kaart" : `${group.count} kaarten`;
    if (chimeOn()) playChime();
    showToast(`⏰ Transferlijst: listing van ${what} is afgelopen – wat niet verkocht is kun je opnieuw listen.`, true);
    relayCall("notify", { title: "Transferlijst verlopen", text: `Listing van ${what} afgelopen. Niet verkocht? Opnieuw listen.` })
      .catch(error => console.warn("Price Watch: ntfy-melding mislukt.", error));
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
                console.warn("Price Watch: transferlijst-timer niet bijgewerkt.", error);
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
    wrap("requestTransferItems", response => {
      const items = (response.response && response.response.items) || (response.data && response.data.items);
      if (!Array.isArray(items)) return;
      lastTransferLoad = Date.now();
      recordTransferList(items);
      reportTransferChanges(items, !ownTransferPoll);
    });
    // Listing one card: (item, startingBid, buyNowPrice, duration in seconds).
    wrap("list", (response, args) => {
      const duration = Number(args[3]);
      if (duration > 0) saveListingEnds(groupEnds(getListingEnds().flatMap(group => Array(group.count).fill(group.end)).concat(Date.now() + duration * 1000)));
    });
    // "Re-list all": ask for the transfer list once, the wrapper above takes the new end times from it.
    wrap("relistExpiredAuctions", () => window.setTimeout(() => {
      try {
        services.Item.requestTransferItems();
      } catch (_) {
        // The next time you open the transfer list.
      }
    }, 1500));
    scheduleListingAlerts();
    // Sold while the page was closed, or listed from the game/app: look once shortly after loading.
    scheduleListingPoll(20 * 1000);
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
              console.warn("Price Watch: marktprijs uit zoekopdracht niet verwerkt.", error);
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
      return list.rules.filter(rule => rule.enabled !== false).flatMap(rule => filterSteps(rule).map(step => ({
        filter: rule,
        position: step.position,
        league: step.league,
        max: rule.max,
        ideal: rule.ideal,
        key: `f${rule.id}|${step.position || "*"}|${step.league ? step.league.id : "*"}`
      })));
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
  function playerMax(list, player) {
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
      return platform === "pc" ? "pc" : platform ? "console" : "pc";
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
        if (known === nation.id) { cost -= 1; reason = reason === "naam" ? reason : "vlag + prijs"; } else cost += 10;
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
    if (state && windows.length > 1) state.text += ` · ${windows.length} vensters`;
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
    const day = date.toDateString() === today.toDateString() ? "vandaag"
      : date.toDateString() === tomorrow.toDateString() ? "morgen"
        : date.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
    return `${day} ${formatTime(timestamp)}`;
  }

  function windowState(span, now = Date.now()) {
    if (!span || !span.start || !span.end) return null;
    if (now < span.start) {
      return { state: "before", text: `Venster ${formatDayTime(span.start)}–${formatTime(span.end)} · begint over ${formatDuration(span.start - now)}` };
    }
    if (now <= span.end) return { state: "open", text: `VENSTER OPEN · nog ${formatDuration(span.end - now)}` };
    return { state: "after", text: `Venster voorbij (${formatDayTime(span.start)}–${formatTime(span.end)})` };
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
    return { name: match[1].trim(), rating, coins, skip: !coins, fitCoins: coins || (anyPrice ? fodderCoins(anyPrice[1]) : null) };
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
    return [...pool].sort((a, b) => versionCost(a, tipCoins) - versionCost(b, tipCoins))[0];
  }

  function versionLabel(version, baseId) {
    const price = (geniePrice(version.definitionId) || {}).price;
    const kind = version.definitionId === baseId ? "Gewoon" : rarityName(version.rarity);
    return `${isHolo(version) ? "✨ Holo " : ""}${kind} ${version.rating}` + (price ? ` · Genie ${priceFormat.format(price)}` : " · geen prijs");
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
      const rated = parseRatedPriceLine(rawLine, platform);
      if (rated) {
        const match = matchRatedPlayer(rated.name, rated.rating);
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
      rawLine.split(/[,;/]/).forEach(part => {
        const line = part.replace(/@\w+/g, "").replace(/[•*_~`>]+/g, " ").replace(/^\s*[-–\d.)]+\s*/, "").trim();
        if (!line || /\d/.test(line)) return;
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
    return { players, skipped, platform, windows: parseWindows(text) };
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
        resolve({ items, done: !response.success || !response.response || response.response.retrievedAll || items.length < CLUB_PAGE_SIZE, failed: !response.success });
      });
    });
  }

  async function clubItems(applyFilter) {
    const items = [];
    for (let offset = 0, page = 0; page < 30; page++, offset += CLUB_PAGE_SIZE) {
      if (page) await new Promise(resolve => window.setTimeout(resolve, CLUB_SEARCH_DELAY_MS));
      const result = await clubSearchPage(applyFilter, offset);
      if (result.failed) throw new Error("Club doorzoeken mislukt");
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

  // Ask for one pile the way its own screen does; null when the request fails or doesn't exist.
  function requestPile(method) {
    return new Promise(resolve => {
      if (!services.Item || typeof services.Item[method] !== "function") return resolve(null);
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
    inventoryProgress.set(list.id, "lijsten…");
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
    inventoryProgress.set(list.id, "lijsten…");
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
    wsl: 2216, nwsl: 2221, mls: 39
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

  const PRICE_LINE = /\b(golds?|silvers?|bronzes?)\b[^\d]*(\d[\d.,]*\s*k?)(?:\s*[-–]\s*(\d[\d.,]*\s*k?))?/i;
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
          levels[levelFromWord(price[1])] = { enabled: true, max: high || low, ideal: high ? low : null };
        });
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

  function parseFilterTip(text) {
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
    return `${step.position || (step.filter && step.filter.kind === "manager" ? "managers" : "alle posities")} · ${step.league ? step.league.label : "alle competities"}`;
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
      if (/\bno risk\b/i.test(after)) rule.note = "geen risico";
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
      // Fodder cycles in bid mode filter on max bid; everything else on max buy now.
      if (rule.player && list.mode === "bid") criteria.maxBid = rule.max;
      else criteria.maxBuy = rule.max;
    }
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
    run = null;
    saveRun();
  }

  let runBar = null;

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
      const next = el("button", "pt-run-btn pt-run-next", "Volgende ▶");
      const stop = el("button", "pt-run-btn pt-run-stop", "✕");
      // Top or bottom of the screen, so it never sits on EA's Search button (remembered; phone starts at the top).
      const flip = el("button", "pt-run-btn pt-run-flip", "⇅");
      flip.title = "Balk naar boven/onder verplaatsen";
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
      prev.title = "Vorige klaarzetten";
      next.title = "Volgende club/kwaliteit klaarzetten (zoeken doe je zelf)";
      stop.title = "Stock-ronde stoppen";
      prev.addEventListener("click", () => run && goToRule(run.listId, run.index - 1));
      // At the last rule "Volgende" starts over at the first one.
      next.addEventListener("click", () => {
        if (!run) return;
        const list = getStock().find(item => item.id === run.listId);
        const count = list ? stockRules(list).length : 0;
        goToRule(run.listId, run.index + 1 >= count ? 0 : run.index + 1);
      });
      stop.addEventListener("click", stopRun);

      // Lazy flip: the cheapest BIN you saw → the filter becomes "market − under".
      const market = el("div", "pt-run-market");
      const marketInput = el("input", "pt-target-input");
      marketInput.inputMode = "numeric";
      marketInput.placeholder = "markt";
      marketInput.title = "Goedkoopste BIN die je nu op de markt ziet";
      const marketSet = el("button", "pt-run-btn", "OK");
      const marketBuy = el("button", "pt-run-btn pt-run-buy", "🔍 Koopfilter");
      const marketClear = el("button", "pt-run-btn", "↺");
      [marketSet, marketBuy, marketClear].forEach(button => { button.type = "button"; });
      marketSet.title = "Marktprijs opslaan en het koopfilter klaarzetten";
      marketBuy.title = "Koopfilter (markt min je marge) klaarzetten";
      marketBuy.addEventListener("click", () => run && goToRule(run.listId, run.index));
      marketClear.title = "Marktprijs vergeten en de markt opnieuw bekijken";
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
      runBar.append(info, market, prev, next, flip, stop);
      document.body.appendChild(runBar);
    }

    const rule = rules[Math.min(run.index, rules.length - 1)];
    const info = runBar.querySelector(".pt-run-info");
    info.textContent = "";
    const state = listWindowState(list);
    runBar.dataset.window = state ? state.state : "";

    if (runLoading) {
      info.append(el("div", "pt-run-title", "Verse FUT Genie-prijzen ophalen…"), el("div", "pt-run-sub", list.name));
    } else if (rule.fodder) {
      const what = list.mode === "bid" ? "max bod" : "max BIN";
      info.append(
        el("div", "pt-run-title", `${rule.fodder.rating}-rated · ${what} ${rule.max ? priceFormat.format(rule.max) : "—"}`),
        el("div", "pt-run-sub", (rule.ideal ? `ideaal ≤ ${priceFormat.format(rule.ideal)} · ` : "") +
          (rule.max ? `winst vanaf verkoop ≥ ${priceFormat.format(roundUpToStep(rule.max / (1 - EA_TAX)))} · ` : "") +
          `${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else if (rule.player) {
      const outlook = snipeOutlook(rule);
      info.append(
        el("div", "pt-run-title", `${rule.player.name} · ${list.mode === "bid" ? "max bod" : "max BIN"} ${rule.max ? priceFormat.format(rule.max) : "—"}`),
        el("div", "pt-run-sub", (list.fodderRating
          ? `${rule.player.rating || list.fodderRating}-rated · Genie ${rule.genie ? priceFormat.format(rule.genie.price) : "—"}` + (rule.player.fixedMax ? " · jouw doel" : ` · auto (winst ${profitFor(list)}%)`)
          : list.holo ? `✨ alleen holo · max = normale prijs${rule.genie ? "" : " (geen Genie-prijs)"}`
          : rule.player.fixedMax ? "vaste max BIN" : rule.genie ? `Genie ${priceFormat.format(rule.genie.price)} · winst ${profitFor(list)}%` : "geen Genie-prijs") +
          (outlook ? ` · winst vanaf verkoop ≥ ${priceFormat.format(outlook.breakEven)}` : "") +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else if (rule.filter) {
      info.append(
        el("div", "pt-run-title", `${filterRuleTitle(rule.filter)}${rule.position ? ` · ${rule.position}` : ""} ≤ ${rule.max ? priceFormat.format(rule.max) : "—"}`),
        el("div", "pt-run-sub", `${rule.league ? rule.league.label : "alle competities"}` + (rule.ideal ? ` · ideaal ≤ ${priceFormat.format(rule.ideal)}` : "") +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else if (list.flip && rule.market) {
      const { sellLow, sellHigh } = list.flip;
      const low = rule.max + sellLow;
      const high = rule.max + sellHigh;
      const aboveTip = rule.ceiling && rule.market.price > rule.ceiling;
      info.append(
        el("div", "pt-run-title", `${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} · koop ≤ ${priceFormat.format(rule.max)}`),
        el("div", "pt-run-sub", `markt ${priceFormat.format(rule.market.price)} (${rule.market.seen ? `${rule.market.count ? `${rule.market.count}× ` : ""}gezien ` : ""}${formatTime(rule.market.at)}) · ` +
          `verkoop ${priceFormat.format(low)}–${priceFormat.format(high)} = ${formatSigned(flipNet(low, rule.max))}…${formatSigned(flipNet(high, rule.max))} na 5%` +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
      if (aboveTip) {
        info.appendChild(el("div", "pt-run-window pt-window-before",
          `⚠ markt boven de tip (≤ ${priceFormat.format(rule.ceiling)}): meer risico, de tip raadt deze nu niet aan`));
      }
    } else if (list.flip) {
      info.append(
        el("div", "pt-run-title", `${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} · markt bekijken (geen max BIN)`),
        el("div", "pt-run-sub", `Zoek: de goedkoopste BIN wordt de markt (of vul hem in) → koopfilter markt − ${priceFormat.format(list.flip.under)}` +
          ` · ${list.name} · ${run.index + 1}/${rules.length}`)
      );
    } else {
      info.append(
        el("div", "pt-run-title", `${rule.club.teamName} · ${LEVEL_LABEL[rule.level]} ≤ ${priceFormat.format(rule.max)}`),
        el("div", "pt-run-sub", `${list.name} · ${run.index + 1}/${rules.length}` + (rule.ideal ? ` · ideaal ≤ ${priceFormat.format(rule.ideal)}` : ""))
      );
    }
    const marketBox = runBar.querySelector(".pt-run-market");
    marketBox.style.display = list.flip && rule.club && !runLoading ? "" : "none";
    marketBox.lastChild.style.display = rule.market ? "" : "none";
    marketBox.querySelector(".pt-run-buy").style.display = rule.market ? "" : "none";
    if (state) info.appendChild(el("div", `pt-run-window pt-window-${state.state}`, state.text));

    const nextButton = runBar.querySelector(".pt-run-next");
    const atEnd = run.index >= rules.length - 1;
    nextButton.disabled = runLoading || rules.length < 2;
    nextButton.textContent = atEnd ? `↻ Opnieuw (1/${rules.length})` : "Volgende ▶";
    nextButton.title = atEnd ? "Terug naar de eerste en opnieuw beginnen" : "Volgende klaarzetten (zoeken doe je zelf)";
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
      `${summary.owned} verhandelbaar` + (summary.untradeable ? ` (+${summary.untradeable} onverhandelbaar, niet meegeteld)` : ""),
      summary.bought < summary.owned ? `${summary.owned - summary.bought} zonder bekende aankoopprijs (bijv. uit packs)` : "",
      summary.avgBuy ? `Gemiddelde aankoop: ${priceFormat.format(Math.round(summary.avgBuy))}` : "",
      summary.avgValue ? `Gemiddelde FUT Genie-waarde nu: ${priceFormat.format(Math.round(summary.avgValue))}` : "",
      summary.breakEven ? `Winst vanaf verkoopprijs ≥ ${priceFormat.format(summary.breakEven)} (na 5% belasting)` : "",
      summary.net !== null ? `Netto als je nu verkoopt: ${summary.net > 0 ? "+" : ""}${priceFormat.format(summary.net)}` : ""
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
      console.warn("Price Watch: fodder-instellingen konden niet worden opgeslagen.", error);
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
      console.warn("Price Watch: fodderprijzen ophalen mislukt.", error);
    } finally {
      fodderMarketLoading = false;
      listeners.forEach(listener => listener());
    }
  }

  function fodderMarketPrice(rating) {
    const entry = fodderMarket && fodderMarket.prices[`${rating}-0`];
    return entry && entry.min > 0 ? entry : null;
  }

  // --- Cheapest players per rating (like FUTBIN's "cheapest by rating"), from FUT Genie prices ---

  const FODDER_CYCLE_SIZE = 10;
  const FODDER_CYCLE_SPREAD = 1.5; // only players up to 1.5× the cheapest one
  let fodderCheapestAt = 0;
  let fodderCheapestLoading = false;

  function fodderCandidates(rating) {
    return getPlayerIndex().filter(entry => entry.rating === rating);
  }

  function cheapestForRating(rating) {
    return fodderCandidates(rating)
      .map(entry => ({ entry, price: (geniePrice(entry.id) || {}).price || 0 }))
      .filter(item => item.price > 0)
      .sort((a, b) => a.price - b.price);
  }

  function cyclePicks(rating) {
    const cheapest = cheapestForRating(rating);
    if (!cheapest.length) return [];
    const limit = cheapest[0].price * FODDER_CYCLE_SPREAD;
    return cheapest.filter(item => item.price <= limit).slice(0, FODDER_CYCLE_SIZE);
  }

  // One bulk FUT Genie request for every regular player in the rating range; refreshed every 5 minutes.
  function loadFodderCheapest(force) {
    if (!genie() || fodderCheapestLoading) return;
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
      return cyclePicks(rating).map(item => ({ definitionId: item.entry.id, name: item.entry.display, rating, fixedMax: target }));
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
      name: ratings.length > 1 ? `${ratings.join("+")}-rated goedkoopste` : `${ratings[0]}-rated goedkoopste`,
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
      console.warn("Price Watch: versies opzoeken mislukt.", error);
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
    stock.push({ id: WATCH_RUN_ID, type: "players", watchRun: true, name: "Spelers", createdAt: Date.now(), profit: null, windows: [], players, done: {} });
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
    fodderInventoryProgress = "lijsten…";
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
    mode.append(new Option("Bieden (max bod)", "bid"), new Option("Direct kopen (max BIN)", "bin"));
    mode.addEventListener("change", () => { getFodder().mode = mode.value; saveFodder(); });
    modeLabel.append(el("span", "pt-muted", "Zoeken op"), mode);

    const refresh = el("button", "pt-watch-refresh", "↻ Prijzen");
    const inventory = el("button", "pt-watch-refresh", "📦 Voorraad bijwerken");
    const futbin = el("a", "pt-link-btn pt-futbin", "FUTBIN ↗");
    futbin.href = FUTBIN_CHEAPEST_URL;
    futbin.target = "_blank";
    futbin.rel = "noopener";
    futbin.title = "Goedkoopste spelers per rating op FUTBIN (met namen), om te vergelijken. Let op: zet FUTBIN op PC, anders zie je consoleprijzen.";
    [refresh, inventory].forEach(button => { button.type = "button"; });
    refresh.addEventListener("click", () => {
      loadFodderMarket(true);
      loadFodderCheapest(true);
    });
    inventory.title = "Telt je gewone kaarten per rating in je club, transferlijst, unassigned en gewonnen transfer targets. Geen transfermarkt-zoekopdrachten.";
    inventory.addEventListener("click", () => updateFodderInventory());
    // Cycle several ratings in one go (the ticked rows), so "Volgende" runs on from 86 into 87.
    const cycleAll = el("button", "pt-watch-refresh pt-cycle-btn", "🔄 Aangevinkte cyclen");
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
    [["Rating", "pt-col-rating"], ["Goedkoopste spelers", "pt-col-cheapest"], ["Mediaan", "pt-col-price"], ["Jouw doel", "pt-col-target"],
      ["Afstand", "pt-col-distance"], ["", "pt-col-level"], ["Voorraad", "pt-col-stock"]]
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
      refresh.disabled = fodderMarketLoading || !genie();
      inventory.disabled = !!fodderInventoryProgress;
      inventory.textContent = fodderInventoryProgress ? `📦 ${fodderInventoryProgress}` : "📦 Voorraad bijwerken";
      status.textContent = !genie()
        ? "FUT Genie is niet geladen: geen marktprijzen per rating."
        : fodderMarketLoading ? "Fodderprijzen ophalen bij FUT Genie…"
          : fodderMarket
            ? `FUT Genie-marktprijzen (PC) per rating, gewone kaarten · bijgewerkt ${fodderMarket.lastUpdated ? formatDayTime(new Date(fodderMarket.lastUpdated).getTime()) : "onbekend"}`
            : "Nog geen fodderprijzen opgehaald.";

      body.textContent = "";
      const what = state.mode === "bin" ? "max BIN" : "max bod";
      const selected = cycleSelection();
      const selectedPicks = selected.reduce((sum, rating) => sum + cyclePicks(rating).length, 0);
      cycleAll.disabled = !selectedPicks;
      cycleAll.textContent = selected.length ? `🔄 Cyclen ${selected.join("+")} (${selectedPicks})` : "🔄 Aangevinkte cyclen";
      cycleAll.title = "Loopt de goedkoopste spelers van alle aangevinkte ratings achter elkaar door (laagste rating eerst, per rating goedkoopste eerst), " +
        "elk met het doel van zijn rating. Zoeken doe je zelf; Volgende ▶ in de balk rechtsonder.";
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
        const medCell = el("td", "pt-col-price pt-muted", market ? `${priceFormat.format(market.med)}${lowSample ? " ⚠️" : ""}` : "—");
        if (market) {
          medCell.title = `Gemiddeld ${priceFormat.format(market.avg)} · ${market.n} waarnemingen` +
            (lowSample ? "\nWeinig waarnemingen: mediaan is onbetrouwbaar, kijk naar het minimum of FUTBIN." : "");
        }

        const targetCell = el("td", "pt-col-target");
        const input = el("input", "pt-target-input");
        input.inputMode = "numeric";
        input.placeholder = cheapest ? `bijv. ${priceFormat.format(roundDownToStep(cheapest * 0.85))}` : "—";
        input.value = target.max || "";
        input.title = `Je ${what} voor ${rating}-rated` + (target.ideal ? ` (ideaal ≤ ${priceFormat.format(target.ideal)})` : "");
        input.addEventListener("change", () => {
          const max = parsePrice(input.value);
          if (max) state.targets[rating] = { ...target, max };
          else delete state.targets[rating];
          saveFodder();
        });
        targetCell.appendChild(input);
        if (target.max) {
          targetCell.appendChild(el("div", "pt-level-detail pt-outlook pt-muted", `winst vanaf ≥ ${priceFormat.format(roundUpToStep(target.max / (1 - EA_TAX)))}`));
        }

        // Distance: cheapest player vs your target (green = the market is at or under your target).
        const distanceCell = el("td", "pt-col-distance");
        const state2 = distanceState(target.max || null, cheapest);
        const pill = el("span", state2.className, state2.text);
        pill.title = target.max ? state2.title : "Vul een doel in om de afstand te zien";
        distanceCell.appendChild(pill);

        const buttonCell = el("td", "pt-col-level");
        const max = target.max || null;
        const cycleActive = activeCycleRatings().includes(rating);
        const cycle = el("button", "pt-level-btn pt-cycle-btn" + (cycleActive ? " pt-current" : ""), picks.length ? `🔄 Cyclen (${picks.length})` : "🔄 Cyclen");
        cycle.type = "button";
        cycle.disabled = !picks.length;
        cycle.title = picks.length
          ? `Loop de ${picks.length} goedkoopste ${rating}-rated spelers één voor één door (goedkoopste eerst) met ${max ? `${what} ${priceFormat.format(max)}` : "auto max (5% winst op de Genie-prijs)"}.\nPer speler worden de filters klaargezet; zoeken doe je zelf. Volgende ▶ in de balk rechtsonder.`
          : "Nog geen spelersprijzen voor deze rating (FUT Genie laadt nog, of geen gewone kaarten met prijs).";
        cycle.addEventListener("click", () => startFodderCycle(rating));
        buttonCell.appendChild(cycle);

        const button = el("button", "pt-icon-btn pt-generic-btn", "🔍");
        button.type = "button";
        button.title = `Algemeen: alle ${rating}-rated gewone kaarten · ${max ? `${what} ${priceFormat.format(max)}` : "geen max"} klaarzetten. Zoeken doe je zelf.`;
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
        tick.title = "Meenemen in \"Cyclen\" bovenaan";
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
          el("span", "", `📦 ${totalOwned} verhandelbare fodderkaarten`),
          el("span", "pt-muted", ` · waarde op marktminimum ~${priceFormat.format(totalValue)} (na belasting ~${priceFormat.format(Math.round(totalValue * (1 - EA_TAX)))})`),
          el("span", "pt-muted", ` · geteld om ${formatTime(state.inventory.updatedAt)}`)
        );
      } else {
        totals.appendChild(el("span", "pt-muted", "📦 Klik op \"Voorraad bijwerken\" om je fodder per rating te tellen."));
      }
    }

    return render;
  }

  // --- Tabs on the Price Watch page ----------------------------------------------

  const TAB_KEY = "pt_watch_tab_v1";

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
      if (name === "fodder") {
        loadFodderMarket(false);
        loadFodderCheapest(false);
      }
    };
    [["watch", "Spelers"], ["fodder", "Fodder"], ["lists", "Lijsten"]].forEach(([key, label]) => {
      const button = el("button", "pt-tab", label);
      button.type = "button";
      button.addEventListener("click", () => show(key));
      buttons[key] = button;
      bar.appendChild(button);
    });
    root.insertBefore(bar, root.firstChild);
    let initial = "watch";
    try {
      initial = localStorage.getItem(TAB_KEY) || "watch";
    } catch (_) {
      // Default tab.
    }
    show(sections[initial] ? initial : "watch");
    return show;
  }

  // --- Stock UI inside the Price Watch page -------------------------------------

  function buildStockSection(root) {
    const card = el("div", "pt-watch-card pt-stock-card");
    root.appendChild(card);

    const toolbar = el("div", "pt-watch-toolbar");
    const heading = el("div", "pt-watch-heading");
    heading.append(
      el("h2", "pt-watch-title", "Stock-lijsten"),
      el("div", "pt-watch-status", "Plak een tip (clubs + prijzen) en loop de zoekopdrachten één voor één door. Zoeken en kopen doe je zelf.")
    );
    const importButton = el("button", "pt-watch-refresh", "+ Tip plakken");
    importButton.type = "button";
    toolbar.append(heading, importButton);

    const importPanel = el("div", "pt-stock-import");
    importPanel.style.display = "none";
    const lists = el("div", "pt-stock-lists");
    card.append(toolbar, importPanel, lists);

    let lastTipText = "";

    function switchLink(toPlayers) {
      const link = el("button", "pt-link-btn", toPlayers ? "Dit is een spelerslijst →" : "Dit is een clublijst →");
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
        row.append(check, el("span", "pt-stock-level-name", "Venster"), start, el("span", "pt-muted", "tot"), end);
        if (span && span.timeZone && span.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone) {
          row.appendChild(el("span", "pt-muted", `(omgerekend vanuit ${span.timeZone})`));
        }
        rows.push({ check, start, end });
        element.insertBefore(row, add);
      };
      const add = el("button", "pt-link-btn", "+ venster");
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
      mode.append(new Option("Bieden (max bod)", "bid"), new Option("Direct kopen (max BIN)", "bin"));
      mode.value = parsed.mode;
      modeLabel.append(el("span", "pt-stock-level-name", "Zoeken op"), mode);
      const windows = windowsEditor(parsed.windows, true);
      settings.append(modeLabel, windows.element);

      const table = el("table", "pt-watch-table pt-stock-review");
      const head = el("tr");
      [["", "pt-col-check"], ["Rating", "pt-col-raw"], ["Max", "pt-col-match"], ["Ideaal", "pt-col-league"], ["", "pt-col-status"]]
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
      const save = el("button", "pt-link-btn", "Als aparte fodder-lijst opslaan");
      const back = el("button", "pt-link-btn", "← Terug");
      [applyToScreen, save, back].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      applyToScreen.addEventListener("click", () => {
        const chosen = rows.filter(row => row.check.checked && parsePrice(row.max.value));
        if (!chosen.length) {
          message.textContent = "Kies minstens één rating met een max-prijs.";
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
          message.textContent = "Kies minstens één rating met een max-prijs.";
          return;
        }
        getStock().unshift({
          id: `s${Date.now()}`,
          type: "fodder",
          name: nameInput.value.trim() || "Fodder-lijst",
          createdAt: Date.now(),
          mode: mode.value,
          windows: windows.read(),
          ratings,
          done: {}
        });
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(applyToScreen, el("span", "pt-muted", "of"), el("span", "pt-muted", "naam"), nameInput, save, back, message);

      const column = parsed.columnUsed ? ` · prijzen uit de ${parsed.columnUsed}-kolom (jouw platform)` : "";
      importPanel.append(
        el("div", "pt-stock-summary", `${parsed.ratings.length} ratings gevonden${column} · bedragen in coins (6 = 6.000) · alleen gewone gouden kaarten, geen specials.`),
        settings, table, actions
      );
    }

    function showTargetsStep(targets, windows) {
      importPanel.textContent = "";
      const snipeLists = getStock().filter(list => list.type === "players" && !list.fodderRating && !list.watchRun);

      const listRow = el("div", "pt-stock-actions");
      const listSelect = el("select", "pt-stock-select pt-list-select");
      snipeLists.forEach(list => listSelect.appendChild(new Option(`🎯 ${list.name} (${list.players.length} spelers)`, list.id)));
      listRow.append(el("span", "pt-muted", "Toepassen op"), listSelect);

      const windowsBox = el("div");
      const tableBox = el("div");
      let editor = null;
      let rows = [];

      const render = () => {
        const list = snipeLists.find(item => item.id === listSelect.value) || snipeLists[0];
        const assignments = assignTargets(targets, list);

        windowsBox.textContent = "";
        if (windows.length) {
          windowsBox.appendChild(el("div", "pt-muted pt-small", "Vensters uit de post (worden toegevoegd aan de lijst; vink uit wat je niet wilt):"));
        }
        editor = windowsEditor(windows, false);
        windowsBox.appendChild(editor.element);

        tableBox.textContent = "";
        const table = el("table", "pt-watch-table pt-stock-review");
        const head = el("tr");
        [["", "pt-col-check"], ["Uit de post", "pt-col-raw"], ["Speler", "pt-col-match"], ["Max BIN", "pt-col-league"], ["", "pt-col-status"]]
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
          status.title = !pick ? "Geen passende speler in deze lijst"
            : sure ? `Gekoppeld op ${pick.reason}` : "Twijfel: gekoppeld op prijsniveau, controleer de speler";
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
      const back = el("button", "pt-link-btn", "← Terug");
      const asNew = el("button", "pt-link-btn", "Toch als nieuwe spelerslijst →");
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
          message.textContent = "Niets geselecteerd om toe te passen.";
          return;
        }
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(apply, back, asNew, message);

      importPanel.append(
        el("div", "pt-stock-summary", `${targets.length} prijsdoel(en) gevonden. Koppeling op naam, of op vlag + prijs als de nationaliteit bekend is, anders op prijsniveau (controleer de oranje regels).`),
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
      profitLabelEl.append(el("span", "pt-stock-level-name", "Winst"), profit,
        el("span", "pt-muted", `% na 5% belasting, bij verkoop op de FUT Genie-prijs · leeg = ${DEFAULT_PROFIT}%`));
      // Holo snipe: the holo version of each card, for the normal card's price.
      let holoMode = false;
      const holoLabel = el("label", "pt-stock-level");
      const holoCheck = el("input");
      holoCheck.type = "checkbox";
      holoLabel.append(holoCheck, el("span", "pt-stock-level-name", "✨ Holo's"),
        el("span", "pt-muted", "op de prijs van de normale kaart (max BIN = Genie-prijs van de normale versie)"));
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
      [["", "pt-col-check"], ["Uit de tip", "pt-col-raw"], ["Herkend als", "pt-col-match"], ["Kaartversie · Genie (PC)", "pt-col-league"],
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
            if (special) versionSelect.appendChild(new Option(`Speciaal ${item.tipRating} · versie onbekend`, ""));
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
          statusCell.title = !player ? "Niet herkend / overgeslagen" : item.status === "sure" ? "Zeker" : "Twijfel: controleer of dit de juiste speler is";
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
          // No rating in the tip: the regular card, unless you pick another version.
          const pick = item.tipRating ? pickVersion(versions, item.tipRating, parsePrice(maxInput.value) || item.fitCoins)
            : versions.find(version => version.definitionId === player.id) || versions[0] || null;
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
              versionSelect.title = "Geen holo-versie van deze kaart gevonden";
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
      const save = el("button", "pt-watch-refresh", "Opslaan als snipe-lijst");
      const back = el("button", "pt-link-btn", "← Terug");
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
          message.textContent = "Kies minstens één speler.";
          return;
        }
        const price = player => player.fixedMax || (geniePrice(player.definitionId) || { price: 0 }).price;
        players.sort((a, b) => price(b) - price(a)); // higher cost cards first
        const profitValue = profit.value.trim() === "" ? null : Number(profit.value.replace(",", "."));
        getStock().unshift({
          id: `s${Date.now()}`,
          type: "players",
          name: nameInput.value.trim() || "Snipe-lijst",
          createdAt: Date.now(),
          profit: Number.isFinite(profitValue) ? profitValue : null,
          windows: windows.read(),
          players,
          holo: holoMode || players.some(player => player.holo),
          done: {}
        });
        saveStock();
        const added = addPlayersToWatch(players);
        showToast(`Snipe-lijst opgeslagen · ${added} speler(s) ook op de Spelers-tab gezet`, true);
        importPanel.style.display = "none";
      });
      actions.append(el("span", "pt-muted", "Naam"), nameInput, save, back, message);

      const recognised = parsed.players.filter(item => item.status === "sure").length;
      const doubtful = parsed.players.filter(item => item.status === "maybe").length;
      const summary = el("div", "pt-stock-summary", `${parsed.players.length} spelers gevonden · ${recognised} zeker · ${doubtful} twijfel (oranje)` +
        (parsed.skipped ? ` · ${parsed.skipped} regel(s) zonder speler overgeslagen` : "") + " · gewone kaart, duurste eerst. ");
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
      area.placeholder = "Plak hier het bericht, bijv.\n\nMLS\nChicago Fire\nLA Galaxy\n\nGolds <650-700\nSilvers <600-700";
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
        ideal.placeholder = "ideaal";
        [max, ideal].forEach(input => { input.inputMode = "numeric"; input.addEventListener("input", () => { check.checked = !!parsePrice(max.value); }); });
        box.append(check, el("span", "pt-stock-level-name", LEVEL_LABEL[level]), el("span", "pt-muted", "max"), max, el("span", "pt-muted", "ideaal"), ideal);
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
      flipBox.title = "Eerst zie je de markt (filter tot de max BIN hierboven). Vul de goedkoopste BIN in de balk in; " +
        "daarna wordt het filter markt min dit bedrag en zie je je verkoopprijzen.";
      flipBox.append(flipCheck, el("span", "pt-stock-level-name", "Lazy flip"), el("span", "pt-muted", "markt −"), flipUnder,
        el("span", "pt-muted", "verkoop +"), flipLow, el("span", "pt-muted", "tot +"), flipHigh);
      levelBox.appendChild(flipBox);

      // Clubs
      const table = el("table", "pt-watch-table pt-stock-review");
      const head = el("tr");
      [["", "pt-col-check"], ["Uit de tip", "pt-col-raw"], ["Herkend als", "pt-col-match"], ["Competitie", "pt-col-league"],
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
          statusCell.title = !club ? "Niet herkend / overgeslagen" : item.status === "sure" ? "Zeker" : "Twijfel: controleer of dit de juiste club is";
          return club;
        };
        select.addEventListener("change", () => { check.checked = !!select.value; item.status = select.value ? "sure" : "none"; row.className = `pt-match-${item.status}`; sync(); });
        const checkCell = el("td", "pt-col-check");
        checkCell.appendChild(check);
        const selectCell = el("td", "pt-col-match");
        selectCell.appendChild(select);
        // Tip with "SILVER OPTIONS" / "BRONZE OPTIONS" blocks: the club only gets its block's quality.
        const level = el("select", "pt-stock-select");
        level.appendChild(new Option("Alle", ""));
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
      const save = el("button", "pt-watch-refresh", "Opslaan als stock-lijst");
      const back = el("button", "pt-link-btn", "← Terug");
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
          message.textContent = "Kies minstens één club en één kwaliteit met een max BIN.";
          return;
        }
        const missing = LEVELS.filter(level => !levels[level].enabled && clubs.some(club => club.levels && club.levels.includes(level)));
        if (missing.length) {
          message.textContent = `Vul ook een max BIN in voor ${missing.map(level => LEVEL_LABEL[level]).join(" en ")}.`;
          return;
        }
        const under = parsePrice(flipUnder.value);
        const sellLow = parsePrice(flipLow.value);
        const flip = flipCheck.checked && under && sellLow
          ? { under, sellLow, sellHigh: Math.max(sellLow, parsePrice(flipHigh.value) || sellLow) }
          : null;
        getStock().unshift({ id: `s${Date.now()}`, name: nameInput.value.trim() || "Stock-lijst", createdAt: Date.now(), levels, clubs, done: {},
          ...(flip ? { flip, market: {} } : {}) });
        saveStock();
        importPanel.style.display = "none";
      });
      actions.append(el("span", "pt-muted", "Naam"), nameInput, save, back, message);

      const recognised = parsed.clubs.filter(item => item.status === "sure").length;
      const doubtful = parsed.clubs.filter(item => item.status === "maybe").length;
      const summary = el("div", "pt-stock-summary", `${parsed.clubs.length} clubs gevonden · ${recognised} zeker · ${doubtful} twijfel (oranje) · controleer en sla op. `);
      summary.appendChild(switchLink(true));
      importPanel.append(summary, levelBox, table, actions);
    }

    // Editor for one filter rule (review step and saved lists share it). Calls onChange after each edit.
    function filterRuleEditor(rule, onChange) {
      const box = el("div", "pt-filter-edit");

      const level = el("select", "pt-stock-select pt-mode-select");
      if (rule.kind === "manager") level.appendChild(new Option("Alle kwaliteiten", ""));
      LEVELS.forEach(value => level.appendChild(new Option(LEVEL_LABEL[value], value)));
      level.value = rule.level || "";
      level.addEventListener("change", () => { rule.level = level.value || null; onChange(); });

      const positions = el("input", "pt-target-input pt-filter-positions");
      positions.value = rule.positions.join("/");
      positions.placeholder = "alle posities";
      positions.title = "Posities, gescheiden door / (bijv. GK/LB/RB). Leeg = alle posities.";
      positions.addEventListener("change", () => {
        rule.positions = [...new Set((positions.value.toUpperCase().match(POSITION_WORD) || []))];
        positions.value = rule.positions.join("/");
        onChange();
      });

      const nation = el("select", "pt-stock-select pt-filter-nation");
      nation.appendChild(new Option("— alle landen —", ""));
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
        add.appendChild(new Option(rule.leagues.length ? "+ competitie" : "alle competities (+ kiezen)", ""));
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
          optionalLabel.title = "Aan = eerst in deze competitie(s) zoeken, daarna nog één keer zonder competitie (\"ideally prem\")";
          optionalLabel.append(optional, document.createTextNode(" ideaal, ook zonder"));
          leagues.appendChild(optionalLabel);
        }
      };
      drawLeagues();

      const max = el("input", "pt-target-input");
      const ideal = el("input", "pt-target-input");
      [max, ideal].forEach(input => { input.inputMode = "numeric"; });
      max.value = rule.max || "";
      max.placeholder = rule.priceNote === "discard" ? "quick-sell" : "max BIN";
      if (rule.priceNote === "discard") max.title = "\"At discard\": vul de quick-sell-waarde in (zie Snel verkopen bij zo'n manager in je club)";
      ideal.value = rule.ideal || "";
      ideal.placeholder = "ideaal";
      max.addEventListener("change", () => { rule.max = parsePrice(max.value); onChange(); });
      ideal.addEventListener("change", () => { rule.ideal = parsePrice(ideal.value); onChange(); });

      if (rule.kind === "manager") positions.style.display = "none";
      box.append(level, positions, nation, leagues, el("span", "pt-muted", "max"), max, el("span", "pt-muted", "ideaal"), ideal);
      return box;
    }

    function showFilterReviewStep(parsed) {
      importPanel.textContent = "";
      const rules = parsed.rules;
      const container = el("div", "pt-filter-review");
      const draw = () => {
        container.textContent = "";
        rules.forEach(rule => {
          const row = el("div", `pt-filter-rule pt-match-${rule.nation && rule.max ? "sure" : "maybe"}`);
          const head = el("label", "pt-filter-raw");
          const check = el("input");
          check.type = "checkbox";
          check.checked = rule.enabled !== false;
          check.addEventListener("change", () => { rule.enabled = check.checked; });
          head.append(check, el("span", "", ` ${rule.raw}`));
          const steps = el("div", "pt-muted pt-small");
          const updateSteps = () => {
            const count = filterSteps(rule).length;
            steps.textContent = `${count} zoekopdracht${count === 1 ? "" : "en"}: ` + filterSteps(rule).map(filterStepLabel).join(" · ") +
              (rule.unknown && rule.unknown.length ? ` · niet herkend: "${rule.unknown.join("\", \"")}"` : ""); +
              (rule.priceNote === "discard" && !rule.max ? " · ⚠ \"at discard\": vul de quick-sell-waarde in als max BIN" : "") +
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
      const save = el("button", "pt-watch-refresh", "Opslaan als filterlijst");
      const back = el("button", "pt-link-btn", "← Terug");
      [save, back].forEach(button => { button.type = "button"; });
      const message = el("span", "pt-muted");
      back.addEventListener("click", showPasteStep);
      save.addEventListener("click", () => {
        const chosen = rules.filter(rule => rule.enabled !== false && rule.max && (rule.nation || rule.leagues.length));
        if (!chosen.length) {
          message.textContent = "Kies minstens één regel met een land (of competitie) en een max BIN.";
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
      actions.append(el("span", "pt-muted", "Naam"), nameInput, save, back, message);

      const summary = el("div", "pt-stock-summary", `${rules.length} filterregel(s) gevonden · per positie en competitie wordt één transfermarkt-filter klaargezet (zoeken doe je zelf) · controleer en sla op.`);
      importPanel.append(summary);
      if (parsed.platform === "console" && userPlatform() === "pc") {
        importPanel.appendChild(el("div", "pt-stock-summary pt-loss", "⚠ Deze prijzen zijn voor console (@console). Op PC liggen ze vaak anders: pas max/ideaal zo nodig aan."));
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
        check.title = "Regel meenemen in de ronde";
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
          button.title = `${filterRuleTitle(rule)} · ${filterStepLabel(step)} · max BIN ${rule.max ? priceFormat.format(rule.max) : "—"} klaarzetten` +
            (done ? ` (eerder om ${formatTime(done)})` : "");
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
      const what = list.mode === "bid" ? "Max bod" : "Max BIN";
      [["Rating", "pt-col-name"], [what, "pt-col-target"], ["Ideaal", "pt-col-price"], ["", "pt-col-level"], ["Voorraad", "pt-col-stock"]]
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
          maxCell.appendChild(el("div", "pt-level-detail pt-outlook pt-muted", `winst vanaf verkoop ≥ ${priceFormat.format(roundUpToStep(fodder.max / (1 - EA_TAX)))}`));
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
        const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""), done ? "✓ klaargezet" : "🔍 klaarzetten");
        button.type = "button";
        button.title = `${fodder.rating}-rated goud · ${what.toLowerCase()} ${fodder.max ? priceFormat.format(fodder.max) : "—"} klaarzetten` + (done ? ` (eerder om ${formatTime(done)})` : "");
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
      [["Speler", "pt-col-name"], ["Rating", "pt-col-rating"], ["Genie (PC)", "pt-col-price"], ["Max BIN", "pt-col-target"], ["", "pt-col-level"], ["Voorraad", "pt-col-stock"]]
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
        maxInput.value = player.fixedMax || "";
        maxInput.placeholder = rule.max && !player.fixedMax ? `auto ${priceFormat.format(rule.max)}` : "auto";
        maxInput.title = `Leeg = automatisch (zodat verkoop op de FUT Genie-prijs ${profitFor(list)}% winst geeft na belasting). Vul een bedrag in om het vast te zetten.`;
        maxInput.addEventListener("change", () => { player.fixedMax = parsePrice(maxInput.value); saveStock(); });
        maxCell.appendChild(maxInput);
        const outlook = snipeOutlook(rule);
        if (outlook) {
          const line = el("div", "pt-level-detail pt-outlook");
          line.appendChild(el("span", "pt-muted", `winst vanaf ≥ ${priceFormat.format(outlook.breakEven)}`));
          if (outlook.atGenie !== null) {
            line.appendChild(el("span", outlook.atGenie > 0 ? "pt-profit" : "pt-loss",
              ` · ${outlook.atGenie > 0 ? "+" : ""}${priceFormat.format(outlook.atGenie)} op Genie`));
          }
          line.title = [
            `Kopen voor ${priceFormat.format(rule.max)}: je moet minimaal ${priceFormat.format(outlook.breakEven)} vragen om na 5% belasting quitte te spelen.`,
            outlook.atGenie !== null ? `Verkoop je op de huidige FUT Genie-prijs (${priceFormat.format(rule.genie.price)}), dan is dat ${outlook.atGenie > 0 ? "+" : ""}${priceFormat.format(outlook.atGenie)} na belasting.` : "",
            "Let op: de Genie-prijs kan achterlopen op de markt als prijzen snel bewegen."
          ].filter(Boolean).join("\n");
          maxCell.appendChild(line);
        }

        const done = list.done && list.done[rule.key];
        const current = active && run.index === index;
        const buttonCell = el("td", "pt-col-level");
        const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""), done ? "✓ klaargezet" : "🔍 klaarzetten");
        button.type = "button";
        button.title = `${player.name} · max BIN ${rule.max ? priceFormat.format(rule.max) : "—"} klaarzetten` + (done ? ` (eerder om ${formatTime(done)})` : "");
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
        lists.appendChild(el("div", "pt-watch-empty", "Nog geen stock-lijsten. Klik op \"+ Tip plakken\"."));
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
            ? `${list.rules.length} filterregels · ${rules.length} zoekopdrachten` + (list.platform === "console" ? " · prijzen uit een console-tip" : "") + ` · ${doneCount}/${rules.length} klaargezet`
            : isFodder
            ? `${rules.length} ratings · ${list.mode === "bid" ? "bieden (max bod)" : "direct kopen (max BIN)"} · ${doneCount}/${rules.length} klaargezet`
            : isPlayers
            ? `${list.players.length} spelers · winst ${profitLabel(list)} na belasting · ${doneCount}/${rules.length} klaargezet`
            : `${list.clubs.length} clubs · ${levels.map(level => `${LEVEL_LABEL[level]} ≤ ${priceFormat.format(list.levels[level].max)}`).join(" · ")}` +
              (list.flip ? ` · lazy flip: markt − ${priceFormat.format(list.flip.under)}, verkoop +${priceFormat.format(list.flip.sellLow)}–${priceFormat.format(list.flip.sellHigh)}` : "") +
              ` · ${doneCount}/${rules.length} klaargezet`)
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
            el("span", "", `📦 ${owned} kaarten · geïnvesteerd ${priceFormat.format(cost)}`),
            el("span", "pt-muted", " · netto bij verkoop nu (na 5% belasting): "),
            el("span", net > 0 ? "pt-profit" : net < 0 ? "pt-loss" : "", netValues.length ? `${net > 0 ? "+" : ""}${priceFormat.format(net)}` : "—"),
            el("span", "pt-muted", ` · bijgewerkt om ${formatTime(list.inventory.updatedAt)}`)
          );
        } else {
          stockLine.appendChild(el("span", "pt-muted", "📦 Nog geen voorraad geteld. Klik op \"Voorraad bijwerken\"."));
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
          mode.append(new Option("Bieden", "bid"), new Option("Direct kopen", "bin"));
          mode.value = list.mode === "bin" ? "bin" : "bid";
          mode.title = "Bieden zet het max bod-filter, direct kopen het max BIN-filter";
          mode.addEventListener("change", () => { list.mode = mode.value; saveStock(); });
          goalLabel.append(el("span", "pt-muted", "Zoeken op"), mode);
        } else if (isPlayers) {
          goal.placeholder = "auto";
          goal.value = Number.isFinite(list.profit) ? list.profit : "";
          goal.title = `Gewenste winst na 5% EA-belasting als je verkoopt op de FUT Genie-prijs (leeg = ${DEFAULT_PROFIT}%). Vaste max BIN per speler gaat altijd voor.`;
          goal.addEventListener("change", () => {
            const value = goal.value.trim() === "" ? null : Number(goal.value.replace(",", "."));
            list.profit = Number.isFinite(value) ? value : null;
            saveStock();
          });
          goalLabel.append(el("span", "pt-muted", "Winst %"), goal);
        } else {
          goal.placeholder = "—";
          goal.value = list.goal || "";
          goal.title = isFilters ? "Hoeveel kaarten je per filterregel wilt stocken" : "Hoeveel kaarten je per club en kwaliteit wilt stocken";
          goal.addEventListener("change", () => { list.goal = parsePrice(goal.value); saveStock(); });
          goalLabel.append(el("span", "pt-muted", isFilters ? "Doel per regel" : "Doel per vakje"), goal);
        }
        const inventory = el("button", "pt-watch-refresh", progress ? `📦 ${progress}` : "📦 Voorraad bijwerken");
        inventory.disabled = !!progress;
        inventory.title = isFodder
          ? "Telt je gewone gouden kaarten per rating in je club, transferlijst, unassigned en gewonnen transfer targets. Geen transfermarkt-zoekopdrachten."
          : isFilters
          ? "Telt per filterregel je kaarten (land, kwaliteit, competitie, positie) in je club, transferlijst, unassigned en gewonnen transfer targets. Geen transfermarkt-zoekopdrachten."
          : isPlayers
          ? "Zoekt deze spelers in je club, transferlijst, unassigned en gewonnen transfer targets (met korte pauzes). Geen transfermarkt-zoekopdrachten."
          : "Doorzoekt je club per club in deze lijst, plus transferlijst, unassigned en gewonnen transfer targets (met korte pauzes). Geen transfermarkt-zoekopdrachten.";
        inventory.addEventListener("click", () => updateInventory(list));
        const start = el("button", "pt-watch-refresh", active ? "▶ Verder" : doneCount ? "▶ Verder" : "▶ Start");
        const reset = el("button", "pt-link-btn", "↺ Reset");
        const remove = el("button", "pt-link-btn pt-danger", "Verwijderen");
        // Snipe lists: put the players on the Spelers tab (your max BIN as their target).
        const toWatch = el("button", "pt-link-btn", "➕ Naar Spelers");
        toWatch.title = "Zet deze spelers op de Spelers-tab, met de vaste max BIN als PC-instapdoel";
        toWatch.addEventListener("click", () => {
          const added = addPlayersToWatch(list.players);
          flashButton(toWatch, `✓ ${added} erbij`, true, "Op de Spelers-tab gezet", "➕ Naar Spelers", toWatch.title);
        });
        // Holo snipe: only holographic cards, max BIN = the normal card's FUT Genie price.
        const holo = el("button", "pt-link-btn" + (list.holo ? " pt-holo-on" : ""), list.holo ? "✨ Alleen holo: aan" : "✨ Alleen holo");
        holo.title = "Zoekt alleen holografische kaarten, met de prijs van de normale kaart (FUT Genie) als max BIN. " +
          "Zelfde extra zoekfilter als FUT Genie's \"Holographic only\"; die zit niet in EA's eigen app.";
        holo.addEventListener("click", () => {
          list.holo = !list.holo;
          if (list.holo) showToast("✨ Alleen holo staat aan. Let op: dit filter zit niet in EA's eigen app (FUT Genie waarschuwt er ook voor); gebruik het met mate.", true);
          saveStock();
        });
        [inventory, start, reset, remove, toWatch, holo].forEach(button => { button.type = "button"; });
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
            remove.textContent = "Verwijderen";
          }, 3000);
        });
        buttons.append(goalLabel, inventory, start, ...(isPlayers ? [toWatch] : []), ...(isPlayers && !list.fodderRating ? [holo] : []), reset, remove);
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
        head.append(el("th", "", "Club"), el("th", "", "Competitie"));
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
              : rule.market ? `${aboveTip ? "⚠ " : ""}koop ≤ ${priceFormat.format(rule.max)}` : "👀 markt";
            const button = el("button", "pt-level-btn" + (done ? " pt-done" : "") + (current ? " pt-current" : ""),
              `${done ? "✓ " : list.flip && !rule.market ? "" : "🔍 "}${label}`);
            button.type = "button";
            button.title = `${club.teamName} · ${LEVEL_LABEL[level]} · ` +
              (rule.max ? `max BIN ${priceFormat.format(rule.max)} klaarzetten` : "markt bekijken (zonder max BIN)") +
              (rule.market ? ` (markt ${priceFormat.format(rule.market.price)} om ${formatTime(rule.market.at)})` : "") +
              (aboveTip ? ` – boven de tip (≤ ${priceFormat.format(rule.ceiling)})` : "") +
              (done ? ` (eerder klaargezet om ${formatTime(done)})` : "");
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
    button.title = watched ? "Klik om uit je Price Watch te halen" : "Voeg deze kaart toe aan je Price Watch";
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
            rarity: current.rareflag
          });
        }
        watchButtonState(button, current);
      });
      const group = root.querySelector(".ut-button-group") || root;
      group.appendChild(button);
    }
    button.__ptItem = item;
    watchButtonState(button, item);
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
          console.warn("Price Watch: knop toevoegen mislukt.", error);
        }
        return result;
      };
      hooked.__ptWatchHooked = true;
      Panel.prototype[method] = hooked;
    });
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
/* Page: dark card on top of EA's bright background, never wider than the viewport. */
.pt-watch-view {
  box-sizing: border-box;
  width: 100%;
  min-height: 100%;
  padding: 24px;
  overflow-y: auto;
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
.pt-watch-table .pt-col-rarity   { width: 19%; }
.pt-watch-table .pt-col-price    { width: 13%; text-align: right; }
.pt-watch-table .pt-col-target   { width: 14%; padding-left: 24px; }
.pt-watch-table .pt-col-distance { width: 16%; text-align: right; }
.pt-watch-table .pt-col-remove   { width: 4%; text-align: right; }

.pt-watch-table td.pt-col-rating { font-weight: 700; }
.pt-watch-table td.pt-col-rarity { color: #aab5c5; }
.pt-watch-table td.pt-col-price  { font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; }
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
    const OUR_AREAS = ".pt-watch-view, .pt-run-bar, .pt-toast, .pt-watch-add, .pt-picker";
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
      target.click();
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
      lowerClickShield();
      if (Date.now() - lastBlockReport < 5000) return;
      lastBlockReport = Date.now();
      const name = `${hit.tagName.toLowerCase()}${hit.className && typeof hit.className === "string" ? "." + hit.className.trim().split(/\s+/).join(".") : ""}`;
      showToast(`Tik geblokkeerd door ${name} – opgeruimd, probeer opnieuw`, false);
    }, true);
  }

  // On the phone (no console to look at) say what's happening: loaded, tab added, or what failed.
  const startedAt = Date.now();
  let tabReported = false;
  let waitReported = false;
  function report(text, ok) {
    if (IS_PHONE && !tabReported) showToast(`Price Watch v${SCRIPT_VERSION}: ${text}`, ok);
  }
  report("geladen, wacht op de web app…", true);

  function tick() {
    // Pc with FUT Genie: prices to the gist (and target pushes) also while EA isn't logged in, e.g. after a
    // refresh once you're playing the game. Genie gets its prices from its own server, not from EA.
    if (!relayStarted && genie()) {
      addStyles();
      startRelay();
    }
    if (!appReady()) {
      if (Date.now() - startedAt > 45000 && !waitReported) {
        report("EA-app nog niet gevonden (nog niet ingelogd?)", false);
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
          `${getComputedStyle(tabNode).display}, in ${parent ? parent.className : "?"}: ${siblings}). Staat Paletools aan? Dat tekent de balk opnieuw.`, false);
        waitReported = true;
      }
      if (installed && visible && !tabReported) {
        report("tab \"Watch\" staat onderin na Transfers", true);
        tabReported = true;
      } else if (installed && !visible && !waitReported && Date.now() - startedAt > 20000) {
        // Diagnose for the phone: what is in the bottom bar instead?
        const bar = [...document.querySelectorAll(".ut-tab-bar-item, nav button")]
          .map(button => button.textContent.trim()).filter(Boolean).join(", ");
        report(`tab gemaakt maar niet zichtbaar. Balk: ${bar || "?"}`, false);
        waitReported = true;
      } else if (!installed && !waitReported && Date.now() - startedAt > 60000) {
        report("tabbalk van de app niet gevonden", false);
        waitReported = true;
      }
    } catch (error) {
      console.warn("Price Watch: tab toevoegen mislukt.", error);
      if (!tabReported && Date.now() - startedAt > 45000) {
        report(`tab toevoegen mislukt – ${error.message}`, false);
        tabReported = true;
      }
    }
    if (!migrated && findTabBarController()) {
      migrated = true;
      renderRunBar(); // resume a stock run after a page refresh
      installMarketWatch();
      installMinBidWrap();
      installListingWatch();
      importPendingTransfer();
      // Pc: send list + prices to the gist every 5 min. Phone: read them every 2 min.
      startRelay();
      migrateFromPaletools().catch(error => console.warn("Price Watch: overnemen uit Paletools mislukt.", error));
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
    if (typeof GM_setValue !== "function") throw new Error("Tampermonkey-opslag niet beschikbaar");
    if (value == null && typeof GM_deleteValue === "function") GM_deleteValue(key);
    else GM_setValue(key, value);
  }

  function request(method, url, body, headers) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("Tampermonkey staat geen verzoeken toe (GM_xmlhttpRequest ontbreekt)"));
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
        onerror: () => reject(new Error("GitHub niet bereikbaar")),
        ontimeout: () => reject(new Error("GitHub antwoordt niet (time-out)"))
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
        onerror: () => reject(new Error("ntfy.sh niet bereikbaar")),
        ontimeout: () => reject(new Error("ntfy.sh antwoordt niet (time-out)"))
      });
    });
  }

  function githubError(response) {
    const message = response.json && response.json.message;
    if (response.status === 401) return "token ongeldig of verlopen";
    if (response.status === 404) return "gist niet gevonden (of token mist het recht \"gist\")";
    if (response.status === 403 && /rate limit/i.test(message || "")) return "te veel verzoeken bij GitHub, even wachten";
    return `${response.status}${message ? ` ${message}` : ""}`;
  }

  const auth = token => ({ Authorization: `Bearer ${token}` });
  const gistUrl = gistId => `https://api.github.com/gists/${encodeURIComponent(gistId)}`;

  async function setToken(token, gistId) {
    if (!/^(ghp_|github_pat_)\w+$/.test(token || "")) throw new Error("Dat lijkt geen GitHub-token (begint met ghp_ of github_pat_)");
    const response = await request("GET", gistUrl(gistId), undefined, auth(token));
    if (response.status !== 200) throw new Error(`Token werkt niet met deze gist: ${githubError(response)}`);
    setValue(TOKEN_KEY, token);
  }

  async function push(gistId, file, content) {
    const token = getValue(TOKEN_KEY);
    if (!token) throw new Error("geen token op dit apparaat");
    const response = await request("PATCH", gistUrl(gistId), { files: { [file]: { content } } },
      { ...auth(token), "Content-Type": "application/json" });
    if (response.status !== 200) throw new Error(`versturen mislukt: ${githubError(response)}`);
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
      throw new Error(`ophalen mislukt: ${githubError(raw)}`);
    }
    const rawUrl = rawBase(getValue(RAW_KEY));
    if (response.status === 403 && rawUrl) {
      const raw = await request("GET", `${rawUrl}${encodeURIComponent(file)}?t=${Date.now()}`);
      if (raw.status === 200) return raw.text;
    }
    throw new Error(`ophalen mislukt: ${githubError(response)}`);
  }

  // Pc → phone: the token as a QR code linking to "…/web-app/#pwt=TOKEN&pwg=GIST". Drawn here into the
  // page's empty box, so the token doesn't pass through the page's events.
  function drawTokenQr(targetId, base, gistId) {
    const token = getValue(TOKEN_KEY);
    if (!token) throw new Error("geen token op deze pc");
    if (typeof qrcode !== "function") throw new Error("QR-bibliotheek niet geladen");
    const box = document.getElementById(targetId);
    if (!box || !/^https:\/\/www\.(ea|easports)\.com\//.test(base || "")) throw new Error("onbekende pagina");
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
    (gistId ? setToken(tokenLink[1], gistId) : Promise.reject(new Error("geen gist in de link"))).then(() => tell({ ok: true, gistId }), error => tell({ ok: false, error: error.message }));
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
        if (topic && !NTFY_TOPIC.test(topic)) throw new Error("topic: 8–64 tekens, alleen letters, cijfers, - en _");
        setValue(NTFY_KEY, topic || null);
        return { topic };
      }
      case "notify":
        return notify(message.title, message.text);
      default:
        throw new Error(`onbekend verzoek ${message.type}`);
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

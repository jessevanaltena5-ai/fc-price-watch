// ==UserScript==
// @name         Paletools Price Tracker Plus
// @namespace    local.paletools.price-tracker-plus
// @version      7.2.0
// @description  Price Tracker met tabellen onder elkaar, FUT Genie-prijzen, PC-instapdoel, afstand met kleurcodering en sortering, kopieerknop en transfermarkt-knop (vult alleen filters in).
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.easports.com/*ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "pt_price_tracker_targets_v2";
  const SORT_KEY = "pt_price_tracker_sort_v1";
  const STYLE_ID = "pt-price-tracker-plus-style";
  const APP_GUARD = "__ptPriceTrackerPlus";
  const NEAR_PERCENT = 3;
  const GENIE_REFRESH_MS = 5 * 60 * 1000;
  const GENIE_TIMEOUT_MS = 15 * 1000;

  if (window[APP_GUARD]) return;
  window[APP_GUARD] = true;

  let scheduled = false;

  // ---------------------------------------------------------------------------
  // Targets (in-memory cache, persisted in localStorage)
  // ---------------------------------------------------------------------------

  let targetsCache = null;

  function getTargets() {
    if (targetsCache) return targetsCache;
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      targetsCache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      targetsCache = {};
    }
    return targetsCache;
  }

  function saveTargets() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(getTargets()));
    } catch (error) {
      console.warn("Price Tracker Plus: instapdoelen konden niet worden opgeslagen.", error);
    }
  }

  // Another tab changed the targets: drop the cache and refresh.
  window.addEventListener("storage", event => {
    if (event.key !== STORAGE_KEY) return;
    targetsCache = null;
    document.querySelectorAll(".pt-target-input").forEach(input => { input.dataset.ptValueLoaded = ""; });
    scheduleEnhance();
  });

  function normalizeKey(value) {
    return String(value || "")
      .replace(/[📋🔍✓!⚠️]/gu, "")
      .replace(/\s+/g, " ")
      .replace(/\s*\|\s*/g, "|")
      .trim()
      .toLowerCase();
  }

  function getOrMigrateTarget(key) {
    const targets = getTargets();
    if (Number.isFinite(targets[key])) return targets[key];

    const normalized = normalizeKey(key);
    for (const [oldKey, value] of Object.entries(targets)) {
      if (Number.isFinite(value) && normalizeKey(oldKey) === normalized) {
        targets[key] = value;
        if (oldKey !== key) delete targets[oldKey];
        saveTargets();
        return value;
      }
    }
    return null;
  }

  function setTarget(key, target) {
    const targets = getTargets();
    if (target !== null) {
      if (targets[key] === target) return;
      targets[key] = target;
    } else {
      if (!Object.prototype.hasOwnProperty.call(targets, key)) return;
      delete targets[key];
    }
    saveTargets();
  }

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

  function directCells(row) {
    return [...row.children].filter(element => element.tagName === "TD");
  }

  function visibleCellText(cell) {
    if (!cell) return "";
    const title = cell.getAttribute("title");
    if (title && title.trim()) return title.trim();

    const clone = cell.cloneNode(true);
    clone.querySelectorAll("button, input").forEach(el => el.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function playerName(row) {
    return visibleCellText(directCells(row)[0]);
  }

  function playerKey(row) {
    const cells = directCells(row);
    return [visibleCellText(cells[0]), visibleCellText(cells[1]), visibleCellText(cells[2])]
      .join("|")
      .toLowerCase();
  }

  function makeButton(className, icon, title, onClick) {
    const button = document.createElement("button");
    button.className = `pt-icon-btn ${className}`;
    button.type = "button";
    button.textContent = icon;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event, button);
    });
    return button;
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
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
/* Keep Paletools' original tables intact and stack them vertically. */
.price-tracker-table {
  display: flex !important;
  flex-direction: column !important;
  align-items: stretch !important;
  justify-content: flex-start !important;
  gap: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
}

.price-tracker-table > table {
  display: table !important;
  flex: 0 0 auto !important;
  width: 100% !important;
  min-width: 100% !important;
  max-width: 100% !important;
  table-layout: fixed !important;
  border-collapse: collapse !important;
  border-spacing: 0 !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
}

/* Hide only the repeated header, not any player rows. */
.price-tracker-table > table:not(:first-of-type) > thead {
  display: none !important;
}

/* Eight columns: Player, Rating, Rarity, Price, remove (X), Genie, PC target, Distance. */
.price-tracker-table > table th:nth-child(1),
.price-tracker-table > table td:nth-child(1) { width: 24% !important; }
.price-tracker-table > table th:nth-child(2),
.price-tracker-table > table td:nth-child(2) { width: 5% !important; }
.price-tracker-table > table th:nth-child(3),
.price-tracker-table > table td:nth-child(3) { width: 28% !important; }
.price-tracker-table > table th:nth-child(4),
.price-tracker-table > table td:nth-child(4) { width: 9% !important; }
.price-tracker-table > table th:nth-child(5),
.price-tracker-table > table td:nth-child(5) { width: 2% !important; }
.price-tracker-table > table th:nth-child(6),
.price-tracker-table > table td:nth-child(6) { width: 10% !important; }
.price-tracker-table > table th:nth-child(7),
.price-tracker-table > table td:nth-child(7) { width: 10% !important; }
.price-tracker-table > table th:nth-child(8),
.price-tracker-table > table td:nth-child(8) { width: 12% !important; }

.price-tracker-table > table td.pt-distance-cell { min-width: 160px !important; }

.price-tracker-table > table th,
.price-tracker-table > table td {
  box-sizing: border-box !important;
  vertical-align: middle !important;
}

.price-tracker-table .pt-target-header,
.price-tracker-table .pt-target-cell {
  white-space: nowrap !important;
}

.price-tracker-table .pt-target-header-distance {
  cursor: pointer;
  user-select: none;
}

.price-tracker-table .pt-target-header-distance:hover,
.price-tracker-table .pt-target-header-distance.pt-sorted {
  color: #63b3ff;
}

.price-tracker-table .pt-target-header-distance::after {
  content: " ⇅";
  opacity: .5;
}

.price-tracker-table .pt-target-header-distance.pt-sorted::after {
  content: " ▲";
  opacity: 1;
}

.price-tracker-table .pt-target-header-genie {
  cursor: pointer;
  user-select: none;
}

.price-tracker-table .pt-target-header-genie:hover { color: #63b3ff; }
.price-tracker-table .pt-target-header-genie::after { content: " ↻"; opacity: .5; }
.price-tracker-table .pt-target-header-genie.pt-loading::after { content: " …"; opacity: 1; }

.price-tracker-table .pt-genie {
  font-variant-numeric: tabular-nums;
  color: #e5e7eb;
}

.price-tracker-table .pt-genie.pt-missing { opacity: .45; }

.price-tracker-table .pt-target-cell {
  overflow: visible !important;
}

.price-tracker-table .pt-target-input {
  display: inline-block !important;
  width: 110px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 5px 6px;
  border: 1px solid #657080;
  border-radius: 4px;
  background: #101720;
  color: inherit;
  font: inherit;
}

.price-tracker-table .pt-distance {
  display: inline-block !important;
  min-width: 100px;
  white-space: nowrap !important;
  font-variant-numeric: tabular-nums;
  color: #e5e7eb;
}

.price-tracker-table .pt-distance.pt-hit  { color: #27d98b !important; font-weight: 700 !important; }
.price-tracker-table .pt-distance.pt-near { color: #f3c969 !important; font-weight: 700 !important; }
.price-tracker-table .pt-distance.pt-far  { color: #ff7070 !important; font-weight: 600 !important; }

.price-tracker-table .pt-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 2px 5px;
  cursor: pointer;
  background: transparent;
  border: 1px solid #657080;
  border-radius: 4px;
  color: #63b3ff;
  font-size: 12px;
  line-height: 1.4;
  vertical-align: middle;
}

.price-tracker-table .pt-icon-btn + .pt-icon-btn { margin-left: 4px; }

.price-tracker-table .pt-icon-btn:hover { color: #fff; border-color: #63b3ff; }
.price-tracker-table .pt-transfer-search:hover { border-color: #27d98b; background: rgba(39, 217, 139, .12); }
.price-tracker-table .pt-icon-btn.pt-ok    { color: #27d98b; border-color: #27d98b; }
.price-tracker-table .pt-icon-btn.pt-error { color: #ff7070; border-color: #ff7070; }
`;

  function addStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== CSS) style.textContent = CSS;
  }

  // ---------------------------------------------------------------------------
  // Copy button
  // ---------------------------------------------------------------------------

  const COPY_TITLE = "Kopieer spelersnaam";

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

  async function onCopy(row, button) {
    const name = playerName(row);
    const copied = await copyText(name);
    flashButton(button, copied ? "✓" : "!", copied,
      copied ? `Gekopieerd: ${name}` : "Kopiëren mislukt; kopieer de naam handmatig",
      "📋", COPY_TITLE);
  }

  // ---------------------------------------------------------------------------
  // Transfer market button: prepares the filters only, never runs a search
  // ---------------------------------------------------------------------------

  const SEARCH_TITLE = "Transfermarkt voorbereiden: speler + rarity + max BIN = instapdoel (Shift+klik: zonder max BIN). Zoeken doe je zelf.";

  // Paletools stores tracked cards in IndexedDB "paletools" / "priceTracker".
  let trackerCache = null;
  let trackerCacheAt = 0;

  function readTracker() {
    if (trackerCache && Date.now() - trackerCacheAt < 5000) return Promise.resolve(trackerCache);
    return new Promise(resolve => {
      const request = indexedDB.open("paletools");
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("priceTracker")) {
          db.close();
          resolve([]);
          return;
        }
        const query = db.transaction("priceTracker").objectStore("priceTracker").getAll();
        query.onsuccess = () => {
          trackerCache = query.result || [];
          trackerCacheAt = Date.now();
          db.close();
          resolve(trackerCache);
        };
        query.onerror = () => {
          db.close();
          resolve([]);
        };
      };
    });
  }

  // Match on name + rating; identical cards are resolved by their original Paletools order.
  async function findTrackedCard(row) {
    const sameCard = r => {
      const cells = directCells(r);
      return [visibleCellText(cells[0]).toLowerCase(), parseInt(visibleCellText(cells[1]), 10)];
    };
    const [name, rating] = sameCard(row);
    const matches = (await readTracker()).filter(card =>
      String(card.name || "").trim().toLowerCase() === name && (!rating || card.rating === rating)
    );
    if (matches.length <= 1) return matches[0] || null;

    const origin = r => (r.__ptOrigin ? r.__ptOrigin.index : 0);
    const twins = [...row.closest(".price-tracker-table").querySelectorAll("tbody tr")]
      .filter(r => { const [n, rt] = sameCard(r); return n === name && rt === rating; })
      .sort((a, b) => origin(a) - origin(b));
    return matches[twins.indexOf(row)] || matches[0];
  }

  // Resolve each row's definitionId once (needed for FUT Genie prices).
  function resolveDefId(row) {
    if (row.__ptDefId !== undefined || row.__ptDefIdPending) return;
    row.__ptDefIdPending = true;
    findTrackedCard(row).then(card => {
      row.__ptDefId = card ? card.definitionId : null;
      row.__ptDefIdPending = false;
      scheduleEnhance();
    });
  }

  function openPreparedSearch(card, maxBuy) {
    const baseId = card.definitionId & 0xFFFFFF;

    const root = getAppMain().getRootViewController();
    root.setGameViewTab(UTGameTabBarController.TabTag.TRANSFERS);
    let nav = root.getPresentedViewController();
    if (nav instanceof UTTabBarController) nav = nav.getCurrentViewController();
    if (!(nav instanceof UTNavigationController)) throw new Error("Transfers-navigatie niet gevonden");

    const criteria = new UTSearchCriteriaDTO();
    criteria.type = SearchType.PLAYER;
    criteria.category = SearchCategory.ANY;
    criteria.maskedDefId = baseId;
    if (card.rarity != null) criteria.rarities = [card.rarity];
    if (maxBuy) criteria.maxBuy = maxBuy;

    const controller = new UTMarketSearchFiltersViewController();
    controller.initWithSearchCriteria(criteria);
    const playerData = repositories.Item.getStaticDataByDefId(baseId);
    if (playerData) controller.viewmodel.setPlayerData(playerData);
    nav.pushViewController(controller);
  }

  async function onTransferSearch(row, button, event) {
    try {
      const card = await findTrackedCard(row);
      if (!card) {
        flashButton(button, "⚠️", false, "Speler niet gevonden in de Paletools Price Tracker", "🔍", SEARCH_TITLE);
        return;
      }
      const input = row.querySelector(".pt-target-input");
      const maxBuy = event.shiftKey ? null : parsePrice(input && input.value);
      openPreparedSearch(card, maxBuy);
    } catch (error) {
      console.error("Price Tracker Plus:", error);
      flashButton(button, "⚠️", false, `Fout: ${error.message}`, "🔍", SEARCH_TITLE);
    }
  }

  function addRowButtons(row) {
    const nameCell = directCells(row)[0];
    if (!nameCell) return;

    if (!nameCell.querySelector(".pt-copy-name")) {
      nameCell.appendChild(makeButton("pt-copy-name", "📋", COPY_TITLE, (_, button) => onCopy(row, button)));
    }
    if (!nameCell.querySelector(".pt-transfer-search")) {
      nameCell.appendChild(makeButton("pt-transfer-search", "🔍", SEARCH_TITLE,
        (event, button) => onTransferSearch(row, button, event)));
    }
  }

  // ---------------------------------------------------------------------------
  // FUT Genie prices (via the FUT Genie extension; no EA market searches)
  // ---------------------------------------------------------------------------

  let genieRequestedAt = 0;
  let genieLoading = false;

  function genie() {
    const g = window.FutGenie;
    return g && typeof g.fetchBulkPrices === "function" ? g : null;
  }

  function geniePrice(defId) {
    const g = genie();
    const entry = g && defId && g._cachedPrices ? g._cachedPrices[defId] : null;
    return entry && entry.price > 0 ? entry : null;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }

  function refreshGeniePrices(rows, force) {
    const g = genie();
    if (!g || genieLoading) return;
    if (!force && Date.now() - genieRequestedAt < GENIE_REFRESH_MS) return;

    const ids = [...new Set(rows.map(row => row.__ptDefId).filter(Boolean))];
    if (!ids.length) return;

    const startedAt = Date.now();
    genieRequestedAt = startedAt;
    genieLoading = true;
    try {
      g.fetchBulkPrices(ids);
    } catch (error) {
      console.warn("Price Tracker Plus: FUT Genie-prijzen ophalen mislukt.", error);
      genieLoading = false;
      return;
    }
    scheduleEnhance();

    // FUT Genie answers asynchronously into its own cache; wait until every price is fresh.
    const poll = window.setInterval(() => {
      const done = ids.every(id => {
        const entry = g._cachedPrices && g._cachedPrices[id];
        return entry && Number(entry._fetchedAt) >= startedAt;
      });
      if (!done && Date.now() - startedAt < GENIE_TIMEOUT_MS) return;
      window.clearInterval(poll);
      genieLoading = false;
      scheduleEnhance();
    }, 300);
  }

  function allTrackerRows() {
    return getTrackerTables().flatMap(table => [...table.querySelectorAll("tbody tr")]);
  }

  function bindGenieHeader(header) {
    if (!header) return;
    header.classList.toggle("pt-loading", genieLoading);
    const title = !genie()
      ? "FUT Genie is niet geladen; Afstand gebruikt de Paletools-prijs"
      : genieRequestedAt
        ? `FUT Genie-prijzen (PC), opgehaald om ${formatTime(genieRequestedAt)}. Klik om te verversen.`
        : "FUT Genie-prijzen (PC). Klik om te verversen.";
    if (header.title !== title) header.title = title;
    if (header.dataset.ptGenieBound === "1") return;
    header.dataset.ptGenieBound = "1";
    header.addEventListener("click", () => refreshGeniePrices(allTrackerRows(), true));
  }

  // ---------------------------------------------------------------------------
  // Genie + target + distance columns
  // ---------------------------------------------------------------------------

  function getTrackerTables() {
    const tables = new Set();
    document.querySelectorAll(".price-tracker-table").forEach(container => {
      if (container.tagName === "TABLE") tables.add(container);
      else [...container.children].forEach(child => { if (child.tagName === "TABLE") tables.add(child); });
    });
    return [...tables];
  }

  function ensureHeader(headerRow, label, markerClass) {
    const wanted = label.toLowerCase();
    const existing = [...headerRow.children].find(cell =>
      cell.classList.contains(markerClass) ||
      (cell.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === wanted
    );

    if (existing) {
      existing.classList.add("pt-target-header", markerClass);
      if ((existing.textContent || "").trim() !== label) existing.textContent = label;
      return;
    }

    const th = document.createElement("th");
    th.className = `pt-target-header ${markerClass}`;
    th.scope = "col";
    th.textContent = label;
    headerRow.appendChild(th);
  }

  function priceColumnIndex(headerRow) {
    const index = headerRow ? [...headerRow.children].findIndex(cell => {
      const label = (cell.textContent || "").trim().toLowerCase();
      return label.includes("price") && !label.includes("instapdoel") && !label.includes("afstand");
    }) : -1;
    return index >= 0 ? index : 3;
  }

  function getOrCreateTargetCell(row) {
    let cell = directCells(row).find(td =>
      td.classList.contains("pt-target-value-cell") || td.querySelector(".pt-target-input")
    );
    if (!cell) cell = document.createElement("td");
    cell.classList.add("pt-target-cell", "pt-target-value-cell");

    let input = cell.querySelector(".pt-target-input");
    if (!input) {
      input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.className = "pt-target-input";
      input.placeholder = "Bijv. 50000";
      input.setAttribute("aria-label", `PC-instapdoel ${playerName(row)}`);
      cell.appendChild(input);
    }
    return { cell, input };
  }

  function getOrCreateDistanceCell(row) {
    let cell = directCells(row).find(td =>
      td.classList.contains("pt-distance-cell") || td.querySelector(".pt-distance")
    );
    if (!cell) cell = document.createElement("td");
    cell.classList.add("pt-target-cell", "pt-distance-cell");

    let span = cell.querySelector(".pt-distance");
    if (!span) {
      span = document.createElement("span");
      span.className = "pt-distance";
      cell.appendChild(span);
    }
    return { cell, span };
  }

  function getOrCreateGenieCell(row) {
    let cell = directCells(row).find(td => td.classList.contains("pt-genie-cell"));
    if (!cell) cell = document.createElement("td");
    cell.classList.add("pt-target-cell", "pt-genie-cell");

    let span = cell.querySelector(".pt-genie");
    if (!span) {
      span = document.createElement("span");
      span.className = "pt-genie";
      cell.appendChild(span);
    }
    return { cell, span };
  }

  // Keep our own cells/headers at the end, in this order, moving them only when needed.
  function ensureTrailingOrder(parent, elements) {
    const tail = [...parent.children].slice(-elements.length);
    if (elements.every((element, i) => tail[i] === element)) return;
    elements.forEach(element => parent.appendChild(element));
  }

  function renderGenie(span, defId) {
    const entry = geniePrice(defId);
    let text = "—";
    let className = "pt-genie pt-missing";
    let title = genie() ? "Nog geen FUT Genie-prijs voor deze kaart" : "FUT Genie is niet geladen";
    if (entry) {
      text = priceFormat.format(entry.price);
      className = "pt-genie";
      title = `FUT Genie (PC), opgehaald om ${formatTime(Number(entry._fetchedAt) || Date.now())}`;
    }
    if (span.textContent !== text) span.textContent = text;
    if (span.className !== className) span.className = className;
    if (span.title !== title) span.title = title;
    return entry ? entry.price : null;
  }

  function distanceState(target, current, source) {
    if (target === null || current === null) {
      return { percent: null, text: "—", className: "pt-distance", title: "Vul een PC-instapdoel in om de afstand te berekenen" };
    }

    const delta = current - target;
    const percent = (delta / target) * 100;
    const sign = delta > 0 ? "+" : "";
    const text = `${sign}${priceFormat.format(delta)} (${sign}${percent.toFixed(1)}%)`;
    const via = ` (prijs: ${source})`;

    if (delta <= 0) {
      return { percent, text, className: "pt-distance pt-hit", title: `Instapdoel bereikt: huidige prijs is op of onder je doelprijs${via}` };
    }
    if (percent <= NEAR_PERCENT) {
      return { percent, text, className: "pt-distance pt-near", title: `Bijna op je instapdoel: maximaal ${NEAR_PERCENT}% erboven${via}` };
    }
    return { percent, text, className: "pt-distance pt-far", title: `Huidige prijs ligt meer dan ${NEAR_PERCENT}% boven je instapdoel${via}` };
  }

  function enhanceRow(row, priceIndex) {
    addRowButtons(row);
    resolveDefId(row);

    const cells = directCells(row);
    if (cells.length < 4) return;
    const priceCell = cells[priceIndex] || cells[3];

    const { cell: genieCell, span: genieSpan } = getOrCreateGenieCell(row);
    const { cell: targetCell, input } = getOrCreateTargetCell(row);
    const { cell: distanceCell, span: distance } = getOrCreateDistanceCell(row);
    ensureTrailingOrder(row, [genieCell, targetCell, distanceCell]);

    const key = playerKey(row);

    // Restore a saved value (migrating keys written by older versions).
    if (input.dataset.ptValueLoaded !== "1") {
      const saved = getOrMigrateTarget(key);
      if (saved !== null && !input.value.trim()) input.value = String(saved);
      input.dataset.ptValueLoaded = "1";
    }

    const update = () => {
      const target = parsePrice(input.value);
      setTarget(key, target);

      // Prefer the (fresher) FUT Genie price; fall back to Paletools.
      const geniePriceValue = renderGenie(genieSpan, row.__ptDefId);
      const state = geniePriceValue !== null
        ? distanceState(target, geniePriceValue, "FUT Genie")
        : distanceState(target, parsePrice(priceCell.textContent), "Paletools");
      row.__ptPercent = state.percent;
      // Only touch the DOM when something changed, to avoid observer loops.
      if (distance.textContent !== state.text) distance.textContent = state.text;
      if (distance.className !== state.className) distance.className = state.className;
      if (distance.title !== state.title) distance.title = state.title;
    };

    input.oninput = update;
    // Re-sort once editing is done (sorting while typing would steal focus).
    input.onchange = () => {
      update();
      scheduleEnhance();
    };
    row.dataset.ptTargetEnhanced = "1";
    update();
  }

  function enhanceTable(table) {
    const headerRow = table.querySelector("thead tr");
    if (headerRow) {
      ensureHeader(headerRow, "Genie", "pt-target-header-genie");
      ensureHeader(headerRow, "PC-instapdoel", "pt-target-header-target");
      ensureHeader(headerRow, "Afstand", "pt-target-header-distance");
      ensureTrailingOrder(headerRow, [
        headerRow.querySelector(".pt-target-header-genie"),
        headerRow.querySelector(".pt-target-header-target"),
        headerRow.querySelector(".pt-target-header-distance")
      ]);
      bindGenieHeader(headerRow.querySelector(".pt-target-header-genie"));
      bindSortHeader(headerRow.querySelector(".pt-target-header-distance"));
    }
    // Repeated (hidden) tables have no visible header; use the first table's columns.
    const firstHeader = document.querySelector(".price-tracker-table thead tr");
    const priceIndex = priceColumnIndex(headerRow || firstHeader);
    table.querySelectorAll("tbody tr").forEach(row => enhanceRow(row, priceIndex));
  }

  // ---------------------------------------------------------------------------
  // Sorting by distance (toggle by clicking the "Afstand" header)
  // ---------------------------------------------------------------------------

  let sortByDistance = (() => {
    try {
      return localStorage.getItem(SORT_KEY) === "distance";
    } catch {
      return false;
    }
  })();
  let rowCounter = 0;

  function bindSortHeader(header) {
    if (!header) return;
    header.classList.toggle("pt-sorted", sortByDistance);
    header.title = sortByDistance
      ? "Gesorteerd op afstand tot je instapdoel (klik: Paletools-volgorde)"
      : "Klik om te sorteren op afstand tot je instapdoel";
    if (header.dataset.ptSortBound === "1") return;
    header.dataset.ptSortBound = "1";
    header.addEventListener("click", () => {
      sortByDistance = !sortByDistance;
      try {
        localStorage.setItem(SORT_KEY, sortByDistance ? "distance" : "");
      } catch (_) {
        // Sorting still works for this session.
      }
      scheduleEnhance();
    });
  }

  // Remember each row's original Paletools position so sorting can be undone.
  function rememberOrigin(row) {
    if (row.__ptOrigin) return;
    row.__ptOrigin = { tbody: row.parentElement, index: rowCounter++ };
  }

  function placeRows(tbody, rows) {
    const current = [...tbody.children];
    if (current.length === rows.length && rows.every((row, i) => current[i] === row)) return;
    rows.forEach(row => tbody.appendChild(row));
  }

  function applySort(tables) {
    // Moving a row would blur the input you are typing in.
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains("pt-target-input")) return;

    const tbodies = tables.map(table => table.tBodies[0]).filter(Boolean);
    if (!tbodies.length) return;
    const rows = tbodies.flatMap(tbody => [...tbody.rows]);
    rows.forEach(rememberOrigin);
    const byOrigin = (a, b) => a.__ptOrigin.index - b.__ptOrigin.index;

    if (sortByDistance) {
      // Closest to (or furthest below) the target first; rows without a target last.
      const rank = row => (row.__ptPercent == null ? Infinity : row.__ptPercent);
      placeRows(tbodies[0], [...rows].sort((a, b) => rank(a) - rank(b) || byOrigin(a, b)));
      return;
    }

    const groups = new Map(tbodies.map(tbody => [tbody, []]));
    rows.forEach(row => {
      const home = groups.has(row.__ptOrigin.tbody) ? row.__ptOrigin.tbody : tbodies[0];
      groups.get(home).push(row);
    });
    groups.forEach((group, tbody) => placeRows(tbody, group.sort(byOrigin)));
  }

  // ---------------------------------------------------------------------------
  // Bootstrapping
  // ---------------------------------------------------------------------------

  function enhance() {
    scheduled = false;
    const tables = getTrackerTables();
    if (!tables.length) return;
    addStyles();
    tables.forEach(enhanceTable);
    applySort(tables);

    // Fetch Genie prices once every row knows its definitionId (and then every 5 minutes).
    const rows = allTrackerRows();
    if (rows.every(row => row.__ptDefId !== undefined)) refreshGeniePrices(rows, false);
  }

  function scheduleEnhance() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(enhance);
  }

  new MutationObserver(scheduleEnhance).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
  // Wake up periodically so the 5-minute Genie refresh also happens on a quiet page.
  window.setInterval(scheduleEnhance, 60 * 1000);
  scheduleEnhance();
})();

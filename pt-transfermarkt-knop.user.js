// ==UserScript==
// @name         Paletools Price Tracker – Transfermarkt-knop
// @namespace    pt-price-tracker-plus
// @version      1.0.0
// @description  Voegt per speler in de Paletools Price Tracker een 🔍-knop toe die het transfermarkt-filterscherm voorbereidt (speler + rarity + max BIN = je instapdoel). Zoeken doe je zelf.
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.ea.com/*/ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BTN_CLASS = 'pt-tm-search';
  const STYLE_ID = 'pt-tm-search-style';

  // ---- Paletools price tracker data (IndexedDB "paletools" / store "priceTracker") ----
  let trackerCache = null;
  let trackerCacheAt = 0;

  function readTracker() {
    if (trackerCache && Date.now() - trackerCacheAt < 5000) return Promise.resolve(trackerCache);
    return new Promise((resolve) => {
      const req = indexedDB.open('paletools');
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('priceTracker')) { db.close(); resolve([]); return; }
        const q = db.transaction('priceTracker').objectStore('priceTracker').getAll();
        q.onsuccess = () => { trackerCache = q.result || []; trackerCacheAt = Date.now(); db.close(); resolve(trackerCache); };
        q.onerror = () => { db.close(); resolve([]); };
      };
    });
  }

  const norm = (s) => String(s || '').trim().toLowerCase();

  // Find the tracked entry for a table row: name + rating; ties resolved by row order.
  async function findEntry(row) {
    const cells = row.querySelectorAll('td');
    const name = norm(cells[0] && (cells[0].getAttribute('title') || cells[0].textContent));
    const rating = parseInt(cells[1] && cells[1].textContent, 10);
    const list = await readTracker();
    const matches = list.filter((p) => norm(p.name) === name && (!rating || p.rating === rating));
    if (matches.length <= 1) return matches[0] || null;

    const rows = [...row.parentElement.querySelectorAll('tr')].filter((r) => {
      const c = r.querySelectorAll('td');
      return norm(c[0] && (c[0].getAttribute('title') || c[0].textContent)) === name &&
        parseInt(c[1] && c[1].textContent, 10) === rating;
    });
    return matches[rows.indexOf(row)] || matches[0];
  }

  function readTarget(row) {
    const input = row.querySelector('.pt-target-input');
    const v = input ? parseInt(String(input.value).replace(/[^\d]/g, ''), 10) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  // ---- Prepare (never execute) the transfer market search ----
  function openPreparedSearch(entry, maxBuy) {
    const defId = entry.definitionId;
    const baseId = defId & 0xFFFFFF;

    const root = getAppMain().getRootViewController();
    root.setGameViewTab(UTGameTabBarController.TabTag.TRANSFERS);
    let nav = root.getPresentedViewController();
    if (nav instanceof UTTabBarController) nav = nav.getCurrentViewController();
    if (!(nav instanceof UTNavigationController)) throw new Error('Transfers-navigatie niet gevonden');

    const criteria = new UTSearchCriteriaDTO();
    criteria.type = SearchType.PLAYER;
    criteria.category = SearchCategory.ANY;
    criteria.maskedDefId = baseId;
    if (entry.rarity != null) criteria.rarities = [entry.rarity];
    if (maxBuy) criteria.maxBuy = maxBuy;

    const vc = new UTMarketSearchFiltersViewController();
    vc.initWithSearchCriteria(criteria);
    const playerData = repositories.Item.getStaticDataByDefId(baseId);
    if (playerData) vc.viewmodel.setPlayerData(playerData);
    nav.pushViewController(vc);
  }

  async function onClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const row = btn.closest('tr');
    try {
      const entry = await findEntry(row);
      if (!entry) { btn.textContent = '⚠️'; btn.title = 'Speler niet gevonden in Paletools Price Tracker'; return; }
      openPreparedSearch(entry, readTarget(row));
    } catch (e) {
      console.error('[PT-TM]', e);
      btn.textContent = '⚠️';
      btn.title = 'Fout: ' + e.message;
    }
  }

  // ---- UI ----
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .${BTN_CLASS} { margin-left: 4px; padding: 0 4px; cursor: pointer; background: transparent;
        border: 1px solid rgba(255,255,255,.25); border-radius: 3px; color: inherit; font-size: 11px; line-height: 16px; }
      .${BTN_CLASS}:hover { border-color: #3ad4a8; background: rgba(58,212,168,.15); }
    `;
    document.head.appendChild(s);
  }

  function enhance() {
    document.querySelectorAll('.price-tracker-table tbody tr').forEach((row) => {
      if (row.querySelector('.' + BTN_CLASS)) return;
      const cell = row.querySelector('td');
      if (!cell) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN_CLASS;
      btn.textContent = '🔍';
      btn.title = 'Bereid transfermarkt-zoekopdracht voor (speler + rarity + max BIN = instapdoel). Zoeken doe je zelf.';
      btn.addEventListener('click', onClick);
      const copy = cell.querySelector('.pt-copy-name');
      if (copy) copy.after(btn); else cell.appendChild(btn);
    });
  }

  injectStyle();
  new MutationObserver(() => enhance()).observe(document.body, { childList: true, subtree: true });
  enhance();
})();

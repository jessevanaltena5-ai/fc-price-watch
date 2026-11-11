// ==UserScript==
// @name         FUTBIN Sales Check
// @namespace    local.fc.futbin-sales
// @version      1.0.0
// @description  Analyseert de FUTBIN-verkoopgeschiedenis: alleen echte verkopen (Sold for), 10/90-percentielen, verkopen per dag, hoeveel listings verkopen, trend, koop/verkoop-advies na 5% belasting.
// @match        https://www.futbin.com/*/sales/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/futbin-sales.user.js
// @downloadURL  https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/futbin-sales.user.js
// ==/UserScript==

(function () {
  "use strict";

  const TAX = 0.05;
  const HOUR = 3600 * 1000;
  const fmt = new Intl.NumberFormat("en-US");
  const k = value => (value >= 10000 ? `${fmt.format(Math.round(value / 100) / 10)}K` : fmt.format(Math.round(value)));
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  // EA price steps (same ladder as the transfer market).
  function step(price) {
    return price < 1000 ? 50 : price < 10000 ? 100 : price < 50000 ? 250 : price < 100000 ? 500 : 1000;
  }
  const roundDown = price => Math.max(200, Math.floor(price / step(price)) * step(price));
  const roundUp = price => Math.max(200, Math.ceil(price / step(price)) * step(price));
  const num = text => Number(String(text || "").replace(/[^\d]/g, "")) || 0;

  // "Nov 11, 12:20 AM" (no year): this year, or last year when that would lie in the future.
  function parseDate(text) {
    const match = String(text).trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match || MONTHS[match[1]] == null) return 0;
    let hour = Number(match[3]) % 12;
    if (match[5].toUpperCase() === "PM") hour += 12;
    const now = new Date();
    const date = new Date(now.getFullYear(), MONTHS[match[1]], Number(match[2]), hour, Number(match[4]));
    if (date.getTime() > now.getTime() + 2 * 24 * HOUR) date.setFullYear(date.getFullYear() - 1);
    return date.getTime();
  }

  function readRows() {
    const table = document.querySelector("table.auctions-table");
    if (!table) return [];
    return [...table.querySelectorAll("tbody tr")].map(tr => {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 3) return null;
      const dateEl = tr.querySelector(".sales-date-time") || cells[0];
      const typeText = (cells[5] && cells[5].textContent || "").trim().toLowerCase();
      return {
        at: parseDate(dateEl.textContent),
        listed: num(cells[1].textContent),
        sold: num(cells[2].textContent),
        type: typeText.includes("bid") ? "bid" : typeText.includes("buy") ? "bin" : ""
      };
    }).filter(row => row && row.at && row.listed);
  }

  // Percentile with linear interpolation on sorted values.
  function pct(sorted, p) {
    if (!sorted.length) return 0;
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
  }

  // Stats for the rows in [from, to): only real sales (Sold for > 0) count for prices.
  function windowStats(rows, from, to) {
    const inWindow = rows.filter(row => row.at >= from && row.at < to);
    const sales = inWindow.filter(row => row.sold > 0);
    const raw = sales.map(row => row.sold).sort((a, b) => a - b);
    // One-off sales far from the middle (a 100K sale on a 165K card, a 399K panic buy) are left out
    // before the percentiles, so a single odd sale can't drag P10/P90 along.
    const mid = pct(raw, 0.5);
    const odd = value => raw.length >= 5 && (value < mid * 0.75 || value > mid * 1.35);
    const outliers = raw.filter(odd);
    const sorted = raw.filter(value => !odd(value));
    const p10 = pct(sorted, 0.1);
    const p90 = pct(sorted, 0.9);
    return {
      listings: inWindow.length,
      sales: sales.length,
      bins: sales.filter(row => row.type === "bin").length,
      bids: sales.filter(row => row.type === "bid").length,
      sellThrough: inWindow.length ? sales.length / inWindow.length : 0,
      p10, p25: pct(sorted, 0.25), median: pct(sorted, 0.5), p75: pct(sorted, 0.75), p90,
      min: sorted[0] || 0, max: sorted[sorted.length - 1] || 0,
      outliers,
      sorted,
      // Unsold listings: what people ask but nobody pays.
      unsoldMedian: pct(inWindow.filter(row => !row.sold).map(row => row.listed).sort((a, b) => a - b), 0.5)
    };
  }

  function analyse(rows) {
    if (!rows.length) return null;
    const newest = Math.max(...rows.map(row => row.at));
    const oldest = Math.min(...rows.map(row => row.at));
    const end = newest + 60 * 1000;
    const day = windowStats(rows, end - 24 * HOUR, end);
    const prevDay = windowStats(rows, end - 48 * HOUR, end - 24 * HOUR);
    const twoDays = windowStats(rows, end - 48 * HOUR, end);
    const all = windowStats(rows, 0, end);
    // Base the advice on 24 h, or 48 h when the last day had fewer than 5 sales.
    const base = day.sales >= 5 ? day : twoDays;
    const baseLabel = day.sales >= 5 ? "24u" : "48u";
    const buy = base.sales ? roundDown(base.p10) : 0;
    const sell = base.sales ? roundDown(base.p75) : 0;
    const profit = buy && sell ? Math.floor(sell * (1 - TAX)) - buy : 0;
    const trend = day.sales >= 3 && prevDay.sales >= 3 ? day.median / prevDay.median - 1 : null;
    const days = Math.max(1, (newest - oldest) / (24 * HOUR));
    const warnings = [];
    if (day.sales < 5) warnings.push(`maar ${day.sales} verkoop/verkopen in 24u: verkoopt traag`);
    if (day.listings >= 10 && day.sellThrough < 0.15) warnings.push(`maar ${Math.round(day.sellThrough * 100)}% van de listings verkoopt`);
    if (trend != null && trend <= -0.05) warnings.push(`verkoopprijs ${Math.round(trend * 100)}% t.o.v. de dag ervoor: dalend`);
    if (base.outliers.length) warnings.push(`uitschieter(s) genegeerd: ${base.outliers.map(k).join(", ")}`);
    if (profit <= 0 && base.sales) warnings.push("koop op P10 en verkoop op P75 levert niets op na belasting");
    return { newest, oldest, days, day, prevDay, twoDays, all, base, baseLabel, buy, sell, profit, trend, warnings };
  }

  // --- Panel ------------------------------------------------------------------------------------
  const CSS = `
#fsc-panel { position: fixed; top: 90px; right: 16px; z-index: 2147483000; width: 340px; max-height: calc(100vh - 110px);
  overflow-y: auto; background: #0c1119; color: #e8ecf2; border: 1px solid #3a4a5e; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
#fsc-panel * { box-sizing: border-box; }
#fsc-panel .fsc-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px;
  border-bottom: 1px solid #243042; cursor: move; user-select: none; }
#fsc-panel .fsc-title { font-weight: 700; font-size: 14px; color: #fff; }
#fsc-panel .fsc-x { background: none; border: 0; color: #9aa6b8; font-size: 16px; cursor: pointer; }
#fsc-panel .fsc-body { padding: 10px 12px 12px; }
#fsc-panel .fsc-advice { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }
#fsc-panel .fsc-box { background: #151d29; border: 1px solid #243042; border-radius: 8px; padding: 6px 8px; text-align: center; }
#fsc-panel .fsc-box b { display: block; font-size: 15px; color: #fff; }
#fsc-panel .fsc-box span { font-size: 11px; color: #9aa6b8; }
#fsc-panel .fsc-plus b { color: #27d98b; } #fsc-panel .fsc-minus b { color: #ff8080; }
#fsc-panel table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
#fsc-panel th, #fsc-panel td { padding: 3px 4px; text-align: right; border-bottom: 1px solid #1b2533; }
#fsc-panel th:first-child, #fsc-panel td:first-child { text-align: left; color: #9aa6b8; }
#fsc-panel th { font-size: 11px; color: #8d9aae; text-transform: uppercase; }
#fsc-panel .fsc-warn { color: #f4a35d; font-weight: 600; margin: 2px 0; }
#fsc-panel .fsc-ok { color: #27d98b; font-weight: 600; margin: 2px 0; }
#fsc-panel .fsc-muted { color: #8d9aae; font-size: 11px; }
#fsc-panel .fsc-own { display: flex; gap: 6px; align-items: center; margin: 8px 0 4px; }
#fsc-panel input { width: 110px; padding: 4px 6px; background: #151d29; color: #fff; border: 1px solid #3a4a5e; border-radius: 6px; font: inherit; }
#fsc-panel .fsc-own-out { margin-top: 4px; }
#fsc-panel.fsc-min .fsc-body { display: none; }
`;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function platformLabel() {
    const fromUrl = new URLSearchParams(location.search).get("platform");
    return fromUrl ? fromUrl.toUpperCase() : "platform: check FUTBIN-instelling";
  }

  function playerName() {
    return (document.title.match(/27\s+(.+?)\s+Sales history/i) || [])[1] || "Speler";
  }

  let panel = null;
  let ownBuy = "";

  function render() {
    const result = analyse(readRows());
    if (!panel) {
      const style = el("style");
      style.textContent = CSS;
      document.head.appendChild(style);
      panel = el("div");
      panel.id = "fsc-panel";
      document.body.appendChild(panel);
    }
    const minimized = panel.classList.contains("fsc-min");
    panel.textContent = "";
    const head = el("div", "fsc-head");
    const title = el("div", "fsc-title", `📊 ${playerName()} · ${platformLabel()}`);
    const toggle = el("button", "fsc-x", minimized ? "▢" : "–");
    toggle.title = "In-/uitklappen";
    toggle.addEventListener("click", () => { panel.classList.toggle("fsc-min"); render(); });
    head.append(title, toggle);
    dragBy(head);
    const body = el("div", "fsc-body");
    panel.append(head, body);

    if (!result) {
      body.appendChild(el("div", "fsc-muted", "Geen verkooptabel gevonden op deze pagina."));
      return;
    }
    const { day, prevDay, all, base, baseLabel, buy, sell, profit, trend, warnings } = result;

    const advice = el("div", "fsc-advice");
    const box = (label, value, cls) => {
      const node = el("div", `fsc-box ${cls || ""}`);
      node.append(el("b", null, value), el("span", null, label));
      return node;
    };
    advice.append(
      box(`koop ≤ (P10 ${baseLabel})`, buy ? k(buy) : "—"),
      box(`verkoop (P75 ${baseLabel})`, sell ? k(sell) : "—"),
      box(`winst na 5%${buy ? ` · ${(profit / buy * 100).toFixed(1)}%` : ""}`, buy ? `${profit > 0 ? "+" : ""}${k(profit)}` : "—", profit > 0 ? "fsc-plus" : "fsc-minus")
    );
    body.appendChild(advice);

    const table = el("table");
    const headRow = el("tr");
    ["", "24u", "24–48u", `alles (${Math.round(result.days)}d)`].forEach(text => headRow.appendChild(el("th", null, text)));
    table.appendChild(headRow);
    const row = (label, fn) => {
      const tr = el("tr");
      tr.appendChild(el("td", null, label));
      [day, prevDay, all].forEach(stats => tr.appendChild(el("td", null, stats.sales || label === "Listings" || label === "Verkocht" ? fn(stats) : "—")));
      table.appendChild(tr);
    };
    row("Verkocht", s => `${s.sales}${s.bids ? ` (${s.bids} bod)` : ""}`);
    row("Listings", s => String(s.listings));
    row("% verkocht", s => `${Math.round(s.sellThrough * 100)}%`);
    row("P10", s => k(s.p10));
    row("Mediaan", s => k(s.median));
    row("P90", s => k(s.p90));
    row("Min–max", s => `${k(s.min)}–${k(s.max)}`);
    row("Vraagprijs onverkocht", s => (s.unsoldMedian ? k(s.unsoldMedian) : "—"));
    body.appendChild(table);

    body.appendChild(el("div", "fsc-muted",
      `Verkopen per dag: ${(all.sales / result.days).toFixed(1)} · trend 24u vs dag ervoor: ${trend == null ? "te weinig verkopen" : `${trend >= 0 ? "+" : ""}${(trend * 100).toFixed(1)}%`}`));
    if (warnings.length) warnings.forEach(text => body.appendChild(el("div", "fsc-warn", `⚠ ${text}`)));
    else body.appendChild(el("div", "fsc-ok", "✓ Genoeg verkopen, stabiel"));

    // Own buy price: break-even and how often it sold above that.
    const own = el("div", "fsc-own");
    const input = el("input");
    input.placeholder = "jouw koopprijs";
    input.inputMode = "numeric";
    input.value = ownBuy;
    own.append(el("span", "fsc-muted", "Gekocht voor"), input);
    const ownOut = el("div", "fsc-own-out");
    const showOwn = () => {
      ownBuy = input.value;
      const paid = num(input.value);
      ownOut.textContent = "";
      if (!paid) return;
      const breakEven = roundUp(paid / (1 - TAX));
      const above = base.sorted.filter(value => value >= breakEven).length;
      ownOut.appendChild(el("div", null, `Break-even: list ≥ ${k(breakEven)} · ${above}/${base.sales} verkopen (${baseLabel}) lagen daarboven`));
      [["mediaan", base.median], ["P75", base.p75], ["P90", base.p90]].forEach(([label, value]) => {
        const at = roundDown(value);
        const net = Math.floor(at * (1 - TAX)) - paid;
        ownOut.appendChild(el("div", net > 0 ? "fsc-ok" : "fsc-warn", `Verkoop op ${label} ${k(at)} → ${net > 0 ? "+" : ""}${k(net)}`));
      });
    };
    input.addEventListener("input", showOwn);
    body.append(own, ownOut);
    showOwn();
    body.appendChild(el("div", "fsc-muted", `Alleen "Sold for" telt; vraagprijzen van onverkochte listings niet. Laatste regel: ${new Date(result.newest).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (FUTBIN-tijd).`));
  }

  function dragBy(handle) {
    handle.addEventListener("pointerdown", event => {
      if (event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      const move = e => {
        panel.style.left = `${Math.max(0, e.clientX - dx)}px`;
        panel.style.top = `${Math.max(0, e.clientY - dy)}px`;
        panel.style.right = "auto";
      };
      const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  // Render now and whenever FUTBIN swaps the table (platform switch, refresh).
  let timer = 0;
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(render, 300); };
  render();
  const target = document.querySelector(".auctions-table-wrapper") || document.body;
  new MutationObserver(mutations => {
    if (mutations.some(m => !panel || !panel.contains(m.target))) schedule();
  }).observe(target, { childList: true, subtree: true });
})();

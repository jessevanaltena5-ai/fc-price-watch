# FC Price Watch

Tampermonkey userscript for the EA FC Ultimate Team web app (PC and console).
It adds a **Price Watch** tab: cheap cards to flip with real FUTBIN sales, a score and buy/sell prices,
fodder prices per rating, your own search/bid lists and your transfer list with profit after tax.

**Price Watch never searches, buys or lists for you.** Its buttons only fill in the transfer market
filters; you press Search, Buy, Bid and List yourself.

## Install (5 minutes, once)

1. **Use Chrome, Brave or Edge on a computer.** (Firefox works too.)
2. **Install Tampermonkey** from <https://www.tampermonkey.net/>.
3. **Allow user scripts** (Chrome/Brave/Edge only):
   go to `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`), click
   **Details** on Tampermonkey and turn on **Allow user scripts**. On older browsers, turn on
   **Developer mode** at the top right of the extensions page instead.
4. **Install the script**: open
   <https://raw.githubusercontent.com/jessevanaltena5-ai/fc-price-watch/main/price-watch.user.js>.
   Tampermonkey shows an install screen, so click **Install**.
5. **Open the web app**: <https://www.ea.com/ea-sports-fc/ultimate-team/web-app/> and log in.
   If it was already open, reload it (F5).
6. Click **Price Watch** in the menu on the left. The first time, a short guide opens:
   choose your **language** and your **platform (PC or console)**, then read the four steps.
   You can open the guide again later with **📘 Guide** at the top.

Updates arrive by themselves through Tampermonkey (Tampermonkey → *Check for userscript updates*
to get one right away).

## Not working?

- **No Price Watch tab:** check that Tampermonkey is on and the script is enabled (green switch in the
  Tampermonkey dashboard), that *Allow user scripts* is on, then reload the web app.
- **Empty Flip list:** wait a minute; the first load and FUTBIN checks take a few minutes.
  Keep the web app open.
- **Wrong prices:** check your platform in Flip → ⚙.

## Other scripts in this repo

| Script | What |
| --- | --- |
| [futbin-sales.user.js](futbin-sales.user.js) | **FUTBIN Sales Check**: panel on FUTBIN sales pages with real sales only, P10/median/P90, sell-through, trend and buy/sell advice after 5% tax. |
| [pt-transfermarkt-knop.user.js](pt-transfermarkt-knop.user.js) | Old: 🔍 button in the Paletools Price Tracker. |
| [price-tracker-plus.user.js](price-tracker-plus.user.js) | Old: Price Tracker Plus for the Paletools table. |

## Live via your PC (optional)

Your GitHub token and gist are **not** in this repo. Fill them in yourself under
*⇄ Transfer → Live via your PC*; they stay in Tampermonkey on your own device only.

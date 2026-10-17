# Peptide Ledger: notes for editing

Installable web app (PWA) hosted on GitHub Pages from `main` / root: https://kingc4rl.github.io/peptide-ledger/
No build step. Plain HTML/CSS/JS.

## Publishing: commit straight to `main`
The owner wants every requested change published directly, with no pull request and no review branch.
GitHub Pages serves the live app from `main`, so nothing reaches his phone until it is on `main`.
When a change is done and tested: bump `VERSION` in `sw.js`, commit to `main`, and `git push origin HEAD:main`.
If the session started on another branch (e.g. `claude/...`), merge or fast-forward that work into `main` and push `main`.
Do not stop at "branch pushed" or open a PR unless the owner asks for one. Afterwards, tell him it's live and to tap Reload in the app.

## Files
- `index.html`: markup and all CSS (light "liquid glass" theme (frosted translucent cards over a soft colour field, overrides in the Liquid glass block at the end of the CSS); orange `--accent-pep` for action fills, `--accent-pep-strong` for orange text, blue `--info` for info, green/red for status only).
- `app.js`: all logic, one IIFE. Sections are marked with `/* ===== ... ===== */` banners.
- `sw.js`: offline cache. **Bump `VERSION` on every change**, or installed phones keep the old files.
- `manifest.webmanifest`, `icons/`: install metadata.

## Data (never break it)
- The owner's real data lives only in IndexedDB on his phone (db `peptide-ledger`, stores `collections` and `blobs`). It is never in this repo.
- Collections: protocols, vials, vendors, research, supplies, supplyVendors, pepEquipment, checkins, photos, labs, urine.
  (pepEquipment, labs and urine no longer have a screen but are kept so old records and backups survive.)
- Tabs: Dose (home), Protocols, Inventory, Claude (centre orb button), Progress, Tools, Resources.
- Claude tab: calls the Messages API from the browser with the owner's own key (localStorage `ledger.claudeKey`, never in backups). Chats are saved in the `research` collection (`messages`, `system`, `model`, `costUsd`); keep conversations append-only.
- Changes must stay backward compatible with existing records and with backup files (`format: 1`). Add fields with safe defaults; never rename or drop fields without a migration in `loadAll()`.
- Backup/restore is in the "Backup, restore, install" section of `app.js`.

## Before publishing a change
0. Run `node --check app.js && node --check sw.js`. A syntax error in `sw.js` silently blocks every future update on the phone.
1. Serve the folder locally and test at phone width (390×844) with Playwright, including a reload to confirm data persists.
2. Check no horizontal overflow and no console errors (blocked Google Fonts in the sandbox are expected).
3. Bump `VERSION` in `sw.js`, commit to `main`, push `main` (see Publishing above). Pages redeploys in about a minute; the app shows "A new version of the app is ready" → Reload.

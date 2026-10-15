# Peptide Ledger: notes for editing

Installable web app (PWA) hosted on GitHub Pages from `main` / root: https://kingc4rl.github.io/peptide-ledger/
No build step. Plain HTML/CSS/JS.

## Files
- `index.html`: markup and all CSS (single dark graphite theme; orange `--accent-pep` for actions, blue `--info` for info, green/red for status only).
- `app.js`: all logic, one IIFE. Sections are marked with `/* ===== ... ===== */` banners.
- `sw.js`: offline cache. **Bump `VERSION` on every change**, or installed phones keep the old files.
- `manifest.webmanifest`, `icons/`: install metadata.

## Data (never break it)
- The owner's real data lives only in IndexedDB on his phone (db `peptide-ledger`, stores `collections` and `blobs`). It is never in this repo.
- Collections: protocols, vials, vendors, research, supplies, supplyVendors, pepEquipment, checkins, photos, labs, urine.
- Changes must stay backward compatible with existing records and with backup files (`format: 1`). Add fields with safe defaults; never rename or drop fields without a migration in `loadAll()`.
- Backup/restore is in the "Backup, restore, install" section of `app.js`.

## Before publishing a change
1. Serve the folder locally and test at phone width (390×844) with Playwright, including a reload to confirm data persists.
2. Check no horizontal overflow and no console errors (blocked Google Fonts in the sandbox are expected).
3. Bump `VERSION` in `sw.js`, commit to `main`, push. Pages redeploys in about a minute; the app shows "A new version of the app is ready" → Reload.

# Peptide Ledger

A private peptide tracker you install on your phone from a web address. Everything you enter is stored only inside the app on that device. No account, no server, no sync.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The app (layout and styles) |
| `app.js` | The app's logic |
| `sw.js` | Lets the app open offline and pick up updates |
| `manifest.webmanifest` | App name, icon and colors for "Add to Home Screen" |
| `icons/` | App icons |

Upload the whole folder as-is. The files must stay together, with `index.html` at the top level.

## Hosting option A: GitHub Pages (same as Iron Log)

1. On github.com, create a new repository, for example `peptide-ledger`.
2. Choose **Add file → Upload files**, drag in everything from this folder (including the `icons` folder), and commit.
3. Go to **Settings → Pages**. Under "Build and deployment" pick **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the address appears at the top of that page, e.g. `https://<your-username>.github.io/peptide-ledger/`.

A free GitHub account needs the repository to be public for Pages. That makes the app's code visible, but none of your data: the code ships empty and your entries never leave your phone. The page also tells search engines not to index it.

## Hosting option B: Netlify Drop (no repository)

1. Go to https://app.netlify.com/drop and sign in (a free account keeps the site online).
2. Drag this whole folder onto the page.
3. Netlify gives you an address like `https://something-random.netlify.app`. You can rename it under Site settings.

## Install on your iPhone

1. Open the address in **Safari**, the most reliable browser for installing web apps on iPhone.
2. Tap **Share → Add to Home Screen → Add**.
3. From then on, open it from the icon. The installed app keeps its own storage, separate from Safari tabs.

On Android, open the address in Chrome and choose **Install app** from the ⋮ menu.

## Backups (important)

Data lives only on the device that entered it. Use the **Saved on this device** pill (top right) → **Export backup file** every week or two and save it to Files / iCloud Drive. The app reminds you after 14 days. **Restore from file** brings everything back, including photos, on a new phone or after reinstalling.

If you ever move the app to a different web address, it starts empty there: export from the old one and restore into the new one.

## Updating the app later

Replace the changed files in your hosting, then open `sw.js` and change `VERSION` (e.g. `v1.0.0` → `v1.0.1`). Next time you open the app it shows **"A new version of the app is ready" → Reload**. Your data is not touched by updates.

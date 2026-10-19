// The iPhone app loads the live site (server.url in capacitor.config.json), so web changes reach it the same way they
// reach the home-screen app, and its service worker keeps it working offline. www/ only needs offline.html, shown if
// the very first launch has no connection; the web files are copied too as a reference copy.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(__dirname, 'www');
fs.rmSync(out, {recursive:true, force:true});
fs.mkdirSync(out, {recursive:true});
for(const f of ['index.html', 'app.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, 'icons'), path.join(out, 'icons'), {recursive:true});
// stamp the version from sw.js so the app can show it
const v = (/VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(root, 'sw.js'), 'utf8')) || [])[1] || '';
fs.writeFileSync(path.join(out, 'index.html'), fs.readFileSync(path.join(out, 'index.html'), 'utf8').replace('<head>', `<head>\n<script>window.PEP_NATIVE_VERSION=${JSON.stringify(v)};</script>`));
fs.writeFileSync(path.join(out, 'offline.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Pep Prep</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;font-family:-apple-system,system-ui,sans-serif;color:#1d1d22;text-align:center;padding:24px;box-sizing:border-box}
img{width:96px;height:96px;border-radius:22px;box-shadow:0 10px 30px rgba(0,0,0,.15)}h1{font-size:20px;margin:18px 0 6px}p{color:#6b6b74;font-size:15px;line-height:1.4;margin:0 0 20px}
button{font:600 16px -apple-system,system-ui,sans-serif;background:#ff8a1e;color:#fff;border:0;border-radius:12px;padding:12px 22px}</style></head>
<body><div><img src="icons/icon-192.png" alt=""><h1>Can't reach Pep Prep</h1><p>The app needs a connection the first time it opens.<br>After that it works offline.</p>
<button onclick="location.href='https://kingc4rl.github.io/peptide-ledger/'">Try again</button></div></body></html>`);
console.log('Copied web app', v, 'to www/');

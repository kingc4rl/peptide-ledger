// Copies the web app (the same files GitHub Pages serves) into www/ for the iPhone build.
// sw.js is left out: the native app ships its files inside the app, so it has no offline cache to manage.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(__dirname, 'www');
fs.rmSync(out, {recursive:true, force:true});
fs.mkdirSync(out, {recursive:true});
for(const f of ['index.html', 'app.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, 'icons'), path.join(out, 'icons'), {recursive:true});
// stamp the version from sw.js so the app can show it
const v = (/VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(root, 'sw.js'), 'utf8')) || [])[1] || '';
fs.writeFileSync(path.join(out, 'index.html'), fs.readFileSync(path.join(out, 'index.html'), 'utf8').replace('<head>', `<head>\n<script>window.PEP_NATIVE_VERSION=${JSON.stringify(v)};</script>`));
console.log('Copied web app', v, 'to www/');

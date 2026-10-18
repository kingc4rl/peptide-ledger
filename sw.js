/* Peptide Ledger service worker: makes the app open offline.
   Bump VERSION whenever you upload changed files so phones pick up the update. */
const VERSION = 'v1.20.0';
const SHELL = `ledger-shell-${VERSION}`;
const FONTS = 'ledger-fonts';
const SHELL_FILES = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', event=>{
  // cache:'reload' skips the browser's HTTP cache, so a new version never stores an older file.
  event.waitUntil(caches.open(SHELL).then(c=> c.addAll(SHELL_FILES.map(u=> new Request(u, {cache:'reload'})))));
});

self.addEventListener('activate', event=>{
  event.waitUntil(caches.keys().then(keys=> Promise.all(
    keys.filter(k=> k.startsWith('ledger-shell-') && k!==SHELL).map(k=> caches.delete(k))
  )));
});

self.addEventListener('message', event=>{
  if(event.data==='skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event=>{
  const req = event.request;
  if(req.method!=='GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache after first load so text looks right offline.
  if(url.hostname==='fonts.googleapis.com' || url.hostname==='fonts.gstatic.com'){
    event.respondWith(caches.open(FONTS).then(async c=>{
      const hit = await c.match(req);
      if(hit) return hit;
      try{ const res = await fetch(req); if(res && (res.ok || res.type==='opaque')) c.put(req, res.clone()); return res; }
      catch(e){ return hit || Response.error(); }
    }));
    return;
  }
  if(url.origin!==self.location.origin) return;

  // App files: serve from cache instantly, refresh the cache in the background.
  event.respondWith(caches.open(SHELL).then(async c=>{
    const key = req.mode==='navigate' ? './index.html' : req;
    const hit = await c.match(key, {ignoreSearch:true});
    const net = fetch(req, {cache:'no-cache'}).then(res=>{ if(res && res.ok) c.put(key, res.clone()); return res; }).catch(()=> null);
    if(hit) return hit;
    const res = await net;
    return res || new Response('Offline and this file is not cached yet.', {status:503, headers:{'Content-Type':'text/plain'}});
  }));
});

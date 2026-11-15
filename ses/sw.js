// Önce ağ, olmazsa önbellek: internet varken her zaman en güncel sürüm yüklenir.
const CACHE = 'kamp-telsizi'
const CORE = ['./', 'index.html', 'style.css', 'app.js', 'gate-worklet.js', 'vendor/trystero.js', 'icon.svg', 'manifest.webmanifest']

self.addEventListener('install', e => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}))
})

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  if (req.url.includes('version.json')) return
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || Response.error()))
  )
})

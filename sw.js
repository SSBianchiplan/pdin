/* GPlanSiS|PDIN · Service worker.
 * - /api/* nunca passa por cache: estado operacional é sempre do servidor.
 * - Navegação: rede primeiro; sem rede, página offline (não serve tela antiga como se fosse atual).
 * - CSS/JS/ícones do shell: rede primeiro, cache só como reserva sem conexão. Cenas 3D (data/) ficam fora: são grandes. */
const VERSION = 'pdin-3.7.1';
const SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Rede primeiro: o PDIN só opera conectado, e servir JS/CSS do cache antes da rede deixava o usuário
  // com a versão anterior por uma visita inteira depois de cada deploy. O cache só cobre queda de rede.
  if (/\.(css|js|png|svg|webp|woff2|webmanifest)$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
});

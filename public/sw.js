// Service worker do FisioGestão (PWA).
// Guarda apenas a "casca" do aplicativo (HTML, CSS, JS e ícones) para abrir rápido e funcionar como app instalado.
// Dados de pacientes e respostas da API NUNCA são guardados no aparelho (/api/* passa direto pela rede).
const VERSION = 'fisio-v17';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/favicon.svg', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/state.js', '/js/charts.js', '/js/schemas.js', '/js/pwa.js',
  '/js/pages/dashboard.js', '/js/pages/patients.js', '/js/pages/records.js', '/js/pages/agenda.js',
  '/js/pages/finance.js', '/js/pages/reports.js', '/js/pages/settings.js', '/js/pages/exercises.js', '/js/pages/signatures.js', '/js/pages/paylink.js', '/js/pages/portal.js', '/js/pages/whatsapp.js', '/js/tour.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Fora do escopo do app: API (dados), área administrativa e o próprio service worker
const bypass = (url) => url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin.') || url.pathname.startsWith('/agendar') || url.pathname.startsWith('/assinar') || url.pathname.startsWith('/paciente') || url.pathname === '/js/admin.js' || url.pathname === '/sw.js';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || bypass(url)) return;

  // Sempre tenta a rede primeiro (versão mais nova); sem internet, usa a cópia guardada
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' && url.pathname === '/' ? '/' : req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (cached) return cached;
      if (req.mode === 'navigate') return (await caches.match('/')) || (await caches.match('/index.html')) || Response.error();
      throw err;
    }
  })());
});

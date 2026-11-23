// PWA: registro do service worker, botão "Instalar aplicativo" e aviso de falta de conexão.
import { h, icon, modal } from './ui.js';

let deferred = null; // evento beforeinstallprompt (Chrome, Edge, Android)
const changed = () => window.dispatchEvent(new Event('fisio:installable'));

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Mostra o botão quando o navegador oferece instalação, ou no iPhone/iPad (instalação manual pelo Safari)
export const canInstall = () => !isStandalone() && (!!deferred || isIOS());

export async function promptInstall() {
  if (deferred) {
    const ev = deferred; deferred = null;
    ev.prompt();
    try { await ev.userChoice; } catch { /* ignorado */ }
    changed();
    return;
  }
  if (isIOS()) {
    modal({ title: 'Instalar no iPhone ou iPad', body: h('ol', { class: 'stack', style: { margin: 0, paddingLeft: '20px' } },
      h('li', null, 'Abra o FisioGestão no ', h('b', null, 'Safari'), '.'),
      h('li', null, 'Toque em ', h('b', null, 'Compartilhar'), ' (o quadrado com a seta para cima).'),
      h('li', null, 'Escolha ', h('b', null, 'Adicionar à Tela de Início'), ' e toque em ', h('b', null, 'Adicionar'), '.'),
      h('li', null, 'Abra pelo ícone na tela inicial: o sistema abre em tela cheia, como um aplicativo.')) });
  }
}

export function installButton(cls = 'install-btn') {
  const btn = h('button', { class: cls, type: 'button', onclick: promptInstall }, icon('download', 16), h('span', null, 'Instalar aplicativo'));
  const sync = () => { btn.hidden = !canInstall(); };
  sync();
  window.addEventListener('fisio:installable', sync);
  return btn;
}

function offlineBanner() {
  const bar = h('div', { class: 'offline-banner', role: 'status', hidden: navigator.onLine },
    icon('alert', 16), h('span', null, 'Sem conexão com a internet. Os dados aparecem de novo quando a conexão voltar — nada fica salvo no aparelho.'));
  document.body.append(bar);
  const sync = () => { bar.hidden = navigator.onLine; };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
}

export function initPWA({ demo = false } = {}) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; changed(); });
  window.addEventListener('appinstalled', () => { deferred = null; changed(); });
  offlineBanner();
  if (demo || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker não registrado:', e.message));
  });
}

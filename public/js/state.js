// Estado global da sessão e navegação
export const state = { user: null, settings: {}, professionals: [], clinic: null };
export const DEMO = !!window.FISIO_DEMO;
export const isClinical = () => ['admin', 'fisio'].includes(state.user?.role);
export const isAdmin = () => state.user?.role === 'admin';

// Navegação: na versão instalada usa o #hash da URL; na demonstração, rota em memória
let memRoute = '';
const stack = [];
export const getRoute = () => (DEMO ? memRoute : location.hash.replace(/^#\/?/, ''));
export function go(hash) {
  const r = String(hash).replace(/^#\/?/, '');
  if (!DEMO) { location.hash = hash; return; }
  if (r === memRoute) return;
  stack.push(memRoute); memRoute = r;
  window.dispatchEvent(new Event('fisio:route'));
}
export function back() {
  if (!DEMO) { history.back(); return; }
  memRoute = stack.pop() ?? 'dashboard';
  window.dispatchEvent(new Event('fisio:route'));
}

export function openPrint(doc, params = {}) {
  const s = new URLSearchParams({ doc, ...params });
  if (!DEMO) { window.open('/print.html?' + s.toString(), '_blank', 'noopener'); return; }
  // Demonstração: abre o documento dentro da própria página
  s.set('preview', '1');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const wrap = document.createElement('div'); wrap.className = 'doc-viewer';
  const bar = document.createElement('div'); bar.className = 'doc-viewer-bar';
  const label = document.createElement('span'); label.textContent = 'Pré-visualização do documento — na versão instalada ele é salvo em PDF.';
  const btn = document.createElement('button'); btn.className = 'btn sm'; btn.type = 'button'; btn.textContent = 'Fechar'; btn.onclick = close;
  bar.append(label, btn);
  const frame = document.createElement('iframe'); frame.src = 'print.html?' + s.toString(); frame.title = 'Documento';
  wrap.append(bar, frame); document.body.append(wrap);
  document.addEventListener('keydown', esc);
}

export async function reloadSettings() {
  const res = await fetch('/api/settings', { credentials: 'same-origin' });
  if (res.ok) state.settings = await res.json();
}

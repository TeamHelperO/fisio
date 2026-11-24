// Página pública de assinatura: /assinar/<código>. O paciente lê o documento, digita o nome e assina com o dedo.
import { h, icon, toast } from './ui.js';

const root = document.getElementById('root');
const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const api = async (body) => {
  const res = await fetch(`/api/public/sign/${encodeURIComponent(token)}`, {
    method: body ? 'POST' : 'GET', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fisio' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Não foi possível carregar. Tente novamente.');
  return data;
};
const message = (title, text, ic = 'file') => root.replaceChildren(h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon(ic, 26)),
  h('h1', { style: { fontSize: '20px', margin: '0 0 8px' } }, title), h('p', { class: 'bk-empty' }, text)));

// quadro de assinatura (mouse, caneta ou dedo)
function signaturePad() {
  const canvas = h('canvas', { class: 'sig-canvas', 'aria-label': 'Quadro para assinar' });
  const ctx = canvas.getContext('2d');
  let drawing = false; let last = null; let ink = 0; // comprimento total do traço, em pixels
  const fit = () => {
    const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const img = ink ? canvas.toDataURL() : null;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1f3a';
    if (img) { const i = new Image(); i.onload = () => ctx.drawImage(i, 0, 0, r.width, r.height); i.src = img; }
  };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); ink += Math.hypot(p[0] - last[0], p[1] - last[1]); last = p; e.preventDefault();
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  window.addEventListener('resize', fit);
  setTimeout(fit, 0);
  return {
    el: canvas,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ink = 0; },
    empty: () => ink < 40,
    // exporta em fundo branco (PNG)
    png: () => {
      const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
      const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0);
      return out.toDataURL('image/png');
    },
  };
}

async function main() {
  if (!token) return message('Link incompleto', 'Abra o link exatamente como foi enviado pela clínica.');
  let d;
  try { d = await api(); } catch (e) { return message('Link indisponível', e.message, 'alert'); }
  document.title = `Assinar — ${d.clinic}`;
  if (d.status === 'assinado') return message('Documento já assinado', `"${d.title}" foi assinado em ${d.signed_at.slice(8, 10)}/${d.signed_at.slice(5, 7)}/${d.signed_at.slice(0, 4)}. Não é preciso fazer mais nada.`, 'check');
  if (d.status === 'cancelado') return message('Link cancelado', 'A clínica cancelou este pedido de assinatura. Se precisar, peça um novo link.', 'alert');
  if (d.status === 'expirado') return message('Link expirado', 'Este link de assinatura venceu. Peça um novo link à clínica.', 'clock');
  const pad = signaturePad();
  const name = h('input', { class: 'input', autocomplete: 'name', maxLength: 160 });
  const cpf = h('input', { class: 'input', inputmode: 'numeric', maxLength: 14, placeholder: 'opcional' });
  const agree = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '12px' } }, 'Assinar documento');
  root.replaceChildren(
    h('div', { class: 'bk-head' }, h('div', { class: 'bk-logo' }, icon('file', 24)), h('div', null, h('h1', null, d.clinic), h('p', null, `Documento para ${d.patient_name}`))),
    h('section', { class: 'bk-card sig-doc' }, h('h2', null, d.doc.title),
      d.doc.sections.map((s) => h('div', { class: 'sig-sec' }, s.h ? h('b', null, s.h) : null, h('p', null, s.text))),
      h('small', { class: 'muted' }, `Código de verificação do documento: ${d.code}`)),
    h('section', { class: 'bk-card' }, h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      if (!agree.checked) return toast('Marque "Li e concordo" para assinar', 'error');
      if (pad.empty()) return toast('Desenhe a sua assinatura no quadro', 'error');
      btn.disabled = true;
      try {
        const r = await api({ name: name.value, cpf: cpf.value, agree: true, signature: pad.png() });
        message('Documento assinado!', `Obrigado. A clínica já recebeu o documento assinado em ${r.signed_at.slice(8, 10)}/${r.signed_at.slice(5, 7)}/${r.signed_at.slice(0, 4)} às ${r.signed_at.slice(11, 16)}. Você pode fechar esta página.`, 'check');
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    } },
    h('h2', { style: { margin: 0 } }, 'Assinatura'),
    h('label', { class: 'field' }, h('span', null, 'Seu nome completo'), name),
    h('label', { class: 'field' }, h('span', null, 'CPF'), cpf),
    h('div', null, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('span', { style: { fontSize: '13px', fontWeight: 600 } }, 'Assine com o dedo no quadro'),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => pad.clear() }, 'Limpar')), pad.el),
    h('label', { class: 'bk-consent' }, agree, h('span', null, 'Li o documento acima e concordo com o seu conteúdo. Sei que esta assinatura eletrônica tem a mesma validade da assinatura no papel e que serão registrados data, hora, endereço IP e navegador.')),
    btn)));
}
main();

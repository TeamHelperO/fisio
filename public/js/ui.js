// Utilitários de interface (DOM, formatação, modais, toasts, formulários)

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v; // usar apenas com conteúdo estático/confiável
      else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);

// ---------- Ícones (SVG inline, traço) ----------
const ICONS = {
  dashboard: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z',
  users: 'M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.7 0-8 1.3-8 4v3h8v-3c0-1.1.4-2.1 1.2-3A11 11 0 0 0 8 13zm8 0c-2.7 0-8 1.3-8 4v3h16v-3c0-2.7-5.3-4-8-4z',
  clipboard: 'M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1zm0 2v2h6V4zM7 11h10M7 15h10M7 19h6',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-4a6 6 0 1 0 0-12 6 6 0 0 0 0 12zm0-4a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  trending: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  wallet: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M3 12h18M3 6h18M3 18h18',
  x: 'M18 6 6 18M6 6l12 12',
  chevL: 'M15 18l-6-6 6-6', chevR: 'M9 18l6-6-6-6',
  check: 'M20 6 9 17l-5-5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  columns: 'M12 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  history: 'M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l4 2',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  receipt: 'M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2l-1 .7-3-2-3 2-3-2-3 2-3-2zM8 8h8M8 12h8M8 16h5',
};
export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name] || ''); s.append(p);
  return s;
}

// ---------- Formatação ----------
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const fmtDate = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');
export const fmtDT = (s) => (s ? `${fmtDate(s)} ${s.slice(11, 16)}` : '—');
export const fmtTime = (s) => (s ? s.slice(11, 16) : '');
export const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export function age(birth) {
  if (!birth) return null; const b = new Date(birth + 'T12:00'); const n = new Date();
  let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a;
}
export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
export const LABELS = {
  status: { avaliacao: 'Em avaliação', em_tratamento: 'Em tratamento', finalizado: 'Finalizado', inativo: 'Inativo' },
  appt: { agendado: 'Agendado', confirmado: 'Confirmado', realizado: 'Realizado', falta: 'Falta', cancelado: 'Cancelado' },
  kind: { avaliacao: 'Avaliação', sessao: 'Sessão', reavaliacao: 'Reavaliação', retorno: 'Retorno', domiciliar: 'Domiciliar', teleatendimento: 'Teleatendimento' },
  method: { pix: 'PIX', dinheiro: 'Dinheiro', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', transferencia: 'Transferência' },
  charge: { pendente: 'Pendente', pago: 'Pago', cancelado: 'Cancelado' },
  role: { admin: 'Administrador', fisio: 'Fisioterapeuta', recepcao: 'Recepção' },
  plano: { ativo: 'Ativo', concluido: 'Concluído', substituido: 'Substituído' },
  record: { anamnese: 'Anamnese', avaliacao: 'Avaliação', plano: 'Plano de tratamento', evolucao: 'Evolução' },
};
const BADGE_TONE = {
  em_tratamento: 'blue', avaliacao: 'amber', finalizado: 'green', inativo: 'gray',
  agendado: 'blue', confirmado: 'teal', realizado: 'green', falta: 'red', cancelado: 'gray',
  pendente: 'amber', pago: 'green', ativo: 'green', concluido: 'blue', substituido: 'gray', encerrado: 'gray',
};
export function badge(value, group) {
  const label = (group && LABELS[group]?.[value]) || value;
  return h('span', { class: `badge ${BADGE_TONE[value] || 'gray'}` }, label);
}
export function maskCPF(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}
export function maskPhone(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
  return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
}

// ---------- Toast ----------
export function toast(msg, type = 'ok') {
  let box = $('#toasts'); if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${type}`, role: 'status' }, icon(type === 'error' ? 'alert' : 'check', 16), h('span', null, msg));
  box.append(t); setTimeout(() => t.classList.add('out'), 3800); setTimeout(() => t.remove(), 4200);
}

// ---------- Modal ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    overlay.remove(); document.removeEventListener('keydown', esc); window.removeEventListener('hashchange', close); window.removeEventListener('fisio:route', close); onClose && onClose();
  };
  window.addEventListener('hashchange', close);
  window.addEventListener('fisio:route', close);
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions) : null));
  document.addEventListener('keydown', esc);
  document.body.append(overlay);
  const first = overlay.querySelector('input:not([type=hidden]),select,textarea'); if (first) setTimeout(() => first.focus(), 30);
  return { close, el: overlay };
}
export function confirmDialog(message, { title = 'Confirmar', okLabel = 'Confirmar', danger = false, input } = {}) {
  return new Promise((resolve) => {
    let done = false; let inp = null;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const body = h('div', null, h('p', { style: { whiteSpace: 'pre-line' } }, message),
      input ? (inp = h('input', { class: 'input', placeholder: input.placeholder || '' }), h('label', { class: 'field' }, h('span', null, input.label), inp)) : null);
    const m = modal({ title, body, onClose: () => finish(null), actions: [
      h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancelar'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(input ? inp.value : true) }, okLabel),
    ] });
  });
}

// ---------- Formulários ----------
// fields: [{ key, label, type, options, required, span, placeholder, mask, help }]
export function buildForm(fields, values = {}, { cols = 2 } = {}) {
  const form = h('form', { class: `form-grid cols-${cols}`, novalidate: true, onsubmit: (e) => e.preventDefault() });
  const inputs = {};
  for (const f of fields) {
    if (f.type === 'section') { form.append(h('h4', { class: 'form-section span-all' }, f.label)); continue; }
    const v = values[f.key] ?? f.default ?? '';
    let input;
    if (f.type === 'textarea') input = h('textarea', { class: 'input', rows: f.rows || 3, name: f.key, placeholder: f.placeholder || '' }, );
    else if (f.type === 'select') {
      input = h('select', { class: 'input', name: f.key },
        f.empty !== false ? h('option', { value: '' }, f.emptyLabel || 'Selecione…') : null,
        (f.options || []).map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
    } else if (f.type === 'scale') {
      const out = h('output', { class: 'scale-out' }, v === '' ? '—' : v);
      const r = h('input', { type: 'range', min: 0, max: 10, step: 1, name: f.key, class: 'range', value: v === '' ? 0 : v });
      r.dataset.touched = v === '' ? '' : '1';
      r.addEventListener('input', () => { out.value = r.value; r.dataset.touched = '1'; paintScale(r); });
      paintScale(r);
      input = r;
      inputs[f.key] = r;
      form.append(h('label', { class: `field ${f.span ? 'span-all' : ''}` }, h('span', null, f.label), h('div', { class: 'scale' }, h('small', null, '0 — sem dor'), r, out, h('small', null, '10 — dor máxima'))));
      continue;
    } else if (f.type === 'checks') {
      const set = new Set(Array.isArray(v) ? v : []);
      const box = h('div', { class: 'checks' }, f.options.map((o) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o, checked: set.has(o) }), h('span', null, o))));
      box.dataset.checks = '1'; inputs[f.key] = box;
      form.append(h('div', { class: `field ${f.span !== false ? 'span-all' : ''}` }, h('span', null, f.label), box));
      continue;
    } else {
      input = h('input', { class: 'input', type: f.type || 'text', name: f.key, placeholder: f.placeholder || '', step: f.step, min: f.min, max: f.max, autocomplete: f.autocomplete || 'off' });
      if (f.mask === 'cpf') input.addEventListener('input', () => (input.value = maskCPF(input.value)));
      if (f.mask === 'phone') input.addEventListener('input', () => (input.value = maskPhone(input.value)));
    }
    input.value = v ?? '';
    if (f.required) input.required = true;
    if (f.readonly) input.readOnly = true;
    inputs[f.key] = input;
    form.append(h('label', { class: `field ${f.span || f.type === 'textarea' ? 'span-all' : ''}` },
      h('span', null, f.label, f.required ? h('b', { class: 'req' }, ' *') : null), input, f.help ? h('small', { class: 'help' }, f.help) : null));
  }
  form.getValues = () => {
    const out = {};
    for (const [k, el] of Object.entries(inputs)) {
      if (el.dataset && el.dataset.checks) out[k] = [...el.querySelectorAll('input:checked')].map((i) => i.value);
      else if (el.type === 'range') out[k] = el.dataset.touched ? Number(el.value) : '';
      else out[k] = el.value.trim();
    }
    return out;
  };
  form.validate = () => {
    for (const f of fields) {
      if (f.required && inputs[f.key] && !String(inputs[f.key].value || '').trim()) {
        inputs[f.key].focus(); toast(`Preencha: ${f.label}`, 'error'); return false;
      }
    }
    return true;
  };
  form.inputs = inputs;
  return form;
}
function paintScale(r) {
  const v = Number(r.value); const hue = 130 - v * 13;
  r.style.setProperty('--fill', `${v * 10}%`); r.style.setProperty('--tone', `hsl(${hue} 65% 45%)`);
}

export function empty(text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('clipboard', 28)), h('p', null, text), action || null);
}
export function loading() { return h('div', { class: 'loading' }, h('div', { class: 'spinner' })); }

export function downloadFile(name, content, type = 'text/plain;charset=utf-8') {
  if (window.FISIO_DEMO) { toast(`Na demonstração os downloads ficam desativados. Na versão instalada, o arquivo ${name} é baixado.`, 'error'); return; }
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
// Célula de CSV segura: aspas escapadas e neutralização de fórmulas (=, +, -, @) ao abrir no Excel/LibreOffice
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

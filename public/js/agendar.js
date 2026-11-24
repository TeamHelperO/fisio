// Página pública de agendamento online: /agendar/<endereço-da-clínica>
import { h, icon, toast, WEEKDAYS, MONTHS, maskPhone } from './ui.js';

const root = document.getElementById('root');
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const api = async (path, opts = {}) => {
  const res = await fetch(`/api/public/booking/${encodeURIComponent(slug)}${path}`, {
    method: opts.body ? 'POST' : 'GET', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fisio' }, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Não foi possível carregar. Tente novamente.'), { status: res.status });
  return data;
};
const fmtLong = (d) => { const x = new Date(`${d}T12:00`); return `${WEEKDAYS[x.getDay()]}, ${x.getDate()} de ${MONTHS[x.getMonth()].toLowerCase()}`; };

async function main() {
  let info;
  try { info = await api(''); } catch (e) {
    root.replaceChildren(h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon('calendar', 26)), h('h1', { style: { fontSize: '20px' } }, 'Agendamento indisponível'), h('p', { class: 'bk-empty' }, e.message)));
    return;
  }
  document.title = `Agendar — ${info.clinic}`;
  const st = { prof: info.professionals.length === 1 ? info.professionals[0] : null, days: null, day: null, time: null };
  const profBox = h('div', { class: 'bk-pros' });
  const dayBox = h('div'); const slotBox = h('div'); const formBox = h('div');
  const head = h('div', { class: 'bk-head' }, h('div', { class: 'bk-logo' }, icon('calendar', 24)),
    h('div', null, h('h1', null, info.clinic), h('p', null, [info.address, info.phone].filter(Boolean).join(' · ') || 'Agendamento online')));
  const step = (n, title, body) => h('section', { class: 'bk-card' }, h('h2', null, h('span', { class: 'bk-step' }, n), title), body);

  function renderProfs() {
    profBox.replaceChildren(...info.professionals.map((p) => h('button', { type: 'button', class: `bk-chip ${st.prof?.id === p.id ? 'on' : ''}`, onclick: () => { st.prof = p; st.day = null; st.time = null; renderProfs(); loadDays(); } }, p.name)));
  }
  async function loadDays() {
    st.days = null; renderDays(); renderSlots(); renderForm();
    if (!st.prof) return;
    try { st.days = (await api(`/slots?professional_id=${st.prof.id}`)).days; } catch (e) { toast(e.message, 'error'); st.days = {}; }
    const first = Object.keys(st.days)[0];
    st.day = first || null; renderDays(); renderSlots();
  }
  function renderDays() {
    if (!st.prof) { dayBox.replaceChildren(h('p', { class: 'bk-empty' }, 'Escolha um profissional acima.')); return; }
    if (!st.days) { dayBox.replaceChildren(h('p', { class: 'bk-empty' }, 'Buscando horários livres…')); return; }
    const days = Object.keys(st.days);
    if (!days.length) { dayBox.replaceChildren(h('p', { class: 'bk-empty' }, 'Não há horários livres nos próximos dias. Entre em contato com a clínica.')); return; }
    dayBox.replaceChildren(h('div', { class: 'bk-days' }, days.map((d) => {
      const x = new Date(`${d}T12:00`);
      return h('button', { type: 'button', class: `bk-chip bk-day ${st.day === d ? 'on' : ''}`, onclick: () => { st.day = d; st.time = null; renderDays(); renderSlots(); renderForm(); } },
        h('small', null, WEEKDAYS[x.getDay()]), h('b', null, x.getDate()), h('small', null, MONTHS[x.getMonth()].slice(0, 3)));
    })));
  }
  function renderSlots() {
    if (!st.day || !st.days?.[st.day]) { slotBox.replaceChildren(); return; }
    slotBox.replaceChildren(h('p', { style: { margin: '14px 0 8px', fontSize: '14px' } }, h('b', null, fmtLong(st.day))),
      h('div', { class: 'bk-slots' }, st.days[st.day].map((t) => h('button', { type: 'button', class: `bk-chip ${st.time === t ? 'on' : ''}`, onclick: () => { st.time = t; renderSlots(); renderForm(); } }, t))));
  }
  function renderForm() {
    if (!st.time) { formBox.replaceChildren(); return; }
    const f = {
      name: h('input', { class: 'input', autocomplete: 'name', required: true, maxLength: 120 }),
      phone: h('input', { class: 'input', type: 'tel', autocomplete: 'tel', required: true, placeholder: '(11) 99999-9999', oninput: (e) => { e.target.value = maskPhone(e.target.value); } }),
      email: h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'para receber a confirmação' }),
      notes: h('textarea', { class: 'input', rows: 2, maxLength: 500, placeholder: 'Opcional: motivo da consulta, convênio, dúvidas' }),
      consent: h('input', { type: 'checkbox' }),
      website: h('input', { tabindex: '-1', autocomplete: 'off' }),
    };
    const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '12px' } }, info.mode === 'automatico' ? 'Confirmar agendamento' : 'Pedir este horário');
    formBox.replaceChildren(step(3, 'Seus dados', h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      if (!f.consent.checked) return toast('Marque a caixa de consentimento para continuar', 'error');
      btn.disabled = true;
      try {
        const r = await api('', { body: { professional_id: st.prof.id, start: `${st.day}T${st.time}`, name: f.name.value, phone: f.phone.value, email: f.email.value, notes: f.notes.value, consent: true, website: f.website.value } });
        done(r.status, f.email.value);
      } catch (err) {
        toast(err.message, 'error'); btn.disabled = false;
        if (err.status === 409) { st.time = null; loadDays(); }
      }
    } },
    h('div', { class: 'bk-summary' }, h('b', null, `${fmtLong(st.day)} às ${st.time}`), ` com ${st.prof.name} · ${info.slot_minutes} min`),
    h('label', { class: 'field' }, h('span', null, 'Nome completo'), f.name),
    h('label', { class: 'field' }, h('span', null, 'Telefone / WhatsApp'), f.phone),
    h('label', { class: 'field' }, h('span', null, 'E-mail'), f.email),
    h('label', { class: 'field' }, h('span', null, 'Observações'), f.notes),
    h('div', { class: 'bk-hp', 'aria-hidden': 'true' }, h('label', null, 'Não preencha', f.website)),
    h('label', { class: 'bk-consent' }, f.consent, h('span', null, `Concordo que a ${info.clinic} use estes dados para agendar e realizar meu atendimento, conforme a `,
      h('a', { href: '/privacidade.html', target: '_blank', rel: 'noopener' }, 'Política de Privacidade'), ' (LGPD).')),
    btn)));
    setTimeout(() => f.name.focus(), 50);
  }
  function done(status, email) {
    const ok = status === 'aceito';
    root.replaceChildren(head, h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon('check', 28)),
      h('h1', { style: { fontSize: '20px', margin: '0 0 8px' } }, ok ? 'Agendamento confirmado!' : 'Pedido enviado!'),
      h('p', { style: { margin: '0 0 6px' } }, h('b', null, `${fmtLong(st.day)} às ${st.time}`), ` com ${st.prof.name}`),
      h('p', { class: 'bk-empty' }, ok ? (email ? 'Enviamos a confirmação para o seu e-mail.' : 'Anote o horário. Se não puder comparecer, avise a clínica.')
        : `A clínica vai confirmar o horário${email ? ' e você receberá um e-mail' : ''}. Se precisar, entre em contato${info.phone ? ` pelo ${info.phone}` : ''}.`)),
    foot());
  }
  const foot = () => h('p', { class: 'bk-foot' }, 'Agendamento online por ', h('a', { href: '/', target: '_blank', rel: 'noopener' }, 'FisioGestão'));
  root.replaceChildren(...[head,
    info.intro ? h('div', { class: 'bk-card', style: { fontSize: '14px', whiteSpace: 'pre-line' } }, info.intro) : null,
    step(1, 'Profissional', profBox), step(2, 'Dia e horário', h('div', null, dayBox, slotBox)), formBox, foot()].filter(Boolean));
  renderProfs(); loadDays();
}
main();

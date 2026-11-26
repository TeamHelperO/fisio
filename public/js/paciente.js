// Portal do paciente: /paciente/<código>. Consultas, pagamentos, documentos, exercícios e diário de dor.
import { h, icon, toast } from './ui.js';

const root = document.getElementById('root');
const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const api = async (path = '', body) => {
  const res = await fetch(`/api/portal/${encodeURIComponent(token)}${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fisio' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Não foi possível carregar. Tente novamente.');
  return data;
};
const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dayLabel = (d) => { const x = new Date(`${d.slice(0, 10)}T12:00`); return `${WD[x.getDay()]}, ${x.getDate()} de ${MO[x.getMonth()]}`; };
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const section = (title, ic, ...body) => h('section', { class: 'bk-card' }, h('h2', null, icon(ic, 17), title), ...body);
const PAIN_COLOR = (n) => (n <= 3 ? '#16a34a' : n <= 6 ? '#d97706' : '#dc2626');
const isImage = (u) => /\.(gif|png|jpe?g|webp)(\?|$)/i.test(u || '');

function fail(msg) {
  root.replaceChildren(h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon('alert', 26)),
    h('h1', { style: { fontSize: '20px', margin: '0 0 8px' } }, 'Link indisponível'), h('p', { class: 'bk-empty' }, msg)));
}

async function main() {
  if (!token) return fail('Abra o link exatamente como foi enviado pela clínica.');
  let d;
  try { d = await api(); } catch (e) { return fail(e.message); }
  document.title = `${d.clinic.name} — Meu acompanhamento`;
  const reload = () => main();
  const phone = onlyDigits(d.clinic.phone);
  const wa = (msg) => (phone.length >= 10 ? `https://wa.me/${phone.length <= 11 ? '55' + phone : phone}?text=${encodeURIComponent(msg)}` : null);

  // ---- Como você está hoje? ----
  const todayEntry = d.diary.find((x) => x.day === d.today);
  let pick = todayEntry ? todayEntry.pain : null;
  const note = h('textarea', { class: 'input', rows: 2, maxLength: 500, placeholder: 'Quer contar algo? (opcional) Ex.: dor ao subir escada, dormi melhor…' });
  note.value = todayEntry?.note || '';
  const scale = h('div', { class: 'pt-scale' });
  const drawScale = () => scale.replaceChildren(...Array.from({ length: 11 }, (_, n) => h('button', {
    type: 'button', class: `pt-n ${pick === n ? 'on' : ''}`, style: pick === n ? { background: PAIN_COLOR(n), borderColor: PAIN_COLOR(n) } : null,
    'aria-label': `Dor ${n}`, onclick: () => { pick = n; drawScale(); },
  }, String(n))));
  drawScale();
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (pick === null) return toast('Toque em um número de 0 a 10', 'error');
    saveBtn.disabled = true;
    try { await api('/diary', { pain: pick, note: note.value }); toast('Registrado. Obrigado!'); reload(); } catch (e) { toast(e.message, 'error'); saveBtn.disabled = false; }
  } }, todayEntry ? 'Atualizar' : 'Registrar');
  const recent = d.diary.slice(0, 14).reverse();
  const chart = recent.length > 1 ? h('div', { class: 'pt-bars', 'aria-label': 'Sua dor nos últimos dias' },
    recent.map((x) => h('div', { class: 'pt-bar', title: `${dm(x.day)}: ${x.pain}` },
      h('i', { style: { height: `${Math.max(4, x.pain * 10)}%`, background: PAIN_COLOR(x.pain) } }), h('small', null, dm(x.day))))) : null;

  // ---- Consultas ----
  const appts = d.appointments.length ? h('div', { class: 'pt-list' }, d.appointments.map((a) => h('div', { class: 'pt-item' },
    h('div', { class: 'grow' }, h('b', null, `${dayLabel(a.start)} às ${a.start.slice(11, 16)}`),
      h('div', { class: 'pt-sub' }, [a.kind, a.professional].filter(Boolean).join(' · ')),
      a.status === 'confirmado' ? h('span', { class: 'badge green', style: { marginTop: '4px' } }, 'Presença confirmada') : null),
    h('div', { class: 'pt-actions' },
      a.can_confirm ? h('button', { class: 'btn sm primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api(`/appointments/${a.id}/confirm`, {}); toast('Presença confirmada'); reload(); } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
      } }, icon('check', 14), 'Confirmar') : null,
      wa(`Olá! Sou ${d.patient.first_name} e preciso remarcar minha consulta de ${dayLabel(a.start)} às ${a.start.slice(11, 16)}.`)
        ? h('a', { class: 'btn sm', href: wa(`Olá! Sou ${d.patient.first_name} e preciso remarcar minha consulta de ${dayLabel(a.start)} às ${a.start.slice(11, 16)}.`), target: '_blank', rel: 'noopener noreferrer' }, 'Remarcar') : null))))
    : h('p', { class: 'bk-empty' }, 'Nenhuma consulta marcada.');

  // ---- Pagamentos ----
  const pay = d.pending.length || d.paid.length ? h('div', { class: 'stack' },
    d.pending.length ? h('div', { class: 'pt-list' }, d.pending.map((c) => h('div', { class: 'pt-item' },
      h('div', { class: 'grow' }, h('b', null, brl(c.amount)), h('div', { class: 'pt-sub' }, c.description)),
      h('button', { class: 'btn sm primary', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { location.href = (await api(`/pay/${c.id}`, {})).url; } catch (err) { toast(err.message, 'error'); b.disabled = false; }
      } }, 'Pagar (Pix ou cartão)')))) : null,
    d.paid.length ? h('details', { class: 'pt-details' }, h('summary', null, `Pagamentos feitos (${d.paid.length})`),
      h('div', { class: 'pt-list' }, d.paid.map((c) => h('div', { class: 'pt-item' },
        h('div', { class: 'grow' }, h('span', null, c.description), h('div', { class: 'pt-sub' }, `Pago em ${dm(c.paid_at)}${c.receipt_number ? ` · recibo nº ${c.receipt_number}` : ''}`)),
        h('b', null, brl(c.amount)))))) : null) : null;

  // ---- Documentos ----
  const docs = d.signatures.length ? h('div', { class: 'pt-list' }, d.signatures.map((s) => h('div', { class: 'pt-item' },
    h('div', { class: 'grow' }, h('b', null, s.title), h('div', { class: 'pt-sub' }, `Assinar até ${dm(s.expires_at)}`)),
    h('button', { class: 'btn sm primary', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { location.href = (await api(`/sign/${s.id}`, {})).url; } catch (err) { toast(err.message, 'error'); b.disabled = false; }
    } }, 'Ler e assinar')))) : null;

  // ---- Exercícios ----
  const dose = (it) => [it.sets ? `${it.sets} série(s)` : '', it.reps ? `${it.reps} repetições` : '', it.hold_s ? `segurar ${it.hold_s} s` : '', it.rest_s ? `descanso ${it.rest_s} s` : '', it.side || '', it.load ? `carga: ${it.load}` : ''].filter(Boolean).join(' · ');
  const programs = d.programs.map((x) => section(x.title, 'activity',
    x.frequency || x.duration ? h('p', { class: 'pt-sub', style: { marginTop: '-6px' } }, [x.frequency, x.duration].filter(Boolean).join(' · ')) : null,
    x.notes ? h('div', { class: 'bk-summary' }, x.notes) : null,
    h('div', { class: 'stack' }, x.items.map((it, i) => h('details', { class: 'pt-ex' },
      h('summary', null, h('span', { class: 'pt-exn' }, i + 1), h('div', { class: 'grow' }, h('b', null, it.name), dose(it) ? h('div', { class: 'pt-sub' }, dose(it)) : null)),
      h('div', { class: 'pt-exbody' },
        it.media_url && isImage(it.media_url) ? h('img', { src: it.media_url, alt: it.name, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        it.steps?.length ? h('ol', null, it.steps.map((st) => h('li', null, st))) : null,
        it.notes ? h('div', { class: 'pt-warn' }, h('b', null, 'Atenção: '), it.notes) : null,
        it.media_url && !isImage(it.media_url) ? h('a', { class: 'btn sm', href: it.media_url, target: '_blank', rel: 'noopener noreferrer' }, 'Ver vídeo') : null)))),
    h('p', { class: 'pt-sub', style: { marginTop: '10px' } }, 'Faça com calma. Se sentir dor forte, tontura, falta de ar ou formigamento, pare e avise seu fisioterapeuta.')));

  root.replaceChildren(
    h('div', { class: 'bk-head' }, h('div', { class: 'bk-logo' }, icon('activity', 24)), h('div', null, h('h1', null, `Olá, ${d.patient.first_name}!`), h('p', null, d.clinic.name))),
    section('Como está sua dor hoje?', 'trending',
      h('p', { class: 'pt-sub', style: { marginTop: '-6px' } }, '0 = sem dor · 10 = pior dor imaginável'),
      scale, note, h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
        todayEntry ? h('small', { class: 'pt-sub' }, `Hoje você marcou ${todayEntry.pain}.`) : h('span'), saveBtn),
      chart ? h('div', null, h('small', { class: 'pt-sub' }, 'Últimos dias'), chart) : null),
    section('Próximas consultas', 'calendar', appts),
    docs ? section('Documentos para assinar', 'file', docs) : null,
    pay ? section('Pagamentos', 'wallet', pay) : null,
    ...programs,
    h('div', { class: 'bk-foot' },
      h('div', null, h('b', null, d.clinic.name)),
      d.clinic.phone ? h('div', null, wa('Olá!') ? h('a', { href: wa('Olá!'), target: '_blank', rel: 'noopener noreferrer' }, `WhatsApp ${d.clinic.phone}`) : d.clinic.phone) : null,
      d.clinic.address ? h('div', null, d.clinic.address) : null,
      h('p', { style: { marginTop: '10px' } }, 'Este link é pessoal: não compartilhe. Para desativá-lo, fale com a clínica.')));
}
main();

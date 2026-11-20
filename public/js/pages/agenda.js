import { h, icon, toast, buildForm, badge, fmtDate, fmtTime, empty, LABELS, confirmDialog, modal, today, ymd, pad, WEEKDAYS, MONTHS, money } from '../ui.js';
import { get, post, put, del, qs } from '../api.js';
import { state, go, isClinical } from '../state.js';

const START_H = 7; const END_H = 21; const HOUR_PX = 56;

// ======================= Modal de agendamento =======================
export async function appointmentModal(appt = {}, onSaved = () => {}) {
  const isNew = !appt.id;
  const [patients, services] = await Promise.all([get('/patients'), get('/services')]);
  const activeServices = services.filter((s) => s.active);
  const def = {
    patient_id: appt.patient_id || '', professional_id: appt.professional_id || (state.user.role !== 'recepcao' ? state.user.id : ''),
    date: appt.start ? appt.start.slice(0, 10) : appt.date || today(), time: appt.start ? appt.start.slice(11, 16) : appt.time || '08:00',
    duration: appt.duration || activeServices[0]?.duration || 50, kind: appt.kind || 'sessao', status: appt.status || 'agendado',
    price: appt.price ?? activeServices[0]?.price ?? '', notes: appt.notes || '', repeat_weeks: 1,
  };
  const fields = [
    { key: 'patient_id', label: 'Paciente', type: 'select', options: patients.filter((p) => p.status !== 'inativo' || p.id === appt.patient_id).map((p) => [p.id, p.name]), required: true, span: true },
    { key: 'date', label: 'Data', type: 'date', required: true },
    { key: 'time', label: 'Horário', type: 'time', required: true },
    { key: 'duration', label: 'Duração (min)', type: 'number', min: 10, step: 5 },
    { key: 'kind', label: 'Tipo de atendimento', type: 'select', options: Object.entries(LABELS.kind), empty: false },
    { key: 'professional_id', label: 'Fisioterapeuta', type: 'select', options: state.professionals.map((p) => [p.id, p.name]), emptyLabel: '— Não definido —' },
    { key: 'status', label: 'Situação', type: 'select', options: Object.entries(LABELS.appt), empty: false },
    { key: 'price', label: 'Valor do atendimento (R$)', type: 'number', min: 0, step: '0.01', help: 'Use 0 para atendimentos cobertos por pacote. A cobrança é gerada ao marcar como "Realizado".' },
    isNew ? { key: 'repeat_weeks', label: 'Repetir semanalmente', type: 'select', options: [[1, 'Não repetir'], ...[2, 3, 4, 6, 8, 10, 12, 16, 20, 24].map((n) => [n, `${n} semanas`])], empty: false } : null,
    { key: 'notes', label: 'Observações', type: 'textarea', rows: 2 },
  ].filter(Boolean);
  const form = buildForm(fields, def);
  if (activeServices.length) {
    const svc = h('select', { class: 'input', onchange: () => { const s = activeServices.find((x) => String(x.id) === svc.value); if (s) { form.inputs.price.value = s.price; form.inputs.duration.value = s.duration; } } },
      h('option', { value: '' }, 'Preencher valor a partir de um serviço…'), activeServices.map((s) => h('option', { value: s.id }, `${s.name} — ${money(s.price)}`)));
    form.insertBefore(h('label', { class: 'field span-all' }, h('span', null, 'Serviço (opcional)'), svc), form.children[1]);
  }
  // ao escolher paciente, sugere o profissional responsável
  form.inputs.patient_id.addEventListener('change', () => {
    const p = patients.find((x) => String(x.id) === form.inputs.patient_id.value);
    if (p?.professional_id) form.inputs.professional_id.value = p.professional_id;
  });

  const save = async (extra = {}, force = false) => {
    if (!form.validate()) return;
    const v = { ...form.getValues(), ...extra };
    const body = { patient_id: v.patient_id, professional_id: v.professional_id, start: `${v.date}T${v.time}`, duration: v.duration, kind: v.kind, status: v.status, price: v.price, notes: v.notes, repeat_weeks: v.repeat_weeks, force };
    try {
      if (isNew) await post('/appointments', body); else await put(`/appointments/${appt.id}`, body);
      m.close(); toast(isNew ? (Number(v.repeat_weeks) > 1 ? `${v.repeat_weeks} atendimentos agendados` : 'Atendimento agendado') : 'Agendamento atualizado'); onSaved();
    } catch (e) {
      if (e.status === 409) { if (await confirmDialog(`${e.message}.\nDeseja agendar mesmo assim?`, { okLabel: 'Agendar mesmo assim' })) save(extra, true); }
      else toast(e.message, 'error');
    }
  };
  const setStatus = (status) => { form.inputs.status.value = status; save(); };
  const remove = async () => {
    if (!(await confirmDialog('Excluir este agendamento? Para manter o histórico, prefira marcar como "Cancelado" ou "Falta".', { danger: true, okLabel: 'Excluir' }))) return;
    try { await del(`/appointments/${appt.id}`); m.close(); toast('Agendamento excluído'); onSaved(); } catch (e) { toast(e.message, 'error'); }
  };
  const quick = !isNew ? h('div', { class: 'row', style: { marginBottom: '14px', padding: '10px 12px', background: 'var(--surface-2)', borderRadius: '9px' } },
    h('small', { class: 'grow' }, 'Marcar como:'),
    h('button', { class: 'btn sm', onclick: () => setStatus('confirmado') }, 'Confirmado'),
    h('button', { class: 'btn sm', style: { color: 'var(--green)' }, onclick: () => setStatus('realizado') }, icon('check', 14), 'Realizado'),
    h('button', { class: 'btn sm', style: { color: 'var(--red)' }, onclick: () => setStatus('falta') }, 'Falta'),
    h('button', { class: 'btn sm', onclick: () => setStatus('cancelado') }, 'Cancelado')) : null;
  const m = modal({
    title: isNew ? 'Novo agendamento' : `Agendamento — ${appt.patient_name || ''}`,
    body: h('div', null, quick, form),
    actions: [
      !isNew ? h('button', { class: 'btn ghost', style: { marginRight: 'auto', color: 'var(--danger)' }, onclick: remove }, icon('trash', 16), 'Excluir') : null,
      !isNew ? h('button', { class: 'btn', onclick: () => { m.close(); go(`#/pacientes/${appt.patient_id}`); } }, 'Prontuário') : null,
      !isNew && isClinical() && appt.status === 'realizado' ? h('button', { class: 'btn', onclick: () => { m.close(); go(`#/registro/evolucao/novo/${appt.patient_id}`); } }, 'Registrar evolução') : null,
      h('button', { class: 'btn primary', onclick: () => save() }, icon('check', 16), 'Salvar'),
    ],
  });
}

// ======================= Agenda (dia / semana / mês) =======================
const saved = { mode: innerWidth < 700 ? 'day' : 'week', date: today(), prof: '' };

export async function agendaPage(view) {
  let { mode, prof } = saved; let cur = new Date(saved.date + 'T12:00');
  const title = h('div', { class: 'cal-title' });
  const box = h('div', { class: 'card', style: { overflow: 'hidden' } });
  const modeBtns = {};
  const range = () => {
    if (mode === 'day') { const s = new Date(cur); return [s, new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)]; }
    if (mode === 'week') { const s = new Date(cur); s.setDate(s.getDate() - s.getDay()); return [s, new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7)]; }
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1); const s = new Date(first); s.setDate(1 - first.getDay());
    const e = new Date(s); e.setDate(s.getDate() + 42); return [s, e];
  };
  const refresh = () => load();
  async function load() {
    saved.mode = mode; saved.date = ymd(cur); saved.prof = prof;
    Object.entries(modeBtns).forEach(([k, b]) => b.classList.toggle('on', k === mode));
    const [s, e] = range();
    const appts = await get('/appointments' + qs({ from: `${ymd(s)}T00:00`, to: `${ymd(e)}T00:00`, professional_id: prof }));
    if (mode === 'month') {
      title.textContent = `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`;
      box.replaceChildren(monthView(s, appts));
    } else {
      const days = mode === 'day' ? [s] : Array.from({ length: 7 }, (_, i) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + i));
      title.textContent = mode === 'day' ? `${WEEKDAYS[s.getDay()]}, ${s.getDate()} de ${MONTHS[s.getMonth()].toLowerCase()} de ${s.getFullYear()}`
        : `${days[0].getDate()} ${MONTHS[days[0].getMonth()].slice(0, 3).toLowerCase()} – ${days[6].getDate()} ${MONTHS[days[6].getMonth()].slice(0, 3).toLowerCase()} ${days[6].getFullYear()}`;
      box.replaceChildren(weekView(days, appts));
      const scroller = box.querySelector('.week-scroll'); if (scroller) scroller.scrollTop = HOUR_PX * 1;
    }
  }
  function weekView(days, appts) {
    const t = today();
    const grid = h('div', { class: `week ${days.length === 1 ? 'day-view' : ''}` });
    grid.append(h('div', { class: 'wk-head' }));
    for (const d of days) grid.append(h('div', { class: `wk-head ${ymd(d) === t ? 'today' : ''}`, style: { cursor: 'pointer' }, onclick: () => { mode = 'day'; cur = d; load(); } }, WEEKDAYS[d.getDay()], h('b', null, d.getDate())));
    const hours = h('div', { class: 'wk-hours' }); for (let i = START_H; i < END_H; i++) hours.append(h('div', { class: 'wk-hour' }, `${pad(i)}:00`));
    const body = h('div', { class: `week ${days.length === 1 ? 'day-view' : ''}` }, hours);
    for (const d of days) {
      const key = ymd(d);
      const col = h('div', { class: `wk-col ${key === t ? 'today' : ''}`, style: { height: `${(END_H - START_H) * HOUR_PX}px` } });
      col.addEventListener('click', (ev) => {
        if (ev.target !== col) return;
        const mins = Math.floor((ev.offsetY / HOUR_PX) * 60 / 30) * 30 + START_H * 60;
        appointmentModal({ date: key, time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` }, refresh);
      });
      for (const a of appts.filter((x) => x.start.slice(0, 10) === key)) {
        const [hh, mm] = a.start.slice(11, 16).split(':').map(Number);
        const top = ((hh - START_H) * 60 + mm) / 60 * HOUR_PX; const height = Math.max(22, (a.duration / 60) * HOUR_PX - 2);
        col.append(h('div', { class: `ev ${a.status}`, style: { top: `${Math.max(0, top)}px`, height: `${height}px` }, title: `${a.patient_name} — ${LABELS.appt[a.status]}`, onclick: () => appointmentModal(a, refresh) },
          h('b', null, a.patient_name), `${fmtTime(a.start)} · ${LABELS.kind[a.kind]}`));
      }
      body.append(col);
    }
    return h('div', null, h('div', { style: { overflowX: 'auto' } }, h('div', { style: { minWidth: days.length > 1 ? '820px' : '0' } }, grid, h('div', { class: 'week-scroll', style: { maxHeight: '68vh', overflowY: 'auto' } }, body))));
  }
  function monthView(start, appts) {
    const t = today();
    const g = h('div', { class: 'month' }, WEEKDAYS.map((w) => h('div', { class: 'm-head' }, w)));
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); const key = ymd(d);
      const list = appts.filter((x) => x.start.slice(0, 10) === key);
      g.append(h('div', { class: `m-cell ${d.getMonth() !== cur.getMonth() ? 'other' : ''} ${key === t ? 'today' : ''}`, onclick: (e) => { if (e.target.closest('.m-ev')) return; mode = 'day'; cur = d; load(); } },
        h('div', { class: 'd' }, d.getDate()),
        list.slice(0, 4).map((a) => h('div', { class: `m-ev ${a.status}`, onclick: () => appointmentModal(a, refresh) }, `${fmtTime(a.start)} ${a.patient_name}`)),
        list.length > 4 ? h('small', null, `+${list.length - 4} mais`) : null));
    }
    return g;
  }
  const move = (dir) => {
    if (mode === 'day') cur.setDate(cur.getDate() + dir);
    else if (mode === 'week') cur.setDate(cur.getDate() + 7 * dir);
    else cur = new Date(cur.getFullYear(), cur.getMonth() + dir, 1, 12);
    load();
  };
  const profSel = state.user.role !== 'fisio' && state.professionals.length > 1 ? h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { prof = e.target.value; load(); } },
    h('option', { value: '' }, 'Todos os profissionais'), state.professionals.map((p) => h('option', { value: p.id, selected: String(p.id) === String(prof) }, p.name))) : null;

  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Agenda'), h('p', null, 'Clique em um horário livre para agendar. Clique em um atendimento para alterar a situação.')),
      h('button', { class: 'btn primary', onclick: () => appointmentModal({ date: ymd(cur) }, refresh) }, icon('plus', 16), 'Novo agendamento')),
    h('div', { class: 'cal-toolbar' },
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { cur = new Date(); load(); } }, 'Hoje'),
        h('button', { class: 'icon-btn', 'aria-label': 'Anterior', onclick: () => move(-1) }, icon('chevL')),
        h('button', { class: 'icon-btn', 'aria-label': 'Próximo', onclick: () => move(1) }, icon('chevR')),
        title),
      h('div', { class: 'row' }, profSel,
        h('div', { class: 'btn-group' }, [['day', 'Dia'], ['week', 'Semana'], ['month', 'Mês']].map(([k, l]) => (modeBtns[k] = h('button', { onclick: () => { mode = k; load(); } }, l)))))),
    box,
    h('div', { class: 'legend', style: { marginTop: '10px' } }, [['#3b6ef0', 'Agendado'], ['#0f9488', 'Confirmado'], ['#22a04b', 'Realizado'], ['#dc2626', 'Falta'], ['#9aa5ae', 'Cancelado']].map(([c, l]) => h('span', null, h('i', { style: { background: c } }), l))));
  await load();
}

// ======================= Aba agenda do paciente =======================
export async function patientAppointments(body, p) {
  const rows = await get('/appointments' + qs({ patient_id: p.id, desc: 1 }));
  const refresh = () => dispatchEvent(new Event('fisio:refresh'));
  const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  body.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'row' }, Object.entries(LABELS.appt).map(([k, l]) => h('span', { class: 'muted', style: { fontSize: '12.5px' } }, `${l}: `, h('b', { style: { color: 'var(--text)' } }, counts[k] || 0)))),
      h('button', { class: 'btn primary sm', onclick: () => appointmentModal({ patient_id: p.id, professional_id: p.professional_id }, refresh) }, icon('plus', 15), 'Agendar')),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Data', 'Horário', 'Tipo', 'Profissional', 'Situação', 'Valor'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((a) => h('tr', { class: 'click', onclick: () => appointmentModal(a, refresh) },
        h('td', null, `${WEEKDAYS[new Date(a.start).getDay()]} ${fmtDate(a.start)}`), h('td', null, fmtTime(a.start)), h('td', null, LABELS.kind[a.kind]),
        h('td', null, a.professional_name || '—'), h('td', null, badge(a.status, 'appt')), h('td', null, a.price ? money(a.price) : '—'))))))
      : empty('Nenhum atendimento agendado para este paciente.')));
}

import { h, icon, money, fmtDate, fmtTime, badge, LABELS, WEEKDAYS, MONTHS, empty, today, ymd } from '../ui.js';
import { get } from '../api.js';
import { state, go, isClinical } from '../state.js';
import { barChart } from '../charts.js';
import { appointmentModal } from './agenda.js';

function kpi(label, value, ic, sub, tone = '', href) {
  return h(href ? 'a' : 'div', { class: `card kpi ${tone}`, href, style: href ? { color: 'inherit' } : null },
    h('div', { class: 'kpi-top' }, h('span', null, label), h('span', { class: 'kpi-ic' }, icon(ic, 16))),
    h('div', { class: 'kpi-val' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}

export async function dashboardPage(view) {
  const d = await get('/dashboard');
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const parts = state.user.name.split(' ');
  const first = /^(dr|dra|prof|profa).?$/i.test(parts[0]) && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0];

  // agrupa próximos atendimentos por dia
  const groups = {};
  for (const a of d.proximos) (groups[a.start.slice(0, 10)] ||= []).push(a);
  const t = today();
  const dayLabel = (k) => {
    const dt = new Date(k + 'T12:00');
    const tm = new Date(); tm.setDate(tm.getDate() + 1);
    if (k === t) return 'Hoje'; if (k === ymd(tm)) return 'Amanhã';
    return `${WEEKDAYS[dt.getDay()]}, ${fmtDate(k)}`;
  };

  view.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, `${greet}, ${first}`), h('p', null, `${WEEKDAYS[now.getDay()]}, ${now.getDate()} de ${MONTHS[now.getMonth()].toLowerCase()} de ${now.getFullYear()}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => go('#/pacientes/novo') }, icon('plus', 16), 'Novo paciente'),
        h('button', { class: 'btn primary', onclick: () => appointmentModal({}, () => dispatchEvent(new Event('fisio:refresh'))) }, icon('calendar', 16), 'Agendar atendimento'))),
    h('div', { class: 'kpis' },
      kpi('Pacientes cadastrados', d.total, 'users', 'Total no sistema', 'blue', '#/pacientes'),
      kpi('Em tratamento', d.em_tratamento, 'activity', 'Inclui pacientes em avaliação', '', '#/pacientes'),
      kpi('Tratamento finalizado', d.finalizado, 'check', 'Altas registradas', 'good'),
      kpi('Consultas agendadas', d.agendadas, 'calendar', 'A partir de agora', 'blue', '#/agenda'),
      kpi('Atendimentos no mês', d.realizados_mes, 'trending', d.faltas_mes ? `${d.faltas_mes} falta(s) no mês` : 'Sessões realizadas', 'good'),
      kpi('Faturamento do mês', money(d.faturamento_mes), 'wallet', 'Pagamentos recebidos', 'good', '#/financeiro'),
      kpi('Pagamentos pendentes', money(d.pendentes.v), 'alert', `${d.pendentes.n} lançamento(s)${d.vencidos.n ? ` · ${d.vencidos.n} vencido(s)` : ''}`, 'warn', '#/financeiro/pendentes')),
    h('div', { class: 'grid g-main' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Próximos atendimentos'), h('a', { href: '#/agenda', class: 'btn sm ghost' }, 'Ver agenda')),
        d.proximos.length ? h('div', { class: 'list' }, Object.entries(groups).map(([k, items]) => [
          h('div', { style: { padding: '10px 18px 4px', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' } }, dayLabel(k)),
          items.map((a) => h('div', { class: 'list-item click', onclick: () => appointmentModal(a, () => dispatchEvent(new Event('fisio:refresh'))) },
            h('div', { class: 'time-chip' }, fmtTime(a.start), h('small', null, `${a.duration} min`)),
            h('div', { class: 'grow' }, h('b', null, a.patient_name), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, LABELS.kind[a.kind], a.professional_name ? ` · ${a.professional_name}` : '', a.phone ? ` · ${a.phone}` : '')),
            badge(a.status, 'appt'))),
        ])) : empty('Nenhum atendimento agendado.', h('button', { class: 'btn primary', onclick: () => appointmentModal({}, () => dispatchEvent(new Event('fisio:refresh'))) }, 'Agendar'))),
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, 'Receita recebida — 6 meses')),
          h('div', { class: 'card-body' }, barChart(d.receita_6m.map((m) => ({ label: MONTHS[Number(m.month.slice(5)) - 1].slice(0, 3), value: m.value })), { format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)) }))),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, 'Atalhos')),
          h('div', { class: 'card-body', style: { display: 'grid', gap: '8px' } },
            isClinical() ? h('a', { class: 'btn', href: '#/evolucoes' }, icon('trending', 16), 'Registrar evolução') : null,
            h('a', { class: 'btn', href: '#/financeiro/pendentes' }, icon('wallet', 16), 'Receber pagamento'),
            h('a', { class: 'btn', href: '#/relatorios' }, icon('printer', 16), 'Emitir documentos'))))));
}

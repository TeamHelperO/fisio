import { h, icon, toast, buildForm, badge, fmtDate, empty, LABELS, confirmDialog, modal, today, ymd, money, MONTHS, downloadFile, debounce, csvCell } from '../ui.js';
import { recvStatus, requestPayLink } from './paylink.js';
import { get, post, put, del, qs } from '../api.js';
import { state, go, openPrint, isClinical } from '../state.js';
import { barChart } from '../charts.js';

const refresh = () => dispatchEvent(new Event('fisio:refresh'));
const METHOD_OPTS = Object.entries(LABELS.method);

// ======================= Modais =======================
export async function chargeModal(charge = {}, patientId) {
  const isNew = !charge.id;
  const patients = isNew && !patientId ? await get('/patients') : null;
  const fields = [
    patients ? { key: 'patient_id', label: 'Paciente', type: 'select', options: patients.map((p) => [p.id, p.name]), required: true, span: true } : null,
    { key: 'description', label: 'Descrição', required: true, span: true, placeholder: 'Ex.: Sessão de fisioterapia, Avaliação, Pacote mensal…' },
    { key: 'amount', label: 'Valor (R$)', type: 'number', step: '0.01', min: 0, required: true },
    { key: 'due_date', label: 'Vencimento', type: 'date', required: true },
    isNew ? { key: 'status', label: 'Situação', type: 'select', options: [['pendente', 'Pendente (a receber)'], ['pago', 'Já recebido']], empty: false } : null,
    isNew ? { key: 'method', label: 'Forma de pagamento (se recebido)', type: 'select', options: METHOD_OPTS } : null,
    isNew ? { key: 'paid_at', label: 'Data do recebimento', type: 'date' } : null,
    { key: 'professional_id', label: 'Profissional que recebe', type: 'select', options: state.professionals.map((p) => [p.id, p.name]), emptyLabel: '— Não definido —' },
    { key: 'notes', label: 'Observações', type: 'textarea', rows: 2 },
  ].filter(Boolean);
  const form = buildForm(fields, { due_date: today(), paid_at: today(), status: 'pendente', ...charge });
  const m = modal({ title: isNew ? 'Novo lançamento' : 'Editar lançamento', body: form, actions: [
    h('button', { class: 'btn primary', onclick: async () => {
      if (!form.validate()) return;
      const v = form.getValues();
      try {
        if (isNew) await post('/charges', { ...v, patient_id: v.patient_id || patientId }); else await put(`/charges/${charge.id}`, v);
        m.close(); toast('Lançamento salvo'); refresh();
      } catch (e) { toast(e.message, 'error'); }
    } }, icon('check', 16), 'Salvar')] });
}

export function payModal(c) {
  const form = buildForm([
    { key: 'paid_at', label: 'Data do pagamento', type: 'date', required: true },
    { key: 'method', label: 'Forma de pagamento', type: 'select', options: METHOD_OPTS, required: true },
    { key: 'payer_name', label: 'Nome do pagador (se diferente do paciente)', span: true, help: 'Para o Carnê-Leão, informe o CPF de quem efetivamente pagou (ex.: responsável legal).' },
    { key: 'payer_cpf', label: 'CPF do pagador', mask: 'cpf' },
  ], { paid_at: today(), method: 'pix' });
  const m = modal({ title: `Registrar pagamento — ${money(c.amount)}`, body: h('div', { class: 'stack' }, h('div', { class: 'muted' }, `${c.patient_name || ''} · ${c.description}`), form), actions: [
    h('button', { class: 'btn primary', onclick: async () => {
      if (!form.validate()) return;
      try {
        await post(`/charges/${c.id}/pay`, form.getValues()); m.close(); toast('Pagamento registrado');
        if (await confirmDialog('Pagamento registrado. Deseja emitir o recibo agora?', { okLabel: 'Emitir recibo', title: 'Recibo' })) openPrint('recibo', { id: c.id });
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    } }, icon('check', 16), 'Confirmar pagamento')] });
}

async function chargeActions(c) {
  const items = [];
  if (c.status === 'pendente') items.push(h('button', { class: 'btn sm primary', onclick: (e) => { e.stopPropagation(); payModal(c); } }, 'Receber'));
  if (c.status === 'pendente' && (await recvStatus()).connected) items.push(h('button', { class: 'btn sm', title: 'Link do Mercado Pago para o paciente pagar com Pix ou cartão', onclick: (e) => { e.stopPropagation(); requestPayLink(c.id); } }, c.pay_url ? 'Link enviado' : 'Link de pagamento'));
  if (c.status === 'pago') items.push(h('button', { class: 'btn sm', title: 'Recibo', onclick: (e) => { e.stopPropagation(); openPrint('recibo', { id: c.id }); } }, icon('receipt', 14), 'Recibo'));
  return items;
}
function chargeMenu(c) {
  const close = () => m.close();
  const act = async (fn) => { try { await fn(); close(); refresh(); } catch (e) { toast(e.message, 'error'); } };
  const m = modal({ title: 'Lançamento', body: h('div', { class: 'stack' },
    h('dl', { class: 'dl' }, [['Paciente', c.patient_name], ['Descrição', c.description], ['Valor', money(c.amount)], ['Vencimento', fmtDate(c.due_date)], ['Situação', LABELS.charge[c.status]],
      c.paid_at ? ['Pago em', fmtDate(c.paid_at)] : null, c.method ? ['Forma', LABELS.method[c.method]] : null, c.receipt_number ? ['Recibo nº', c.receipt_number] : null,
      c.payer_name ? ['Pagador', `${c.payer_name} ${c.payer_cpf || ''}`] : null, c.notes ? ['Observações', c.notes] : null].filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
  actions: [
    c.status === 'pago' ? h('button', { class: 'btn', onclick: () => confirmDialog('Estornar este pagamento? O lançamento volta a ficar pendente e o recibo é invalidado.', { danger: true, okLabel: 'Estornar' }).then((ok) => ok && act(() => post(`/charges/${c.id}/status`, { status: 'pendente' }))) }, 'Estornar') : null,
    c.status === 'pendente' ? h('button', { class: 'btn', onclick: () => confirmDialog('Cancelar esta cobrança?', { okLabel: 'Cancelar cobrança', danger: true }).then((ok) => ok && act(() => post(`/charges/${c.id}/status`, { status: 'cancelado' }))) }, 'Cancelar cobrança') : null,
    c.status !== 'pago' && isClinical() ? h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: () => confirmDialog('Excluir este lançamento?', { danger: true, okLabel: 'Excluir' }).then((ok) => ok && act(() => del(`/charges/${c.id}`))) }, icon('trash', 15), 'Excluir') : null,
    h('button', { class: 'btn', onclick: () => { close(); chargeModal(c); } }, icon('edit', 15), 'Editar'),
    c.status === 'pago' ? h('button', { class: 'btn', onclick: () => openPrint('recibo', { id: c.id }) }, icon('receipt', 15), 'Recibo') : null,
    c.status === 'pendente' ? h('button', { class: 'btn', onclick: () => { close(); requestPayLink(c.id); } }, 'Link do Mercado Pago') : null,
    c.status === 'pendente' ? h('button', { class: 'btn primary', onclick: () => { close(); payModal(c); } }, 'Registrar pagamento') : null,
  ] });
}

async function chargesTable(rows, { showPatient = true } = {}) {
  if (!rows.length) return empty('Nenhum lançamento encontrado.');
  const total = rows.filter((r) => r.status !== 'cancelado').reduce((s, r) => s + r.amount, 0);
  const tr = await Promise.all(rows.map(async (c) => {
    const overdue = c.status === 'pendente' && c.due_date < today();
    return h('tr', { class: 'click', onclick: () => chargeMenu(c) },
      h('td', { class: 'nowrap' }, fmtDate(c.paid_at || c.due_date), overdue ? h('div', null, h('span', { class: 'badge red' }, 'Vencido')) : null),
      showPatient ? h('td', null, h('b', null, c.patient_name)) : null,
      h('td', null, c.description, c.receipt_number ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `Recibo ${c.receipt_number}`) : null),
      h('td', { class: 'hide-sm' }, c.method ? LABELS.method[c.method] : '—'),
      h('td', null, badge(c.status, 'charge')),
      h('td', { class: 'right nowrap' }, h('b', null, money(c.amount))),
      h('td', { class: 'actions' }, await chargeActions(c)));
  }));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, 'Data'), showPatient ? h('th', null, 'Paciente') : null, h('th', null, 'Descrição'), h('th', { class: 'hide-sm' }, 'Forma'), h('th', null, 'Situação'), h('th', { class: 'right' }, 'Valor'), h('th', null, ''))),
    h('tbody', null, tr),
    h('tfoot', null, h('tr', null, h('td', { colSpan: showPatient ? 5 : 4 }, `${rows.length} lançamento(s)`), h('td', { class: 'right nowrap' }, money(total)), h('td')))));
}

// ======================= Página Financeiro =======================
const TABS = [['lancamentos', 'Lançamentos'], ['pendentes', 'Pendentes'], ['pacotes', 'Pacotes'], ['precos', 'Valores e pacotes'], ['relatorio', 'Relatório de receitas'], ['carneleao', 'Carnê-Leão']];

export async function financePage(view, [tab = 'lancamentos']) {
  const tabs = TABS.filter((t) => t[0] !== 'carneleao' || isClinical());
  const body = h('div');
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Financeiro'), h('p', null, 'Módulo independente do prontuário clínico: valores, pacotes, pagamentos e receitas.')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => chargeModal() }, icon('plus', 16), 'Novo lançamento'))),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { href: `#/financeiro/${k}`, class: k === tab ? 'on' : '' }, l))),
    body);
  const T = { lancamentos, pendentes, pacotes, precos, relatorio, carneleao };
  if (!T[tab]) return;
  await T[tab](body);
}

const fState = { month: today().slice(0, 7), status: '' };
async function lancamentos(body) {
  const monthIn = h('input', { class: 'input', type: 'month', value: fState.month, style: { width: 'auto' } });
  const statusSel = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'Todas as situações'), Object.entries(LABELS.charge).map(([k, v]) => h('option', { value: k }, v)));
  statusSel.value = fState.status;
  const wrap = h('div');
  const summary = h('div', { class: 'kpis' });
  const load = async () => {
    fState.month = monthIn.value; fState.status = statusSel.value;
    const [y, m] = monthIn.value.split('-').map(Number);
    const from = `${monthIn.value}-01`; const to = ymd(new Date(y, m, 0));
    const [paid, due] = await Promise.all([
      get('/charges' + qs({ by: 'paid', from, to, status: 'pago' })),
      get('/charges' + qs({ from, to })),
    ]);
    // lançamentos do mês: recebidos no mês + vencimentos do mês (sem duplicar)
    const map = new Map(); [...paid, ...due].forEach((c) => map.set(c.id, c));
    let rows = [...map.values()].sort((a, b) => (b.paid_at || b.due_date).localeCompare(a.paid_at || a.due_date));
    if (statusSel.value) rows = rows.filter((r) => r.status === statusSel.value);
    const recebido = paid.reduce((s, c) => s + c.amount, 0);
    const pend = due.filter((c) => c.status === 'pendente').reduce((s, c) => s + c.amount, 0);
    summary.replaceChildren(
      h('div', { class: 'card kpi good' }, h('div', { class: 'kpi-top' }, 'Recebido no mês', h('span', { class: 'kpi-ic' }, icon('wallet', 16))), h('div', { class: 'kpi-val' }, money(recebido)), h('div', { class: 'kpi-sub' }, `${paid.length} pagamento(s)`)),
      h('div', { class: 'card kpi warn' }, h('div', { class: 'kpi-top' }, 'A receber (vencimento no mês)', h('span', { class: 'kpi-ic' }, icon('clock', 16))), h('div', { class: 'kpi-val' }, money(pend))),
      h('div', { class: 'card kpi blue' }, h('div', { class: 'kpi-top' }, 'Previsto no mês', h('span', { class: 'kpi-ic' }, icon('trending', 16))), h('div', { class: 'kpi-val' }, money(recebido + pend))));
    wrap.replaceChildren(await chargesTable(rows));
  };
  monthIn.onchange = load; statusSel.onchange = load;
  body.append(summary, h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'row' }, monthIn, statusSel)), wrap));
  await load();
}

async function pendentes(body) {
  const rows = await get('/charges' + qs({ status: 'pendente' }));
  rows.sort((a, b) => a.due_date.localeCompare(b.due_date));
  const total = rows.reduce((s, c) => s + c.amount, 0);
  const overdue = rows.filter((c) => c.due_date < today());
  body.append(
    h('div', { class: 'kpis' },
      h('div', { class: 'card kpi warn' }, h('div', { class: 'kpi-top' }, 'Total pendente'), h('div', { class: 'kpi-val' }, money(total)), h('div', { class: 'kpi-sub' }, `${rows.length} lançamento(s)`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, 'Vencidos'), h('div', { class: 'kpi-val', style: { color: 'var(--red)' } }, money(overdue.reduce((s, c) => s + c.amount, 0))), h('div', { class: 'kpi-sub' }, `${overdue.length} lançamento(s)`))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Pagamentos pendentes'), h('small', null, 'Ordenados por vencimento')), await chargesTable(rows)));
}

async function pacotes(body) {
  const [rows, pkgs] = await Promise.all([get('/patient-packages'), get('/packages')]);
  body.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Pacotes contratados'), h('button', { class: 'btn primary sm', onclick: () => packageModal(null, pkgs) }, icon('plus', 15), 'Vincular pacote a paciente')),
    rows.length ? packagesTable(rows) : empty('Nenhum pacote contratado.')));
}
function packagesTable(rows, showPatient = true) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, showPatient ? h('th', null, 'Paciente') : null, ['Pacote', 'Vigência', 'Sessões usadas', 'Valor', 'Pagamento', 'Situação', ''].map((t) => h('th', null, t)))),
    h('tbody', null, rows.map((r) => h('tr', null,
      showPatient ? h('td', null, h('a', { href: `#/pacientes/${r.patient_id}/financeiro` }, r.patient_name)) : null,
      h('td', null, r.name), h('td', { class: 'nowrap' }, `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`),
      h('td', null, h('b', { style: { color: r.used > r.sessions ? 'var(--red)' : 'inherit' } }, `${r.used} / ${r.sessions}`)),
      h('td', { class: 'nowrap' }, money(r.price)), h('td', null, r.charge_status ? badge(r.charge_status, 'charge') : '—'),
      h('td', null, badge(r.status)),
      h('td', { class: 'actions' }, r.status === 'ativo' ? h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog('Encerrar este pacote?', { okLabel: 'Encerrar' })) { await put(`/patient-packages/${r.id}`, { status: 'encerrado' }); refresh(); } } }, 'Encerrar') : null))))));
}
export async function packageModal(patientId, pkgs) {
  pkgs = pkgs || await get('/packages');
  const patients = patientId ? null : await get('/patients');
  const active = pkgs.filter((p) => p.active);
  const form = buildForm([
    patients ? { key: 'patient_id', label: 'Paciente', type: 'select', options: patients.map((p) => [p.id, p.name]), required: true, span: true } : null,
    { key: 'package_id', label: 'Pacote', type: 'select', options: active.map((p) => [p.id, `${p.name} — ${p.sessions} sessões — ${money(p.price)}`]), emptyLabel: 'Personalizado', span: true },
    { key: 'name', label: 'Nome (se personalizado)' },
    { key: 'sessions', label: 'Nº de sessões' , type: 'number', min: 1 },
    { key: 'price', label: 'Valor (R$)', type: 'number', step: '0.01', min: 0 },
    { key: 'start_date', label: 'Início da vigência', type: 'date', required: true },
    { key: 'end_date', label: 'Fim da vigência', type: 'date', help: 'Em branco = 1 mês a partir do início' },
    { key: 'due_date', label: 'Vencimento do pagamento', type: 'date' },
  ].filter(Boolean), { start_date: today() });
  form.inputs.package_id.addEventListener('change', () => {
    const p = active.find((x) => String(x.id) === form.inputs.package_id.value);
    if (p) { form.inputs.name.value = p.name; form.inputs.sessions.value = p.sessions; form.inputs.price.value = p.price; }
  });
  const m = modal({ title: 'Vincular pacote mensal', body: h('div', { class: 'stack' }, h('div', { class: 'notice info' }, icon('wallet'), 'Será gerada uma cobrança no valor do pacote. Agende as sessões com valor R$ 0 para não duplicar a cobrança.'), form), actions: [
    h('button', { class: 'btn primary', onclick: async () => {
      if (!form.validate()) return;
      const v = form.getValues();
      if (!v.package_id && (!v.sessions || !v.price)) return toast('Informe sessões e valor do pacote personalizado', 'error');
      try { await post('/patient-packages', { ...v, patient_id: v.patient_id || patientId }); m.close(); toast('Pacote vinculado'); refresh(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Salvar')] });
}

async function precos(body) {
  const [services, pkgs] = await Promise.all([get('/services'), get('/packages')]);
  const edit = (kind, item = {}) => {
    const fields = kind === 'services'
      ? [{ key: 'name', label: 'Nome do serviço', required: true, span: true, placeholder: 'Ex.: Sessão de fisioterapia ortopédica' }, { key: 'price', label: 'Valor por atendimento (R$)', type: 'number', step: '0.01', required: true }, { key: 'duration', label: 'Duração (min)', type: 'number', default: 50 }]
      : [{ key: 'name', label: 'Nome do pacote', required: true, span: true, placeholder: 'Ex.: Pacote mensal 2x/semana' }, { key: 'sessions', label: 'Sessões incluídas', type: 'number', required: true }, { key: 'price', label: 'Valor mensal (R$)', type: 'number', step: '0.01', required: true }];
    const form = buildForm(fields, item);
    const m = modal({ title: item.id ? 'Editar' : kind === 'services' ? 'Novo valor por atendimento' : 'Novo pacote mensal', body: form, actions: [
      item.id ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => { await put(`/${kind}/${item.id}`, { active: !item.active }); m.close(); refresh(); } }, item.active ? 'Desativar' : 'Reativar') : null,
      h('button', { class: 'btn primary', onclick: async () => { if (!form.validate()) return; try { item.id ? await put(`/${kind}/${item.id}`, form.getValues()) : await post(`/${kind}`, form.getValues()); m.close(); toast('Salvo'); refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Salvar')] });
  };
  const table = (kind, rows, cols) => rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c[0])), h('th'))),
    h('tbody', null, rows.map((r) => h('tr', { class: 'click', onclick: () => edit(kind, r), style: { opacity: r.active ? 1 : 0.5 } }, cols.map((c) => h('td', null, c[1](r))), h('td', null, r.active ? '' : badge('inativo', 'status')))))))
    : empty('Nenhum item cadastrado.');
  body.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Valores por atendimento'), h('button', { class: 'btn sm primary', onclick: () => edit('services') }, icon('plus', 15), 'Novo')),
      table('services', services, [['Serviço', (r) => r.name], ['Duração', (r) => `${r.duration} min`], ['Valor', (r) => money(r.price)]])),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Pacotes mensais'), h('button', { class: 'btn sm primary', onclick: () => edit('packages') }, icon('plus', 15), 'Novo')),
      table('packages', pkgs, [['Pacote', (r) => r.name], ['Sessões', (r) => r.sessions], ['Valor', (r) => money(r.price)], ['Por sessão', (r) => money(r.price / r.sessions)]]))));
}

const rState = { from: `${new Date().getFullYear()}-01-01`, to: today() };
async function relatorio(body) {
  const from = h('input', { class: 'input', type: 'date', value: rState.from, style: { width: 'auto' } });
  const to = h('input', { class: 'input', type: 'date', value: rState.to, style: { width: 'auto' } });
  const out = h('div', { class: 'stack' });
  const load = async () => {
    rState.from = from.value; rState.to = to.value;
    const r = await get('/finance/report' + qs({ from: from.value, to: to.value }));
    const tbl = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, head.map((x, i) => h('th', { class: i ? 'right' : '' }, x)))), h('tbody', null, rows)));
    out.replaceChildren(
      h('div', { class: 'kpis' },
        h('div', { class: 'card kpi good' }, h('div', { class: 'kpi-top' }, 'Receita no período'), h('div', { class: 'kpi-val' }, money(r.total.v)), h('div', { class: 'kpi-sub' }, `${r.total.n} recebimento(s)`)),
        h('div', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, 'Ticket médio'), h('div', { class: 'kpi-val' }, money(r.total.n ? r.total.v / r.total.n : 0))),
        h('div', { class: 'card kpi warn' }, h('div', { class: 'kpi-top' }, 'Pendente (venc. no período)'), h('div', { class: 'kpi-val' }, money(r.pendente.v)), h('div', { class: 'kpi-sub' }, `${r.pendente.n} lançamento(s)`))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Faturamento mensal')),
        h('div', { class: 'card-body' }, r.por_mes.length ? barChart(r.por_mes.map((m) => ({ label: `${MONTHS[+m.month.slice(5) - 1].slice(0, 3)}/${m.month.slice(2, 4)}`, value: m.v })), { format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)) }) : empty('Sem receitas no período.'))),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Por forma de pagamento')), tbl(['Forma', 'Qtd.', 'Total'], r.por_forma.map((x) => h('tr', null, h('td', null, LABELS.method[x.method] || '—'), h('td', { class: 'right' }, x.n), h('td', { class: 'right' }, money(x.v)))))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Por mês')), tbl(['Mês', 'Qtd.', 'Total'], r.por_mes.map((x) => h('tr', null, h('td', null, `${MONTHS[+x.month.slice(5) - 1]}/${x.month.slice(0, 4)}`), h('td', { class: 'right' }, x.n), h('td', { class: 'right' }, money(x.v))))))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Por paciente')), tbl(['Paciente', 'Qtd.', 'Total'], r.por_paciente.map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'right' }, x.n), h('td', { class: 'right' }, money(x.v)))))));
  };
  from.onchange = load; to.onchange = load;
  body.append(h('div', { class: 'row', style: { marginBottom: '14px' } }, h('span', null, 'Período:'), from, h('span', null, 'a'), to,
    h('button', { class: 'btn', onclick: () => openPrint('receitas', { from: from.value, to: to.value }) }, icon('printer', 16), 'PDF do relatório')), out);
  await load();
}

async function carneleao(body) {
  let year = String(new Date().getFullYear()); let prof = state.user.role === 'fisio' ? state.user.id : (state.professionals[0]?.id || '');
  const out = h('div', { class: 'stack' });
  const yearSel = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { year = e.target.value; load(); } },
    Array.from({ length: 6 }, (_, i) => String(new Date().getFullYear() - i)).map((y) => h('option', { value: y }, y)));
  const profSel = state.user.role !== 'fisio' ? h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { prof = e.target.value; load(); } },
    h('option', { value: '' }, 'Todos os profissionais'), state.professionals.map((p) => h('option', { value: p.id, selected: String(p.id) === String(prof) }, p.name))) : null;
  let data = null;
  const load = async () => {
    data = await get('/finance/carne-leao' + qs({ year, professional_id: prof }));
    const byMonth = Array.from({ length: 12 }, (_, i) => ({ m: i, rows: data.rows.filter((r) => +r.paid_at.slice(5, 7) === i + 1) }));
    const missingCpf = data.rows.filter((r) => !r.payer_cpf && !r.patient_cpf).length;
    out.replaceChildren(
      missingCpf ? h('div', { class: 'notice' }, icon('alert'), `${missingCpf} recebimento(s) sem CPF do pagador/paciente. O Carnê-Leão exige o CPF do titular do pagamento — complete os cadastros.`) : null,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, `Resumo mensal — ${year}`), h('h2', null, money(data.rows.reduce((s, r) => s + r.amount, 0)))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Mês'), h('th', { class: 'right' }, 'Recebimentos'), h('th', { class: 'right' }, 'Total recebido'))),
          h('tbody', null, byMonth.map(({ m, rows }) => h('tr', null, h('td', null, MONTHS[m]), h('td', { class: 'right' }, rows.length), h('td', { class: 'right' }, money(rows.reduce((s, r) => s + r.amount, 0))))))))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Receitas recebidas (detalhado)'), h('small', null, 'Data · paciente/beneficiário · pagador · CPF · valor')),
        data.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['Data', 'Paciente (beneficiário)', 'CPF paciente', 'Pagador', 'CPF pagador', 'Forma', 'Recibo', 'Valor'].map((t) => h('th', null, t)))),
          h('tbody', null, data.rows.map((r) => h('tr', null, h('td', { class: 'nowrap' }, fmtDate(r.paid_at)), h('td', null, r.patient_name), h('td', { class: 'nowrap' }, r.patient_cpf || h('span', { class: 'badge red' }, 'sem CPF')),
            h('td', null, r.payer_name || 'O próprio paciente'), h('td', { class: 'nowrap' }, r.payer_cpf || r.patient_cpf || '—'), h('td', null, LABELS.method[r.method] || '—'), h('td', null, r.receipt_number || '—'), h('td', { class: 'right nowrap' }, money(r.amount))))))) : empty('Nenhuma receita recebida neste ano.')));
  };
  const exportCsv = () => {
    if (!data) return;
    const esc = csvCell;
    const lines = [['Data do recebimento', 'Mês', 'Paciente (beneficiário)', 'CPF do paciente', 'Pagador', 'CPF do pagador', 'Forma de pagamento', 'Nº recibo', 'Descrição', 'Profissional', 'Valor (R$)'].map(esc).join(';')];
    for (const r of data.rows) lines.push([fmtDate(r.paid_at), r.paid_at.slice(0, 7), r.patient_name, r.patient_cpf, r.payer_name || r.patient_name, r.payer_cpf || r.patient_cpf, LABELS.method[r.method], r.receipt_number, r.description, r.professional_name, r.amount.toFixed(2).replace('.', ',')].map(esc).join(';'));
    downloadFile(`carne-leao-${year}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  };
  body.append(
    h('div', { class: 'notice info', style: { marginBottom: '14px' } }, icon('shield'), h('div', null, h('b', null, 'Organização de dados para o Carnê-Leão. '),
      'Esta área apenas consolida as receitas efetivamente recebidas de pessoas físicas, com datas, identificação dos pacientes/pagadores e formas de pagamento. ',
      h('b', null, 'O sistema não calcula imposto'), ' — a apuração deve ser feita no programa oficial da Receita Federal (Carnê-Leão Web, no e-CAC) e validada com um contador, conforme as regras fiscais vigentes.')),
    h('div', { class: 'row', style: { marginBottom: '14px' } }, h('span', null, 'Ano:'), yearSel, profSel,
      h('button', { class: 'btn', onclick: exportCsv }, icon('download', 16), 'Exportar planilha (CSV)'),
      h('button', { class: 'btn', onclick: () => openPrint('carneleao', { year, professional_id: prof }) }, icon('printer', 16), 'PDF')),
    out);
  await load();
}

// ======================= Aba financeiro do paciente =======================
export async function patientFinance(body, p) {
  const [rows, pkgs] = await Promise.all([get('/charges' + qs({ patient_id: p.id })), get('/patient-packages' + qs({ patient_id: p.id }))]);
  const paid = rows.filter((r) => r.status === 'pago').reduce((s, r) => s + r.amount, 0);
  const pend = rows.filter((r) => r.status === 'pendente').reduce((s, r) => s + r.amount, 0);
  body.append(
    h('div', { class: 'kpis' },
      h('div', { class: 'card kpi good' }, h('div', { class: 'kpi-top' }, 'Total pago'), h('div', { class: 'kpi-val' }, money(paid))),
      h('div', { class: 'card kpi warn' }, h('div', { class: 'kpi-top' }, 'Em aberto'), h('div', { class: 'kpi-val' }, money(pend)))),
    h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'card-head' }, h('h2', null, 'Histórico financeiro'), h('button', { class: 'btn sm primary', onclick: () => chargeModal({}, p.id) }, icon('plus', 15), 'Novo lançamento')),
      await chargesTable(rows, { showPatient: false })),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Pacotes'), h('button', { class: 'btn sm', onclick: () => packageModal(p.id) }, icon('plus', 15), 'Vincular pacote')),
      pkgs.length ? packagesTable(pkgs, false) : empty('Nenhum pacote contratado.')));
}

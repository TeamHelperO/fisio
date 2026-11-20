import { h, icon, toast, buildForm, badge, fmtDate, fmtDT, age, empty, debounce, LABELS, confirmDialog, modal, downloadFile, today } from '../ui.js';
import { get, post, put, del, qs } from '../api.js';
import { state, go, back, isClinical, isAdmin, openPrint } from '../state.js';
import { recordTab, evolutionsTab, painSeries } from './records.js';
import { patientAppointments } from './agenda.js';
import { patientFinance } from './finance.js';
import { lineChart } from '../charts.js';

const profOptions = () => state.professionals.map((p) => [p.id, p.name]);

// ======================= Lista =======================
export async function patientsPage(view, _p, query) {
  let status = query.get('status') || '';
  let term = '';
  const tbody = h('tbody');
  const countEl = h('span', { class: 'muted' });
  async function load() {
    const rows = await get('/patients' + qs({ q: term, status }));
    countEl.textContent = `${rows.length} paciente(s)`;
    if (!rows.length) { tbody.replaceChildren(h('tr', null, h('td', { colSpan: 7 }, empty(term || status ? 'Nenhum paciente encontrado com esses filtros.' : 'Nenhum paciente cadastrado ainda.')))); return; }
    tbody.replaceChildren(...rows.map((p) => h('tr', { class: 'click', onclick: () => go(`#/pacientes/${p.id}`) },
      h('td', null, h('b', null, p.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, p.birth_date ? `${age(p.birth_date)} anos` : '', p.cpf ? ` · ${p.cpf}` : '')),
      h('td', { class: 'hide-sm' }, p.phone || '—'),
      h('td', null, badge(p.status, 'status')),
      h('td', { class: 'hide-sm' }, p.professional_name || '—'),
      h('td', { class: 'hide-sm nowrap' }, p.last_visit ? fmtDate(p.last_visit) : '—'),
      h('td', { class: 'hide-sm nowrap' }, p.next_visit ? fmtDT(p.next_visit) : '—'),
      h('td', { class: 'hide-sm' }, p.consent ? h('span', { class: 'badge green', title: 'Consentimento LGPD registrado' }, 'LGPD ✓') : h('span', { class: 'badge amber', title: 'Consentimento LGPD pendente' }, 'Pendente')))));
  }
  const search = h('input', { class: 'input', placeholder: 'Buscar por nome, CPF ou telefone', oninput: debounce((e) => { term = e.target.value.trim(); load(); }) });
  const sel = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { status = e.target.value; load(); } },
    h('option', { value: '' }, 'Todas as situações'), Object.entries(LABELS.status).map(([k, v]) => h('option', { value: k, selected: k === status }, v)));
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Pacientes'), h('p', null, 'Cadastro e prontuário individual de cada paciente.')),
      h('button', { class: 'btn primary', onclick: () => go('#/pacientes/novo') }, icon('plus', 16), 'Novo paciente')),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'row grow' }, h('div', { class: 'search' }, icon('search', 16), search), sel), countEl),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Paciente'), h('th', { class: 'hide-sm' }, 'Telefone'), h('th', null, 'Situação'), h('th', { class: 'hide-sm' }, 'Profissional'), h('th', { class: 'hide-sm' }, 'Último atend.'), h('th', { class: 'hide-sm' }, 'Próximo'), h('th', { class: 'hide-sm' }, 'LGPD'))),
        tbody))));
  await load();
  setTimeout(() => search.focus(), 50);
}

// ======================= Formulário =======================
export const PATIENT_FIELDS = () => [
  { type: 'section', label: 'Identificação' },
  { key: 'name', label: 'Nome completo', required: true, span: true },
  { key: 'birth_date', label: 'Data de nascimento', type: 'date' },
  { key: 'cpf', label: 'CPF', mask: 'cpf', placeholder: '000.000.000-00' },
  { key: 'phone', label: 'Telefone / WhatsApp', mask: 'phone', placeholder: '(00) 00000-0000' },
  { key: 'email', label: 'E-mail', type: 'email' },
  { key: 'address', label: 'Endereço', span: true, placeholder: 'Rua, número, bairro, cidade/UF, CEP' },
  { key: 'profession', label: 'Profissão' },
  { key: 'first_visit', label: 'Data do primeiro atendimento', type: 'date' },
  { type: 'section', label: 'Contato de emergência' },
  { key: 'emergency_name', label: 'Nome / parentesco' },
  { key: 'emergency_phone', label: 'Telefone', mask: 'phone' },
  { type: 'section', label: 'Acompanhamento' },
  { key: 'status', label: 'Situação', type: 'select', options: Object.entries(LABELS.status), empty: false, default: 'avaliacao' },
  { key: 'professional_id', label: 'Fisioterapeuta responsável', type: 'select', options: profOptions(), emptyLabel: '— Não definido —' },
  { key: 'notes', label: 'Observações administrativas', type: 'textarea' },
];

export async function patientFormPage(view, [id]) {
  const p = id ? await get(`/patients/${id}`) : { first_visit: today(), professional_id: state.user.role !== 'recepcao' ? state.user.id : '' };
  const form = buildForm(PATIENT_FIELDS(), p);
  const consentBox = !id ? h('label', { class: 'check', style: { borderRadius: '8px', padding: '10px 12px' } }, h('input', { type: 'checkbox', id: 'consent-now' }),
    h('span', null, 'O paciente assinou o Termo de Consentimento LGPD (registrar agora)')) : null;
  const save = async () => {
    if (!form.validate()) return;
    try {
      const v = form.getValues();
      if (id) { await put(`/patients/${id}`, v); toast('Cadastro atualizado'); go(`#/pacientes/${id}`); }
      else {
        const r = await post('/patients', v);
        if (consentBox.querySelector('input').checked) await post(`/patients/${r.id}/consents`, { method: 'assinatura_fisica', signer_name: v.name });
        toast('Paciente cadastrado'); go(`#/pacientes/${r.id}`);
      }
    } catch (e) { toast(e.message, 'error'); }
  };
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('a', { class: 'crumb', href: id ? `#/pacientes/${id}` : '#/pacientes' }, '← Voltar'), h('h1', null, id ? 'Editar cadastro' : 'Novo paciente'))),
    h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, form, consentBox,
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: () => back() }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: save }, icon('check', 16), 'Salvar')))));
}

// ======================= Prontuário =======================
const TABS = [
  ['resumo', 'Resumo'], ['anamnese', 'Anamnese', true], ['avaliacoes', 'Avaliações', true], ['plano', 'Plano de tratamento', true],
  ['evolucoes', 'Evoluções', true], ['agenda', 'Agenda'], ['financeiro', 'Financeiro'], ['documentos', 'Documentos'], ['lgpd', 'LGPD e privacidade'],
];

export async function patientPage(view, [id, tab = 'resumo']) {
  const p = await get(`/patients/${id}`);
  const initials = p.name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const tabs = TABS.filter((t) => !t[2] || isClinical());
  const body = h('div');
  view.append(
    h('a', { class: 'crumb', href: '#/pacientes' }, '← Pacientes'),
    h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'patient-head' },
        h('div', { class: 'avatar' }, initials),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('h1', null, p.name), badge(p.status, 'status'), !p.consent ? h('span', { class: 'badge amber' }, 'Consentimento LGPD pendente') : null),
          h('div', { class: 'meta' },
            p.birth_date ? h('span', null, `${age(p.birth_date)} anos (${fmtDate(p.birth_date)})`) : null,
            p.phone ? h('span', null, p.phone) : null,
            p.profession ? h('span', null, p.profession) : null,
            h('span', null, `Responsável: ${p.professional_name || '—'}`))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => go(`#/pacientes/${id}/editar`) }, icon('edit', 16), 'Editar'),
          isClinical() ? h('button', { class: 'btn primary', onclick: () => go(`#/registro/evolucao/novo/${id}`) }, icon('plus', 16), 'Nova evolução') : null))),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { href: `#/pacientes/${id}/${k}`, class: k === tab ? 'on' : '' }, l))),
    body);

  const T = {
    resumo: () => summaryTab(body, p),
    anamnese: () => recordTab(body, p, 'anamnese'),
    avaliacoes: () => recordTab(body, p, 'avaliacao'),
    plano: () => recordTab(body, p, 'plano'),
    evolucoes: () => evolutionsTab(body, p),
    agenda: () => patientAppointments(body, p),
    financeiro: () => patientFinance(body, p),
    documentos: () => documentsTab(body, p),
    lgpd: () => lgpdTab(body, p),
  };
  if (!T[tab] || (TABS.find((t) => t[0] === tab)?.[2] && !isClinical())) return body.append(h('div', { class: 'notice' }, icon('shield'), 'Acesso não permitido.'));
  await T[tab]();
}

async function summaryTab(body, p) {
  const dl = (pairs) => h('dl', { class: 'dl' }, pairs.filter(([, v]) => v).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  const cards = [
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Dados cadastrais')),
      h('div', { class: 'card-body' }, dl([
        ['Nome completo', p.name], ['Data de nascimento', p.birth_date && `${fmtDate(p.birth_date)} (${age(p.birth_date)} anos)`], ['CPF', p.cpf],
        ['Telefone / WhatsApp', p.phone], ['E-mail', p.email], ['Endereço', p.address], ['Profissão', p.profession],
        ['Contato de emergência', [p.emergency_name, p.emergency_phone].filter(Boolean).join(' — ')], ['Primeiro atendimento', p.first_visit && fmtDate(p.first_visit)],
        ['Cadastrado em', fmtDT(p.created_at.replace(' ', 'T'))], ['Observações', p.notes],
      ]))),
  ];
  const side = [
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Acompanhamento')),
      h('div', { class: 'card-body' }, dl([
        ['Sessões realizadas', String(p.counts.realizados)], ['Faltas', String(p.counts.faltas)],
        isClinical() ? ['Evoluções registradas', String(p.counts.evolucao || 0)] : [],
        isClinical() ? ['Avaliações', String(p.counts.avaliacao || 0)] : [],
        ['Próximo atendimento', p.next ? fmtDT(p.next.start) : 'Nenhum agendado'],
        ['Em aberto (financeiro)', p.counts.pendente ? p.counts.pendente.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Nada pendente'],
        ['Consentimento LGPD', p.consent ? `Registrado em ${fmtDate(p.consent.accepted_at)} (v${p.consent.term_version})` : 'PENDENTE'],
      ]))),
  ];
  if (isClinical()) {
    const [plans, evols] = await Promise.all([get(`/records${qs({ type: 'plano', patient_id: p.id, full: 1 })}`), get(`/records${qs({ type: 'evolucao', patient_id: p.id, full: 1 })}`)]);
    const plan = plans.find((x) => x.status === 'ativo');
    side.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Plano de tratamento ativo'), plan ? h('a', { class: 'btn sm ghost', href: `#/registro/${plan.id}` }, 'Abrir') : null),
      h('div', { class: 'card-body' }, plan ? dl([['Diagnóstico fisioterapêutico', plan.data.diagnostico_fisio], ['Objetivo geral', plan.data.objetivo_geral], ['Frequência', plan.data.frequencia], ['Duração prevista', plan.data.duracao]])
        : empty('Nenhum plano ativo.', h('a', { class: 'btn primary sm', href: `#/registro/plano/novo/${p.id}` }, 'Criar plano')))));
    if (evols.length) {
      cards.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Evolução da dor (EVA) por sessão'), h('a', { class: 'btn sm ghost', href: `#/pacientes/${p.id}/evolucoes` }, 'Ver evoluções')),
        h('div', { class: 'card-body' }, lineChart(...painSeries(evols)))));
    }
  }
  body.append(h('div', { class: 'grid g-main' }, h('div', { class: 'stack' }, cards), h('div', { class: 'stack' }, side)));
}

function documentsTab(body, p) {
  const doc = (title, desc, ic, fn, clinical = true) => (clinical && !isClinical() ? null :
    h('div', { class: 'list-item' }, h('span', { class: 'kpi-ic', style: { width: '36px', height: '36px', borderRadius: '9px', display: 'grid', placeItems: 'center', background: 'var(--primary-50)', color: 'var(--primary)' } }, icon(ic, 18)),
      h('div', { class: 'grow' }, h('b', null, title), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, desc)),
      h('button', { class: 'btn sm', onclick: fn }, icon('printer', 15), 'Gerar PDF')));
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Documentos do paciente'), h('small', null, 'Abre o documento pronto para impressão — escolha "Salvar como PDF" no destino.')),
    h('div', { class: 'list' },
      doc('Ficha de anamnese', 'Última anamnese registrada', 'clipboard', () => openPrint('anamnese', { patient: p.id })),
      doc('Avaliação fisioterapêutica', 'Última avaliação/reavaliação', 'activity', () => openPrint('avaliacao', { patient: p.id })),
      doc('Plano de tratamento', 'Plano ativo (ou o mais recente)', 'target', () => openPrint('plano', { patient: p.id })),
      doc('Evolução das sessões', 'Todas as evoluções em ordem cronológica', 'trending', () => openPrint('evolucoes', { patient: p.id })),
      doc('Relatório de acompanhamento', 'Resumo clínico: diagnóstico, plano, frequência, evolução da dor', 'file', () => openPrint('acompanhamento', { patient: p.id })),
      doc('Prontuário completo', 'Cadastro, anamnese, avaliações, planos e evoluções', 'file', () => openPrint('prontuario', { patient: p.id })),
      doc('Termo de consentimento LGPD', 'Para assinatura do paciente', 'shield', () => openPrint('consentimento', { patient: p.id }), false),
      doc('Recibos de pagamento', 'Emitidos na aba Financeiro, para cada pagamento recebido', 'receipt', () => go(`#/pacientes/${p.id}/financeiro`), false))));
}

async function lgpdTab(body, p) {
  const consents = await get(`/patients/${p.id}/consents`);
  const METHOD = { assinatura_fisica: 'Assinatura em papel', assinatura_digital: 'Assinatura digital', aceite_presencial: 'Aceite presencial' };
  const register = () => {
    const form = buildForm([
      { key: 'signer_name', label: 'Nome do titular ou responsável legal', required: true, span: true },
      { key: 'method', label: 'Forma de coleta', type: 'select', options: Object.entries(METHOD), empty: false },
      { key: 'accepted_at', label: 'Data', type: 'date', required: true },
    ], { signer_name: p.name, accepted_at: today() });
    const m = modal({ title: 'Registrar consentimento', body: h('div', { class: 'stack' },
      h('div', { class: 'notice info' }, icon('shield'), h('span', null, 'Imprima o termo, colha a assinatura do paciente e arquive. Versão atual do termo: v', state.settings.consent_version)), form),
    actions: [h('button', { class: 'btn', onclick: () => openPrint('consentimento', { patient: p.id }) }, icon('printer', 16), 'Imprimir termo'),
      h('button', { class: 'btn primary', onclick: async () => { if (!form.validate()) return; try { await post(`/patients/${p.id}/consents`, form.getValues()); m.close(); toast('Consentimento registrado'); dispatchEvent(new Event('fisio:refresh')); } catch (e) { toast(e.message, 'error'); } } }, 'Registrar')] });
  };
  const revoke = async (c) => {
    const reason = await confirmDialog('A revogação não afeta o tratamento já realizado nem a guarda obrigatória do prontuário.', { title: 'Revogar consentimento', okLabel: 'Revogar', danger: true, input: { label: 'Motivo / solicitação do titular' } });
    if (reason === null) return;
    try { await post(`/consents/${c.id}/revoke`, { reason }); toast('Consentimento revogado'); dispatchEvent(new Event('fisio:refresh')); } catch (e) { toast(e.message, 'error'); }
  };
  const exportData = async () => {
    try { const data = await get(`/patients/${p.id}/export`); downloadFile(`dados-${p.name.replace(/\W+/g, '_')}-${today()}.json`, JSON.stringify(data, null, 2), 'application/json'); toast('Dados exportados'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    const name = await confirmDialog(`Esta ação exclui DEFINITIVAMENTE o paciente e todo o prontuário, agenda e histórico financeiro.\n\nAtenção: as normas do COFFITO exigem a guarda do prontuário por prazo mínimo. Exclua apenas quando permitido (ex.: cadastro feito por engano). Um backup é criado automaticamente antes da exclusão.\n\nDigite o nome completo do paciente para confirmar:`,
      { title: 'Excluir paciente', okLabel: 'Excluir definitivamente', danger: true, input: { label: 'Nome completo', placeholder: p.name } });
    if (name === null) return;
    try { await del(`/patients/${p.id}`, { confirm: name }); toast('Paciente excluído'); go('#/pacientes'); } catch (e) { toast(e.message, 'error'); }
  };
  const cards = [
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Consentimento para tratamento de dados'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => openPrint('consentimento', { patient: p.id }) }, icon('printer', 15), 'Imprimir termo'),
        h('button', { class: 'btn sm primary', onclick: register }, icon('plus', 15), 'Registrar'))),
    consents.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Data', 'Titular', 'Forma', 'Versão', 'Registrado por', 'Situação', ''].map((t) => h('th', null, t)))),
      h('tbody', null, consents.map((c) => h('tr', null, h('td', null, fmtDate(c.accepted_at)), h('td', null, c.signer_name), h('td', null, METHOD[c.method]), h('td', null, 'v' + c.term_version), h('td', null, c.registered_by_name || '—'),
        h('td', null, c.revoked_at ? h('span', { class: 'badge red', title: c.revoke_reason || '' }, `Revogado ${fmtDate(c.revoked_at)}`) : h('span', { class: 'badge green' }, 'Vigente')),
        h('td', { class: 'actions' }, !c.revoked_at ? h('button', { class: 'btn sm ghost', onclick: () => revoke(c) }, 'Revogar') : null))))))
      : h('div', { class: 'card-body' }, h('div', { class: 'notice' }, icon('alert'), 'Nenhum consentimento registrado. Dados de saúde exigem consentimento específico e destacado do titular (LGPD, art. 11).'))),
  ];
  if (isClinical()) {
    cards.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Direitos do titular')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', null, 'Acesso e portabilidade'), h('div', { class: 'muted' }, 'Exporta todos os dados do paciente em formato estruturado (JSON).')), h('button', { class: 'btn', onclick: exportData }, icon('download', 16), 'Exportar dados')),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', null, 'Correção'), h('div', { class: 'muted' }, 'Atualize os dados cadastrais; todas as alterações ficam registradas.')), h('button', { class: 'btn', onclick: () => go(`#/pacientes/${p.id}/editar`) }, icon('edit', 16), 'Editar cadastro')),
        isAdmin() ? h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', null, 'Eliminação'), h('div', { class: 'muted' }, 'Exclusão definitiva, respeitando o prazo legal de guarda do prontuário.')), h('button', { class: 'btn danger', onclick: remove }, icon('trash', 16), 'Excluir paciente')) : null)));
    const log = await get(`/patients/${p.id}/audit`);
    cards.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Registro de acessos e alterações'), h('small', null, `${log.length} evento(s)`)),
      h('div', { class: 'table-wrap', style: { maxHeight: '420px', overflowY: 'auto' } }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Data/hora', 'Usuário', 'Ação', 'Item'].map((t) => h('th', null, t)))),
        h('tbody', null, log.map((l) => h('tr', null, h('td', { class: 'nowrap' }, fmtDT(l.ts.replace(' ', 'T'))), h('td', null, l.user_name || '—'), h('td', null, l.action.replace(/_/g, ' ')), h('td', null, LABELS.record[l.entity] || l.entity || '', l.entity_id ? ` #${l.entity_id}` : ''))))))));
  }
  body.append(h('div', { class: 'stack' }, cards));
}

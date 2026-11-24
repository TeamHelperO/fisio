// Geração de documentos para impressão / PDF
import { h, fmtDate, fmtDT, fmtTime, age, money, LABELS, MONTHS, WEEKDAYS, today } from './ui.js';
import { get, qs } from './api.js';
import { SCHEMAS, fieldValue, schemaFor, areaLabel } from './schemas.js';
import { lineChart } from './charts.js';
import { painSeries } from './pages/records.js';

const P = new URLSearchParams(location.search);
const doc = document.getElementById('doc');
let S = {}; let ME = {};

// ---------- Valor por extenso ----------
function extenso(valor) {
  const U = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const D = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const C = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  const ate999 = (n) => {
    if (n === 0) return ''; if (n === 100) return 'cem';
    const c = Math.floor(n / 100); const r = n % 100; const parts = [];
    if (c) parts.push(C[c]);
    if (r) parts.push(r < 20 ? U[r] : D[Math.floor(r / 10)] + (r % 10 ? ' e ' + U[r % 10] : ''));
    return parts.join(' e ');
  };
  const inteiro = (n) => {
    if (n === 0) return 'zero';
    const mi = Math.floor(n / 1e6); const mil = Math.floor((n % 1e6) / 1000); const r = n % 1000; const parts = [];
    if (mi) parts.push(ate999(mi) + (mi === 1 ? ' milhão' : ' milhões'));
    if (mil) parts.push(mil === 1 ? 'mil' : ate999(mil) + ' mil');
    if (r) parts.push(ate999(r));
    let s = parts[0]; for (let i = 1; i < parts.length; i++) s += (i === parts.length - 1 && (r < 100 || r % 100 === 0) && r ? ' e ' : ' ') + parts[i];
    return s;
  };
  const reais = Math.floor(valor + 1e-9); const cent = Math.round((valor - reais) * 100);
  const out = [];
  if (reais) out.push(`${inteiro(reais)} ${reais === 1 ? 'real' : 'reais'}`);
  if (cent) out.push(`${inteiro(cent)} ${cent === 1 ? 'centavo' : 'centavos'}`);
  return out.join(' e ') || 'zero reais';
}

// ---------- Blocos comuns ----------
function header(title) {
  const org = S.clinic_name || S.professional_name || 'Fisioterapia';
  return [
    h('div', { class: 'doc-head' },
      h('div', { class: 'org' }, h('b', null, org),
        S.clinic_name && S.professional_name ? h('div', null, `${S.professional_name}${S.crefito ? ' — CREFITO ' + S.crefito : ''}`) : S.crefito ? h('div', null, `CREFITO ${S.crefito}`) : null,
        S.address ? h('div', null, S.address) : null,
        h('div', null, [S.phone, S.email].filter(Boolean).join(' · '))),
      h('div', { class: 'meta' }, `Emitido em ${fmtDate(today())}`, h('br'), `por ${ME.name || ''}`)),
    h('h1', { class: 'doc-title' }, title),
  ];
}
function patientBox(p) {
  return h('div', { class: 'box ident' },
    h('div', { class: 'wide' }, h('b', null, 'Paciente'), p.name),
    h('div', null, h('b', null, 'Data de nascimento'), p.birth_date ? `${fmtDate(p.birth_date)} (${age(p.birth_date)} anos)` : '—'),
    h('div', null, h('b', null, 'CPF'), p.cpf || '—'),
    h('div', null, h('b', null, 'Telefone'), p.phone || '—'),
    h('div', null, h('b', null, 'Profissão'), p.profession || '—'),
    p.address ? h('div', { class: 'full' }, h('b', null, 'Endereço'), p.address) : null);
}
function signature(name, crefito, { patient } = {}) {
  const d = new Date();
  return h('div', { class: 'sign' },
    h('div', { class: 'place' }, `${S.city ? S.city + ', ' : ''}${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()} de ${d.getFullYear()}.`),
    h('div', { class: 'sign-lines' },
      patient ? h('div', { class: 'sign-line' }, patient, h('small', null, 'Paciente / responsável')) : null,
      h('div', { class: 'sign-line' }, name || S.professional_name || '', h('small', null, `Fisioterapeuta${crefito || S.crefito ? ' — CREFITO ' + (crefito || S.crefito) : ''}`))));
}
function kv(type, data) {
  const out = []; let rows = [];
  const flush = (title) => { if (rows.length) out.push(title ? h('h2', null, title) : null, h('table', { class: 'kv' }, h('tbody', null, rows))); rows = []; };
  let title = null;
  if (data.area && areaLabel(data.area)) out.push(h('div', { class: 'box' }, h('b', null, 'Área de atuação: '), areaLabel(data.area)));
  for (const f of schemaFor(type, data)) {
    if (f.type === 'section') { flush(title); title = f.label; continue; }
    const v = fieldValue(f, data[f.key]);
    if (v) rows.push(h('tr', null, h('th', null, f.label), h('td', null, v)));
  }
  flush(title);
  return out.length ? out : [h('p', { class: 'empty' }, 'Nenhum campo preenchido.')];
}
const confidential = () => h('div', { class: 'footnote' }, 'Documento confidencial — contém dados pessoais sensíveis de saúde protegidos pela LGPD (Lei 13.709/2018) e pelo sigilo profissional (Código de Ética da Fisioterapia). Uso restrito ao paciente e profissionais autorizados.');
const profOf = (p) => ({ name: p.professional_name || ME.name, crefito: p.professional_crefito || ME.crefito });
const recordTitle = (r) => (r.type === 'evolucao' ? `Evolução fisioterapêutica — sessão nº ${r.seq}` : r.type === 'avaliacao' ? ((r.data.tipo === 'Avaliação inicial' || !r.data.tipo ? 'Avaliação fisioterapêutica' : `Avaliação fisioterapêutica — ${r.data.tipo}`) + (areaLabel(r.data.area) ? ` (${areaLabel(r.data.area)})` : '')) : r.type === 'anamnese' ? 'Ficha de anamnese' : 'Plano de tratamento fisioterapêutico');

function recordSection(r, p, { withHeader = true } = {}) {
  return [
    withHeader ? header(recordTitle(r)) : h('h1', { class: 'doc-title', style: { marginTop: '24px' } }, recordTitle(r)),
    withHeader ? patientBox(p) : null,
    h('div', { style: { color: 'var(--muted)', marginBottom: '6px' } }, `Data: ${fmtDate(r.record_date)}${r.type === 'plano' ? ` · Situação: ${LABELS.plano[r.status] || ''}` : ''} · Profissional: ${r.author_name || '—'}${r.author_crefito ? ` (CREFITO ${r.author_crefito})` : ''}`),
    kv(r.type, r.data),
  ];
}

// ---------- Documentos ----------
const DOCS = {
  async registro() {
    const r = await get(`/records/${P.get('id')}`); const p = await get(`/patients/${r.patient_id}`);
    return { title: recordTitle(r), body: [recordSection(r, p), signature(r.author_name, r.author_crefito, { patient: r.type === 'plano' ? p.name : null }), confidential()] };
  },
  async anamnese() { return latest('anamnese'); },
  async avaliacao() { return latest('avaliacao'); },
  async plano() { return latest('plano'); },
  async evolucoes() {
    const p = await get(`/patients/${P.get('patient')}`);
    const rows = (await get(`/records${qs({ type: 'evolucao', patient_id: p.id, full: 1 })}`)).sort((a, b) => a.seq - b.seq);
    return { title: 'Evolução das sessões', body: [header('Evolução das sessões'), patientBox(p),
      rows.length ? rows.map((r) => h('div', { class: 'session' }, h('div', { class: 'session-head' }, h('span', null, `Sessão nº ${r.seq}`), h('span', null, `${fmtDate(r.record_date)} · ${r.author_name || ''}`)),
        h('table', { class: 'kv' }, h('tbody', null, schemaFor('evolucao', r.data).map((f) => { if (f.type === 'section') return null; const v = fieldValue(f, r.data[f.key]); return v ? h('tr', null, h('th', null, f.label), h('td', null, v)) : null; })))))
        : h('p', { class: 'empty' }, 'Nenhuma evolução registrada.'),
      signature(profOf(p).name, profOf(p).crefito), confidential()] };
  },
  async acompanhamento() {
    const p = await get(`/patients/${P.get('patient')}`);
    const [an, av, pl, ev, ap] = await Promise.all(['anamnese', 'avaliacao', 'plano', 'evolucao'].map((t) => get(`/records${qs({ type: t, patient_id: p.id, full: 1 })}`)).concat(get('/appointments' + qs({ patient_id: p.id }))));
    const plan = pl.find((x) => x.status === 'ativo') || pl[0]; const anam = an[0];
    const avs = [...av].sort((a, b) => a.record_date.localeCompare(b.record_date));
    const evs = [...ev].sort((a, b) => a.seq - b.seq);
    const first = evs[0]; const last = evs[evs.length - 1];
    const cnt = (s) => ap.filter((a) => a.status === s).length;
    const row = (k, v) => (v ? h('tr', null, h('th', null, k), h('td', null, v)) : null);
    return { title: 'Relatório de acompanhamento', body: [header('Relatório de acompanhamento fisioterapêutico'), patientBox(p),
      h('h2', null, 'Identificação clínica'),
      h('table', { class: 'kv' }, h('tbody', null, row('Diagnóstico médico', anam?.data.diagnostico_medico), row('Queixa principal', anam?.data.queixa_principal),
        row('Diagnóstico fisioterapêutico', plan?.data.diagnostico_fisio), row('Início do acompanhamento', p.first_visit ? fmtDate(p.first_visit) : evs[0] ? fmtDate(evs[0].record_date) : null),
        row('Situação atual', LABELS.status[p.status]))),
      h('h2', null, 'Frequência'),
      h('table', { class: 'kv' }, h('tbody', null, row('Sessões realizadas', String(cnt('realizado'))), row('Faltas', String(cnt('falta'))), row('Cancelamentos', String(cnt('cancelado'))),
        row('Evoluções registradas', String(evs.length)), row('Período', evs.length ? `${fmtDate(first.record_date)} a ${fmtDate(last.record_date)}` : null))),
      plan ? [h('h2', null, 'Plano de tratamento'), h('table', { class: 'kv' }, h('tbody', null, row('Objetivo geral', plan.data.objetivo_geral), row('Objetivos específicos', plan.data.objetivos_especificos),
        row('Condutas', plan.data.condutas), row('Técnicas', [...(plan.data.tecnicas || []), plan.data.outras_tecnicas].filter(Boolean).join(', ')), row('Frequência', plan.data.frequencia), row('Duração prevista', plan.data.duracao)))] : null,
      avs.length ? [h('h2', null, 'Avaliações'), h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Data'), h('th', null, 'Tipo'), h('th', null, 'Dor (EVA)'), h('th', null, 'Limitações funcionais'))),
        h('tbody', null, avs.map((a) => h('tr', null, h('td', null, fmtDate(a.record_date)), h('td', null, a.data.tipo || '—'), h('td', null, fieldValue({ type: 'scale' }, a.data.dor_intensidade) || '—'), h('td', null, a.data.limitacoes || '—')))))] : null,
      evs.length ? [h('h2', null, 'Evolução da dor (EVA)'), h('div', { class: 'chart' }, lineChart(...painSeries(evs), { height: 180 })),
        h('h2', null, 'Evolução clínica'), h('table', { class: 'kv' }, h('tbody', null, row('Primeira sessão', first.data.condicao_inicial || first.data.queixa), row('Última sessão', [last.data.evolucao, last.data.resposta].filter(Boolean).join('\n')), row('Orientações atuais', last.data.orientacoes)))] : null,
      signature(profOf(p).name, profOf(p).crefito), confidential()] };
  },
  async prontuario() {
    const p = await get(`/patients/${P.get('patient')}`);
    const all = await Promise.all(['anamnese', 'avaliacao', 'plano', 'evolucao'].map((t) => get(`/records${qs({ type: t, patient_id: p.id, full: 1 })}`)));
    const recs = all.flat().sort((a, b) => a.record_date.localeCompare(b.record_date) || (a.seq || 0) - (b.seq || 0));
    // full=1 não traz CREFITO do autor; usa nome do autor
    return { title: 'Prontuário', body: [header('Prontuário fisioterapêutico'), patientBox(p),
      h('div', { class: 'box ident' }, h('div', null, h('b', null, 'Contato de emergência'), [p.emergency_name, p.emergency_phone].filter(Boolean).join(' — ') || '—'),
        h('div', null, h('b', null, 'Primeiro atendimento'), fmtDate(p.first_visit)), h('div', null, h('b', null, 'Profissional responsável'), p.professional_name || '—')),
      recs.length ? recs.map((r) => recordSection(r, p, { withHeader: false })) : h('p', { class: 'empty' }, 'Nenhum registro clínico.'),
      signature(profOf(p).name, profOf(p).crefito), confidential()] };
  },
  async consentimento() {
    const p = await get(`/patients/${P.get('patient')}`);
    return { title: 'Termo de consentimento', body: [header(`Termo de consentimento — LGPD (v${S.consent_version})`), patientBox(p),
      h('div', { class: 'box' }, h('b', null, 'Controlador dos dados: '), `${S.clinic_name ? S.clinic_name + ' — ' : ''}${S.professional_name || ''}${S.crefito ? ', CREFITO ' + S.crefito : ''}${S.email ? ' · ' + S.email : ''}${S.phone ? ' · ' + S.phone : ''}`),
      h('div', { class: 'term' }, S.consent_text),
      h('p', null, 'Responsável legal (se paciente menor ou incapaz): ______________________________________ CPF: ____________________'),
      signature(S.professional_name, S.crefito, { patient: p.name })] };
  },
  async recibo() {
    const c = await get(`/charges/${P.get('id')}`);
    if (c.status !== 'pago') return { title: 'Recibo', body: [h('p', null, 'Este lançamento não está pago. O recibo só pode ser emitido após o registro do pagamento.')] };
    const payer = c.payer_name || c.patient_name; const payerCpf = c.payer_cpf || c.patient_cpf;
    const profName = c.professional_name || S.professional_name; const crefito = c.professional_crefito || S.crefito;
    const block = (via) => h('div', { class: 'receipt', style: { marginBottom: '18px' } },
      h('div', { class: 'top' }, h('div', null, h('h1', null, 'RECIBO'), h('small', null, `Nº ${c.receipt_number} · ${via}`)), h('div', { class: 'value' }, money(c.amount))),
      h('p', null, 'Recebi de ', h('b', null, payer), payerCpf ? `, CPF ${payerCpf},` : ',', ' a importância de ', h('b', null, `${money(c.amount)} (${extenso(c.amount)})`),
        ', referente a ', h('b', null, c.description), c.payer_name ? ` prestado(s) ao(à) paciente ${c.patient_name}${c.patient_cpf ? ', CPF ' + c.patient_cpf : ''}` : '',
        `, pago em ${fmtDate(c.paid_at)} via ${LABELS.method[c.method] || '—'}.`),
      h('p', null, 'Para clareza, firmo o presente recibo, dando plena quitação do valor acima.'),
      h('div', { class: 'sign', style: { marginTop: '16px' } },
        h('div', { class: 'place', style: { marginBottom: '34px' } }, `${S.city ? S.city + ', ' : ''}${fmtDate(c.paid_at)}.`),
        h('div', { class: 'sign-line' }, profName, h('small', null, `Fisioterapeuta${crefito ? ' — CREFITO ' + crefito : ''}${S.professional_cpf ? ' — CPF ' + S.professional_cpf : ''}`),
          S.address ? h('small', null, S.address) : null)));
    return { title: `Recibo ${c.receipt_number}`, body: [block('1ª via — paciente'), h('div', { style: { borderTop: '1px dashed #999', margin: '6px 0 18px' } }), block('2ª via — profissional')] };
  },
  async receitas() {
    const from = P.get('from'); const to = P.get('to');
    const [r, rows] = await Promise.all([get('/finance/report' + qs({ from, to })), get('/charges' + qs({ by: 'paid', from, to, status: 'pago' }))]);
    rows.sort((a, b) => a.paid_at.localeCompare(b.paid_at));
    return { title: 'Relatório de receitas', body: [header('Relatório de receitas'),
      h('div', { class: 'box' }, `Período: ${fmtDate(from)} a ${fmtDate(to)} · Total recebido: `, h('b', null, money(r.total.v)), ` · ${r.total.n} recebimento(s) · Pendente no período: ${money(r.pendente.v)}`),
      h('h2', null, 'Por mês'), h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Mês'), h('th', { class: 'n' }, 'Qtd.'), h('th', { class: 'n' }, 'Total'))),
        h('tbody', null, r.por_mes.map((m) => h('tr', null, h('td', null, `${MONTHS[+m.month.slice(5) - 1]}/${m.month.slice(0, 4)}`), h('td', { class: 'n' }, m.n), h('td', { class: 'n' }, money(m.v)))))),
      h('h2', null, 'Por forma de pagamento'), h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Forma'), h('th', { class: 'n' }, 'Qtd.'), h('th', { class: 'n' }, 'Total'))),
        h('tbody', null, r.por_forma.map((m) => h('tr', null, h('td', null, LABELS.method[m.method] || '—'), h('td', { class: 'n' }, m.n), h('td', { class: 'n' }, money(m.v)))))),
      h('h2', null, 'Recebimentos'), h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Data', 'Paciente', 'Descrição', 'Forma', 'Recibo'].map((t) => h('th', null, t)), h('th', { class: 'n' }, 'Valor'))),
        h('tbody', null, rows.map((c) => h('tr', null, h('td', null, fmtDate(c.paid_at)), h('td', null, c.patient_name), h('td', null, c.description), h('td', null, LABELS.method[c.method] || '—'), h('td', null, c.receipt_number || ''), h('td', { class: 'n' }, money(c.amount))))),
        h('tfoot', null, h('tr', null, h('td', { colSpan: 5 }, 'Total'), h('td', { class: 'n' }, money(r.total.v))))),
      signature(S.professional_name, S.crefito)] };
  },
  async atendimentos() {
    const from = P.get('from'); const to = P.get('to');
    const end = new Date(to + 'T12:00'); end.setDate(end.getDate() + 1);
    const rows = await get('/appointments' + qs({ from: `${from}T00:00`, to: `${end.toISOString().slice(0, 10)}T00:00` }));
    const cnt = (s) => rows.filter((a) => a.status === s).length;
    return { title: 'Relatório de atendimentos', body: [header('Relatório de atendimentos'),
      h('div', { class: 'box' }, `Período: ${fmtDate(from)} a ${fmtDate(to)} · Total: ${rows.length} · `, Object.entries(LABELS.appt).map(([k, l]) => `${l}: ${cnt(k)}`).join(' · ')),
      h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Data', 'Hora', 'Paciente', 'Tipo', 'Profissional', 'Situação'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((a) => h('tr', null, h('td', null, `${WEEKDAYS[new Date(a.start).getDay()]} ${fmtDate(a.start)}`), h('td', null, fmtTime(a.start)), h('td', null, a.patient_name), h('td', null, LABELS.kind[a.kind]), h('td', null, a.professional_name || '—'), h('td', null, LABELS.appt[a.status]))))),
      signature(S.professional_name, S.crefito)] };
  },
  async carneleao() {
    const year = P.get('year');
    const d = await get('/finance/carne-leao' + qs({ year, professional_id: P.get('professional_id') }));
    const total = d.rows.reduce((s, r) => s + r.amount, 0);
    return { title: `Carnê-Leão ${year}`, body: [header(`Receitas recebidas de pessoas físicas — ${year}`),
      h('div', { class: 'notice' }, 'Documento de apoio para lançamento no Carnê-Leão (Receita Federal). Apenas consolida receitas recebidas; não realiza cálculo de imposto. Valide a apuração com um contador e conforme as regras fiscais vigentes.'),
      h('h2', null, 'Resumo mensal'), h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Mês'), h('th', { class: 'n' }, 'Recebimentos'), h('th', { class: 'n' }, 'Total'))),
        h('tbody', null, MONTHS.map((m, i) => { const rs = d.rows.filter((r) => +r.paid_at.slice(5, 7) === i + 1); return h('tr', null, h('td', null, m), h('td', { class: 'n' }, rs.length), h('td', { class: 'n' }, money(rs.reduce((s, r) => s + r.amount, 0)))); })),
        h('tfoot', null, h('tr', null, h('td', null, 'Total do ano'), h('td', { class: 'n' }, d.rows.length), h('td', { class: 'n' }, money(total))))),
      h('h2', null, 'Detalhamento'), h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Data', 'Paciente (beneficiário)', 'CPF paciente', 'Pagador (titular)', 'CPF pagador', 'Forma', 'Recibo'].map((t) => h('th', null, t)), h('th', { class: 'n' }, 'Valor'))),
        h('tbody', null, d.rows.map((r) => h('tr', null, h('td', null, fmtDate(r.paid_at)), h('td', null, r.patient_name), h('td', null, r.patient_cpf || '—'), h('td', null, r.payer_name || r.patient_name), h('td', null, r.payer_cpf || r.patient_cpf || '—'), h('td', null, LABELS.method[r.method] || '—'), h('td', null, r.receipt_number || ''), h('td', { class: 'n' }, money(r.amount)))))),
      signature(S.professional_name, S.crefito)] };
  },
  // Comprovante de assinatura digital: documento como foi assinado + assinatura + evidências
  async assinatura() {
    const s = await get(`/signatures/${P.get('id')}`);
    if (s.status !== 'assinado') return { title: 'Assinatura', body: [h('p', null, 'Este documento ainda não foi assinado.')] };
    return { title: `Assinado — ${s.doc.title}`, body: [header(s.doc.title),
      ...s.doc.sections.map((x) => (x.h ? [h('h2', null, x.h), h('div', { class: 'term' }, x.text)] : h('div', { class: 'term', style: { marginTop: '10px' } }, x.text))).flat(),
      h('h2', null, 'Assinatura eletrônica do paciente'),
      h('div', { class: 'sig-proof' }, h('img', { src: s.signature, alt: `Assinatura de ${s.signer_name}` }), h('div', { class: 'sign-line', style: { width: '320px' } }, s.signer_name, h('small', null, s.signer_cpf ? `CPF ${s.signer_cpf}` : 'Paciente / responsável'))),
      h('table', { class: 'kv', style: { marginTop: '12px' } }, h('tbody', null,
        [['Assinado por', s.signer_name], ['CPF informado', s.signer_cpf || '—'], ['Data e hora', `${fmtDate(s.signed_at.slice(0, 10))} às ${s.signed_at.slice(11, 16)} (horário da clínica)`],
          ['Endereço IP', s.ip || '—'], ['Navegador', s.user_agent || '—'], ['Código de verificação do documento', s.doc_hash.slice(0, 16).toUpperCase()],
          ['Pedido de assinatura', `nº ${s.id}, gerado por ${s.created_by_name || '—'} em ${fmtDate(s.created_at.slice(0, 10))}`]].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
      h('p', { class: 'footnote' }, 'Assinatura eletrônica coletada pelo FisioGestão (MP 2.200-2/2001, art. 10, § 2º). O documento foi registrado exatamente como apresentado ao signatário; o código de verificação muda se qualquer parte do texto for alterada.')] };
  },
  // Folha de exercícios para o paciente levar para casa
  async programa() {
    const x = await get(`/programs/${P.get('id')}`);
    const p = await get(`/patients/${x.patient_id}`);
    const dose = (it) => [it.sets ? `${it.sets} série(s)` : '', it.reps ? `${it.reps} repetições` : '', it.hold_s ? `sustentar ${it.hold_s} segundos` : '',
      it.rest_s ? `descanso de ${it.rest_s} s` : '', it.side || ''].filter(Boolean).join(' · ');
    return { title: x.title, body: [header('Programa de exercícios'),
      h('div', { class: 'box ident' },
        h('div', { class: 'wide' }, h('b', null, 'Paciente'), p.name),
        h('div', null, h('b', null, 'Início'), fmtDate(x.start_date)),
        h('div', { class: 'wide' }, h('b', null, 'Programa'), x.title),
        h('div', null, h('b', null, 'Frequência'), x.frequency || '—'),
        x.duration ? h('div', { class: 'full' }, h('b', null, 'Duração prevista'), x.duration) : null),
      x.notes ? h('div', { class: 'box term' }, x.notes) : null,
      ...x.items.map((it, i) => h('div', { class: 'exercise' },
        h('div', { class: 'ex-head' }, h('span', { class: 'ex-n' }, i + 1), h('b', null, it.name)),
        dose(it) || it.load ? h('div', { class: 'ex-dose' }, dose(it), it.load ? h('span', null, ` · Carga: ${it.load}`) : null) : null,
        it.steps?.length ? h('ol', null, it.steps.map((s) => h('li', null, s))) : null,
        it.notes ? h('div', { class: 'ex-note' }, h('b', null, 'Atenção: '), it.notes) : null,
        it.media_url ? h('div', { class: 'ex-link' }, 'Vídeo: ', it.media_url) : null,
        h('div', { class: 'ex-check' }, 'Feito:', ...['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => h('span', null, '☐ ', d))))),
      h('div', { class: 'notice' }, 'Faça os exercícios com calma e respiração tranquila. Se sentir dor forte, tontura, falta de ar ou formigamento, pare e avise seu fisioterapeuta.'),
      signature(x.author_name, x.author_crefito)] };
  },
};

async function latest(type) {
  const p = await get(`/patients/${P.get('patient')}`);
  const rows = await get(`/records${qs({ type, patient_id: p.id })}`);
  const pick = type === 'plano' ? rows.find((r) => r.status === 'ativo') || rows[0] : rows[0];
  if (!pick) return { title: LABELS.record[type], body: [header(LABELS.record[type]), patientBox(p), h('p', { class: 'empty' }, `Nenhum registro de ${LABELS.record[type].toLowerCase()} para este paciente.`)] };
  const r = await get(`/records/${pick.id}`);
  return { title: recordTitle(r), body: [recordSection(r, p), signature(r.author_name, r.author_crefito, { patient: type === 'plano' ? p.name : null }), confidential()] };
}

async function main() {
  const btn = document.getElementById('btn-print');
  if (window.FISIO_DEMO) btn.hidden = true; else btn.addEventListener('click', () => window.print());
  try {
    const me = await get('/me'); S = me.settings; ME = me.user;
    const fn = DOCS[P.get('doc')]; if (!fn) throw new Error('Documento desconhecido');
    const { title, body } = await fn();
    document.title = `${title} — FisioGestão`; document.getElementById('doc-title').textContent = title;
    doc.replaceChildren(h('div', null, body));
    if (!P.has('preview')) setTimeout(() => window.print(), 400);
  } catch (e) {
    document.getElementById('doc-title').textContent = 'Erro';
    doc.replaceChildren(h('p', null, e.status === 401 ? 'Sessão expirada. Faça login novamente no sistema.' : e.message));
  }
}
main();

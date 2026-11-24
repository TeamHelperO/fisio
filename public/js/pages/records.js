import { h, icon, toast, buildForm, badge, fmtDate, fmtDT, age, empty, debounce, LABELS, confirmDialog, modal, today } from '../ui.js';
import { get, post, put, del, qs } from '../api.js';
import { go, back, openPrint } from '../state.js';
import { SCHEMAS, fieldValue, EVOLUCAO, schemaFor, AREA_OPTIONS, areaLabel } from '../schemas.js';

// Une os campos de vários registros (cada um pode ter uma área diferente)
const unionFields = (type, list) => { const seen = new Set(); const out = []; for (const r of list) for (const f of schemaFor(type, r.data)) if (f.type !== 'section' && !seen.has(f.key)) { seen.add(f.key); out.push(f); } return out; };
import { lineChart } from '../charts.js';
import { requestSignature } from './signatures.js';

const LIST_META = {
  anamnese: { type: 'anamnese', title: 'Anamnese', desc: 'Fichas de anamnese: informações clínicas, histórico de saúde e hábitos de vida.' },
  avaliacoes: { type: 'avaliacao', title: 'Avaliações fisioterapêuticas', desc: 'Avaliações iniciais, reavaliações e avaliações de alta.' },
  planos: { type: 'plano', title: 'Planos de tratamento', desc: 'Planos individualizados vinculados ao prontuário, com histórico de versões.' },
  evolucoes: { type: 'evolucao', title: 'Evoluções', desc: 'Registro de cada sessão em ordem cronológica.' },
};
const NEW_LABEL = { anamnese: 'Nova anamnese', avaliacao: 'Nova avaliação', plano: 'Novo plano', evolucao: 'Nova evolução' };
const TAB_OF = { anamnese: 'anamnese', avaliacao: 'avaliacoes', plano: 'plano', evolucao: 'evolucoes' };

export function pickPatient(type) {
  const list = h('div', { class: 'list', style: { maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' } });
  const load = async (term = '') => {
    const rows = await get('/patients' + qs({ q: term }));
    list.replaceChildren(...(rows.length ? rows.map((p) => h('div', { class: 'list-item click', onclick: () => { m.close(); go(`#/registro/${type}/novo/${p.id}`); } },
      h('div', { class: 'grow' }, h('b', null, p.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, p.cpf || '', p.birth_date ? ` · ${age(p.birth_date)} anos` : '')), badge(p.status, 'status')))
      : [h('div', { class: 'empty' }, 'Nenhum paciente encontrado.', h('div', null, h('a', { href: '#/pacientes/novo', onclick: () => m.close() }, 'Cadastrar paciente')))]));
  };
  const input = h('input', { class: 'input', placeholder: 'Buscar paciente…', oninput: debounce((e) => load(e.target.value)) });
  const m = modal({ title: `${NEW_LABEL[type]} — selecione o paciente`, body: h('div', { class: 'stack' }, h('div', { class: 'search' }, icon('search', 16), input), list) });
  load();
}

// ======================= Lista geral (menu) =======================
export async function recordsListPage(view, [kind]) {
  const meta = LIST_META[kind];
  let term = '';
  const tbody = h('tbody');
  const load = async () => {
    const rows = await get('/records' + qs({ type: meta.type, q: term }));
    tbody.replaceChildren(...(rows.length ? rows.map((r) => h('tr', { class: 'click', onclick: () => go(`#/registro/${r.id}`) },
      h('td', { class: 'nowrap' }, fmtDate(r.record_date)),
      h('td', null, h('b', null, r.patient_name)),
      h('td', null, meta.type === 'evolucao' ? `Sessão nº ${r.seq}` : meta.type === 'plano' ? badge(r.status, 'plano') : r.title || LABELS.record[r.type]),
      h('td', { class: 'hide-sm' }, r.author_name || '—'),
      h('td', { class: 'hide-sm nowrap' }, fmtDT(r.updated_at.replace(' ', 'T'))),
      h('td', { class: 'actions' }, h('button', { class: 'icon-btn', title: 'Imprimir / PDF', onclick: (e) => { e.stopPropagation(); openPrint('registro', { id: r.id }); } }, icon('printer', 16)))))
      : [h('tr', null, h('td', { colSpan: 6 }, empty(term ? 'Nenhum registro encontrado.' : 'Nenhum registro ainda.', h('button', { class: 'btn primary', onclick: () => pickPatient(meta.type) }, NEW_LABEL[meta.type]))))]));
  };
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, meta.title), h('p', null, meta.desc)),
      h('button', { class: 'btn primary', onclick: () => pickPatient(meta.type) }, icon('plus', 16), NEW_LABEL[meta.type])),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'search' }, icon('search', 16), h('input', { class: 'input', placeholder: 'Filtrar por paciente', oninput: debounce((e) => { term = e.target.value.trim(); load(); }) }))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Data'), h('th', null, 'Paciente'), h('th', null, meta.type === 'evolucao' ? 'Sessão' : meta.type === 'plano' ? 'Situação' : 'Tipo'), h('th', { class: 'hide-sm' }, 'Profissional'), h('th', { class: 'hide-sm' }, 'Atualizado em'), h('th', null, ''))),
        tbody))));
  await load();
}

// ======================= Visualização =======================
export function renderRecordData(type, data) {
  const out = []; let section = null; let dl = null;
  const flush = () => { if (dl && dl.childNodes.length) out.push(section, dl); };
  if (data.area && areaLabel(data.area)) out.push(h('div', { class: 'area-tag' }, icon('activity', 14), `Área de atuação: ${areaLabel(data.area)}`));
  for (const f of schemaFor(type, data)) {
    if (f.type === 'section') { flush(); section = h('h4', { class: 'view-section' }, f.label); dl = h('dl', { class: 'dl' }); continue; }
    if (!dl) { section = null; dl = h('dl', { class: 'dl' }); }
    const v = fieldValue(f, data[f.key]);
    if (v) dl.append(h('dt', null, f.label), h('dd', null, v));
  }
  flush();
  return out.some((n) => n && n.tagName === 'DL') ? out : [...out, h('p', { class: 'muted' }, 'Nenhum campo preenchido.')];
}

export async function recordViewPage(view, [id]) {
  const r = await get(`/records/${id}`);
  const p = await get(`/patients/${r.patient_id}`);
  const title = r.type === 'evolucao' ? `Evolução — sessão nº ${r.seq}` : r.type === 'avaliacao' ? r.data.tipo || 'Avaliação' : LABELS.record[r.type];
  const remove = async () => {
    const reason = await confirmDialog('O registro será removido do prontuário, mas permanece guardado no histórico de auditoria (guarda legal).', { title: 'Excluir registro', okLabel: 'Excluir', danger: true, input: { label: 'Motivo da exclusão' } });
    if (reason === null) return;
    try { await del(`/records/${id}`, { reason }); toast('Registro excluído'); go(`#/pacientes/${r.patient_id}/${TAB_OF[r.type]}`); } catch (e) { toast(e.message, 'error'); }
  };
  const showVersions = () => {
    const m = modal({ title: 'Histórico de versões', body: r.versions.length ? h('div', { class: 'list' }, r.versions.map((v) => h('div', { class: 'list-item click', onclick: async () => {
      const ver = await get(`/records/${id}/versions/${v.id}`);
      m.close();
      modal({ title: `Versão ${v.version} — salva em ${fmtDT(v.changed_at.replace(' ', 'T'))}`, wide: true, body: h('div', null, h('div', { class: 'notice info', style: { marginBottom: '12px' } }, icon('history'), `Conteúdo anterior à alteração feita por ${v.changed_by_name || '—'}. Data do registro: ${fmtDate(ver.record_date)}`), renderRecordData(r.type, ver.data)) });
    } }, icon('history', 16), h('div', { class: 'grow' }, `Versão ${v.version}`), h('small', null, `${fmtDT(v.changed_at.replace(' ', 'T'))} · ${v.changed_by_name || ''}`))))
      : h('p', { class: 'muted' }, 'Este registro ainda não foi alterado.') });
  };
  view.append(
    h('div', { class: 'page-head' },
      h('div', null, h('a', { class: 'crumb', href: `#/pacientes/${p.id}/${TAB_OF[r.type]}` }, `← ${p.name}`),
        h('div', { class: 'row' }, h('h1', null, title), r.type === 'plano' ? badge(r.status, 'plano') : null),
        h('p', null, `${fmtDate(r.record_date)} · ${r.author_name || '—'}${r.author_crefito ? ` (CREFITO ${r.author_crefito})` : ''}${r.versions.length ? ` · editado ${r.versions.length}x` : ''}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: showVersions }, icon('history', 16), 'Versões'),
        h('button', { class: 'btn', onclick: () => openPrint('registro', { id }) }, icon('printer', 16), 'PDF'),
        r.type === 'plano' ? h('button', { class: 'btn', title: 'O paciente assina o plano pelo celular', onclick: () => requestSignature(p, 'plano', r.id) }, icon('edit', 16), 'Assinatura do paciente') : null,
        h('button', { class: 'btn', onclick: remove }, icon('trash', 16)),
        h('button', { class: 'btn primary', onclick: () => go(`#/registro/${id}/editar`) }, icon('edit', 16), 'Editar'))),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, renderRecordData(r.type, r.data))));
}

// ======================= Edição =======================
export async function recordEditPage(view, params) {
  let rec; let type; let patientId;
  if (params.length === 2) { [type, patientId] = params; rec = { record_date: today(), data: {} }; }
  else { rec = await get(`/records/${params[0]}`); type = rec.type; patientId = rec.patient_id; }
  const p = await get(`/patients/${patientId}`);
  const isNew = !rec.id;

  const dateIn = h('input', { class: 'input', type: 'date', value: rec.record_date });
  const head = [h('label', { class: 'field' }, h('span', null, type === 'evolucao' ? 'Data da sessão' : 'Data'), dateIn)];
  let seqIn; let statusIn; let last = null;
  if (type === 'evolucao') {
    let seq = rec.seq;
    if (isNew) {
      const ev = await get(`/records${qs({ type: 'evolucao', patient_id: p.id, full: 1 })}`);
      seq = (Math.max(0, ...ev.map((e) => e.seq || 0))) + 1; last = ev[0] || null;
    }
    seqIn = h('input', { class: 'input', type: 'number', min: 1, value: seq });
    head.push(h('label', { class: 'field' }, h('span', null, 'Número da sessão'), seqIn));
  }
  if (type === 'plano') {
    statusIn = h('select', { class: 'input' }, Object.entries(LABELS.plano).map(([k, v]) => h('option', { value: k }, v)));
    statusIn.value = rec.status || 'ativo';
    head.push(h('label', { class: 'field' }, h('span', null, 'Situação do plano'), statusIn, isNew ? h('small', { class: 'help' }, 'Ao salvar como ativo, o plano ativo anterior passa a "substituído".') : null));
  }

  let areaIn = null;
  if (type === 'avaliacao' || type === 'evolucao') {
    let def = rec.data.area || '';
    if (isNew) {
      const [avs, evs] = await Promise.all([get(`/records${qs({ type: 'avaliacao', patient_id: p.id, full: 1 })}`), type === 'evolucao' ? get(`/records${qs({ type: 'evolucao', patient_id: p.id, full: 1 })}`) : []]);
      def = evs.find((x) => x.data.area)?.data.area || avs.find((x) => x.data.area)?.data.area || '';
    }
    areaIn = h('select', { class: 'input', id: 'record-area' }, h('option', { value: '' }, 'Geral (sem ficha específica)'), AREA_OPTIONS.map(([k, l]) => h('option', { value: k }, l)));
    areaIn.value = def;
    head.push(h('label', { class: 'field' }, h('span', null, 'Área de atuação'), areaIn, h('small', { class: 'help' }, 'Acrescenta a ficha específica da área ao formulário.')));
  }
  const currentArea = () => areaIn?.value || '';
  let carry = { ...rec.data };
  let form = buildForm(schemaFor(type, { area: currentArea() }), rec.data);
  const formBox = h('div', null, form);
  const rebuild = (values) => { carry = { ...carry, ...values }; form = buildForm(schemaFor(type, { area: currentArea() }), carry); formBox.replaceChildren(form); };
  if (areaIn) areaIn.addEventListener('change', () => { rebuild(form.getValues()); toast(currentArea() ? `Ficha ${areaLabel(currentArea())} adicionada` : 'Ficha específica removida'); });
  const tools = [];
  if (type === 'evolucao' && last) {
    tools.push(h('button', { class: 'btn sm', onclick: () => {
      const keep = form.getValues(); const carry = {};
      for (const k of ['exercicios', 'tecnicas', 'series_repeticoes', 'tempo', 'orientacoes']) carry[k] = last.data[k];
      if (areaIn && last.data.area && !areaIn.value) areaIn.value = last.data.area;
      rebuild({ ...keep, ...Object.fromEntries(Object.entries(carry).filter(([, v]) => v)) }); toast(`Conduta copiada da sessão nº ${last.seq}`);
    } }, icon('history', 15), `Copiar conduta da sessão nº ${last.seq}`));
  }
  if (type === 'plano' && isNew) {
    const plans = await get(`/records${qs({ type: 'plano', patient_id: p.id, full: 1 })}`);
    const active = plans.find((x) => x.status === 'ativo');
    if (active) tools.push(h('button', { class: 'btn sm', onclick: () => { rebuild(active.data); toast('Dados do plano atual carregados'); } }, icon('history', 15), 'Partir do plano atual'));
  }

  const save = async () => {
    if (!dateIn.value) return toast('Informe a data', 'error');
    const data = form.getValues();
    if (areaIn) data.area = currentArea();
    const body = { record_date: dateIn.value, data, seq: seqIn?.value, status: statusIn?.value, title: type === 'avaliacao' ? [data.tipo, areaLabel(data.area)].filter(Boolean).join(' · ') : null };
    try {
      if (isNew) { const r = await post('/records', { ...body, type, patient_id: p.id }); toast('Registro salvo'); go(`#/registro/${r.id}`); }
      else { await put(`/records/${rec.id}`, body); toast('Alterações salvas (versão anterior preservada)'); go(`#/registro/${rec.id}`); }
    } catch (e) { toast(e.message, 'error'); }
  };

  const personal = type === 'anamnese' ? h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('h3', null, 'Dados pessoais do paciente'), h('a', { class: 'btn sm ghost', href: `#/pacientes/${p.id}/editar` }, 'Editar cadastro')),
    h('div', { class: 'card-body' }, h('div', { class: 'tl-grid', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', marginTop: 0 } },
      [['Nome', p.name], ['Idade', p.birth_date ? `${age(p.birth_date)} anos (${fmtDate(p.birth_date)})` : '—'], ['CPF', p.cpf || '—'], ['Telefone', p.phone || '—'], ['Profissão', p.profession || '—'], ['Endereço', p.address || '—'], ['Contato de emergência', [p.emergency_name, p.emergency_phone].filter(Boolean).join(' — ') || '—']]
        .map(([k, v]) => h('div', null, h('b', null, k), h('span', null, v)))))) : null;

  view.append(
    h('div', { class: 'page-head' },
      h('div', null, h('a', { class: 'crumb', href: isNew ? `#/pacientes/${p.id}/${TAB_OF[type]}` : `#/registro/${rec.id}` }, `← ${p.name}`),
        h('h1', null, `${isNew ? NEW_LABEL[type] : 'Editar ' + LABELS.record[type].toLowerCase()}`), h('p', null, p.name)),
      h('div', { class: 'row' }, tools)),
    personal,
    h('div', { class: 'card' },
      h('div', { class: 'card-body stack' },
        h('div', { class: 'form-grid cols-3' }, head),
        formBox,
        h('div', { class: 'row', style: { justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: '14px' } },
          h('button', { class: 'btn ghost', onclick: () => back() }, 'Cancelar'),
          h('button', { class: 'btn primary', onclick: save }, icon('check', 16), 'Salvar registro')))));
}

// ======================= Abas do prontuário =======================
export async function recordTab(body, p, type) {
  const rows = await get(`/records${qs({ type, patient_id: p.id, full: 1 })}`);
  const addBtn = h('button', { class: 'btn primary', onclick: () => go(`#/registro/${type}/novo/${p.id}`) }, icon('plus', 16), NEW_LABEL[type]);
  if (!rows.length) { body.append(h('div', { class: 'card' }, empty(`Nenhum registro de ${LABELS.record[type].toLowerCase()} para este paciente.`, addBtn))); return; }
  body.append(h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '12px' } }, addBtn));
  for (const r of rows) {
    const title = type === 'avaliacao' ? [r.data.tipo || 'Avaliação', areaLabel(r.data.area)].filter(Boolean).join(' · ') : LABELS.record[type];
    body.append(h('div', { class: 'card', style: { marginBottom: '14px', opacity: r.status === 'substituido' ? 0.8 : 1 } },
      h('div', { class: 'card-head' },
        h('div', null, h('div', { class: 'row' }, h('h2', null, `${title} — ${fmtDate(r.record_date)}`), type === 'plano' ? badge(r.status, 'plano') : null),
          h('small', null, `${r.author_name || '—'} · atualizado em ${fmtDT(r.updated_at.replace(' ', 'T'))}`)),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => openPrint('registro', { id: r.id }) }, icon('printer', 15), 'PDF'),
          h('button', { class: 'btn sm', onclick: () => go(`#/registro/${r.id}`) }, icon('eye', 15), 'Abrir'),
          h('button', { class: 'btn sm', onclick: () => go(`#/registro/${r.id}/editar`) }, icon('edit', 15), 'Editar'))),
      h('div', { class: 'card-body' }, renderRecordData(type, r.data))));
  }
}

export function painSeries(evols) {
  const pts = [...evols].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map((e) => ({ label: `S${e.seq}`, ini: e.data.dor_inicio, fim: e.data.dor_fim }));
  return [pts, [{ key: 'ini', label: 'Dor no início da sessão', color: '#c2410c' }, { key: 'fim', label: 'Dor ao final da sessão', color: '#0f766e', dash: '5 4' }]];
}

export async function evolutionsTab(body, p) {
  const rows = await get(`/records${qs({ type: 'evolucao', patient_id: p.id, full: 1 })}`);
  const addBtn = h('button', { class: 'btn primary', onclick: () => go(`#/registro/evolucao/novo/${p.id}`) }, icon('plus', 16), 'Nova evolução');
  if (!rows.length) { body.append(h('div', { class: 'card' }, empty('Nenhuma evolução registrada.', addBtn))); return; }
  const selected = new Set();
  const cmpBtn = h('button', { class: 'btn', disabled: true, onclick: () => compare(rows.filter((r) => selected.has(r.id))) }, icon('columns', 16), 'Comparar selecionadas');
  const updateBtn = () => { cmpBtn.disabled = selected.size < 2; cmpBtn.lastChild.textContent = selected.size ? `Comparar (${selected.size})` : 'Comparar selecionadas'; };
  const highlights = ['queixa', 'exercicios', 'tecnicas', 'series_repeticoes', 'resposta', 'evolucao', 'intercorrencias', 'orientacoes'];
  const fieldsByKey = Object.fromEntries(unionFields('evolucao', rows).map((f) => [f.key, f]));
  const baseKeys = new Set(EVOLUCAO.map((f) => f.key));

  body.append(
    rows.some((r) => ['dor_inicio', 'dor_fim'].some((k) => r.data[k] !== '' && r.data[k] != null && Number(r.data[k]) > 0)) ? h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-head' }, h('h2', null, 'Dor (EVA) ao longo das sessões'), h('small', null, `${rows.length} sessão(ões) registrada(s)`)),
      h('div', { class: 'card-body' }, lineChart(...painSeries(rows)))) : '',
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } }, h('small', null, 'Marque 2 a 4 sessões para comparar lado a lado.'), h('div', { class: 'row' }, cmpBtn, h('button', { class: 'btn', onclick: () => openPrint('evolucoes', { patient: p.id }) }, icon('printer', 16), 'PDF'), addBtn)),
    h('div', { class: 'timeline' }, rows.map((r) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': `Selecionar sessão ${r.seq}`, onchange: () => { if (cb.checked) { if (selected.size >= 4) { cb.checked = false; return toast('Selecione no máximo 4 sessões', 'error'); } selected.add(r.id); } else selected.delete(r.id); updateBtn(); } });
      const pain = [r.data.dor_inicio !== '' && r.data.dor_inicio != null ? `início ${r.data.dor_inicio}` : null, r.data.dor_fim !== '' && r.data.dor_fim != null ? `fim ${r.data.dor_fim}` : null].filter(Boolean).join(' → ');
      return h('div', { class: 'tl-item card' }, h('div', { class: 'card-body' },
        h('div', { class: 'tl-head' },
          h('label', { class: 'row', style: { gap: '8px', cursor: 'pointer' } }, cb, h('b', null, `Sessão nº ${r.seq}`), h('span', { class: 'muted' }, fmtDate(r.record_date)), pain ? h('span', { class: 'badge amber' }, `EVA ${pain}`) : null),
          h('div', { class: 'row', style: { gap: '4px' } },
            h('button', { class: 'icon-btn', title: 'PDF', onclick: () => openPrint('registro', { id: r.id }) }, icon('printer', 16)),
            h('button', { class: 'icon-btn', title: 'Editar', onclick: () => go(`#/registro/${r.id}/editar`) }, icon('edit', 16)),
            h('button', { class: 'btn sm ghost', onclick: () => go(`#/registro/${r.id}`) }, 'Abrir'))),
        h('div', { class: 'tl-grid' },
          schemaFor('evolucao', r.data).filter((f) => f.type !== 'section' && !baseKeys.has(f.key) && fieldValue(f, r.data[f.key])).map((f) => h('div', null, h('b', null, f.label), h('span', null, fieldValue(f, r.data[f.key])))),
          highlights.filter((k) => r.data[k]).map((k) => h('div', null, h('b', null, fieldsByKey[k].label), h('span', null, r.data[k])))),
        h('small', null, r.author_name || '')));
    })));

  function compare(list) {
    list.sort((a, b) => a.seq - b.seq);
    const tbl = h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Campo'), list.map((r) => h('th', null, `Sessão ${r.seq} — ${fmtDate(r.record_date)}`)))),
      h('tbody', null, unionFields('evolucao', list).filter((f) => list.some((r) => fieldValue(f, r.data[f.key]))).map((f) =>
        h('tr', null, h('td', null, f.label), list.map((r) => h('td', null, fieldValue(f, r.data[f.key]) || '—'))))));
    modal({ title: 'Comparação de evoluções', wide: true, body: h('div', { class: 'compare' }, tbl) });
  }
}

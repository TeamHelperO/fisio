// Biblioteca de exercícios e programas de exercícios (prescrição para o paciente)
import { h, icon, toast, buildForm, fmtDate, empty, debounce, confirmDialog, modal, today } from '../ui.js';
import { get, post, put, del } from '../api.js';
import { go, back, openPrint } from '../state.js';

let META = null; let LIB = null;
const meta = async () => (META ||= await get('/exercises/meta'));
const library = async (force = false) => { if (!LIB || force) LIB = await get('/exercises'); return LIB; };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const OBJ_TONE = { Fortalecimento: 'blue', 'Alongamento e mobilidade': 'teal', 'Equilíbrio e propriocepção': 'amber', Condicionamento: 'red' };

// ---------- Filtros e lista (usados na biblioteca e no seletor do programa) ----------
function browser({ onOpen, pageSize = 40 }) {
  const state = { q: '', region: '', objective: '', equipment: '', source: '', shown: pageSize };
  const sel = (key, label, opts) => {
    const s = h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': label },
      h('option', { value: '' }, label), opts.map((o) => h('option', { value: o }, o)));
    s.onchange = () => { state[key] = s.value; state.shown = pageSize; render(); };
    return s;
  };
  const list = h('div', { class: 'list ex-list' });
  const count = h('small', { class: 'muted' });
  const filters = h('div', { class: 'row ex-filters' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar exercício, músculo ou região…',
    oninput: debounce((e) => { state.q = e.target.value; state.shown = pageSize; render(); }, 150) });
  let all = [];
  async function init() {
    const [m, lib] = await Promise.all([meta(), library()]);
    all = lib;
    const eq = [...new Set([...m.equipment, ...lib.map((e) => e.equipment)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const regions = [...new Set([...m.regions, ...lib.map((e) => e.region)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    filters.replaceChildren(
      h('div', { class: 'search grow', style: { minWidth: '220px' } }, icon('search', 16), search),
      sel('region', 'Todas as regiões', regions), sel('objective', 'Todos os objetivos', m.objectives),
      sel('equipment', 'Todo equipamento', eq),
      (() => { const s = h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Origem' },
        [['', 'Catálogo e da clínica'], ['clinica', 'Só da clínica'], ['catalogo', 'Só do catálogo']].map(([v, l]) => h('option', { value: v }, l)));
      s.onchange = () => { state.source = s.value; state.shown = pageSize; render(); }; return s; })());
    render();
  }
  function render() {
    const terms = norm(state.q).split(/\s+/).filter(Boolean);
    const rows = all.filter((e) => (!state.region || e.region === state.region) && (!state.objective || e.objective === state.objective)
      && (!state.equipment || e.equipment === state.equipment) && (!state.source || e.source === state.source)
      && (!terms.length || terms.every((t) => norm([e.name, e.region, e.target, ...(e.muscles || []), e.equipment].join(' ')).includes(t))));
    count.textContent = `${rows.length} exercício(s)`;
    list.replaceChildren(...(rows.length ? rows.slice(0, state.shown).map((e) => h('div', { class: 'list-item click', onclick: () => onOpen(e) },
      h('span', { class: 'ex-ic' }, icon(e.objective === 'Alongamento e mobilidade' ? 'activity' : e.objective === 'Condicionamento' ? 'trending' : 'target', 17)),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('b', null, e.name, e.source === 'clinica' ? h('span', { class: 'badge green', style: { marginLeft: '8px' } }, 'Da clínica') : null),
        h('div', { class: 'muted ex-sub' }, [e.region, e.equipment, e.target].filter(Boolean).join(' · '))),
      h('span', { class: `badge ${OBJ_TONE[e.objective] || 'gray'} hide-sm` }, e.objective)))
      : [empty('Nenhum exercício encontrado com esses filtros.')]),
    rows.length > state.shown ? h('div', { class: 'list-item', style: { justifyContent: 'center' } },
      h('button', { class: 'btn sm', onclick: () => { state.shown += pageSize * 2; render(); } }, `Mostrar mais (${rows.length - state.shown})`)) : null);
  }
  return { el: h('div', null, filters, h('div', { style: { margin: '8px 2px' } }, count), list), init, focus: () => search.focus(), refresh: async () => { all = await library(true); render(); } };
}

// ---------- Detalhe do exercício ----------
function exerciseBody(e) {
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: `badge ${OBJ_TONE[e.objective] || 'gray'}` }, e.objective), h('span', { class: 'badge gray' }, e.region), h('span', { class: 'badge gray' }, e.equipment),
      e.source === 'clinica' ? h('span', { class: 'badge green' }, 'Da clínica') : null),
    e.target || e.muscles?.length ? h('p', { style: { margin: 0 } }, h('b', null, 'Músculos: '), [e.target, ...(e.muscles || [])].filter(Boolean).join(', ')) : null,
    h('div', null, h('b', null, 'Como fazer'), h('ol', { class: 'ex-steps' }, (e.steps || []).map((s) => h('li', null, s)))),
    e.media_url ? h('p', { style: { margin: 0 } }, icon('eye', 14), ' ', h('a', { href: e.media_url, target: '_blank', rel: 'noopener noreferrer' }, 'Ver vídeo ou imagem de referência')) : null);
}
async function openExercise(ref, { onAdd, onChanged } = {}) {
  const e = await get(`/exercises/${ref}`);
  const actions = [];
  if (e.source === 'catalogo') actions.push(h('button', { class: 'btn ghost', onclick: () => { m.close(); exerciseForm({ ...e, based_on: e.ref, name: e.name }, { onSaved: onChanged }); } }, icon('edit', 15), 'Personalizar'));
  else {
    actions.push(h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => {
      if (!(await confirmDialog(`Excluir "${e.name}" da biblioteca da clínica? Programas já prescritos não são alterados.`, { okLabel: 'Excluir', danger: true }))) return;
      try { await del(`/exercises/${e.id}`); toast('Exercício excluído'); m.close(); onChanged && onChanged(); } catch (err) { toast(err.message, 'error'); }
    } }, icon('trash', 15), 'Excluir'));
    actions.push(h('button', { class: 'btn', onclick: () => { m.close(); exerciseForm(e, { onSaved: onChanged }); } }, icon('edit', 15), 'Editar'));
  }
  if (onAdd) actions.push(h('button', { class: 'btn primary', onclick: () => { onAdd(e); m.close(); } }, icon('plus', 15), 'Adicionar ao programa'));
  const m = modal({ title: e.name, wide: true, body: h('div', { class: 'stack' }, exerciseBody(e),
    e.source === 'catalogo' ? h('small', { class: 'help' }, '"Personalizar" cria uma cópia na biblioteca da clínica, onde você pode ajustar o texto e incluir um link de vídeo.') : null), actions });
}

// ---------- Cadastro de exercício da clínica ----------
async function exerciseForm(e = {}, { onSaved } = {}) {
  const m0 = await meta();
  const own = e.source === 'clinica' && e.id;
  const opts = (list, cur) => [...new Set([...(cur ? [cur] : []), ...list])];
  const form = buildForm([
    { key: 'name', label: 'Nome do exercício', required: true, span: true },
    { key: 'region', label: 'Região do corpo', type: 'select', options: opts(m0.regions, e.region), required: true },
    { key: 'objective', label: 'Objetivo', type: 'select', options: m0.objectives, required: true },
    { key: 'equipment', label: 'Equipamento', type: 'select', options: opts(m0.equipment, e.equipment), required: true },
    { key: 'target', label: 'Músculo principal', placeholder: 'ex.: glúteo médio' },
    { key: 'muscles', label: 'Outros músculos (um por linha)', type: 'textarea', rows: 2 },
    { key: 'steps', label: 'Como fazer (um passo por linha)', type: 'textarea', rows: 7, required: true },
    { key: 'media_url', label: 'Link de vídeo ou imagem (opcional)', type: 'url', placeholder: 'https://…', span: true, help: 'Ex.: um vídeo seu no YouTube. Aparece na folha do paciente.' },
  ], { ...e, muscles: (e.muscles || []).join('\n'), steps: (e.steps || []).join('\n') });
  const save = async () => {
    if (!form.validate()) return;
    const v = form.getValues();
    try {
      if (own) await put(`/exercises/${e.id}`, v);
      else await post('/exercises', { ...v, based_on: e.based_on });
      toast(own ? 'Exercício atualizado' : 'Exercício salvo na biblioteca da clínica');
      LIB = null; m.close(); onSaved && onSaved();
    } catch (err) { toast(err.message, 'error'); }
  };
  const m = modal({ title: own ? 'Editar exercício' : e.based_on ? 'Personalizar exercício' : 'Novo exercício', wide: true, body: form,
    actions: [h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: save }, icon('check', 16), 'Salvar')] });
}

// ---------- Página: Biblioteca ----------
export async function exercisesPage(view) {
  const b = browser({ onOpen: (e) => openExercise(e.ref, { onChanged: () => b.refresh() }) });
  const m0 = await meta();
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Biblioteca de exercícios'),
      h('p', null, 'Exercícios para prescrever aos pacientes. Monte o programa na ficha do paciente (aba Exercícios) e imprima a folha para casa.')),
    h('button', { class: 'btn primary', onclick: () => exerciseForm({}, { onSaved: () => b.refresh() }) }, icon('plus', 16), 'Novo exercício')),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, b.el)),
    h('p', null, h('small', { class: 'muted' }, `${m0.catalog_count} exercícios no catálogo. ${m0.credit}`)));
  await b.init();
}

// ---------- Seletor (usado no editor do programa) ----------
function pickExercises(onPick) {
  const b = browser({ pageSize: 30, onOpen: (e) => openExercise(e.ref, { onAdd: (full) => { onPick(full); toast(`Adicionado: ${full.name}`); } }) });
  const m = modal({ title: 'Adicionar exercícios', wide: true, body: h('div', { class: 'stack' },
    h('small', { class: 'help' }, 'Clique num exercício para ver os detalhes e adicioná-lo. Você pode adicionar vários antes de fechar.'), b.el),
  actions: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Concluir')] });
  b.init().then(() => b.focus()).catch((e) => toast(e.message, 'error'));
}

// ---------- Aba do paciente: programas ----------
export const doseText = (it) => [
  it.sets ? `${it.sets} série(s)` : '', it.reps ? `${it.reps} repetições` : '', it.hold_s ? `sustentar ${it.hold_s} s` : '',
  it.load ? `carga: ${it.load}` : '', it.rest_s ? `descanso ${it.rest_s} s` : '', it.side || '',
].filter(Boolean).join(' · ');

export async function programsTab(body, p) {
  const list = await get(`/patients/${p.id}/programs`);
  const card = (x) => h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, x.title, ' ', h('span', { class: `badge ${x.status === 'ativo' ? 'green' : 'gray'}` }, x.status === 'ativo' ? 'Ativo' : 'Encerrado')),
        h('small', { class: 'muted' }, `Desde ${fmtDate(x.start_date)} · ${x.items.length} exercício(s)${x.frequency ? ' · ' + x.frequency : ''}${x.author_name ? ' · ' + x.author_name : ''}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => openPrint('programa', { id: x.id }) }, icon('printer', 15), 'Folha do paciente'),
        h('button', { class: 'btn sm', onclick: () => go(`#/programa/${x.id}/editar`) }, icon('edit', 15), 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: async () => {
          try { await put(`/programs/${x.id}`, { status: x.status === 'ativo' ? 'encerrado' : 'ativo' }); toast(x.status === 'ativo' ? 'Programa encerrado' : 'Programa reativado'); dispatchEvent(new Event('fisio:refresh')); } catch (e) { toast(e.message, 'error'); }
        } }, x.status === 'ativo' ? 'Encerrar' : 'Reativar'),
        h('button', { class: 'icon-btn', title: 'Excluir', 'aria-label': 'Excluir programa', onclick: async () => {
          if (!(await confirmDialog(`Excluir o programa "${x.title}"?`, { okLabel: 'Excluir', danger: true }))) return;
          try { await del(`/programs/${x.id}`); toast('Programa excluído'); dispatchEvent(new Event('fisio:refresh')); } catch (e) { toast(e.message, 'error'); }
        } }, icon('trash', 16)))),
    h('div', { class: 'list' }, x.items.map((it, i) => h('div', { class: 'list-item' },
      h('span', { class: 'ex-num' }, i + 1),
      h('div', { class: 'grow' }, h('b', null, it.name), h('div', { class: 'muted ex-sub' }, doseText(it) || 'Sem dosagem definida'))))));
  body.append(h('div', { class: 'stack' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('small', { class: 'muted' }, 'Programas de exercícios prescritos (para casa ou para as sessões). A folha do paciente sai pronta para imprimir ou salvar em PDF.'),
      h('button', { class: 'btn primary', onclick: () => go(`#/programa/novo/${p.id}`) }, icon('plus', 16), 'Novo programa')),
    list.length ? list.map(card) : h('div', { class: 'card' }, empty('Nenhum programa de exercícios ainda.', h('button', { class: 'btn primary', onclick: () => go(`#/programa/novo/${p.id}`) }, 'Montar programa')))));
}

// ---------- Editor de programa ----------
export async function programEditPage(view, [a, b]) {
  // rotas: programa/novo/:pacienteId  ·  programa/:id/editar
  const editing = a !== 'novo';
  const prog = editing ? await get(`/programs/${a}`) : null;
  const patientId = editing ? prog.patient_id : b;
  const p = await get(`/patients/${patientId}`);
  const items = (prog?.items || []).map((it) => ({ ...it }));
  const form = buildForm([
    { key: 'title', label: 'Título', required: true, placeholder: 'ex.: Exercícios para casa — fase 1' },
    { key: 'start_date', label: 'Início', type: 'date', required: true },
    { key: 'frequency', label: 'Frequência', placeholder: 'ex.: 1 vez ao dia, 5 dias por semana' },
    { key: 'duration', label: 'Duração prevista', placeholder: 'ex.: 4 semanas' },
    { key: 'notes', label: 'Orientações gerais', type: 'textarea', rows: 3, placeholder: 'ex.: Faça os exercícios devagar. Se sentir dor forte, pare e avise seu fisioterapeuta.' },
  ], prog || { title: 'Exercícios para casa', start_date: today() });
  const listEl = h('div', { class: 'stack' });
  const field = (it, key, label, attrs = {}) => {
    const inp = h('input', { class: 'input', value: it[key] ?? '', ...attrs });
    inp.oninput = () => { it[key] = inp.value; };
    return h('label', { class: 'field' }, h('span', null, label), inp);
  };
  const render = () => {
    listEl.replaceChildren(...(items.length ? items.map((it, i) => {
      const steps = h('textarea', { class: 'input', rows: 4 }); steps.value = (it.steps || []).join('\n');
      steps.oninput = () => { it.steps = steps.value.split('\n'); };
      return h('div', { class: 'card ex-item' },
        h('div', { class: 'card-head' },
          h('div', { class: 'row grow', style: { minWidth: 0 } }, h('span', { class: 'ex-num' }, i + 1), h('b', null, it.name)),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn', title: 'Subir', 'aria-label': 'Mover para cima', disabled: i === 0, onclick: () => { items.splice(i - 1, 0, items.splice(i, 1)[0]); render(); } }, '↑'),
            h('button', { class: 'icon-btn', title: 'Descer', 'aria-label': 'Mover para baixo', disabled: i === items.length - 1, onclick: () => { items.splice(i + 1, 0, items.splice(i, 1)[0]); render(); } }, '↓'),
            h('button', { class: 'icon-btn', title: 'Remover', 'aria-label': 'Remover exercício', onclick: () => { items.splice(i, 1); render(); } }, icon('trash', 16)))),
        h('div', { class: 'card-body' },
          h('div', { class: 'form-grid cols-4 ex-dose' },
            field(it, 'sets', 'Séries', { type: 'number', min: 0, max: 50, inputmode: 'numeric' }),
            field(it, 'reps', 'Repetições', { placeholder: 'ex.: 10 ou 8–12' }),
            field(it, 'hold_s', 'Sustentar (s)', { type: 'number', min: 0, max: 3600, inputmode: 'numeric' }),
            field(it, 'rest_s', 'Descanso (s)', { type: 'number', min: 0, max: 3600, inputmode: 'numeric' }),
            field(it, 'load', 'Carga', { placeholder: 'ex.: elástico verde, 1 kg' }),
            field(it, 'side', 'Lado', { placeholder: 'ex.: cada lado, direito' }),
            h('div', { class: 'span-2' }, field(it, 'notes', 'Observação para o paciente', { placeholder: 'ex.: sem dor; pare se formigar' }))),
          h('details', { class: 'ex-details' }, h('summary', null, 'Instruções de execução (aparecem na folha)'),
            h('label', { class: 'field' }, h('span', null, 'Um passo por linha'), steps))));
    }) : [h('div', { class: 'card' }, empty('Nenhum exercício no programa ainda.', h('button', { class: 'btn primary', onclick: add }, icon('plus', 16), 'Adicionar exercícios')))]));
  };
  function add() {
    pickExercises((e) => { items.push({ ref: e.ref, name: e.name, region: e.region, equipment: e.equipment, steps: e.steps, media_url: e.media_url, sets: 3, reps: '10' }); render(); });
  }
  const save = async () => {
    if (!form.validate()) return;
    if (!items.length) return toast('Adicione pelo menos um exercício', 'error');
    const body = { ...form.getValues(), items: items.map((it) => ({ ...it, steps: (it.steps || []).map((s) => String(s).trim()).filter(Boolean) })) };
    try {
      let id = prog?.id;
      if (editing) await put(`/programs/${id}`, body);
      else id = (await post('/programs', { ...body, patient_id: p.id })).id;
      toast('Programa salvo');
      go(`#/pacientes/${p.id}/exercicios`);
      if (!editing) setTimeout(() => openPrint('programa', { id }), 50);
    } catch (e) { toast(e.message, 'error'); }
  };
  render();
  view.append(
    h('a', { class: 'crumb', href: `#/pacientes/${p.id}/exercicios` }, `← ${p.name}`),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, editing ? 'Editar programa de exercícios' : 'Novo programa de exercícios'), h('p', null, `Paciente: ${p.name}`))),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('div', { class: 'card-body' }, form)),
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', { style: { margin: 0, fontSize: '16px' } }, 'Exercícios'),
        h('button', { class: 'btn', onclick: add }, icon('plus', 16), 'Adicionar exercícios')),
      listEl,
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: () => back() }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: save }, icon('check', 16), editing ? 'Salvar' : 'Salvar e gerar folha'))));
}

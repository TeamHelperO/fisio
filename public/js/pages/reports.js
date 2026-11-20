import { h, icon, toast, today, debounce, age, badge } from '../ui.js';
import { get, qs } from '../api.js';
import { openPrint, isClinical, go } from '../state.js';

const PATIENT_DOCS = [
  ['anamnese', 'Ficha de anamnese', 'clipboard', true],
  ['avaliacao', 'Avaliação fisioterapêutica', 'activity', true],
  ['plano', 'Plano de tratamento', 'target', true],
  ['evolucoes', 'Evolução das sessões', 'trending', true],
  ['acompanhamento', 'Relatório de acompanhamento', 'file', true],
  ['prontuario', 'Prontuário completo', 'file', true],
  ['consentimento', 'Termo de consentimento LGPD', 'shield', false],
];

export async function reportsPage(view) {
  let patient = null;
  const chosen = h('div', { class: 'muted' }, 'Nenhum paciente selecionado.');
  const results = h('div', { class: 'list', style: { maxHeight: '260px', overflowY: 'auto' } });
  const docs = h('div', { class: 'list' });
  const renderDocs = () => {
    docs.replaceChildren(...PATIENT_DOCS.filter((d) => !d[3] || isClinical()).map(([k, label, ic]) => h('div', { class: 'list-item' },
      icon(ic, 18), h('div', { class: 'grow' }, label),
      h('button', { class: 'btn sm', disabled: !patient, onclick: () => openPrint(k, { patient: patient.id }) }, icon('printer', 15), 'Gerar PDF'))));
  };
  const search = async (term) => {
    if (!term) { results.replaceChildren(); return; }
    const rows = await get('/patients' + qs({ q: term }));
    results.replaceChildren(...rows.slice(0, 20).map((p) => h('div', { class: 'list-item click', onclick: () => {
      patient = p; results.replaceChildren(); input.value = '';
      chosen.replaceChildren(h('b', null, p.name), ' ', p.birth_date ? `(${age(p.birth_date)} anos)` : '', ' ', badge(p.status, 'status'));
      renderDocs();
    } }, h('div', { class: 'grow' }, h('b', null, p.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, p.cpf || '')))));
  };
  const input = h('input', { class: 'input', placeholder: 'Buscar paciente por nome ou CPF…', oninput: debounce((e) => search(e.target.value.trim())) });
  renderDocs();

  const y = new Date().getFullYear();
  const from = h('input', { class: 'input', type: 'date', value: `${y}-01-01`, style: { width: 'auto' } });
  const to = h('input', { class: 'input', type: 'date', value: today(), style: { width: 'auto' } });
  const year = h('select', { class: 'input', style: { width: 'auto' } }, Array.from({ length: 6 }, (_, i) => h('option', { value: y - i }, y - i)));

  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Relatórios e documentos'), h('p', null, 'Documentos com identificação do profissional e do paciente, data e espaço para assinatura. Na janela de impressão, escolha "Salvar como PDF".'))),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Documentos do paciente')),
        h('div', { class: 'card-body stack' }, h('div', { class: 'search' }, icon('search', 16), input), results, chosen), docs),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Relatórios administrativos')),
          h('div', { class: 'card-body stack' },
            h('div', { class: 'row' }, h('span', null, 'Período:'), from, h('span', null, 'a'), to),
            h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: () => openPrint('receitas', { from: from.value, to: to.value }) }, icon('printer', 16), 'Relatório de receitas'),
              h('button', { class: 'btn', onclick: () => openPrint('atendimentos', { from: from.value, to: to.value }) }, icon('printer', 16), 'Relatório de atendimentos')))),
        isClinical() ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Carnê-Leão')),
          h('div', { class: 'card-body stack' },
            h('p', { class: 'muted', style: { margin: 0 } }, 'Consolidação anual das receitas recebidas, para conferência e lançamento no Carnê-Leão. Não calcula imposto.'),
            h('div', { class: 'row' }, h('span', null, 'Ano:'), year, h('button', { class: 'btn', onclick: () => openPrint('carneleao', { year: year.value }) }, icon('printer', 16), 'Gerar PDF'),
              h('button', { class: 'btn ghost', onclick: () => go('#/financeiro/carneleao') }, 'Abrir área')))) : null,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Recibos de pagamento')),
          h('div', { class: 'card-body' }, h('p', { class: 'muted', style: { marginTop: 0 } }, 'Os recibos são emitidos para cada pagamento registrado.'),
            h('button', { class: 'btn', onclick: () => go('#/financeiro/lancamentos') }, icon('receipt', 16), 'Ir para lançamentos'))))));
}

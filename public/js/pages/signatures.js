// Assinatura digital: gerar link para o paciente assinar pelo celular e acompanhar as assinaturas
import { h, icon, toast, modal, confirmDialog, fmtDate } from '../ui.js';
import { get, post } from '../api.js';
import { openPrint } from '../state.js';

const refresh = () => dispatchEvent(new Event('fisio:refresh'));
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// abre a janela para gerar o link e compartilhar
export function requestSignature(patient, docType, recordId = null) {
  const label = docType === 'consentimento' ? 'o termo de consentimento (LGPD)' : 'o plano de tratamento';
  const sendEmail = h('input', { type: 'checkbox', checked: !!patient.email, disabled: !patient.email });
  const m = modal({ title: 'Enviar para assinatura digital', body: h('div', { class: 'stack' },
    h('p', { style: { margin: 0 } }, `Gera um link para ${patient.name} ler e assinar ${label} pelo celular, com o dedo. O link vale por 7 dias e funciona uma única vez.`),
    h('label', { class: 'switch-row' }, sendEmail, h('span', null, patient.email ? `Enviar o link também por e-mail (${patient.email})` : 'Paciente sem e-mail cadastrado: compartilhe o link pelo WhatsApp')),
    h('small', { class: 'help' }, 'Ficam registrados, cifrados: o documento exatamente como foi assinado, a assinatura, data e hora, IP e navegador.')),
  actions: [h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await post(`/patients/${patient.id}/signatures`, { doc_type: docType, record_id: recordId, send_email: sendEmail.checked });
      m.close(); shareLink(patient, r);
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  } }, 'Gerar link')] });
}

function shareLink(patient, r) {
  const msg = `Olá, ${patient.name.split(' ')[0]}! Segue o link para ler e assinar o documento "${r.title}": ${r.url}`;
  const phone = onlyDigits(patient.phone);
  const wa = `https://wa.me/${phone.length >= 10 ? (phone.length <= 11 ? '55' + phone : phone) : ''}?text=${encodeURIComponent(msg)}`;
  const input = h('input', { class: 'input', value: r.url, readOnly: true, onfocus: (e) => e.target.select() });
  modal({ title: 'Link de assinatura pronto', body: h('div', { class: 'stack' },
    r.emailed ? h('div', { class: 'notice info' }, icon('check'), h('span', null, `Link enviado por e-mail para ${patient.email}.`)) : null,
    h('label', { class: 'field' }, h('span', null, 'Link (vale por 7 dias, uso único)'), input),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(r.url); toast('Link copiado'); } catch { input.select(); toast('Copie o link selecionado', 'error'); } } }, 'Copiar link'),
      h('a', { class: 'btn primary', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'Enviar pelo WhatsApp')),
    h('small', { class: 'help' }, 'Quando o paciente assinar, o documento aparece como "Assinado" na aba LGPD, com o comprovante.')),
  onClose: refresh });
}

// cartão da aba LGPD do paciente
export async function signaturesCard(patient) {
  const list = await get(`/patients/${patient.id}/signatures`);
  const ST = { pendente: ['amber', 'Aguardando assinatura'], assinado: ['green', 'Assinado'], cancelado: ['gray', 'Cancelado'] };
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Assinatura digital'),
      h('button', { class: 'btn sm primary', onclick: () => requestSignature(patient, 'consentimento') }, icon('edit', 15), 'Enviar termo LGPD para assinar')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Documento', 'Pedido em', 'Situação', 'Assinado por', ''].map((t) => h('th', null, t)))),
      h('tbody', null, list.map((s) => h('tr', null,
        h('td', null, s.title), h('td', { class: 'nowrap' }, fmtDate(s.created_at.slice(0, 10)), h('div', null, h('small', { class: 'muted' }, s.created_by_name || ''))),
        h('td', null, s.expired ? h('span', { class: 'badge gray' }, 'Link expirado') : h('span', { class: `badge ${ST[s.status][0]}` }, ST[s.status][1])),
        h('td', null, s.signed_at ? [s.signer_name, h('div', null, h('small', { class: 'muted' }, `${fmtDate(s.signed_at.slice(0, 10))} às ${s.signed_at.slice(11, 16)}`))] : '—'),
        h('td', { class: 'actions' },
          s.status === 'assinado' ? h('button', { class: 'btn sm', onclick: () => openPrint('assinatura', { id: s.id }) }, icon('printer', 14), 'Comprovante') : null,
          s.status === 'pendente' && !s.expired ? h('button', { class: 'btn sm ghost', onclick: async () => {
            if (!(await confirmDialog('Cancelar este pedido? O link deixa de funcionar.', { okLabel: 'Cancelar pedido', danger: true }))) return;
            try { await post(`/signatures/${s.id}/cancel`); toast('Pedido cancelado'); refresh(); } catch (e) { toast(e.message, 'error'); }
          } }, 'Cancelar') : null,
          (s.status === 'pendente' && s.expired) || s.status === 'cancelado' ? h('button', { class: 'btn sm ghost', onclick: () => requestSignature(patient, s.doc_type, s.record_id) }, 'Gerar novo link') : null))))))
      : h('div', { class: 'card-body' }, h('small', { class: 'muted' }, 'Envie o termo LGPD ou o plano de tratamento para o paciente assinar pelo celular, sem papel. O plano é enviado pela tela do próprio plano.')));
}

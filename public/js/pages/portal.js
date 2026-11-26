// Portal do paciente (lado da clínica): gerar/compartilhar o link pessoal e ver o diário de dor
import { h, icon, toast, modal, confirmDialog, fmtDate } from '../ui.js';
import { get, post } from '../api.js';
import { lineChart } from '../charts.js';

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const fmtTs = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export async function portalModal(p) {
  const st = await get(`/patients/${p.id}/portal`);
  const sendEmail = h('input', { type: 'checkbox', checked: !!p.email, disabled: !p.email });
  const body = h('div', { class: 'stack' });
  const m = modal({ title: 'Portal do paciente', body });
  const share = (r) => {
    const msg = `Olá, ${p.name.split(' ')[0]}! Este é o seu link pessoal para acompanhar suas consultas, exercícios, pagamentos e registrar como está sua dor: ${r.url}`;
    const phone = onlyDigits(p.phone);
    const wa = `https://wa.me/${phone.length >= 10 ? (phone.length <= 11 ? '55' + phone : phone) : ''}?text=${encodeURIComponent(msg)}`;
    const input = h('input', { class: 'input', value: r.url, readOnly: true, onfocus: (e) => e.target.select() });
    body.replaceChildren(
      r.emailed ? h('div', { class: 'notice info' }, icon('check'), h('span', null, `Link enviado por e-mail para ${p.email}.`)) : null,
      h('label', { class: 'field' }, h('span', null, `Link pessoal (vale ${Math.round((r.expires_at - Date.now()) / 86400e3)} dias)`), input),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(r.url); toast('Link copiado'); } catch { input.select(); toast('Copie o link selecionado', 'error'); } } }, 'Copiar link'),
        h('a', { class: 'btn primary', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'Enviar pelo WhatsApp')),
      h('small', { class: 'help' }, 'Envie só para o próprio paciente (ou responsável): quem tiver o link vê as consultas, os exercícios e o diário dele. Por segurança, o link aparece só agora; se perder, gere outro.'));
  };
  const generate = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { share(await post(`/patients/${p.id}/portal`, { send_email: sendEmail.checked })); } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  };
  body.append(
    h('p', { style: { margin: 0 } }, `Um link pessoal para ${p.name.split(' ')[0]} acompanhar pelo celular, sem senha:`),
    h('ul', { style: { margin: '0', paddingLeft: '20px', lineHeight: 1.7 } },
      h('li', null, 'próximas consultas, com botão para confirmar presença'),
      h('li', null, 'exercícios do programa ativo, com passos e imagens'),
      h('li', null, 'pagamentos em aberto (link do Mercado Pago) e recibos'),
      h('li', null, 'documentos para assinar'),
      h('li', null, 'diário de dor (0 a 10), que aparece para o fisioterapeuta no Resumo')),
    st.active ? h('div', { class: 'notice info' }, icon('check'), h('span', null, `Link ativo desde ${fmtTs(st.created_at)} (gerado por ${st.created_by || '—'}). Último acesso do paciente: ${st.last_used_at ? fmtTs(st.last_used_at) : 'ainda não abriu'}.`)) : null,
    h('label', { class: 'switch-row' }, sendEmail, h('span', null, p.email ? `Enviar o link também por e-mail (${p.email})` : 'Paciente sem e-mail cadastrado: compartilhe pelo WhatsApp')),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', onclick: generate }, st.active ? 'Gerar novo link' : 'Gerar link do portal'),
      st.active ? h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: async () => {
        if (!(await confirmDialog('Desativar o link do portal? O paciente perde o acesso até você gerar um novo.', { okLabel: 'Desativar', danger: true }))) return;
        try { await post(`/patients/${p.id}/portal/revoke`); toast('Link desativado'); m.close(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Desativar link') : null),
    st.active ? h('small', { class: 'help' }, 'Gerar um novo link desativa o anterior.') : null);
}

// cartão do Resumo (perfil clínico): diário de dor registrado pelo paciente no portal
export async function diaryCard(p) {
  const rows = await get(`/patients/${p.id}/diary`).catch(() => []);
  if (!rows.length) return null;
  const pts = rows.slice(0, 30).reverse().map((r) => ({ label: `${r.day.slice(8, 10)}/${r.day.slice(5, 7)}`, dor: r.pain }));
  const notes = rows.filter((r) => r.note).slice(0, 5);
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Diário de dor (registrado pelo paciente)'), h('small', { class: 'muted' }, `${rows.length} registro(s)`)),
    h('div', { class: 'card-body' }, lineChart(pts, [{ key: 'dor', label: 'Dor relatada (0–10)', color: '#0f766e' }]),
      notes.length ? h('div', { class: 'stack', style: { marginTop: '10px' } }, notes.map((r) => h('div', { style: { fontSize: '13px' } },
        h('b', null, `${fmtDate(r.day)} · dor ${r.pain}: `), r.note))) : null));
}

// Recebimentos pelo app: link para o paciente pagar com Pix numa página do FisioGestão (o dinheiro cai na conta do Mercado Pago da clínica)
import { h, icon, toast, modal, money } from '../ui.js';
import { get, post } from '../api.js';

const refresh = () => dispatchEvent(new Event('fisio:refresh'));
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// situação da conta do Mercado Pago da clínica (guardada durante a sessão)
let cached = null;
export async function recvStatus(force = false) {
  if (!cached || force) cached = await get('/recebimentos/mp').catch(() => ({ available: false, connected: false, fee_pct: 0 }));
  return cached;
}

export async function requestPayLink(chargeId) {
  try { payLinkModal(await post(`/charges/${chargeId}/pay-link`)); } catch (e) { toast(e.message, 'error'); }
}

// janela para compartilhar o link (copiar, WhatsApp, e-mail) e conferir se já foi pago
export function payLinkModal(link) {
  const p = link.patient || {};
  const msg = `Olá, ${(p.name || '').split(' ')[0]}! Segue o link para pagar "${link.description}" (${money(link.amount)}) com Pix: ${link.url}`;
  const phone = onlyDigits(p.phone);
  const wa = `https://wa.me/${phone.length >= 10 ? (phone.length <= 11 ? '55' + phone : phone) : ''}?text=${encodeURIComponent(msg)}`;
  const input = h('input', { class: 'input', value: link.url, readOnly: true, onfocus: (e) => e.target.select() });
  const status = h('div');
  const m = modal({ title: 'Link de pagamento', body: h('div', { class: 'stack' },
    h('div', { class: 'muted' }, `${p.name || ''} · ${link.description}`),
    h('div', { style: { fontSize: '22px', fontWeight: 700 } }, money(link.amount)),
    h('label', { class: 'field' }, h('span', null, 'Link de pagamento (Pix, vale enquanto a cobrança estiver em aberto)'), input),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(link.url); toast('Link copiado'); } catch { input.select(); toast('Copie o link selecionado', 'error'); } } }, 'Copiar link'),
      h('a', { class: 'btn primary', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'Enviar pelo WhatsApp'),
      p.email ? h('button', { class: 'btn', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await post(`/charges/${link.charge_id}/pay-link/email`); toast(`Link enviado para ${p.email}`); } catch (err) { toast(err.message, 'error'); b.disabled = false; }
      } }, 'Enviar por e-mail') : null),
    status,
    h('small', { class: 'help' }, 'Quando o paciente pagar, o lançamento fica como pago sozinho, com o recibo. O dinheiro cai na conta do Mercado Pago da clínica.')),
  actions: [
    h('button', { class: 'btn ghost', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const r = await post(`/charges/${link.charge_id}/pay-link/check`);
        status.replaceChildren(r.status === 'pago' ? h('div', { class: 'notice info' }, icon('check'), 'Pagamento aprovado e registrado.') : h('div', { class: 'notice' }, icon('clock'), 'Ainda não consta pagamento aprovado.'));
        if (r.status === 'pago') refresh();
      } catch (err) { toast(err.message, 'error'); }
      b.disabled = false;
    } }, 'Verificar pagamento'),
    h('button', { class: 'btn primary', onclick: () => m.close() }, 'Fechar'),
  ], onClose: refresh });
}

// aba Configurações → Recebimentos (administrador da clínica)
export async function recebimentosTab(body, query) {
  const st = await recvStatus(true);
  const back = query?.get?.('mp');
  const MSG = { ok: ['info', 'Conta do Mercado Pago conectada!'], cancelado: ['', 'A conexão foi cancelada no Mercado Pago.'], expirado: ['', 'O pedido de conexão expirou. Tente de novo.'], erro: ['', 'Não foi possível conectar a conta. Tente de novo.'] };
  const fee = st.fee_pct ? `${String(st.fee_pct).replace('.', ',')}%` : null;
  const connect = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { location.href = (await post('/recebimentos/mp/connect')).url; } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  };
  const how = h('ol', { style: { margin: '6px 0 0', paddingLeft: '20px', lineHeight: 1.7 } },
    h('li', null, 'Ao agendar (ou no Financeiro), escolha "Enviar link de pagamento".'),
    h('li', null, 'Mande o link ao paciente pelo WhatsApp ou por e-mail. Ele abre uma página da clínica e paga com Pix, sem sair do FisioGestão.'),
    h('li', null, 'O dinheiro cai direto na conta do Mercado Pago da clínica e o lançamento fica pago sozinho, com recibo.'));
  const fees = h('p', { class: 'muted', style: { margin: 0 } }, 'Tarifas: o Mercado Pago cobra a tarifa dele de cada pagamento (por exemplo, Pix ou cartão)',
    fee ? `, e a plataforma FisioGestão retém ${fee} do valor de cada pagamento recebido pelo app.` : '. A plataforma FisioGestão não cobra taxa sobre os recebimentos.');
  body.append(h('div', { class: 'stack' },
    back && MSG[back] ? h('div', { class: `notice ${MSG[back][0]}` }, icon(back === 'ok' ? 'check' : 'alert'), MSG[back][1]) : null,
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Receber pelo app com o Mercado Pago')),
      h('div', { class: 'card-body stack' },
        !st.available ? h('div', { class: 'notice' }, icon('alert'), 'Os recebimentos pelo Mercado Pago ainda não foram liberados pela plataforma.')
          : st.connected ? h('div', { class: 'stack' },
            h('div', { class: 'notice info' }, icon('check'), h('span', null, 'Conta conectada: ', h('b', null, st.account?.nickname || st.account?.email || 'Mercado Pago'),
              st.account?.email && st.account?.nickname ? ` (${st.account.email})` : '', st.account?.live_mode === false ? ' — conta de TESTE' : '')),
            st.account?.connected_by ? h('small', { class: 'muted' }, `Conectada por ${st.account.connected_by}.`) : null,
            h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: connect }, 'Conectar outra conta'),
              h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, onclick: async () => {
                if (!confirm('Desconectar a conta do Mercado Pago? Os links já enviados continuam funcionando no Mercado Pago, mas não será possível gerar novos.')) return;
                try { await post('/recebimentos/mp/disconnect'); toast('Conta desconectada'); await recvStatus(true); refresh(); } catch (e) { toast(e.message, 'error'); }
              } }, 'Desconectar')))
          : h('div', { class: 'stack' },
            h('p', { style: { margin: 0 } }, 'Conecte a conta do Mercado Pago da clínica para mandar links de pagamento aos pacientes. Você entra com o login do Mercado Pago e autoriza; o FisioGestão nunca vê a sua senha.'),
            h('div', null, h('button', { class: 'btn primary', onclick: connect }, 'Conectar Mercado Pago'))),
        h('div', null, h('b', null, 'Como funciona'), how),
        fees)),
  ));
}

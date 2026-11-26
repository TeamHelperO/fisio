// Página de pagamento própria: /pagar/<código>. O paciente paga com Pix gerado na hora
// (QR Code + "copia e cola"), sem passar pela página do Mercado Pago. A tela confere sozinha até aprovar.
import { h, icon, toast } from './ui.js';

const root = document.getElementById('root');
const show = (...els) => root.replaceChildren(...els.flat().filter(Boolean));
const token = location.pathname.split('/').filter(Boolean)[1] || '';
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const api = async (path = '', body) => {
  const res = await fetch(`/api/pagar/${encodeURIComponent(token)}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fisio' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Não foi possível carregar. Tente novamente.'), { status: res.status });
  return data;
};
const head = (d) => h('div', { class: 'bk-head' }, h('div', { class: 'bk-logo' }, icon('activity', 24)),
  h('div', null, h('h1', null, d.clinic.name), h('p', null, d.patient.first_name ? `Pagamento de ${d.patient.first_name}` : 'Pagamento')));
const message = (ic, title, text) => h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon(ic, 26)),
  h('h1', { style: { fontSize: '20px', margin: '0 0 8px' } }, title), h('p', { class: 'bk-empty' }, text));
const paid = (d, receipt) => show(head(d), message('check', 'Pagamento aprovado!', `Obrigado. ${receipt ? `Recibo nº ${receipt}. ` : ''}A clínica já recebeu a confirmação.`));

async function start() {
  let d;
  try { d = await api(); } catch (e) { return show(message('alert', 'Link indisponível', e.status === 404 ? 'Este link de pagamento não é válido. Peça um novo link à clínica.' : e.message)); }
  if (d.status === 'pago') return paid(d, d.receipt_number);
  if (d.status !== 'pendente') return show(head(d), message('alert', 'Cobrança encerrada', 'Esta cobrança não está mais em aberto. Em caso de dúvida, fale com a clínica.'));
  if (!d.can_pay) return show(head(d), message('alert', 'Pagamento indisponível', `A clínica não está recebendo pagamentos online no momento.${d.clinic.phone ? ` Fale com a clínica: ${d.clinic.phone}.` : ''}`));

  const summary = h('section', { class: 'bk-card', style: { textAlign: 'center' } },
    h('div', { class: 'pt-sub' }, d.description),
    h('div', { style: { fontSize: '30px', fontWeight: 700, margin: '6px 0 2px' } }, brl(d.amount)));
  const box = h('section', { class: 'bk-card stack pt-pix' });
  const gen = h('button', { class: 'btn primary', style: { width: '100%', padding: '12px' }, onclick: () => pix() }, 'Pagar com Pix');
  box.append(h('p', { class: 'pt-sub', style: { textAlign: 'center', margin: 0 } }, 'O pagamento é feito por Pix, aqui mesmo. O valor cai direto na conta da clínica.'), gen);
  show(head(d), summary, box, h('p', { class: 'pt-sub', style: { textAlign: 'center' } }, icon('shield', 14), ' Pagamento processado com segurança pelo Mercado Pago.'));

  async function pix() {
    gen.disabled = true; gen.textContent = 'Gerando o Pix…';
    let p;
    try { p = await api('/pix', {}); } catch (e) { toast(e.message, 'error'); gen.disabled = false; gen.textContent = 'Pagar com Pix'; return; }
    const status = h('div', { class: 'pt-pix-status' }, h('span', { class: 'pt-dot' }), 'Aguardando o pagamento…');
    const left = h('small', { class: 'pt-sub', style: { textAlign: 'center' } });
    const code = h('textarea', { class: 'input pt-pix-code', readOnly: true, rows: 3, onfocus: (e) => e.target.select() }); code.value = p.code;
    const copy = h('button', { class: 'btn primary', style: { width: '100%' }, onclick: async () => {
      try { await navigator.clipboard.writeText(p.code); copy.textContent = 'Código copiado!'; setTimeout(() => { copy.textContent = 'Copiar código Pix'; }, 2500); }
      catch { code.focus(); code.select(); toast('Selecione e copie o código acima', 'error'); }
    } }, 'Copiar código Pix');
    box.replaceChildren(...[
      p.qr ? h('img', { class: 'pt-pix-qr', src: p.qr, alt: 'QR Code Pix' }) : null,
      h('ol', { class: 'pt-steps' }, h('li', null, 'Abra o app do seu banco e escolha Pix.'),
        h('li', null, p.qr ? 'Leia o QR Code ou use o "Pix copia e cola" com o código abaixo.' : 'Use o "Pix copia e cola" com o código abaixo.'),
        h('li', null, 'Confirme o pagamento. Esta página atualiza sozinha.')),
      code, copy, status, left].filter(Boolean));
    const exp = new Date(p.expires_at).getTime();
    const tick = async () => {
      const ms = exp - Date.now();
      if (ms <= 0) {
        status.replaceChildren('Este código Pix venceu.'); status.classList.add('off'); left.textContent = '';
        box.append(h('button', { class: 'btn', style: { width: '100%' }, onclick: () => start() }, 'Gerar um novo Pix'));
        return;
      }
      left.textContent = `O código vale por mais ${Math.floor(ms / 60000)} min ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} s.`;
      try {
        const r = await api('/pix');
        if (r.status === 'pago') return paid(d, r.receipt_number);
      } catch { /* sem conexão: tenta de novo */ }
      setTimeout(tick, 4000);
    };
    tick();
  }
}
start();

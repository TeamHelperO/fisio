// Configurações → WhatsApp: conexão por QR Code, lembretes automáticos (48h, 24h, 3h, 1h) e confirmação SIM/NÃO
import { h, icon, toast, confirmDialog, fmtDT } from '../ui.js';
import { get, post, put } from '../api.js';

const LABEL = { 48: '48 horas antes', 24: '24 horas antes', 3: '3 horas antes', 1: '1 hora antes' };
let poll = null;
const stopPoll = () => { if (poll) { clearTimeout(poll); poll = null; } };

export async function whatsappTab(body) {
  stopPoll();
  const st = await get('/whatsapp');
  body.replaceChildren();
  if (!st.available) {
    body.append(h('div', { class: 'notice' }, icon('shield'), h('div', null, 'O envio pelo WhatsApp ainda não foi liberado pela plataforma. Fale com o suporte do FisioGestão.')));
    return;
  }
  body.append(h('div', { class: 'stack' }, connectionCard(st, body), remindersCard(st), testCard(st), await logCard()));
}

function connectionCard(st, body) {
  const area = h('div', { class: 'stack' });
  const reload = () => whatsappTab(body);
  const showQr = (r) => {
    if (!document.body.contains(area) && poll !== null) return stopPoll();
    if (r.state === 'open') { stopPoll(); toast('WhatsApp conectado!'); return reload(); }
    area.replaceChildren(
      h('div', { class: 'row', style: { flexWrap: 'wrap', alignItems: 'flex-start', gap: '18px' } },
        r.qr ? h('img', { src: r.qr, alt: 'QR Code do WhatsApp', width: 230, height: 230, style: { border: '1px solid var(--border)', borderRadius: '8px', background: '#fff' } })
          : h('div', { class: 'loading' }, h('div', { class: 'spinner' })),
        h('ol', { style: { margin: 0, paddingLeft: '18px', lineHeight: 1.8, maxWidth: '360px' } },
          h('li', null, 'Abra o WhatsApp no celular da clínica'),
          h('li', null, 'Toque em ', h('b', null, 'Mais opções (⋮)'), ' ou ', h('b', null, 'Configurações'), ' → ', h('b', null, 'Aparelhos conectados')),
          h('li', null, 'Toque em ', h('b', null, 'Conectar um aparelho'), ' e aponte a câmera para o código'),
          h('li', null, h('small', { class: 'help' }, 'O código muda sozinho a cada poucos segundos. Esta tela atualiza quando a conexão for concluída.')))),
      h('div', null, h('button', { class: 'btn sm ghost', onclick: () => { stopPoll(); reload(); } }, 'Cancelar')));
    poll = setTimeout(async () => { try { showQr(await get('/whatsapp/qr')); } catch (e) { toast(e.message, 'error'); stopPoll(); } }, 4000);
  };
  const connect = async (btn) => {
    btn.disabled = true;
    try { showQr(await post('/whatsapp/connect')); } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  if (st.connected) {
    area.append(
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '12px', alignItems: 'center' } },
        h('span', { class: 'badge green' }, 'Conectado'),
        h('span', null, st.phone ? `Número: +${st.phone}` : 'WhatsApp da clínica conectado'),
        st.connected_at ? h('small', { class: 'help' }, `desde ${new Date(st.connected_at).toLocaleString('pt-BR')}`) : null),
      h('div', null, h('button', { class: 'btn sm ghost', style: { color: 'var(--danger)' }, onclick: async () => {
        if (!(await confirmDialog('Desconectar o WhatsApp da clínica? Os lembretes param de ser enviados até conectar de novo.', { okLabel: 'Desconectar', danger: true }))) return;
        try { await post('/whatsapp/disconnect'); toast('WhatsApp desconectado'); reload(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Desconectar')));
  } else {
    const btn = h('button', { class: 'btn primary', onclick: (e) => connect(e.currentTarget) }, st.state === 'close' ? 'Reconectar WhatsApp' : 'Conectar WhatsApp');
    if (st.state === 'close') area.append(h('div', { class: 'notice' }, icon('shield'), h('div', null, 'A conexão com o WhatsApp caiu (o celular foi desconectado ou ficou muito tempo sem internet). Escaneie o QR Code de novo.')));
    area.append(
      h('p', { style: { margin: 0 } }, 'Conecte o WhatsApp da clínica para enviar lembretes de consulta automaticamente. O paciente pode responder SIM para confirmar ou NÃO para desmarcar, e a agenda é atualizada sozinha.'),
      h('div', null, btn));
  }
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Conexão do WhatsApp')), h('div', { class: 'card-body' }, area));
}

function remindersCard(st) {
  const s = st.settings;
  const enabled = h('input', { type: 'checkbox', checked: s.enabled });
  const quiet = h('input', { type: 'checkbox', checked: s.quiet });
  const rows = st.offsets.map((hh) => {
    const r = s.reminders[hh];
    const on = h('input', { type: 'checkbox', checked: r.on });
    const ask = h('input', { type: 'checkbox', checked: r.ask });
    const text = h('textarea', { class: 'input', rows: 2, maxLength: 1000, value: r.text });
    const box = h('div', { class: 'stack', style: { borderTop: '1px solid var(--border)', paddingTop: '12px' } },
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '16px' } },
        h('label', { class: 'switch-row' }, on, h('b', null, LABEL[hh])),
        h('label', { class: 'switch-row' }, ask, h('span', null, 'Pedir confirmação (SIM / NÃO)'))),
      text);
    const sync = () => { text.disabled = !on.checked; ask.disabled = !on.checked; box.style.opacity = on.checked ? 1 : 0.6; };
    on.addEventListener('change', sync); sync();
    return { hh, on, ask, text, box };
  });
  const askText = h('textarea', { class: 'input', rows: 2, maxLength: 1000, value: s.ask_text });
  const confirmReply = h('textarea', { class: 'input', rows: 2, maxLength: 1000, value: s.confirm_reply });
  const cancelReply = h('textarea', { class: 'input', rows: 2, maxLength: 1000, value: s.cancel_reply });
  const save = h('button', { class: 'btn primary', onclick: async () => {
    save.disabled = true;
    try {
      await put('/whatsapp/settings', {
        enabled: enabled.checked, quiet: quiet.checked,
        reminders: Object.fromEntries(rows.map((r) => [r.hh, { on: r.on.checked, ask: r.ask.checked, text: r.text.value }])),
        ask_text: askText.value, confirm_reply: confirmReply.value, cancel_reply: cancelReply.value,
      });
      toast('Lembretes salvos');
    } catch (e) { toast(e.message, 'error'); } finally { save.disabled = false; }
  } }, 'Salvar lembretes');
  const field = (label, el, help) => h('label', { class: 'field' }, h('span', null, label), el, help ? h('small', { class: 'help' }, help) : null);
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Lembretes automáticos')),
    h('div', { class: 'card-body stack' },
      h('label', { class: 'switch-row' }, enabled, h('b', null, 'Enviar lembretes de consulta pelo WhatsApp')),
      !st.connected ? h('small', { class: 'help' }, 'Os lembretes começam a sair depois que o WhatsApp estiver conectado.') : null,
      h('small', { class: 'help' }, 'Variáveis: ', st.vars.map((v) => h('code', { style: { marginRight: '6px' } }, `{${v}}`)),
        ' — quem marca em cima da hora recebe só o lembrete mais próximo (ex.: consulta marcada 20 h antes recebe só o de 24 h). Pacientes sem celular cadastrado não recebem.'),
      rows.map((r) => r.box),
      h('div', { class: 'stack', style: { borderTop: '1px solid var(--border)', paddingTop: '12px' } },
        field('Pedido de confirmação (vai no fim dos lembretes marcados)', askText),
        field('Resposta quando o paciente confirma', confirmReply),
        field('Resposta quando o paciente desmarca', cancelReply, 'Quando o paciente responde NÃO, a consulta fica como "Cancelado" na agenda e o horário é liberado.'),
        h('label', { class: 'switch-row' }, quiet, h('span', null, 'Não enviar entre 22h e 6h (os lembretes desse período são pulados)'))),
      h('div', null, save)));
}

function testCard(st) {
  const phone = h('input', { class: 'input', placeholder: '(00) 00000-0000', style: { maxWidth: '220px' } });
  const btn = h('button', { class: 'btn', disabled: !st.connected, onclick: async () => {
    btn.disabled = true;
    try { await post('/whatsapp/test', { phone: phone.value }); toast('Mensagem de teste enviada'); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  } }, 'Enviar teste');
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Testar')),
    h('div', { class: 'card-body stack' },
      h('p', { style: { margin: 0 } }, 'Envia um lembrete de exemplo (salve as mensagens antes) para conferir como chega no celular.'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, phone, btn)));
}

async function logCard() {
  const rows = await get('/whatsapp/log').catch(() => []);
  const tone = { enviado: 'green', enviando: 'blue', falhou: 'red' };
  const reply = { sim: h('span', { class: 'badge teal' }, 'Confirmou'), nao: h('span', { class: 'badge amber' }, 'Desmarcou') };
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Últimos lembretes')),
    rows.length ? h('div', { class: 'table-wrap', style: { maxHeight: '50vh', overflowY: 'auto' } }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Enviado em', 'Paciente', 'Consulta', 'Lembrete', 'Situação', 'Resposta'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, fmtDT(r.sent_at || r.created_at)), h('td', null, r.patient), h('td', null, fmtDT(r.start)), h('td', null, `${r.offset_h} h antes`),
        h('td', null, h('span', { class: `badge ${tone[r.status] || 'gray'}`, title: r.error || '' }, r.status === 'falhou' ? 'Falhou' : r.status === 'enviado' ? 'Enviado' : 'Enviando')),
        h('td', null, r.reply ? reply[r.reply] : r.ask ? h('small', { class: 'help' }, 'aguardando') : '—'))))))
      : h('div', { class: 'card-body' }, h('small', { class: 'help' }, 'Nenhum lembrete enviado ainda.')));
}

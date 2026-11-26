// Configurações → WhatsApp: conexão por QR Code, lembretes automáticos (48h, 24h, 3h, 1h) e confirmação SIM/NÃO
import { h, icon, toast, confirmDialog, fmtDT } from '../ui.js';
import { get, post, put } from '../api.js';

const LABEL = { 48: '48 horas antes', 24: '24 horas antes', 3: '3 horas antes', 1: '1 hora antes' };
// ícones estáticos (conteúdo fixo, sem dados do usuário)
const AVATAR_SVG = '<svg viewBox="0 0 24 24" width="30" height="30" fill="#fff" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><path d="M3.8 20.5c.7-4.1 4.1-6.6 8.2-6.6s7.5 2.5 8.2 6.6c.1.5-.3.9-.8.9H4.6c-.5 0-.9-.4-.8-.9z"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
// +55 (11) 99999-0000
function fmtPhone(d) {
  const m = String(d).match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
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
  const nameInput = h('input', { class: 'input', maxLength: 60, value: st.label || '', placeholder: 'Ex.: Recepção, Dra. Ana, Unidade Centro', style: { maxWidth: '320px' } });
  const connect = async (btn) => {
    const label = nameInput.value.trim();
    if (!label) { toast('Dê um nome para a conexão', 'error'); nameInput.focus(); return; }
    btn.disabled = true;
    try { showQr(await post('/whatsapp/connect', { label })); } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  const rename = async () => {
    const v = await confirmDialog('Novo nome da conexão:', { title: 'Renomear conexão', okLabel: 'Salvar', input: { label: 'Nome da conexão', placeholder: st.label || 'Ex.: Recepção' } });
    if (!v || typeof v !== 'string' || !v.trim()) return;
    try { await put('/whatsapp/label', { label: v }); toast('Nome atualizado'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  if (st.connected) {
    const since = st.connected_at ? new Date(st.connected_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
    const avatar = h('div', { class: 'wa-avatar', html: AVATAR_SVG }, h('span', { class: 'wa-check', html: CHECK_SVG, title: 'Verificado' }));
    // foto do perfil do WhatsApp (se o número tiver uma e ela for pública)
    get('/whatsapp/photo').then(({ photo }) => {
      if (photo && /^data:image\/(jpeg|png|webp);base64,/.test(photo)) avatar.prepend(h('img', { class: 'wa-photo', src: photo, alt: 'Foto do perfil do WhatsApp' }));
    }).catch(() => {});
    area.append(
      h('div', { class: 'wa-connected' },
        avatar,
        h('div', { class: 'wa-info' },
          h('div', { class: 'wa-name' }, st.label || 'WhatsApp da clínica',
            h('button', { class: 'wa-rename', title: 'Renomear conexão', 'aria-label': 'Renomear conexão', onclick: rename, html: PENCIL_SVG })),
          h('div', { class: 'wa-status' }, h('span', { class: 'wa-dot' }), 'Conectado'),
          h('div', { class: 'wa-phone' }, st.phone ? fmtPhone(st.phone) : 'WhatsApp da clínica'),
          since ? h('small', { class: 'help' }, `Conectado desde ${since}`) : null),
        h('button', { class: 'btn sm ghost wa-disconnect', onclick: async () => {
          if (!(await confirmDialog('Desconectar o WhatsApp da clínica? Os lembretes param de ser enviados até conectar de novo.', { okLabel: 'Desconectar', danger: true }))) return;
          try { await post('/whatsapp/disconnect'); toast('WhatsApp desconectado'); reload(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Desconectar')));
  } else {
    const btn = h('button', { class: 'btn primary', onclick: (e) => connect(e.currentTarget) }, st.state === 'close' ? 'Reconectar WhatsApp' : 'Conectar WhatsApp');
    if (st.state === 'close') area.append(h('div', { class: 'notice' }, icon('shield'), h('div', null, 'A conexão com o WhatsApp caiu (o celular foi desconectado ou ficou muito tempo sem internet). Escaneie o QR Code de novo.')));
    area.append(
      h('p', { style: { margin: 0 } }, 'Conecte o WhatsApp da clínica para enviar lembretes de consulta automaticamente. O paciente pode responder SIM para confirmar ou NÃO para desmarcar, e a agenda é atualizada sozinha.'),
      h('label', { class: 'field', style: { maxWidth: '320px' } }, h('span', null, 'Nome da conexão'), nameInput,
        h('small', { class: 'help' }, 'Para identificar este WhatsApp (aparece aqui e no painel da Evolution).')),
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
  const result = h('div', { class: 'stack' });
  const run = h('button', { class: 'btn primary', disabled: !st.connected, onclick: async () => {
    run.disabled = true;
    try {
      const r = await post('/whatsapp/run');
      const lines = [`${r.enviados} lembrete(s) enviado(s)${r.falhas ? `, ${r.falhas} com falha` : ''}.`];
      if (r.desligado) lines.push('Os lembretes estão desligados: marque "Enviar lembretes de consulta pelo WhatsApp" e salve.');
      if (r.nenhum_horario) lines.push('Nenhum horário de lembrete está ligado.');
      if (r.horario_silencio) lines.push('Agora é entre 22h e 6h: nada é enviado nesse horário (dá para desligar essa opção).');
      if (r.sem_celular) lines.push(`${r.sem_celular} consulta(s) de paciente sem celular válido no cadastro.`);
      if (r.ja_enviado) lines.push(`${r.ja_enviado} consulta(s) já tinham recebido este lembrete.`);
      if (r.fora_do_horario) lines.push(`${r.fora_do_horario} consulta(s) ainda não chegaram no horário do lembrete.`);
      if (r.erros?.length) lines.push(`Erro: ${r.erros[0]}`);
      if (!r.enviados && lines.length === 1) lines.push('Nenhuma consulta agendada dentro dos horários dos lembretes ligados.');
      result.replaceChildren(...lines.map((l) => h('small', { class: 'help', style: { display: 'block' } }, l)));
    } catch (e) { toast(e.message, 'error'); } finally { run.disabled = false; }
  } }, 'Enviar lembretes agora');
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Testar')),
    h('div', { class: 'card-body stack' },
      h('p', { style: { margin: 0 } }, 'Envia um lembrete de exemplo (salve as mensagens antes) para conferir como chega no celular.'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, phone, btn),
      h('p', { style: { margin: '8px 0 0' } }, 'Os lembretes saem sozinhos a cada 5 minutos. Para disparar agora os que já estão no horário:'),
      h('div', null, run), result));
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

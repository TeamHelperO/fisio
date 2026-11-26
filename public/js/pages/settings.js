import { h, icon, toast, buildForm, badge, fmtDT, empty, LABELS, modal, confirmDialog, money, downloadFile, csvCell } from '../ui.js';
import { get, post, put, qs } from '../api.js';
import { state, isAdmin, reloadSettings } from '../state.js';
import { recebimentosTab } from './paylink.js';
import { portalSettingsTab } from './portal.js';
import { whatsappTab } from './whatsapp.js';


const refresh = () => dispatchEvent(new Event('fisio:refresh'));

export async function settingsPage(view, [tab], query) {
  const tabs = [['perfil', 'Profissional e clínica', true], ['usuarios', 'Usuários e acesso', true], ['seguranca', 'Minha conta'], ['lgpd', 'LGPD', true], ['agendamento', 'Agendamento online', true], ['recebimentos', 'Recebimentos', true], ['portal', 'Portal do paciente', true], ['whatsapp', 'WhatsApp', true], ['assinatura', 'Assinatura e dados', true], ['auditoria', 'Registro de alterações', true]]
    .filter((t) => !t[2] || isAdmin());
  tab = tab || tabs[0][0];
  const body = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Configurações'), h('p', null, 'Dados do profissional, usuários, segurança, privacidade e assinatura.'))),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { href: `#/configuracoes/${k}`, class: k === tab ? 'on' : '' }, l))), body);
  const T = { perfil, usuarios, seguranca, lgpd, agendamento: agendamentoOnline, recebimentos: recebimentosTab, portal: portalSettingsTab, whatsapp: whatsappTab, assinatura, auditoria };
  if (!tabs.find((t) => t[0] === tab)) return body.append(h('div', { class: 'notice' }, icon('shield'), 'Acesso restrito ao administrador.'));
  await T[tab](body, query);
}

async function perfil(body) {
  const form = buildForm([
    { type: 'section', label: 'Identificação nos documentos' },
    { key: 'professional_name', label: 'Nome do profissional responsável', span: true },
    { key: 'crefito', label: 'CREFITO' },
    { key: 'professional_cpf', label: 'CPF do profissional', mask: 'cpf', help: 'Exibido nos recibos (exigido para dedução no IR do paciente).' },
    { key: 'clinic_name', label: 'Nome da clínica / consultório (opcional)', span: true },
    { key: 'phone', label: 'Telefone', mask: 'phone' },
    { key: 'email', label: 'E-mail', type: 'email' },
    { key: 'address', label: 'Endereço', span: true },
    { key: 'city', label: 'Cidade/UF (para local e data nos documentos)' },
    { key: 'timezone', label: 'Fuso horário da clínica', type: 'select', options: Object.entries(await get('/timezones')), empty: false, help: 'Usado para "hoje", agenda e datas dos registros.' },
  ], state.settings);
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, form,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: async () => {
      try { await put('/settings', form.getValues()); await reloadSettings(); toast('Configurações salvas'); } catch (e) { toast(e.message, 'error'); }
    } }, icon('check', 16), 'Salvar')))));
}

async function usuarios(body) {
  const users = await get('/users');
  const edit = (u = {}) => {
    const form = buildForm([
      { key: 'name', label: 'Nome completo', required: true, span: true },
      { key: 'email', label: 'E-mail (login)', type: 'email', required: true },
      { key: 'role', label: 'Perfil de acesso', type: 'select', options: Object.entries(LABELS.role), empty: false, default: 'fisio' },
      { key: 'crefito', label: 'CREFITO (fisioterapeutas)' },
      { key: 'password', label: u.id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial', type: 'password', required: !u.id, autocomplete: 'new-password', help: 'Mínimo 8 caracteres, com letras e números.' },
    ], { ...u, password: '' });
    const m = modal({ title: u.id ? 'Editar usuário' : 'Novo usuário', body: h('div', { class: 'stack' }, form,
      h('div', { class: 'notice info' }, icon('shield'), h('div', null, h('b', null, 'Perfis: '), 'Administrador — acesso total. Fisioterapeuta — prontuários dos pacientes sob sua responsabilidade, agenda e financeiro. Recepção — cadastro, agenda e financeiro, sem acesso a dados clínicos.'))),
    actions: [
      u.id && u.id !== state.user.id ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => { try { await put(`/users/${u.id}`, { active: !u.active }); m.close(); toast(u.active ? 'Usuário desativado' : 'Usuário reativado'); refresh(); } catch (e) { toast(e.message, 'error'); } } }, u.active ? 'Desativar acesso' : 'Reativar acesso') : null,
      h('button', { class: 'btn primary', onclick: async () => {
        if (!form.validate()) return; const v = form.getValues(); if (!v.password) delete v.password;
        try { const r = u.id ? await put(`/users/${u.id}`, v) : await post('/users', v); m.close(); toast(r?.verification_sent ? `Usuário salvo. Enviamos um link de confirmação para ${v.email}.` : 'Usuário salvo'); state.professionals = (await get('/users')).filter((x) => x.role !== 'recepcao' && x.active); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Salvar')] });
  };
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Usuários'), h('button', { class: 'btn primary sm', onclick: () => edit() }, icon('plus', 15), 'Novo usuário')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Nome', 'E-mail', 'Perfil', 'CREFITO', 'Último acesso', 'Situação'].map((t) => h('th', null, t)))),
      h('tbody', null, users.map((u) => h('tr', { class: 'click', onclick: () => edit(u) }, h('td', null, h('b', null, u.name)), h('td', null, u.email), h('td', null, LABELS.role[u.role]), h('td', null, u.crefito || '—'),
        h('td', null, u.last_login ? fmtDT(u.last_login.replace(' ', 'T')) : 'Nunca'), h('td', null, u.active ? badge('ativo') : badge('inativo', 'status')))))))));
}

async function seguranca(body) {
  const mk = await get('/me/marketing').catch(() => ({ opt_in: false }));
  const mkBox = h('input', { type: 'checkbox', checked: mk.opt_in, onchange: async () => {
    try { await put('/me/marketing', { opt_in: mkBox.checked }); toast(mkBox.checked ? 'Você vai receber as novidades por e-mail' : 'Você não vai mais receber e-mails de novidades'); }
    catch (e) { mkBox.checked = !mkBox.checked; toast(e.message, 'error'); }
  } });
  const form = buildForm([
    { key: 'current', label: 'Senha atual', type: 'password', required: true, autocomplete: 'current-password' },
    { key: 'password', label: 'Nova senha', type: 'password', required: true, autocomplete: 'new-password', help: 'Mínimo 8 caracteres, com letras e números.' },
    { key: 'password2', label: 'Confirmar nova senha', type: 'password', required: true, autocomplete: 'new-password' },
  ], {}, { cols: 1 });
  body.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Alterar senha')), h('div', { class: 'card-body stack' }, form,
      h('button', { class: 'btn primary', onclick: async () => {
        if (!form.validate()) return; const v = form.getValues();
        if (v.password !== v.password2) return toast('As senhas não conferem', 'error');
        try { await post('/me/password', v); toast('Senha alterada. Outras sessões foram encerradas.'); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Alterar senha'))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Medidas de segurança ativas')), h('div', { class: 'card-body' },
      h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '8px' } },
        ['Login individual com senha protegida por hash (scrypt)', 'Bloqueio temporário após 5 tentativas de login incorretas', 'Sessão expira após 10 horas de inatividade',
          'Registros clínicos criptografados no banco (AES-256-GCM)', 'Controle de acesso por perfil e por profissional responsável',
          'Registro de acessos e alterações (auditoria) com histórico de versões dos registros clínicos', 'Dados de cada clínica isolados em área própria do banco, com chave de criptografia própria', 'Cópias de segurança diárias do banco de dados + cópia criptografada antes de excluir pacientes',
          'Proteções contra XSS, CSRF e clickjacking (cabeçalhos de segurança)'].map((t) => h('li', null, t)))))),
    h('div', { class: 'card', style: { marginTop: '16px' } }, h('div', { class: 'card-head' }, h('h2', null, 'Comunicação')), h('div', { class: 'card-body' },
      h('label', { class: 'terms-check', style: { color: 'var(--text)', fontSize: '14px' } }, mkBox, h('span', null, 'Receber novidades, dicas e ofertas do FisioGestão por e-mail. ', h('small', null, 'Avisos sobre a sua conta e a assinatura continuam sendo enviados.'))))));
}

async function lgpd(body) {
  const form = buildForm([
    { key: 'consent_version', label: 'Versão do termo', help: 'Ao alterar o texto, a versão é incrementada automaticamente.' },
    { key: 'consent_text', label: 'Texto do Termo de Consentimento (LGPD)', type: 'textarea', rows: 18 },
  ], state.settings, { cols: 1 });
  body.append(h('div', { class: 'stack' },
    h('div', { class: 'notice info' }, icon('shield'), h('div', null, 'Dados de saúde são dados pessoais sensíveis (LGPD, art. 5º, II e art. 11). O sistema registra o consentimento de cada paciente com data, versão do termo e responsável pelo registro, permite revogação, exportação (portabilidade) e mantém trilha de auditoria. ',
      h('b', null, 'Revise o termo com sua assessoria jurídica antes de usar.'))),
    h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, form, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { class: 'btn primary', onclick: async () => { try { await put('/settings', form.getValues()); await reloadSettings(); toast('Termo atualizado'); refresh(); } catch (e) { toast(e.message, 'error'); } } }, icon('check', 16), 'Salvar termo'))))));
}

const SUB_STATUS = { active: 'Ativa', trialing: 'Em período de teste', past_due: 'Pagamento atrasado', canceled: 'Cancelada', unpaid: 'Não paga', incomplete: 'Pagamento pendente', incomplete_expired: 'Expirada', paused: 'Pausada' };
async function assinatura(body, query) {
  let info = await get('/billing');
  // volta do pagamento: o webhook pode levar alguns segundos para confirmar a assinatura
  // (no Mercado Pago a situação também é consultada diretamente)
  const recheck = () => (info.has_mp_preapproval && info.providers?.mercadopago ? post('/billing/mp/refresh') : get('/billing'));
  if (query?.get('status') === 'ok' && info.access.reason !== 'subscription') {
    for (let i = 0; i < 6 && info.access.reason !== 'subscription'; i++) { await new Promise((r) => setTimeout(r, 1500)); info = await recheck().catch(() => info); }
    if (info.access.reason === 'subscription') { toast('Assinatura confirmada. Obrigado!'); location.hash = '#/configuracoes/assinatura'; location.reload(); return; }
  }
  const a = info.access;
  const fmt = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');
  const goTo = async (path, btn) => {
    btn.disabled = true;
    try { const r = await post(path); location.href = r.url; } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  const subscribed = ['active', 'trialing', 'past_due'].includes(info.subscription_status);
  const provider = info.billing_provider;
  const endsSoon = info.subscription_status === 'canceled' && a.reason === 'subscription'; // cancelada, mas ainda dentro do período pago
  const pill = (tone, text) => h('span', { class: `badge ${tone}` }, text);
  let status;
  if (subscribed) status = [pill(info.subscription_status === 'past_due' ? 'amber' : 'green', SUB_STATUS[info.subscription_status] || info.subscription_status), provider ? ` via ${provider === 'mercadopago' ? 'Mercado Pago' : 'Stripe'}` : ''];
  else if (endsSoon) status = [pill('amber', 'Cancelada'), ` — o acesso continua até ${fmt(info.current_period_end)}`];
  else if (a.reason === 'trial') status = [pill('blue', 'Teste grátis'), ` ${a.trial_days_left} dia(s) restante(s), até ${fmt(info.trial_ends_at)}`];
  else status = pill('gray', a.reason === 'trial_ended' ? 'Teste grátis encerrado' : `Assinatura ${(SUB_STATUS[info.subscription_status] || 'inativa').toLowerCase()}`);

  const both = info.providers?.stripe && info.providers?.mercadopago;
  const subBtn = h('button', { class: 'btn primary' }, icon('wallet', 16), both ? 'Assinar com cartão (Stripe)' : 'Assinar o FisioGestão');
  subBtn.onclick = () => goTo('/billing/checkout', subBtn);
  const mpBtn = h('button', { class: `btn ${both ? '' : 'primary'}` }, icon('wallet', 16), 'Assinar com Mercado Pago');
  mpBtn.onclick = () => {
    const email = h('input', { class: 'input', type: 'email', value: state.user.email, autocomplete: 'email' });
    const go = h('button', { class: 'btn primary' }, 'Continuar para o Mercado Pago');
    const m = modal({ title: 'Assinar com Mercado Pago', body: h('div', { class: 'stack' },
      info.mp_price ? h('p', { style: { margin: 0 } }, 'Assinatura mensal de ', h('b', null, money(info.mp_price)), ', cobrada automaticamente no cartão de crédito. Você pode cancelar quando quiser.') : null,
      endsSoon ? h('div', { class: 'notice' }, icon('alert'), `Sua assinatura anterior já está paga até ${fmt(info.current_period_end)}. A nova assinatura começa a cobrar hoje.`) : null,
      h('label', { class: 'field' }, h('span', null, 'E-mail da sua conta do Mercado Pago'), email,
        h('small', { class: 'help' }, 'Precisa ser o mesmo e-mail com que você entra no Mercado Pago, senão o pagamento é recusado.'))),
    actions: [h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Voltar'), go] });
    go.onclick = async () => {
      go.disabled = true;
      try { const r = await post('/billing/mp/checkout', { payer_email: email.value }); location.href = r.url; } catch (e) { toast(e.message, 'error'); go.disabled = false; }
    };
  };
  const mpCancelBtn = h('button', { class: 'btn ghost' }, icon('x', 16), 'Cancelar assinatura');
  mpCancelBtn.onclick = async () => {
    const ok = await confirmDialog(`A cobrança mensal no Mercado Pago será cancelada.${info.current_period_end ? ` O acesso completo continua até ${fmt(info.current_period_end)}.` : ''} Depois disso, os dados ficam disponíveis para consulta e exportação.`, { title: 'Cancelar assinatura', okLabel: 'Cancelar assinatura', danger: true });
    if (!ok) return;
    mpCancelBtn.disabled = true;
    try { await post('/billing/mp/cancel'); toast('Assinatura cancelada'); location.reload(); } catch (e) { toast(e.message, 'error'); mpCancelBtn.disabled = false; }
  };
  const portalBtn = h('button', { class: 'btn' }, icon('settings', 16), 'Gerenciar assinatura e pagamento');
  portalBtn.onclick = () => goTo('/billing/portal', portalBtn);

  body.append(h('div', { class: 'stack' },
    query?.get('status') === 'cancelado' ? h('div', { class: 'notice' }, icon('alert'), 'A assinatura não foi concluída. Você pode tentar novamente quando quiser.') : null,
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Assinatura')), h('div', { class: 'card-body stack' },
      h('p', { style: { margin: 0, fontSize: '15px' } }, h('b', null, 'Situação: '), status),
      subscribed && info.current_period_end ? h('p', { style: { margin: 0 } }, info.cancel_at_period_end ? `Cancelamento agendado: o acesso continua até ${fmt(info.current_period_end)}.` : `Próxima cobrança: ${fmt(info.current_period_end)}.`) : null,
      subscribed && provider === 'mercadopago' && info.subscription_status === 'past_due' ? h('div', { class: 'notice' }, icon('alert'), 'O Mercado Pago não conseguiu cobrar o cartão e vai tentar de novo. Para trocar o cartão, entre na sua conta do Mercado Pago → Assinaturas.') : null,
      a.mode === 'readonly' ? h('div', { class: 'notice' }, icon('alert'), 'Enquanto a assinatura não estiver ativa, os dados ficam disponíveis apenas para consulta e exportação.') : null,
      !info.billing_enabled ? h('div', { class: 'notice info' }, icon('clock'), 'A assinatura on-line ainda não foi liberada nesta instalação.') : null,
      h('div', { class: 'row' },
        !subscribed && info.providers?.mercadopago ? mpBtn : null,
        !subscribed && info.providers?.stripe ? subBtn : null,
        info.providers?.stripe && provider !== 'mercadopago' && (subscribed || info.subscription_status) ? portalBtn : null,
        info.providers?.mercadopago && provider === 'mercadopago' && subscribed ? mpCancelBtn : null),
      h('small', { class: 'help' }, provider === 'mercadopago'
        ? 'Pagamento processado pelo Mercado Pago. O FisioGestão não armazena dados do seu cartão. Para trocar o cartão, use sua conta do Mercado Pago → Assinaturas.'
        : `Pagamento processado pelo ${both ? 'Stripe ou pelo Mercado Pago' : info.providers?.mercadopago ? 'Mercado Pago' : 'Stripe'}. O FisioGestão não armazena dados do seu cartão. Você pode cancelar a qualquer momento.`))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Seus dados')), h('div', { class: 'card-body stack' },
      h('p', { style: { margin: 0 } }, 'Os dados da clínica ficam em uma área isolada do banco de dados, com chave de criptografia própria para os registros clínicos. A infraestrutura faz cópias de segurança diárias.'),
      h('p', { style: { margin: 0 } }, 'Você pode baixar a qualquer momento uma cópia completa (pacientes, prontuários, agenda, financeiro e registro de alterações) em formato JSON — inclusive com a assinatura inativa.'),
      h('div', null, h('button', { class: 'btn', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try {
          const res = await fetch('/api/clinic/export', { credentials: 'same-origin' });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Falha ao exportar');
          const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'fisiogestao.json';
          downloadFile(name, await res.blob()); toast('Exportação concluída');
        } catch (err) { toast(err.message, 'error'); }
        b.disabled = false;
      } }, icon('download', 15), 'Exportar todos os dados da clínica')),
      h('small', { class: 'help' }, 'O arquivo contém dados de saúde sem criptografia: guarde-o em local seguro.')))));
}

async function auditoria(body) {
  const users = await get('/users');
  const userSel = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'Todos os usuários'), users.map((u) => h('option', { value: u.id }, u.name)));
  const from = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  const to = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  const wrap = h('div');
  let rows = [];
  const load = async () => {
    rows = await get('/audit' + qs({ user_id: userSel.value, from: from.value, to: to.value }));
    wrap.replaceChildren(rows.length ? h('div', { class: 'table-wrap', style: { maxHeight: '65vh', overflowY: 'auto' } }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Data/hora', 'Usuário', 'Ação', 'Item', 'Paciente', 'Detalhes', 'IP'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((l) => h('tr', null, h('td', { class: 'nowrap' }, fmtDT(l.ts.replace(' ', 'T'))), h('td', null, l.user_name || '—'), h('td', null, l.action.replace(/_/g, ' ')),
        h('td', null, `${LABELS.record[l.entity] || l.entity || ''}${l.entity_id ? ' #' + l.entity_id : ''}`), h('td', null, l.patient_id ? h('a', { href: `#/pacientes/${l.patient_id}` }, `#${l.patient_id}`) : '—'),
        h('td', { style: { maxWidth: '280px', fontSize: '12px', color: 'var(--muted)', wordBreak: 'break-all' } }, l.details || ''), h('td', { style: { fontSize: '12px' } }, l.ip || '')))))) : empty('Nenhum evento no período.'));
  };
  [userSel, from, to].forEach((el) => (el.onchange = load));
  const exportCsv = () => {
    const esc = csvCell;
    downloadFile('auditoria.csv', '﻿' + [['Data/hora', 'Usuário', 'Ação', 'Entidade', 'ID', 'Paciente', 'Detalhes', 'IP'].map(esc).join(';'),
      ...rows.map((l) => [l.ts, l.user_name, l.action, l.entity, l.entity_id, l.patient_id, l.details, l.ip].map(esc).join(';'))].join('\r\n'), 'text/csv;charset=utf-8');
  };
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'row' }, userSel, from, h('span', null, 'a'), to), h('button', { class: 'btn sm', onclick: exportCsv }, icon('download', 14), 'Exportar CSV')), wrap));
  await load();
}

// ---------- Agendamento online ----------
async function agendamentoOnline(body) {
  const cfg = await get('/booking/settings');
  const WD = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const enabled = h('input', { type: 'checkbox', checked: cfg.enabled });
  const slug = h('input', { class: 'input', value: cfg.slug, maxLength: 60, style: { maxWidth: '280px' } });
  const mode = h('select', { class: 'input' }, [['confirmar', 'A clínica confirma cada pedido (recomendado)'], ['automatico', 'O horário é marcado na hora, sem confirmação']].map(([v, l]) => h('option', { value: v, selected: cfg.mode === v }, l)));
  const num = (v, min, max) => h('input', { class: 'input', type: 'number', min, max, value: v, style: { maxWidth: '120px' } });
  const slot = num(cfg.slot_minutes, 10, 240); const minH = num(cfg.min_hours, 0, 720); const ahead = num(cfg.days_ahead, 1, 120);
  const intro = h('textarea', { class: 'input', rows: 3, maxLength: 600, placeholder: 'Ex.: Atendemos particular e convênios. Chegue 10 minutos antes.' }); intro.value = cfg.intro || '';
  const profs = cfg.all_professionals.map((u) => ({ u, box: h('input', { type: 'checkbox', checked: !cfg.professionals.length || cfg.professionals.includes(u.id) }) }));
  const hours = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, input: h('input', { class: 'input', value: cfg.hours[d] || '', placeholder: 'fechado' }) }));
  const linkUrl = () => `${location.origin}/agendar/${slug.value.trim()}`;
  const linkText = h('a', { href: cfg.url, target: '_blank', rel: 'noopener' }, cfg.url);
  slug.addEventListener('input', () => { linkText.textContent = linkUrl(); linkText.href = linkUrl(); });
  const save = async () => {
    try {
      await put('/booking/settings', {
        enabled: enabled.checked, slug: slug.value, mode: mode.value, slot_minutes: Number(slot.value), min_hours: Number(minH.value), days_ahead: Number(ahead.value), intro: intro.value,
        professionals: profs.every((p) => p.box.checked) ? [] : profs.filter((p) => p.box.checked).map((p) => p.u.id),
        hours: Object.fromEntries(hours.map((x) => [x.d, x.input.value])),
      });
      toast('Agendamento online salvo'); refresh();
    } catch (e) { toast(e.message, 'error'); }
  };
  body.append(h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Agendamento online')), h('div', { class: 'card-body stack' },
      h('label', { class: 'switch-row', style: { fontSize: '15px' } }, enabled, h('b', null, 'Ligar a página de agendamento online')),
      h('p', { style: { margin: 0 } }, 'Seus pacientes escolhem um horário livre da agenda pelo celular, sem precisar ligar. Divulgue o link no WhatsApp, Instagram e Google.'),
      h('label', { class: 'field' }, h('span', null, 'Endereço da sua página'), h('div', { class: 'row' }, h('span', { class: 'muted' }, `${location.origin}/agendar/`), slug),
        h('small', { class: 'help' }, 'Link: ', linkText, ' ', h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(linkUrl()); toast('Link copiado'); } catch { toast('Não foi possível copiar', 'error'); } } }, 'Copiar'))),
      h('label', { class: 'field' }, h('span', null, 'Como confirmar'), mode),
      h('div', { class: 'row', style: { gap: '18px', alignItems: 'flex-start' } },
        h('label', { class: 'field' }, h('span', null, 'Duração de cada horário (min)'), slot),
        h('label', { class: 'field' }, h('span', null, 'Antecedência mínima (horas)'), minH),
        h('label', { class: 'field' }, h('span', null, 'Mostrar até quantos dias à frente'), ahead)),
      h('label', { class: 'field' }, h('span', null, 'Recado na página (opcional)'), intro))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Profissionais na página')), h('div', { class: 'card-body' },
      h('div', { class: 'row', style: { gap: '16px' } }, profs.map((p) => h('label', { class: 'switch-row' }, p.box, h('span', null, p.u.name)))))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Dias e horários de atendimento'), h('small', null, 'Ex.: 08:00-12:00, 13:00-18:00 · deixe em branco nos dias fechados')),
      h('div', { class: 'card-body stack', style: { gap: '8px' } }, hours.map((x) => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('b', { style: { width: '90px', flex: 'none' } }, WD[x.d]), x.input))),
      h('div', { class: 'card-body', style: { paddingTop: 0 } }, h('small', { class: 'help' }, 'Horários já ocupados na agenda (e pedidos aguardando resposta) nunca aparecem como livres.'))),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: save }, icon('check', 16), 'Salvar'))));
}

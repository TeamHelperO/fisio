// Área administrativa da PLATAFORMA (dono do SaaS).
// Mostra contas, assinaturas, métricas e contatos — nunca dados clínicos ou de pacientes.
import { h, icon, toast, $, loading, modal, buildForm, empty, money, fmtDate, fmtDT, confirmDialog, csvCell, downloadFile } from './ui.js';
import { get, post, put } from './api.js';
import { barChart } from './charts.js';

const root = $('#root');
let me = null; let shell = null;

const A = (p) => `/admin${p}`;
const fmtTs = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
const pill = (tone, text) => h('span', { class: `badge ${tone}` }, text);
const money2 = (v, cur = 'BRL') => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: cur });

function accessPill(a, c) {
  if (a.mode === 'blocked') return pill('red', 'Suspensa');
  if (a.reason === 'trial') return pill('blue', `Teste · ${a.trial_days_left}d`);
  if (a.reason === 'subscription') return pill('green', c?.cancel_at_period_end ? 'Assinante · cancela no fim do período' : 'Assinante');
  if (a.reason === 'past_due') return pill('amber', 'Pagamento atrasado');
  if (a.reason === 'manual') return pill('teal', a.mode === 'full' ? 'Liberada manualmente' : 'Somente leitura (manual)');
  return pill('gray', a.reason === 'trial_ended' ? 'Teste encerrado' : 'Assinatura inativa');
}
function kpi(label, value, ic, sub, tone = '') {
  return h('div', { class: `card kpi ${tone}` }, h('div', { class: 'kpi-top' }, h('span', null, label), h('span', { class: 'kpi-ic' }, icon(ic, 16))),
    h('div', { class: 'kpi-val' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}
const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, heads.map((t) => h('th', null, t)))), h('tbody', null, rows)));
const card = (title, body, tools) => h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, title), tools || null), body);

// ---------------- Acesso ----------------
function authBox(form) {
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-art' },
      h('div', { class: 'brand', style: { padding: 0 } }, h('div', { class: 'brand-mark' }, icon('shield', 18)), h('div', null, h('b', null, 'FisioGestão'), h('small', null, 'Administração da plataforma'))),
      h('div', null, h('h1', null, 'Painel do dono da plataforma.'),
        h('p', null, 'Métricas, clínicas, assinaturas, chaves de API e contatos. Por política de privacidade, este painel não dá acesso a prontuários nem a dados de pacientes.')),
      h('small', { style: { color: '#a5b4fc' } }, 'Acesso restrito. Todas as ações ficam registradas.')),
    h('div', { class: 'auth-form' }, form)));
}
function loginScreen() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  authBox(h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try { await post(A('/login'), { email: email.value, password: pw.value }); await boot(); } catch (err) { toast(err.message, 'error'); btn.disabled = false; pw.select(); }
  } }, h('div', null, h('h2', null, 'Administração'), h('p', null, 'Entre com a sua conta de administrador da plataforma.')),
  h('label', { class: 'field' }, h('span', null, 'E-mail'), email), h('label', { class: 'field' }, h('span', null, 'Senha'), pw), btn,
  h('p', { class: 'auth-switch' }, h('a', { href: '/' }, '← Ir para o sistema das clínicas'))));
  setTimeout(() => email.focus(), 50);
}
function setupScreen(enabled) {
  const f = { token: h('input', { class: 'input', type: 'password', autocomplete: 'off' }), name: h('input', { class: 'input' }), email: h('input', { class: 'input', type: 'email', autocomplete: 'username' }),
    password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password' }), password2: h('input', { class: 'input', type: 'password', autocomplete: 'new-password' }) };
  authBox(h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault();
    if (f.password.value !== f.password2.value) return toast('As senhas não conferem', 'error');
    try { await post(A('/setup'), { token: f.token.value, name: f.name.value, email: f.email.value, password: f.password.value }); toast('Administrador criado'); await boot(); } catch (err) { toast(err.message, 'error'); }
  } }, h('div', null, h('h2', null, 'Primeiro acesso'), h('p', null, 'Crie a conta do administrador da plataforma.')),
  enabled ? null : h('div', { class: 'notice' }, icon('alert'), 'Cadastre a variável ADMIN_SETUP_TOKEN na Vercel e faça um novo deploy para liberar este passo.'),
  h('label', { class: 'field' }, h('span', null, 'Código de configuração (ADMIN_SETUP_TOKEN)'), f.token),
  h('label', { class: 'field' }, h('span', null, 'Seu nome'), f.name), h('label', { class: 'field' }, h('span', null, 'E-mail'), f.email),
  h('label', { class: 'field' }, h('span', null, 'Senha'), f.password, h('small', { class: 'help' }, 'Mínimo de 12 caracteres, com letras e números.')),
  h('label', { class: 'field' }, h('span', null, 'Confirmar senha'), f.password2),
  h('button', { class: 'btn primary', type: 'submit', disabled: !enabled }, 'Criar administrador e entrar')));
}

// ---------------- Layout ----------------
const NAV = [['dashboard', 'Dashboard', 'dashboard'], ['clinicas', 'Clínicas', 'users'], ['financeiro', 'Financeiro', 'wallet'], ['usuarios', 'Usuários e marketing', 'phone'], ['apis', 'APIs e integrações', 'settings'], ['admins', 'Administradores', 'shield'], ['auditoria', 'Registro de ações', 'history']];
function buildShell() {
  const nav = h('nav', { class: 'nav' }, NAV.map(([p, l, ic]) => h('a', { href: `#/${p}`, 'data-path': p, onclick: () => app.classList.remove('menu-open') }, icon(ic), h('span', { class: 'grow' }, l))));
  const content = h('main', { class: 'content', tabindex: '-1' });
  const initials = me.name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const app = h('div', { class: 'app' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('shield', 18)), h('div', null, h('b', null, 'FisioGestão'), h('small', null, 'Administração'))),
      nav,
      h('div', { class: 'side-foot' }, h('div', { class: 'avatar' }, initials), h('div', { class: 'who' }, h('b', null, me.name), h('small', null, 'Admin da plataforma')),
        h('button', { class: 'icon-btn', title: 'Sair', 'aria-label': 'Sair', onclick: async () => { try { await post(A('/logout')); } catch { /* ignora */ } me = null; shell = null; loginScreen(); } }, icon('logout')))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Abrir menu', onclick: () => app.classList.toggle('menu-open') }, icon('menu', 22)), h('b', null, 'Administração')),
      h('div', { class: 'billing-banner admin-banner' }, icon('shield', 16), h('span', null, 'Área da plataforma: dados de conta e assinatura apenas. Prontuários e cadastros de pacientes não são acessíveis aqui.')),
      content));
  root.replaceChildren(app);
  shell = { nav, content };
}

const PAGES = { dashboard, clinicas, financeiro, usuarios, apis, admins, auditoria };
let seq = 0;
async function router() {
  if (!me) return;
  if (!shell) buildShell();
  const page = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  shell.nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.path === page));
  const fn = PAGES[page]; const c = shell.content; const my = ++seq;
  if (!fn) { c.replaceChildren(empty('Página não encontrada.')); return; }
  c.replaceChildren(loading());
  const view = h('div');
  try { await fn(view); if (my === seq) { c.replaceChildren(view); window.scrollTo(0, 0); } }
  catch (e) { if (my === seq) c.replaceChildren(h('div', { class: 'notice' }, icon('alert'), e.message || 'Erro ao carregar')); }
}
window.addEventListener('hashchange', router);
window.addEventListener('fisio:logout', () => { if (me) { me = null; shell = null; toast('Sessão encerrada. Entre novamente.', 'error'); loginScreen(); } });
const head = (title, sub, tools) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null), tools || null);
const refresh = () => router();

// ---------------- Dashboard ----------------
async function dashboard(view) {
  const d = await get(A('/dashboard'));
  const mrrText = !d.billing_enabled ? 'Stripe não configurado' : d.mrr?.error ? 'Erro ao consultar Stripe'
    : Object.keys(d.mrr || {}).length ? Object.entries(d.mrr).map(([c, v]) => money2(v, c)).join(' + ') : money2(0);
  view.append(head('Dashboard', 'Visão geral da plataforma'),
    h('div', { class: 'kpis' },
      kpi('Clínicas', d.count.total, 'users', `${d.users} usuário(s) no total`),
      kpi('Em teste grátis', d.count.trial, 'clock', d.count.trial_ending_3d ? `${d.count.trial_ending_3d} terminam em até 3 dias` : 'nenhum terminando nos próximos dias', 'blue'),
      kpi('Assinantes', d.count.paying, 'check', d.conversion !== null ? `conversão de teste: ${d.conversion}%` : 'sem testes encerrados ainda', 'good'),
      kpi('Receita mensal recorrente', mrrText, 'wallet', 'MRR das assinaturas ativas (Stripe)', 'good'),
      kpi('Pagamento atrasado', d.count.past_due, 'alert', 'Stripe tentando cobrar novamente', d.count.past_due ? 'warn' : ''),
      kpi('Sem assinatura', d.count.readonly, 'eye', `${d.count.blocked} suspensa(s) manualmente`, d.count.readonly ? 'warn' : ''),
      kpi('Aceitam marketing', d.marketing_opt_in, 'phone', 'contatos com consentimento', 'blue')),
    h('div', { class: 'grid g2' },
      card('Novas clínicas — últimos 30 dias', h('div', { class: 'card-body' }, barChart(d.signups_30d.map((s) => ({ label: s.day.slice(8), value: s.n })), { height: 190 }))),
      card('Cadastros recentes', d.recent.length ? table(['Clínica', 'Responsável', 'Criada', 'Situação'], d.recent.map((c) =>
        h('tr', null, h('td', null, h('b', null, c.name)), h('td', null, c.owner_email), h('td', { class: 'nowrap' }, fmtDay(c.created_at)), h('td', null, accessPill(c.access, c)))))
        : empty('Nenhuma clínica cadastrada ainda.'), h('a', { class: 'btn sm', href: '#/clinicas' }, 'Ver todas'))));
}

// ---------------- Clínicas ----------------
async function clinicas(view) {
  const list = await get(A('/clinics?stats=1'));
  const search = h('input', { class: 'input', placeholder: 'Buscar por nome ou e-mail', style: { maxWidth: '280px' } });
  const status = h('select', { class: 'input', style: { width: 'auto' } }, [['', 'Todas'], ['trial', 'Em teste'], ['subscription', 'Assinantes'], ['past_due', 'Pagamento atrasado'], ['readonly', 'Sem assinatura'], ['blocked', 'Suspensas']].map(([v, l]) => h('option', { value: v }, l)));
  const wrap = h('div');
  const match = (c) => {
    const t = search.value.trim().toLowerCase(); const s = status.value; const a = c.access;
    if (t && !`${c.name} ${c.owner_email}`.toLowerCase().includes(t)) return false;
    if (!s) return true;
    if (s === 'blocked') return a.mode === 'blocked';
    if (s === 'readonly') return a.mode === 'readonly';
    return a.reason === s;
  };
  const render = () => {
    const rows = list.filter(match);
    wrap.replaceChildren(rows.length ? table(['Clínica', 'Responsável', 'Situação', 'Teste até', 'Usuários', 'Pacientes', 'Atend. 30d', 'Último acesso', ''], rows.map((c) => h('tr', null,
      h('td', null, h('b', null, c.name), h('div', null, h('small', null, `#${c.id} · desde ${fmtDay(c.created_at)}`))), h('td', null, c.owner_email), h('td', null, accessPill(c.access, c)),
      h('td', { class: 'nowrap' }, fmtDay(c.trial_ends_at)), h('td', { class: 'right' }, c.stats?.users ?? '—'), h('td', { class: 'right' }, c.stats?.patients ?? '—'),
      h('td', { class: 'right' }, c.stats?.appts_30d ?? '—'), h('td', { class: 'nowrap' }, c.stats?.last_login ? fmtDT(c.stats.last_login.replace(' ', 'T')) : '—'),
      h('td', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => manage(c) }, 'Gerenciar'))))) : empty('Nenhuma clínica encontrada.'));
  };
  const manage = (c) => {
    const days = h('input', { class: 'input', type: 'number', min: 1, max: 365, value: 7, style: { width: '90px' } });
    const access = h('select', { class: 'input' }, [['', 'Automático (pela assinatura/teste)'], ['full', 'Liberar acesso total'], ['readonly', 'Somente leitura'], ['blocked', 'Suspender acesso']].map(([v, l]) => h('option', { value: v, selected: (c.manual_access || '') === v }, l)));
    const m = modal({ title: c.name, body: h('div', { class: 'stack' },
      h('div', { class: 'notice info' }, icon('shield'), h('div', null, 'Responsável: ', h('b', null, c.owner_email), ` · Pagamento: ${c.billing_provider === 'mercadopago' ? `Mercado Pago (${c.mp_preapproval_id})` : c.stripe_customer_id ? `Stripe (${c.stripe_customer_id})` : 'nenhum'} · Assinatura: ${c.subscription_status || 'nenhuma'}`)),
      h('div', { class: 'field' }, h('span', null, 'Estender o teste grátis'), h('div', { class: 'row' }, days, h('span', null, 'dias'), h('button', { class: 'btn', onclick: async () => {
        try { await put(A(`/clinics/${c.id}`), { extend_trial_days: Number(days.value) }); toast('Teste estendido'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Estender'))),
      h('label', { class: 'field' }, h('span', null, 'Acesso'), access, h('small', { class: 'help' }, 'Suspender encerra as sessões abertas da clínica. "Automático" volta a seguir o teste grátis e a assinatura.'))),
    actions: [h('button', { class: 'btn primary', onclick: async () => {
      if (access.value === 'blocked' && !(await confirmDialog(`Suspender o acesso de "${c.name}"? Todos os usuários da clínica serão desconectados.`, { danger: true, okLabel: 'Suspender' }))) return;
      try { await put(A(`/clinics/${c.id}`), { manual_access: access.value }); toast('Acesso atualizado'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Salvar acesso')] });
  };
  search.oninput = render; status.onchange = render;
  view.append(head('Clínicas', `${list.length} clínica(s) cadastrada(s). Contagens agregadas apenas — sem acesso a dados de pacientes.`),
    card('Lista de clínicas', wrap, h('div', { class: 'row' }, search, status)));
  render();
}

// ---------------- Financeiro ----------------
async function financeiro(view) {
  const f = await get(A('/finance'));
  view.append(head('Financeiro', 'Assinaturas no Stripe e no Mercado Pago', f.billing_enabled ? h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; await get(A('/finance?refresh=1')); refresh(); } }, icon('history', 15), 'Atualizar') : null));
  if (!f.billing_enabled) {
    view.append(h('div', { class: 'notice info' }, icon('wallet'), h('div', null, 'Nenhuma forma de pagamento configurada. Cadastre as chaves do Stripe ou do Mercado Pago em ', h('a', { href: '#/apis' }, 'APIs e integrações'), '.')));
    return;
  }
  if (f.mp_enabled) view.append(mpFinance(f.mercadopago));
  if (!f.stripe_enabled) return;
  view.append(h('h2', { style: { margin: '8px 0 12px' } }, 'Stripe'));
  const mrr = Object.entries(f.mrr || {});
  const cur = mrr[0]?.[0] || 'BRL';
  const last = f.revenue_by_month[f.revenue_by_month.length - 1];
  view.append(h('div', { class: 'kpis' },
    kpi('MRR', mrr.length ? mrr.map(([c, v]) => money2(v, c)).join(' + ') : money2(0), 'wallet', 'receita mensal recorrente', 'good'),
    kpi('Assinaturas ativas', (f.subscriptions.active || 0), 'check', `${f.subscriptions.past_due || 0} com pagamento atrasado`),
    kpi('Canceladas', (f.subscriptions.canceled || 0), 'x', 'desde o início'),
    kpi('Recebido no último mês', last ? money2(last[cur] || 0, cur) : money2(0, cur), 'trending', last ? last.month.split('-').reverse().join('/') : '—', 'blue')),
  h('div', { class: 'grid g2' },
    card('Receita por mês (faturas pagas, 12 meses)', h('div', { class: 'card-body' }, f.revenue_by_month.length ? barChart(f.revenue_by_month.map((r) => ({ label: r.month.slice(5) + '/' + r.month.slice(2, 4), value: r[cur] || 0 })), { height: 200, format: (v) => money2(v, cur).replace(/,00$/, '') }) : empty('Nenhuma fatura paga ainda.'))),
    card('Últimas faturas pagas', f.recent_invoices.length ? table(['Data', 'Clínica', 'Valor', ''], f.recent_invoices.map((i) => h('tr', null,
      h('td', { class: 'nowrap' }, fmtDay(i.created)), h('td', null, i.clinic), h('td', { class: 'right nowrap' }, money2(i.amount, i.currency)),
      h('td', { class: 'actions' }, i.url ? h('a', { class: 'btn sm', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, 'Fatura') : null)))) : empty('Nenhuma fatura ainda.'))),
  h('p', null, h('small', null, `Dados consultados no Stripe em ${fmtTs(f.fetched_at)} (atualizados a cada 5 minutos).`)));
}

function mpFinance(m) {
  const box = h('div', { style: { marginBottom: '24px' } }, h('h2', { style: { margin: '0 0 12px' } }, 'Mercado Pago'));
  if (!m || m.error) { box.append(h('div', { class: 'notice' }, icon('alert'), `Erro ao consultar o Mercado Pago: ${m?.error || 'sem resposta'}`)); return box; }
  const mrr = Object.entries(m.mrr || {});
  const MP_ST = { authorized: ['green', 'Ativa'], paused: ['amber', 'Pausada'] };
  box.append(h('div', { class: 'kpis' },
    kpi('MRR (Mercado Pago)', mrr.length ? mrr.map(([c, v]) => money2(v, c)).join(' + ') : money2(0), 'wallet', 'assinaturas ativas', 'good'),
    kpi('Ativas', m.subscriptions.authorized, 'check', `${m.subscriptions.paused} pausada(s)`),
    kpi('Canceladas', m.subscriptions.cancelled, 'x', 'desde o início'),
    kpi('Pendentes', m.subscriptions.pending, 'clock', 'iniciaram e não pagaram', 'blue')),
  card('Assinaturas ativas no Mercado Pago', m.active_list.length ? table(['Clínica', 'Situação', 'Valor', 'Próxima cobrança'], m.active_list.map((s) => h('tr', null,
    h('td', null, s.clinic), h('td', null, pill(...(MP_ST[s.status] || ['gray', s.status]))), h('td', { class: 'right nowrap' }, money2(s.amount, s.currency)),
    h('td', { class: 'nowrap' }, s.next_payment_date ? fmtDay(s.next_payment_date) : '—')))) : empty('Nenhuma assinatura ativa ainda.')),
  h('p', null, h('small', null, `Consultado no Mercado Pago em ${fmtTs(m.fetched_at)} (atualizado a cada 5 minutos).`)));
  return box;
}

// ---------------- Usuários e marketing ----------------
async function usuarios(view) {
  const list = await get(A('/users'));
  const search = h('input', { class: 'input', placeholder: 'Buscar por nome, e-mail ou clínica', style: { maxWidth: '280px' } });
  const only = h('select', { class: 'input', style: { width: 'auto' } }, [['', 'Todos'], ['mk', 'Aceitam marketing'], ['owner', 'Responsáveis das clínicas']].map(([v, l]) => h('option', { value: v }, l)));
  const wrap = h('div');
  const ROLE = { admin: 'Administrador', fisio: 'Fisioterapeuta', recepcao: 'Recepção' };
  const render = () => {
    const t = search.value.trim().toLowerCase();
    const rows = list.filter((u) => (!t || `${u.name} ${u.email} ${u.clinic}`.toLowerCase().includes(t)) && (only.value !== 'mk' || u.marketing) && (only.value !== 'owner' || u.owner));
    wrap.replaceChildren(rows.length ? table(['Nome', 'E-mail', 'Clínica', 'Perfil', 'Último acesso', 'Marketing'], rows.map((u) => h('tr', null,
      h('td', null, h('b', null, u.name), u.owner ? h('div', null, h('small', null, 'Responsável pela conta')) : null), h('td', null, u.email), h('td', null, u.clinic),
      h('td', null, ROLE[u.role] || u.role, u.active ? null : h('div', null, pill('gray', 'inativo'))), h('td', { class: 'nowrap' }, u.last_login ? fmtDT(u.last_login.replace(' ', 'T')) : 'Nunca'),
      h('td', null, u.marketing ? pill('green', `Sim · ${fmtDay(u.consent_at)}`) : pill('gray', 'Não'))))) : empty('Nenhum usuário encontrado.'));
  };
  const exportCsv = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const rows = await get(A('/marketing/export'));
      if (!rows.length) { toast('Nenhum contato aceitou receber marketing ainda.', 'error'); return; }
      const lines = [['E-mail', 'Nome', 'Clínica', 'Consentimento em', 'Link de descadastro'].map(csvCell).join(';'),
        ...rows.map((r) => [r.email, r.name, r.clinic, fmtTs(r.consent_at), r.unsubscribe_url].map(csvCell).join(';'))];
      downloadFile(`contatos-marketing-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
      toast(`${rows.length} contato(s) exportado(s)`);
    } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
  };
  search.oninput = render; only.onchange = render;
  const mkCount = list.filter((u) => u.marketing).length;
  view.append(head('Usuários e marketing', `${list.length} usuário(s) em todas as clínicas · ${mkCount} aceitam receber marketing`,
    h('button', { class: 'btn primary', onclick: exportCsv }, icon('download', 15), 'Exportar contatos de marketing (CSV)')),
  h('div', { class: 'notice info', style: { marginBottom: '16px' } }, icon('shield'), h('div', null, h('b', null, 'LGPD: '), 'a exportação traz apenas quem marcou "quero receber novidades" (no cadastro ou em Minha conta), com o link de descadastro de cada pessoa — inclua esse link em todo e-mail de marketing. Quem não aceitou só pode receber avisos sobre a própria conta.')),
  card('Usuários', wrap, h('div', { class: 'row' }, search, only)));
  render();
}

// ---------------- APIs e integrações ----------------
async function apis(view) {
  const fields = await get(A('/config'));
  const groups = {};
  for (const f of fields) (groups[f.group] ||= []).push(f);
  const edit = (f) => {
    const input = h('input', { class: 'input', type: f.secret ? 'password' : 'text', autocomplete: 'off', placeholder: f.secret ? 'Cole o novo valor' : '', value: f.secret ? '' : f.display || '' });
    const m = modal({ title: f.label, body: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, f.key), input,
      h('small', { class: 'help' }, f.secret ? 'O valor é guardado cifrado e nunca é exibido de novo por inteiro.' : 'Deixe em branco e salve para remover o valor do painel.')),
    f.source === 'variável de ambiente' ? h('div', { class: 'notice info' }, icon('settings'), 'Hoje este valor vem de uma variável de ambiente da Vercel. Um valor salvo aqui passa a ter prioridade.') : null),
    actions: [
      f.source === 'painel' ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => { try { await put(A('/config'), { key: f.key, value: '' }); toast('Valor removido do painel'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Remover') : null,
      h('button', { class: 'btn primary', onclick: async () => { try { await put(A('/config'), { key: f.key, value: input.value }); toast('Configuração salva'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Salvar')] });
  };
  view.append(head('APIs e integrações', 'Chaves e parâmetros usados pela plataforma'),
    h('div', { class: 'notice info', style: { marginBottom: '16px' } }, icon('shield'), h('div', null, 'As chaves ficam cifradas no banco de dados (com uma subchave da MASTER_KEY) e não aparecem na tela nem no registro de ações. Webhooks: Stripe → ', h('code', null, `${location.origin}/api/stripe/webhook`), ' · Mercado Pago (evento "Planos e assinaturas") → ', h('code', null, `${location.origin}/api/mercadopago/webhook`), '.')),
    h('div', { class: 'stack' }, Object.entries(groups).map(([g, fs]) => card(g, table(['Configuração', 'Valor atual', 'Origem', 'Atualizado', ''], fs.map((f) => h('tr', null,
      h('td', null, h('b', null, f.label), h('div', null, h('small', null, f.key))), h('td', null, f.display ? h('code', null, f.display) : pill('gray', 'não configurado')),
      h('td', null, f.source || '—'), h('td', { class: 'nowrap' }, f.updated_at ? h('span', null, fmtTs(f.updated_at), h('div', null, h('small', null, f.updated_by || ''))) : '—'),
      h('td', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => edit(f) }, f.display ? 'Alterar' : 'Configurar')))))))));
}

// ---------------- Administradores ----------------
async function admins(view) {
  const list = await get(A('/admins'));
  const add = () => {
    const form = buildForm([{ key: 'name', label: 'Nome', required: true, span: true }, { key: 'email', label: 'E-mail', type: 'email', required: true, span: true },
      { key: 'password', label: 'Senha inicial', type: 'password', required: true, autocomplete: 'new-password', help: 'Mínimo de 12 caracteres, com letras e números.', span: true }], {}, { cols: 1 });
    const m = modal({ title: 'Novo administrador da plataforma', body: h('div', { class: 'stack' }, form, h('div', { class: 'notice' }, icon('alert'), 'Administradores veem todas as clínicas, assinaturas, contatos e podem alterar chaves de API.')),
      actions: [h('button', { class: 'btn primary', onclick: async () => { if (!form.validate()) return; try { await post(A('/admins'), form.getValues()); toast('Administrador criado'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Criar')] });
  };
  const changePw = () => {
    const form = buildForm([{ key: 'current', label: 'Senha atual', type: 'password', required: true, autocomplete: 'current-password' },
      { key: 'password', label: 'Nova senha', type: 'password', required: true, autocomplete: 'new-password', help: 'Mínimo de 12 caracteres.' }], {}, { cols: 1 });
    const m = modal({ title: 'Alterar minha senha', body: form, actions: [h('button', { class: 'btn primary', onclick: async () => {
      if (!form.validate()) return; try { await put(A(`/admins/${me.id}`), form.getValues()); toast('Senha alterada'); m.close(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Salvar')] });
  };
  view.append(head('Administradores', 'Quem pode acessar esta área', h('div', { class: 'row' }, h('button', { class: 'btn', onclick: changePw }, 'Alterar minha senha'), h('button', { class: 'btn primary', onclick: add }, icon('plus', 15), 'Novo administrador'))),
    card('Administradores da plataforma', table(['Nome', 'E-mail', 'Criado', 'Último acesso', 'Situação', ''], list.map((a) => h('tr', null,
      h('td', null, h('b', null, a.name), a.id === me.id ? h('div', null, h('small', null, 'você')) : null), h('td', null, a.email), h('td', { class: 'nowrap' }, fmtDay(a.created_at)),
      h('td', { class: 'nowrap' }, fmtTs(a.last_login)), h('td', null, a.active ? pill('green', 'Ativo') : pill('gray', 'Inativo')),
      h('td', { class: 'actions' }, a.id !== me.id ? h('button', { class: 'btn sm', onclick: async () => {
        if (a.active && !(await confirmDialog(`Desativar o acesso de ${a.name}?`, { danger: true, okLabel: 'Desativar' }))) return;
        try { await put(A(`/admins/${a.id}`), { active: !a.active }); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, a.active ? 'Desativar' : 'Reativar') : null))))));
}

// ---------------- Registro de ações ----------------
async function auditoria(view) {
  const list = await get(A('/audit'));
  const ACT = { login: 'Entrou', login_falhou: 'Login recusado', criou_admin_inicial: 'Criou o administrador inicial', criou_admin: 'Criou administrador', alterou_admin: 'Alterou administrador',
    alterou_clinica: 'Alterou clínica', alterou_config: 'Alterou configuração', removeu_config: 'Removeu configuração', exportou_marketing: 'Exportou contatos de marketing' };
  view.append(head('Registro de ações', 'Últimas 500 ações na área administrativa'),
    card('Ações', list.length ? table(['Data/hora', 'Administrador', 'Ação', 'Alvo', 'Detalhes', 'IP'], list.map((l) => h('tr', null,
      h('td', { class: 'nowrap' }, fmtTs(l.ts)), h('td', null, l.admin_name || '—'), h('td', null, ACT[l.action] || l.action), h('td', null, l.target || '—'),
      h('td', { style: { fontSize: '12px', color: 'var(--muted)', maxWidth: '260px', wordBreak: 'break-all' } }, l.details || ''), h('td', { style: { fontSize: '12px' } }, l.ip || '')))) : empty('Nenhuma ação registrada.')));
}

// ---------------- Início ----------------
async function boot() {
  try {
    const st = await get(A('/status'));
    if (st.admin) { me = st.admin; shell = null; router(); return; }
    st.needsSetup ? setupScreen(st.setupEnabled) : loginScreen();
  } catch (e) { root.replaceChildren(h('div', { class: 'content' }, h('div', { class: 'notice' }, icon('alert'), e.message || 'Não foi possível conectar ao servidor.'))); }
}
boot();

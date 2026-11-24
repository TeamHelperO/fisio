// Área administrativa da PLATAFORMA (dono do SaaS).
// Mostra contas, assinaturas, métricas e contatos — nunca dados clínicos ou de pacientes.
import { h, icon, toast, $, loading, modal, buildForm, empty, money, fmtDate, fmtDT, confirmDialog, csvCell, downloadFile } from './ui.js';
import { get, post, put, del } from './api.js';
import { barChart } from './charts.js';
import { qrSvg } from './qr.js';

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
    try {
      const r = await post(A('/login'), { email: email.value, password: pw.value });
      if (r.needs2fa) return twoFactorScreen(r.ticket);
      await boot();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; pw.select(); }
  } }, h('div', null, h('h2', null, 'Administração'), h('p', null, 'Entre com a sua conta de administrador da plataforma.')),
  h('label', { class: 'field' }, h('span', null, 'E-mail'), email), h('label', { class: 'field' }, h('span', null, 'Senha'), pw), btn,
  h('p', { class: 'auth-switch', style: { marginTop: '10px' } }, h('a', { href: '#/esqueci-senha', onclick: (e) => { e.preventDefault(); forgotScreen(email.value); } }, 'Esqueci minha senha')),
  h('p', { class: 'auth-switch' }, h('a', { href: '/' }, '← Ir para o sistema das clínicas'))));
  setTimeout(() => email.focus(), 50);
}
// segunda etapa: código do app autenticador (ou código de recuperação)
function twoFactorScreen(ticket) {
  const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 12, style: { fontSize: '22px', letterSpacing: '.2em', textAlign: 'center' } });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Confirmar');
  let recovery = false;
  const label = h('span', null, 'Código de 6 dígitos do app autenticador');
  const switchLink = h('a', { href: '#', onclick: (e) => {
    e.preventDefault(); recovery = !recovery;
    label.textContent = recovery ? 'Código de recuperação (ex.: abcd-efgh)' : 'Código de 6 dígitos do app autenticador';
    switchLink.textContent = recovery ? 'Usar o app autenticador' : 'Perdi o celular: usar um código de recuperação';
    code.value = ''; code.inputMode = recovery ? 'text' : 'numeric'; code.style.letterSpacing = recovery ? '.05em' : '.2em'; code.focus();
  } }, 'Perdi o celular: usar um código de recuperação');
  authBox(h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try {
      const r = await post(A('/login/2fa'), { ticket, code: code.value });
      if (r.via === 'codigo_recuperacao') toast(`Código de recuperação usado. Restam ${r.recovery_left}.`, r.recovery_left <= 2 ? 'error' : 'ok');
      await boot();
    } catch (err) {
      toast(err.message, 'error'); btn.disabled = false; code.select();
      if (/acabou|de novo com e-mail/.test(err.message)) setTimeout(loginScreen, 1200);
    }
  } }, h('div', null, h('h2', null, 'Verificação em duas etapas'), h('p', null, 'Abra o app autenticador no celular e digite o código do FisioGestão Admin.')),
  h('label', { class: 'field' }, label, code), btn,
  h('p', { class: 'auth-switch' }, switchLink),
  h('p', { class: 'auth-switch' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); loginScreen(); } }, '← Voltar'))));
  setTimeout(() => code.focus(), 50);
}

// esqueci minha senha (administrador)
function forgotScreen(prefill = '') {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', value: prefill });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Enviar link');
  const box = h('div');
  authBox(h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try { const r = await post(A('/password/forgot'), { email: email.value }); box.replaceChildren(h('div', { class: 'notice info' }, icon('check'), h('span', null, r.message))); btn.hidden = true; email.disabled = true; }
    catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  } }, h('div', null, h('h2', null, 'Esqueci minha senha'), h('p', null, 'Informe o e-mail da sua conta de administrador. Enviaremos um link para criar uma nova senha.')),
  h('label', { class: 'field' }, h('span', null, 'E-mail'), email), btn, box,
  h('p', { class: 'auth-switch' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); history.replaceState(null, '', '#/'); loginScreen(); } }, '← Voltar para o login'))));
  setTimeout(() => email.focus(), 50);
}
async function resetScreen(token) {
  history.replaceState(null, '', '#/redefinir-senha');
  const back = () => { history.replaceState(null, '', '#/'); loginScreen(); };
  let info;
  try { info = await post(A('/password/check'), { token }); }
  catch (err) {
    authBox(h('div', { class: 'auth-box stack' }, h('div', null, h('h2', null, 'Link inválido')), h('div', { class: 'notice' }, icon('alert'), h('span', null, err.message)),
      h('button', { class: 'btn primary', onclick: () => forgotScreen() }, 'Pedir um novo link'), h('p', { class: 'auth-switch' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); back(); } }, '← Voltar para o login'))));
    return;
  }
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' }); const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Salvar nova senha');
  authBox(h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault();
    if (pw.value !== pw2.value) return toast('As duas senhas não são iguais', 'error');
    btn.disabled = true;
    try { await post(A('/password/reset'), { token, password: pw.value }); back(); toast('Senha alterada. Entre com a nova senha.'); }
    catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  } }, h('div', null, h('h2', null, 'Criar nova senha'), h('p', null, `Administrador: ${info.email}`)),
  h('input', { type: 'email', autocomplete: 'username', value: info.email || '', hidden: true, readOnly: true }),
  h('label', { class: 'field' }, h('span', null, 'Nova senha'), pw, h('small', { class: 'help' }, 'Mínimo de 12 caracteres, com letras e números.')),
  h('label', { class: 'field' }, h('span', null, 'Repita a nova senha'), pw2), btn,
  h('small', { class: 'help' }, 'Todas as sessões abertas serão encerradas. A verificação em duas etapas, se ativa, continua valendo.')));
  setTimeout(() => pw.focus(), 50);
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
const NAV = [['dashboard', 'Dashboard', 'dashboard'], ['clinicas', 'Clínicas', 'users'], ['financeiro', 'Financeiro', 'wallet'], ['usuarios', 'Usuários e marketing', 'phone'], ['apis', 'APIs e integrações', 'settings'], ['emails', 'E-mails', 'file'], ['admins', 'Administradores', 'shield'], ['auditoria', 'Registro de ações', 'history']];
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
      me.totp_enabled ? null : h('div', { class: 'billing-banner warn' }, icon('alert', 16), h('span', null, h('b', null, 'Proteja sua conta: '), 'ative a verificação em duas etapas. Mesmo que alguém descubra sua senha, não consegue entrar sem o código do seu celular.'),
        h('a', { class: 'btn sm', href: '#/admins' }, 'Ativar agora')),
      content));
  root.replaceChildren(app);
  shell = { nav, content };
}

const PAGES = { dashboard, clinicas, financeiro, usuarios, apis, emails, admins, auditoria };
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
    wrap.replaceChildren(rows.length ? table(['Nome', 'E-mail', 'Clínica', 'Perfil', 'Último acesso', 'Marketing', 'E-mail'], rows.map((u) => h('tr', null,
      h('td', null, h('b', null, u.name), u.owner ? h('div', null, h('small', null, 'Responsável pela conta')) : null), h('td', null, u.email), h('td', null, u.clinic),
      h('td', null, ROLE[u.role] || u.role, u.active ? null : h('div', null, pill('gray', 'inativo'))), h('td', { class: 'nowrap' }, u.last_login ? fmtDT(u.last_login.replace(' ', 'T')) : 'Nunca'),
      h('td', null, u.marketing ? pill('green', `Sim · ${fmtDay(u.consent_at)}`) : pill('gray', 'Não')),
      h('td', null, u.email_verified ? pill('green', 'Confirmado') : pill('amber', 'Pendente'))))) : empty('Nenhum usuário encontrado.'));
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

// ---------------- Envio de e-mail: situação, teste de conexão e envio de teste ----------------
function connectionCard(mail, withHelp) {
  const to = h('input', { class: 'input', type: 'email', value: me?.email || '', style: { maxWidth: '260px' }, 'aria-label': 'Enviar teste para' });
  const verifyBtn = h('button', { class: 'btn', disabled: !mail.provider }, icon('shield', 15), 'Testar conexão');
  const testBtn = h('button', { class: 'btn', disabled: !mail.provider }, icon('check', 15), 'Enviar e-mail de teste');
  const result = h('div');
  const busy = (on, label) => { verifyBtn.disabled = testBtn.disabled = on; if (on) result.replaceChildren(h('small', { class: 'muted' }, label)); };
  verifyBtn.onclick = async () => {
    busy(true, 'Conectando ao servidor…');
    try {
      const r = await post(A('/email/verify'));
      result.replaceChildren(h('div', { class: 'notice info' }, icon('check'), h('div', null,
        h('b', null, `Conexão OK (${(r.ms / 1000).toFixed(1).replace('.', ',')} s) — nenhum e-mail foi enviado.`),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, r.steps.map((x) => h('li', null, x))),
        r.warning ? h('div', { style: { marginTop: '6px' } }, h('b', null, 'Atenção: '), r.warning) : null)));
    } catch (e) { result.replaceChildren(h('div', { class: 'notice' }, icon('alert'), h('span', null, h('b', null, 'Falha na conexão. '), e.message))); }
    busy(false);
  };
  testBtn.onclick = async () => {
    busy(true, 'Enviando…');
    try {
      const r = await post(A('/email/test'), { to: to.value });
      result.replaceChildren(h('div', { class: 'notice info' }, icon('check'), h('span', null, `Enviado via ${r.provider === 'smtp' ? 'SMTP' : 'Resend'}. Confira a caixa de entrada (e o spam) de ${to.value}.`, r.response ? h('small', { style: { display: 'block' } }, `Resposta do servidor: ${r.response}`) : null)));
    } catch (e) { result.replaceChildren(h('div', { class: 'notice' }, icon('alert'), h('span', null, e.message))); }
    busy(false);
  };
  return card('Envio de e-mails', h('div', { class: 'card-body stack' },
    h('p', { style: { margin: 0 } }, h('b', null, 'Situação: '), mail.provider
      ? [pill('green', mail.provider === 'smtp' ? 'SMTP' : 'Resend'), ' ', mail.detail || '', mail.from ? h('div', null, h('small', { class: 'muted' }, `Remetente: ${mail.from}`)) : h('div', null, h('small', { class: 'muted' }, 'Falta configurar o remetente (EMAIL_FROM).'))]
      : [pill('gray', 'não configurado'), ' Preencha o servidor SMTP em ', h('a', { href: '#/apis' }, 'APIs e integrações'), ' (ou a chave do Resend).']),
    withHelp ? h('small', { class: 'help' }, 'Gmail/Google Workspace: smtp.gmail.com, porta 587, STARTTLS, com uma "senha de app". Outlook/Microsoft 365: smtp.office365.com, 587, STARTTLS. Hostinger/Locaweb/KingHost: use os dados do seu provedor.') : null,
    h('small', { class: 'help' }, '"Testar conexão" confere servidor, porta, criptografia e login sem enviar nada. "Enviar e-mail de teste" manda uma mensagem de verdade.'),
    h('div', { class: 'row' }, verifyBtn, to, testBtn), result));
}

// ---------------- E-mails: modelos ----------------
async function emails(view) {
  const [mail, list, logRows] = await Promise.all([get(A('/email/status')), get(A('/email/templates')), get(A('/email/log?limit=60'))]);
  const NAMES = Object.fromEntries(list.map((t) => [t.key, t.name]));
  const toggle = (t) => {
    if (!t.optional) return h('small', { class: 'muted' }, 'Sempre ativo');
    const box = h('input', { type: 'checkbox', checked: t.enabled, 'aria-label': `Enviar automaticamente: ${t.name}` });
    box.onchange = async () => {
      box.disabled = true;
      try { await put(A(`/email/templates/${t.key}/enabled`), { enabled: box.checked }); toast(box.checked ? 'E-mail ligado' : 'E-mail desligado'); t.enabled = box.checked; }
      catch (e) { toast(e.message, 'error'); box.checked = !box.checked; }
      box.disabled = false;
    };
    return h('label', { class: 'switch-row' }, box, h('span', null, 'Ligado'));
  };
  const groupTable = (group, desc) => card(group, h('div', null,
    desc ? h('div', { class: 'card-body', style: { paddingBottom: 0 } }, h('small', { class: 'muted' }, desc)) : null,
    table(['Modelo', 'Quando é enviado', 'Assunto', 'Texto', 'Envio', ''], list.filter((t) => t.group === group).map((t) => h('tr', null,
      h('td', null, h('b', null, t.name)), h('td', null, h('small', null, t.when)), h('td', null, t.subject),
      h('td', { class: 'nowrap' }, t.customized ? [pill('blue', 'Personalizado'), h('div', null, h('small', { class: 'muted' }, `${fmtTs(t.updated_at)} · ${t.updated_by || ''}`))] : pill('gray', 'Padrão')),
      h('td', { class: 'nowrap' }, toggle(t)),
      h('td', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => editTemplate(t) }, icon('edit', 14), 'Editar')))))));
  const runBtn = h('button', { class: 'btn sm' }, icon('history', 14), 'Rodar envios automáticos agora');
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    try {
      const r = await post(A('/email/run-daily'));
      toast(`${r.clinicas} clínica(s) verificada(s): ${r.enviados} e-mail(s) enviado(s)${r.falhas ? `, ${r.falhas} falha(s)` : ''}`, r.falhas ? 'error' : 'ok');
      refresh();
    } catch (e) { toast(e.message, 'error'); runBtn.disabled = false; }
  };
  const ST = { enviado: ['green', 'Enviado'], falhou: ['red', 'Falhou'], enviando: ['amber', 'Enviando'] };
  view.append(head('E-mails', 'Conexão com o servidor de e-mail, os textos dos e-mails e o histórico de envios'), connectionCard(mail, false),
    groupTable('Ciclo do cliente', 'Enviados automaticamente para os administradores de cada clínica — uma única vez por situação. Os avisos de teste grátis e as boas-vindas saem na rotina diária (todo dia de manhã); os de assinatura saem assim que o pagamento muda.'),
    groupTable('Conta e acesso', 'E-mails essenciais de cadastro e senha: podem ter o texto alterado, mas não podem ser desligados.'),
    groupTable('Administradores da plataforma', 'Enviados aos administradores deste painel (/admin).'),
    card('Histórico de envios', logRows.length ? table(['Data', 'E-mail', 'Para', 'Clínica', 'Situação'], logRows.map((r) => h('tr', null,
      h('td', { class: 'nowrap' }, fmtTs(r.created_at)), h('td', null, NAMES[r.template] || r.template), h('td', null, r.recipient), h('td', null, r.clinic || '—'),
      h('td', null, pill(...(ST[r.status] || ['gray', r.status])), r.error ? h('div', null, h('small', { class: 'muted' }, r.error)) : null))))
      : empty('Nenhum e-mail enviado ainda.'), runBtn),
    h('p', null, h('small', { class: 'muted' }, 'Use as variáveis entre chaves duplas, como {{nome}}; elas são trocadas pelos dados de cada pessoa no envio. O histórico guarda só para quem e quando foi enviado — nunca o conteúdo — por 180 dias.')));
}

function editTemplate(t) {
  const subject = h('input', { class: 'input', value: t.subject, maxLength: 200 });
  const body = h('textarea', { class: 'input', rows: 11, style: { fontFamily: 'inherit' } }); body.value = t.body;
  const button = h('input', { class: 'input', value: t.button || '', maxLength: 60 });
  const prev = h('div', { class: 'mail-preview' });
  const err = h('div');
  let last = null;
  const values = () => ({ subject: subject.value, body: body.value, button: button.value, enabled: t.enabled });
  const insertVar = (v) => {
    const el = document.activeElement === subject ? subject : body;
    const tag = `{{${v}}}`; const a = el.selectionStart ?? el.value.length; const b = el.selectionEnd ?? a;
    el.value = el.value.slice(0, a) + tag + el.value.slice(b); el.focus(); el.selectionStart = el.selectionEnd = a + tag.length; refreshPreview();
  };
  const refreshPreview = debounceLocal(async () => {
    try {
      const r = await post(A(`/email/templates/${t.key}/preview`), values()); last = r; err.replaceChildren();
      prev.replaceChildren(
        h('div', { class: 'mail-subject' }, h('small', null, 'Assunto'), h('b', null, r.subject)),
        h('div', { class: 'mail-card' }, h('div', { class: 'mail-brand' }, 'FisioGestão'),
          r.paragraphs.map((p) => h('p', null, ...p.split('\n').flatMap((line, i) => (i ? [h('br'), line] : [line])))),
          r.button ? h('span', { class: 'mail-btn' }, r.button) : null));
    } catch (e) { err.replaceChildren(h('div', { class: 'notice' }, icon('alert'), h('span', null, e.message))); }
  }, 350);
  [subject, body, button].forEach((el) => el.addEventListener('input', refreshPreview));
  const to = h('input', { class: 'input', type: 'email', value: me?.email || '', style: { maxWidth: '230px' }, 'aria-label': 'Enviar teste para' });
  const m = modal({ title: `Modelo: ${t.name}`, wide: true, body: h('div', { class: 'grid g2 tpl-edit' },
    h('div', { class: 'stack' },
      h('small', { class: 'help' }, t.when),
      h('label', { class: 'field' }, h('span', null, 'Assunto'), subject),
      h('label', { class: 'field' }, h('span', null, 'Texto (deixe uma linha em branco entre os parágrafos)'), body),
      t.link ? h('label', { class: 'field' }, h('span', null, 'Texto do botão (o link é colocado automaticamente)'), button) : null,
      h('div', null, h('small', { class: 'muted' }, 'Variáveis — clique para inserir:'),
        h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } }, Object.entries(t.vars).map(([v, label]) =>
          h('button', { type: 'button', class: 'btn sm ghost', title: label, onmousedown: (e) => e.preventDefault(), onclick: () => insertVar(v) }, `{{${v}}}`)))),
      err),
    h('div', { class: 'stack' }, h('small', { class: 'muted' }, 'Prévia (com dados de exemplo)'), prev,
      h('div', { class: 'row' }, to, h('button', { class: 'btn sm', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await post(A(`/email/templates/${t.key}/test`), { ...values(), to: to.value }); toast(`Teste enviado para ${to.value}`); } catch (er) { toast(er.message, 'error'); }
        b.disabled = false;
      } }, 'Enviar teste deste modelo')))),
  actions: [
    t.customized ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => {
      if (!(await confirmDialog('Voltar este modelo ao texto padrão do sistema?', { okLabel: 'Restaurar padrão' }))) return;
      try { await del(A(`/email/templates/${t.key}`)); toast('Modelo restaurado'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Restaurar padrão') : null,
    h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await put(A(`/email/templates/${t.key}`), values()); toast('Modelo salvo'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); }
    } }, icon('check', 15), 'Salvar')] });
  refreshPreview();
}
function debounceLocal(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------- APIs e integrações ----------------
async function apis(view) {
  const [fields, mail] = await Promise.all([get(A('/config')), get(A('/email/status'))]);
  const groups = {};
  for (const f of fields) (groups[f.group] ||= []).push(f);
  const edit = (f) => {
    const input = f.options
      ? h('select', { class: 'input' }, h('option', { value: '' }, 'Selecione…'), f.options.map(([v, l]) => h('option', { value: v, selected: f.display === v }, l)))
      : h('input', { class: 'input', type: f.secret ? 'password' : 'text', autocomplete: f.secret ? 'new-password' : 'off', placeholder: f.secret ? 'Cole o novo valor' : '', value: f.secret ? '' : f.display || '' });
    const m = modal({ title: f.label, body: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, f.key), input,
      h('small', { class: 'help' }, f.secret ? 'O valor é guardado cifrado e nunca é exibido de novo por inteiro.' : 'Deixe em branco e salve para remover o valor do painel.')),
    f.source === 'variável de ambiente' ? h('div', { class: 'notice info' }, icon('settings'), 'Hoje este valor vem de uma variável de ambiente da Vercel. Um valor salvo aqui passa a ter prioridade.') : null),
    actions: [
      f.source === 'painel' ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => { try { await put(A('/config'), { key: f.key, value: '' }); toast('Valor removido do painel'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Remover') : null,
      h('button', { class: 'btn primary', onclick: async () => { try { await put(A('/config'), { key: f.key, value: input.value }); toast('Configuração salva'); m.close(); refresh(); } catch (e) { toast(e.message, 'error'); } } }, 'Salvar')] });
  };
  const mailCard = connectionCard(mail, true);
  view.append(head('APIs e integrações', 'Chaves e parâmetros usados pela plataforma'), mailCard,
    h('div', { class: 'notice info', style: { marginBottom: '16px' } }, icon('shield'), h('div', null, 'As chaves ficam cifradas no banco de dados (com uma subchave da MASTER_KEY) e não aparecem na tela nem no registro de ações. Webhooks: Stripe → ', h('code', null, `${location.origin}/api/stripe/webhook`), ' · Mercado Pago (evento "Planos e assinaturas") → ', h('code', null, `${location.origin}/api/mercadopago/webhook`), '.')),
    h('div', { class: 'stack' }, Object.entries(groups).map(([g, fs]) => card(g, table(['Configuração', 'Valor atual', 'Origem', 'Atualizado', ''], fs.map((f) => h('tr', null,
      h('td', null, h('b', null, f.label), h('div', null, h('small', null, f.key))), h('td', null, f.display ? h('code', null, f.display) : pill('gray', 'não configurado')),
      h('td', null, f.source || '—'), h('td', { class: 'nowrap' }, f.updated_at ? h('span', null, fmtTs(f.updated_at), h('div', null, h('small', null, f.updated_by || ''))) : '—'),
      h('td', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => edit(f) }, f.display ? 'Alterar' : 'Configurar')))))))));
}

// ---------------- Administradores ----------------
// ---------- Minha segurança: verificação em duas etapas ----------
function recoveryBox(codes) {
  const txt = codes.join('\n');
  return h('div', { class: 'stack' },
    h('div', { class: 'notice' }, icon('alert'), h('span', null, h('b', null, 'Guarde estes códigos agora. '), 'Eles não serão mostrados de novo. Cada um funciona uma vez, para entrar se você perder o celular.')),
    h('div', { class: 'recovery-codes' }, codes.map((c) => h('code', null, c))),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(txt); toast('Códigos copiados'); } catch { toast('Não foi possível copiar', 'error'); } } }, 'Copiar'),
      h('button', { class: 'btn sm', onclick: () => downloadFile('fisiogestao-admin-codigos-recuperacao.txt', `Códigos de recuperação — FisioGestão Admin (${me.email})\nCada código funciona uma vez.\n\n${txt}\n`) }, 'Baixar .txt')));
}
async function securityCard() {
  const st = await get(A('/2fa'));
  const askPassword = (title, then) => {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const m = modal({ title, body: h('label', { class: 'field' }, h('span', null, 'Confirme sua senha'), pw),
      actions: [h('button', { class: 'btn primary', onclick: async () => { try { await then(pw.value, m); } catch (e) { toast(e.message, 'error'); } } }, 'Continuar')] });
  };
  const enable = () => askPassword('Ativar verificação em duas etapas', async (password, m0) => {
    const r = await post(A('/2fa/setup'), { password }); m0.close();
    const qr = h('div', { class: 'qr-box', html: qrSvg(r.otpauth, 5) });
    const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, style: { fontSize: '20px', letterSpacing: '.2em', textAlign: 'center', maxWidth: '180px' } });
    const body = h('div', { class: 'stack' },
      h('ol', { style: { margin: 0, paddingLeft: '18px' } },
        h('li', null, 'Instale um app autenticador no celular (Google Authenticator, Microsoft Authenticator, Authy ou outro).'),
        h('li', null, 'No app, toque em "+" e escaneie o QR Code abaixo.'),
        h('li', null, 'Digite o código de 6 dígitos que aparecer no app.')),
      qr,
      h('small', { class: 'help' }, 'Não consegue escanear? Digite esta chave no app: ', h('code', null, r.secret)),
      h('label', { class: 'field' }, h('span', null, 'Código do app'), code));
    const m = modal({ title: 'Ativar verificação em duas etapas', body, actions: [h('button', { class: 'btn primary', onclick: async () => {
      try {
        const out = await post(A('/2fa/enable'), { code: code.value });
        m.close(); me.totp_enabled = true; shell = null;
        const m2 = modal({ title: 'Verificação em duas etapas ativada', body: recoveryBox(out.recovery_codes),
          actions: [h('button', { class: 'btn primary', onclick: () => { m2.close(); refresh(); } }, 'Já guardei os códigos')] });
      } catch (e) { toast(e.message, 'error'); code.select(); }
    } }, 'Ativar')] });
    setTimeout(() => code.focus(), 100);
  });
  const disable = () => {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const code = h('input', { class: 'input', inputmode: 'numeric', maxLength: 6 });
    const m = modal({ title: 'Desativar verificação em duas etapas', body: h('div', { class: 'stack' },
      h('div', { class: 'notice' }, icon('alert'), 'Sem as duas etapas, quem descobrir sua senha consegue entrar no painel.'),
      h('label', { class: 'field' }, h('span', null, 'Sua senha'), pw), h('label', { class: 'field' }, h('span', null, 'Código atual do app'), code)),
    actions: [h('button', { class: 'btn danger', onclick: async () => {
      try { await post(A('/2fa/disable'), { password: pw.value, code: code.value }); m.close(); me.totp_enabled = false; shell = null; toast('Verificação em duas etapas desativada'); refresh(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Desativar')] });
  };
  const regen = () => askPassword('Gerar novos códigos de recuperação', async (password, m0) => {
    const r = await post(A('/2fa/recovery'), { password }); m0.close();
    const m = modal({ title: 'Novos códigos de recuperação', body: h('div', { class: 'stack' }, h('small', { class: 'help' }, 'Os códigos anteriores deixaram de valer.'), recoveryBox(r.recovery_codes)),
      actions: [h('button', { class: 'btn primary', onclick: () => { m.close(); refresh(); } }, 'Já guardei os códigos')] });
  });
  return card('Minha segurança', h('div', { class: 'card-body stack' },
    h('p', { style: { margin: 0 } }, h('b', null, 'Verificação em duas etapas: '), st.enabled ? pill('green', 'Ativa') : pill('amber', 'Desativada'),
      st.enabled ? h('small', { class: 'muted' }, `  ·  ${st.recovery_left} código(s) de recuperação restante(s)`) : null),
    h('small', { class: 'help' }, 'Ao entrar, além da senha, o painel pede um código que muda a cada 30 segundos no app autenticador do seu celular.'),
    h('div', { class: 'row' }, st.enabled
      ? [h('button', { class: 'btn', onclick: regen }, 'Gerar novos códigos de recuperação'), h('button', { class: 'btn ghost', onclick: disable }, 'Desativar')]
      : h('button', { class: 'btn primary', onclick: enable }, icon('shield', 15), 'Ativar verificação em duas etapas'))));
}

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
    await securityCard(),
    card('Administradores da plataforma', table(['Nome', 'E-mail', 'Criado', 'Último acesso', 'Duas etapas', 'Situação', ''], list.map((a) => h('tr', null,
      h('td', null, h('b', null, a.name), a.id === me.id ? h('div', null, h('small', null, 'você')) : null), h('td', null, a.email), h('td', { class: 'nowrap' }, fmtDay(a.created_at)),
      h('td', { class: 'nowrap' }, fmtTs(a.last_login)), h('td', null, a.totp_enabled ? pill('green', 'Ativa') : pill('amber', 'Não')), h('td', null, a.active ? pill('green', 'Ativo') : pill('gray', 'Inativo')),
      h('td', { class: 'actions' }, a.id !== me.id && a.totp_enabled ? h('button', { class: 'btn sm ghost', title: 'Para quando o administrador perdeu o celular e os códigos', onclick: async () => {
        if (!(await confirmDialog(`Desligar a verificação em duas etapas de ${a.name}? Use só se ele perdeu o celular e os códigos de recuperação. Ele poderá entrar só com a senha e deverá ativar de novo.`, { danger: true, okLabel: 'Desligar' }))) return;
        try { await put(A(`/admins/${a.id}`), { reset_2fa: true }); toast('Verificação em duas etapas desligada'); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Zerar 2 etapas') : null, a.id !== me.id ? h('button', { class: 'btn sm', onclick: async () => {
        if (a.active && !(await confirmDialog(`Desativar o acesso de ${a.name}?`, { danger: true, okLabel: 'Desativar' }))) return;
        try { await put(A(`/admins/${a.id}`), { active: !a.active }); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, a.active ? 'Desativar' : 'Reativar') : null))))));
}

// ---------------- Registro de ações ----------------
async function auditoria(view) {
  const list = await get(A('/audit'));
  const ACT = { login: 'Entrou', login_falhou: 'Login recusado', criou_admin_inicial: 'Criou o administrador inicial', criou_admin: 'Criou administrador', alterou_admin: 'Alterou administrador',
    alterou_clinica: 'Alterou clínica', login_2fa_falhou: 'Código de duas etapas errado', ativou_2fa: 'Ativou duas etapas', desativou_2fa: 'Desativou duas etapas',
    gerou_codigos_recuperacao: 'Gerou códigos de recuperação', zerou_2fa_de_admin: 'Zerou duas etapas de outro admin', pediu_nova_senha_admin: 'Pediu nova senha', redefiniu_senha_admin: 'Redefiniu a senha', alterou_config: 'Alterou configuração', removeu_config: 'Removeu configuração', exportou_marketing: 'Exportou contatos de marketing' };
  view.append(head('Registro de ações', 'Últimas 500 ações na área administrativa'),
    card('Ações', list.length ? table(['Data/hora', 'Administrador', 'Ação', 'Alvo', 'Detalhes', 'IP'], list.map((l) => h('tr', null,
      h('td', { class: 'nowrap' }, fmtTs(l.ts)), h('td', null, l.admin_name || '—'), h('td', null, ACT[l.action] || l.action), h('td', null, l.target || '—'),
      h('td', { style: { fontSize: '12px', color: 'var(--muted)', maxWidth: '260px', wordBreak: 'break-all' } }, l.details || ''), h('td', { style: { fontSize: '12px' } }, l.ip || '')))) : empty('Nenhuma ação registrada.')));
}

// ---------------- Início ----------------
async function boot() {
  const route = location.hash.replace(/^#\/?/, '');
  if (route.startsWith('redefinir-senha?')) { const t = new URLSearchParams(route.split('?')[1]).get('t'); if (t) return resetScreen(t); }
  if (route === 'esqueci-senha') return forgotScreen();
  try {
    const st = await get(A('/status'));
    if (st.admin) { me = st.admin; shell = null; router(); return; }
    st.needsSetup ? setupScreen(st.setupEnabled) : loginScreen();
  } catch (e) { root.replaceChildren(h('div', { class: 'content' }, h('div', { class: 'notice' }, icon('alert'), e.message || 'Não foi possível conectar ao servidor.'))); }
}
boot();

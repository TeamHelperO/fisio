import { h, icon, toast, $, loading, LABELS, confirmDialog } from './ui.js';
import { get, post } from './api.js';
import { state, isClinical, go, getRoute, DEMO } from './state.js';
import { dashboardPage } from './pages/dashboard.js';
import { patientsPage, patientFormPage, patientPage } from './pages/patients.js';
import { recordsListPage, recordEditPage, recordViewPage } from './pages/records.js';
import { agendaPage } from './pages/agenda.js';
import { financePage } from './pages/finance.js';
import { reportsPage } from './pages/reports.js';
import { settingsPage } from './pages/settings.js';

const root = $('#root');

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['pacientes', 'Pacientes', 'users'],
  ['anamnese', 'Anamnese', 'clipboard', true],
  ['avaliacoes', 'Avaliações', 'activity', true],
  ['planos', 'Planos de tratamento', 'target', true],
  ['evolucoes', 'Evoluções', 'trending', true],
  ['agenda', 'Agenda', 'calendar'],
  ['financeiro', 'Financeiro', 'wallet'],
  ['relatorios', 'Relatórios', 'file'],
  ['configuracoes', 'Configurações', 'settings'],
];

// ---------------- Autenticação ----------------
function authShell(form) {
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-art' },
      h('div', { class: 'brand', style: { padding: 0 } }, h('div', { class: 'brand-mark' }, icon('activity', 18)), h('div', null, h('b', null, 'FisioGestão'), h('small', null, 'Prontuário eletrônico'))),
      h('div', null,
        h('h1', null, 'Do primeiro contato à alta, todo o prontuário em um só lugar.'),
        h('p', null, 'Anamnese, avaliação, plano de tratamento, evolução das sessões, agenda e financeiro — com segurança e adequação à LGPD.'),
        h('ul', null, ['Registros clínicos criptografados', 'Controle de acesso por perfil', 'Registro de alterações e backups automáticos', 'Documentos prontos para impressão e PDF']
          .map((t) => h('li', null, icon('check', 16), t)))),
      h('small', { style: { color: '#6f9894' } }, 'Dados de saúde são dados pessoais sensíveis (LGPD, art. 5º, II). Acesso restrito a profissionais autorizados.')),
    h('div', { class: 'auth-form' }, form)));
}

function loginScreen() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  const form = h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try { await post('/login', { email: email.value, password: pw.value }); await boot(); }
    catch (err) { toast(err.message, 'error'); btn.disabled = false; pw.select(); }
  } },
    h('div', null, h('h2', null, 'Entrar'), h('p', null, 'Acesse com seu e-mail e senha individuais.')),
    h('label', { class: 'field' }, h('span', null, 'E-mail'), email),
    h('label', { class: 'field' }, h('span', null, 'Senha'), pw),
    btn,
    DEMO ? demoLogin(async (who) => { try { await post('/login', { email: `${who}@demo.fisio`, password: 'demo1234' }); await boot(); } catch (err) { toast(err.message, 'error'); } })
      : h('p', { class: 'auth-switch' }, 'Ainda não usa o FisioGestão? ', h('a', { href: '#/criar-conta', onclick: (e) => { e.preventDefault(); signupScreen(); } }, `Crie sua conta — ${TRIAL_DAYS} dias grátis`)));
  authShell(form); if (!DEMO) setTimeout(() => email.focus(), 50);
}

function demoLogin(enter) {
  const opt = (who, title, desc) => h('button', { type: 'button', class: 'demo-login', onclick: () => enter(who) }, h('b', null, title), h('small', null, desc));
  return h('div', { class: 'stack', style: { gap: '8px', marginTop: '6px' } },
    h('div', { class: 'demo-divider' }, h('span', null, 'Versão de demonstração — entre com um perfil')),
    opt('admin', 'Administradora · Dra. Helena Prado', 'Acesso total: prontuários, financeiro, usuários e auditoria'),
    opt('fisio', 'Fisioterapeuta · Dr. Bruno Tavares', 'Vê apenas os próprios pacientes'),
    opt('recepcao', 'Recepção · Patrícia Nunes', 'Cadastro, agenda e financeiro, sem dados clínicos'),
    h('small', null, 'Todos os dados são fictícios e ficam salvos só neste navegador. Senha dos três perfis: demo1234.'));
}

const TRIAL_DAYS = 7;
function signupScreen() {
  const f = {
    clinic_name: h('input', { class: 'input', required: true, placeholder: 'Ex.: Clínica Movimento ou seu nome' }),
    name: h('input', { class: 'input', required: true, autocomplete: 'name' }), crefito: h('input', { class: 'input', placeholder: 'Ex.: 123456-F' }),
    email: h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true }),
    password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true }),
    password2: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true }),
    terms: h('input', { type: 'checkbox' }),
    marketing: h('input', { type: 'checkbox' }),
  };
  const btn = h('button', { class: 'btn primary', type: 'submit' }, `Começar teste grátis de ${TRIAL_DAYS} dias`);
  const form = h('form', { class: 'auth-box stack', onsubmit: async (e) => {
    e.preventDefault();
    if (f.password.value !== f.password2.value) return toast('As senhas não conferem', 'error');
    if (!f.terms.checked) return toast('Para continuar, aceite os Termos de Uso e a Política de Privacidade', 'error');
    btn.disabled = true;
    try {
      await post('/signup', { clinic_name: f.clinic_name.value, name: f.name.value, crefito: f.crefito.value, email: f.email.value, password: f.password.value, accept_terms: true, marketing_opt_in: f.marketing.checked });
      toast('Conta criada! Bem-vindo(a) ao FisioGestão.'); location.hash = '#/configuracoes/perfil'; await boot();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  } },
    h('div', null, h('h2', null, 'Crie sua conta'), h('p', null, `${TRIAL_DAYS} dias grátis, sem cartão de crédito. Depois, assine para continuar registrando — seus dados ficam sempre disponíveis para consulta.`)),
    h('label', { class: 'field' }, h('span', null, 'Nome da clínica ou consultório'), f.clinic_name),
    h('label', { class: 'field' }, h('span', null, 'Seu nome completo'), f.name),
    h('label', { class: 'field' }, h('span', null, 'CREFITO'), f.crefito),
    h('label', { class: 'field' }, h('span', null, 'E-mail (será seu login)'), f.email),
    h('label', { class: 'field' }, h('span', null, 'Senha'), f.password, h('small', { class: 'help' }, 'Mínimo de 8 caracteres, com letras e números.')),
    h('label', { class: 'field' }, h('span', null, 'Confirmar senha'), f.password2),
    h('label', { class: 'terms-check' }, f.terms, h('span', null, 'Li e aceito os ', h('a', { href: '/termos.html', target: '_blank', rel: 'noopener' }, 'Termos de Uso'), ' e a ', h('a', { href: '/privacidade.html', target: '_blank', rel: 'noopener' }, 'Política de Privacidade'), '.')),
    h('label', { class: 'terms-check' }, f.marketing, h('span', null, 'Quero receber novidades, dicas e ofertas do FisioGestão por e-mail (opcional — dá para cancelar a qualquer momento).')),
    btn,
    h('p', { class: 'auth-switch' }, 'Já tem conta? ', h('a', { href: '#/', onclick: (e) => { e.preventDefault(); loginScreen(); } }, 'Entrar')));
  authShell(form); setTimeout(() => f.clinic_name.focus(), 50);
}

// Aviso de teste grátis / assinatura no topo do sistema
function billingBanner() {
  const c = state.clinic; if (!c || DEMO) return null;
  const a = c.access; const admin = state.user.role === 'admin';
  const go2 = admin ? h('a', { class: 'btn sm', href: '#/configuracoes/assinatura' }, 'Assinar agora') : null;
  if (a.mode === 'readonly') {
    return h('div', { class: 'billing-banner warn' }, icon('alert', 16), h('span', null,
      a.reason === 'trial_ended' ? h('b', null, 'Seu teste grátis terminou. ') : h('b', null, 'A assinatura da clínica não está ativa. '),
      'Os dados continuam disponíveis para consulta e exportação, mas novos registros estão bloqueados.', admin ? '' : ' Fale com o administrador da clínica.'), go2);
  }
  if (a.reason === 'trial') {
    return h('div', { class: 'billing-banner' }, icon('clock', 16), h('span', null,
      a.trial_days_left <= 1 ? 'Último dia do teste grátis.' : `Teste grátis: faltam ${a.trial_days_left} dias.`), go2);
  }
  if (a.reason === 'past_due' && admin) {
    return h('div', { class: 'billing-banner warn' }, icon('alert', 16), h('span', null, 'Não conseguimos cobrar a assinatura. Atualize a forma de pagamento para não perder o acesso.'),
      h('a', { class: 'btn sm', href: '#/configuracoes/assinatura' }, 'Atualizar pagamento'));
  }
  return null;
}

// ---------------- Layout ----------------
let shell = null;
function buildShell() {
  const u = state.user;
  const initials = u.name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const nav = h('nav', { class: 'nav', 'aria-label': 'Menu principal' },
    NAV.filter((n) => !n[3] || isClinical()).map(([path, label, ic], i) =>
      h('a', { href: `#/${path}`, 'data-path': path, onclick: () => app.classList.remove('menu-open') }, icon(ic), h('span', { class: 'grow' }, label))));
  const content = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  const app = h('div', { class: 'app' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('activity', 18)), h('div', null, h('b', null, 'FisioGestão'), h('small', null, state.settings.clinic_name || 'Prontuário eletrônico'))),
      nav,
      h('div', { class: 'side-foot' }, h('div', { class: 'avatar' }, initials),
        h('div', { class: 'who' }, h('b', null, u.name), h('small', null, LABELS.role[u.role])),
        h('button', { class: 'icon-btn', title: 'Sair', 'aria-label': 'Sair', onclick: logout }, icon('logout')))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Abrir menu', onclick: () => app.classList.toggle('menu-open') }, icon('menu', 22)), h('b', null, 'FisioGestão')),
      DEMO ? h('div', { class: 'demo-banner' }, h('span', null, h('b', null, 'Demonstração'), ' · dados fictícios, salvos só neste navegador. Não insira dados reais de pacientes.'), h('button', { class: 'btn sm', onclick: resetDemo }, 'Restaurar dados de exemplo')) : null,
      billingBanner(),
      content));
  app.addEventListener('click', (e) => { if (app.classList.contains('menu-open') && e.target === app) app.classList.remove('menu-open'); });
  root.replaceChildren(app);
  shell = { app, nav, content };
}

async function resetDemo() {
  if (!(await confirmDialog('Apagar tudo o que você fez nesta demonstração e voltar aos dados de exemplo?', { okLabel: 'Restaurar', danger: true }))) return;
  window.FISIO_BACKEND.reset(); state.user = null; shell = null; go(''); loginScreen(); toast('Dados de exemplo restaurados');
}

async function logout() {
  try { await post('/logout'); } catch { /* ignora */ }
  state.user = null; shell = null; if (DEMO) go(''); else location.hash = ''; loginScreen();
}
window.addEventListener('fisio:logout', () => { if (state.user) { state.user = null; shell = null; toast('Sessão expirada. Entre novamente.', 'error'); loginScreen(); } });

// ---------------- Roteador ----------------
const ROUTES = [
  [/^dashboard$/, () => dashboardPage],
  [/^pacientes$/, () => patientsPage],
  [/^pacientes\/novo$/, () => patientFormPage],
  [/^pacientes\/(\d+)\/editar$/, () => patientFormPage],
  [/^pacientes\/(\d+)(?:\/(\w+))?$/, () => patientPage],
  [/^(anamnese|avaliacoes|planos|evolucoes)$/, () => recordsListPage, true],
  [/^registro\/(anamnese|avaliacao|plano|evolucao)\/novo\/(\d+)$/, () => recordEditPage, true],
  [/^registro\/(\d+)\/editar$/, () => recordEditPage, true],
  [/^registro\/(\d+)$/, () => recordViewPage, true],
  [/^agenda$/, () => agendaPage],
  [/^financeiro(?:\/(\w+))?$/, () => financePage],
  [/^relatorios$/, () => reportsPage],
  [/^configuracoes(?:\/(\w+))?$/, () => settingsPage],
];

let renderSeq = 0;
async function router() {
  if (!state.user) return;
  if (!shell) buildShell();
  const raw = getRoute();
  const [path, query] = raw.split('?');
  if (!path || path === 'criar-conta') return go('#/dashboard');
  const top = path.split('/')[0];
  const navKey = top === 'registro' ? { anamnese: 'anamnese', avaliacao: 'avaliacoes', plano: 'planos', evolucao: 'evolucoes' }[path.split('/')[1]] || 'pacientes' : top;
  shell.nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.path === navKey));
  const r = ROUTES.find(([re]) => re.test(path));
  const c = shell.content;
  if (!r) { c.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Página não encontrada.'))); return; }
  if (r[2] && !isClinical()) { c.replaceChildren(h('div', { class: 'notice' }, icon('shield'), 'Seu perfil não tem acesso aos registros clínicos (prontuário).')); return; }
  const params = path.match(r[0]).slice(1);
  const seq = ++renderSeq;
  c.replaceChildren(loading());
  const view = h('div');
  try {
    await r[1]()(view, params, new URLSearchParams(query || ''));
    if (seq !== renderSeq) return;
    c.replaceChildren(view); window.scrollTo(0, 0);
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    c.replaceChildren(h('div', { class: 'notice' }, icon('alert'), err.message || 'Erro ao carregar a página'));
  }
}
// permite que páginas peçam re-renderização da rota atual
window.addEventListener('fisio:refresh', router);
window.addEventListener('hashchange', router);
window.addEventListener('fisio:route', router);
// Demonstração: links internos (#/...) navegam sem alterar a URL
if (DEMO) document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="#/"]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });

async function loadSession() {
  const me = await get('/me');
  state.user = me.user; state.settings = me.settings; state.clinic = me.clinic || null;
  state.professionals = await get('/users').then((us) => us.filter((u) => u.role !== 'recepcao' && u.active !== 0));
}


async function boot() {
  try {
    await loadSession();
    shell = null; router();
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) { root.replaceChildren(h('div', { class: 'content' }, h('div', { class: 'notice' }, icon('alert'), 'Não foi possível conectar ao servidor.'))); return; }
    if (e.status === 403) toast(e.message, 'error');
    !DEMO && getRoute() === 'criar-conta' ? signupScreen() : loginScreen();
  }
}
boot();

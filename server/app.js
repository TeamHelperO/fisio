'use strict';
// API do FisioGestão (SaaS multi-clínica). Exporta `handler(req, res)`, usado pela Vercel (api/index.js)
// e pelo servidor local de desenvolvimento (server/server.js).
const crypto = require('crypto');
const { q, tx, sql, currentSql, als, encrypt, decrypt, nowParts, TIMEZONES, signToken, ensureCore, withClinic, getClinic, createClinic, dropClinic, sealPlatform, openPlatform } = require('./core');
const { HttpError, route, match, readBody, parseCookies, send, SECURITY_HEADERS } = require('./http');
const stripe = require('./stripe');
const mp = require('./mercadopago');
const mailer = require('./mailer');
const templates = require('./emailTemplates');
const notify = require('./notify');
const config = require('./config');

const ON_VERCEL = !!process.env.VERCEL;
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : ON_VERCEL;
const SESSION_HOURS = 10;
const RETENTION_YEARS = 5; // prazo mínimo de guarda do prontuário
const trialDays = () => Number(config.get('TRIAL_DAYS')) || 7; // configurável na área administrativa
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// ====================== Utilidades ======================
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => nowParts().date; // data no fuso da clínica
const nowLocal = () => { const n = nowParts(); return `${n.date}T${n.time}`; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new HttpError(400, `Texto muito longo (máx. ${max} caracteres)`);
  return s;
}
function reqStr(v, label, max) { const s = str(v, max); if (!s) throw new HttpError(400, `${label} é obrigatório`); return s; }
function date(v, label, required = false) {
  const s = str(v, 10);
  if (!s) { if (required) throw new HttpError(400, `${label} é obrigatório`); return null; }
  if (!DATE_RE.test(s) || !realDate(s)) throw new HttpError(400, `${label}: data inválida`);
  return s;
}
// confere se a data existe no calendário (rejeita 31/02, mês 13 etc.)
function realDate(s) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function realDateTime(s) {
  if (!DT_RE.test(s) || !realDate(s)) return false;
  const [hh, mm] = s.slice(11).split(':').map(Number);
  return hh < 24 && mm < 60;
}
function num(v, label, { min = 0, required = false } = {}) {
  if (v === '' || v === null || v === undefined) { if (required) throw new HttpError(400, `${label} é obrigatório`); return 0; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new HttpError(400, `${label}: valor inválido`);
  return Math.round(n * 100) / 100;
}
function oneOf(v, list, label, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!list.includes(v)) throw new HttpError(400, `${label}: opção inválida`);
  return v;
}
function validCPF(cpf) {
  const c = String(cpf).replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  let s = 0; for (let i = 0; i < 9; i++) s += +c[i] * (10 - i);
  let d = (s * 10) % 11 % 10; if (d !== +c[9]) return false;
  s = 0; for (let i = 0; i < 10; i++) s += +c[i] * (11 - i);
  d = (s * 10) % 11 % 10; return d === +c[10];
}
function cpfField(v, label = 'CPF') {
  const s = str(v, 20); if (!s) return null;
  if (!validCPF(s)) throw new HttpError(400, `${label} inválido`);
  const c = s.replace(/\D/g, ''); return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
}
function emailField(v) {
  const e = reqStr(v, 'E-mail', 160).toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'E-mail inválido');
  return e;
}

// ====================== Senhas e sessões ======================
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'A senha deve ter pelo menos 8 caracteres');
  if (pw.length > 200) throw new HttpError(400, 'Senha muito longa');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'A senha deve conter letras e números');
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// hash fictício: o login gasta o mesmo tempo exista ou não o e-mail (evita descobrir contas pelo tempo de resposta)
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function setCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `fisio_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`);
}
async function createSession(res, clinicId, userId, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q.run('INSERT INTO saas.sessions(token_hash, clinic_id, user_id, expires_at, ip) VALUES (?,?,?,?,?)', sha(token), clinicId, userId, Date.now() + SESSION_HOURS * 3600e3, ip);
  setCookie(res, token, SESSION_HOURS * 3600);
}
async function dropSessions(clinicId, userId) {
  await q.run('DELETE FROM saas.sessions WHERE clinic_id=? AND user_id=?', clinicId, userId);
}

// Limite de tentativas (força bruta / abuso), guardado no banco — funciona com várias instâncias serverless
// usa a conexão da requisição quando houver (dentro da transação da clínica) — evita disputar outra conexão
async function checkRate(key) {
  const a = (await currentSql().unsafe('SELECT lock_until FROM saas.login_attempts WHERE key=$1', [key]))[0];
  if (a && a.lock_until > Date.now()) throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil((a.lock_until - Date.now()) / 60000)} min.`);
}
async function failRate(key, max = 5, lockMin = 15) {
  const now = Date.now();
  await currentSql().unsafe(`INSERT INTO saas.login_attempts(key, n, last) VALUES ($1, 1, $2)
    ON CONFLICT (key) DO UPDATE SET n = CASE WHEN saas.login_attempts.last < $2 - 3600000 THEN 1 ELSE saas.login_attempts.n + 1 END, last = $2`, [key, now]);
  await currentSql().unsafe('UPDATE saas.login_attempts SET lock_until=$2, n=0 WHERE key=$1 AND n >= $3', [key, now + lockMin * 60e3, max]);
}
async function clearRate(key) { await currentSql().unsafe('DELETE FROM saas.login_attempts WHERE key=$1', [key]); }

// ====================== Assinatura (acesso da clínica) ======================
// full = uso normal · readonly = teste/assinatura vencidos (consulta e exportação liberadas) · blocked = suspensa pela plataforma
function clinicAccess(c) {
  const now = Date.now();
  const trialEnd = new Date(c.trial_ends_at).getTime();
  const trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / 86400e3));
  let mode; let reason;
  if (c.manual_access) { mode = c.manual_access; reason = 'manual'; }
  else if (['active', 'trialing'].includes(c.subscription_status)) { mode = 'full'; reason = 'subscription'; }
  // cancelada no Mercado Pago (lá o cancelamento é imediato): o acesso segue até o fim do período já pago
  else if (c.subscription_status === 'canceled' && c.current_period_end && new Date(c.current_period_end).getTime() > now) { mode = 'full'; reason = 'subscription'; }
  else if (c.subscription_status === 'past_due') { mode = 'full'; reason = 'past_due'; } // o Stripe ainda está tentando cobrar
  else if (trialEnd > now) { mode = 'full'; reason = 'trial'; }
  else { mode = 'readonly'; reason = c.subscription_status ? 'subscription_ended' : 'trial_ended'; }
  return { mode, reason, trial_days_left: trialDaysLeft };
}
function clinicInfo(c) {
  return {
    id: c.id, name: c.name, timezone: c.timezone, trial_ends_at: c.trial_ends_at,
    subscription_status: c.subscription_status, current_period_end: c.current_period_end, cancel_at_period_end: c.cancel_at_period_end,
    access: clinicAccess(c), billing_enabled: stripe.enabled() || mp.enabled(),
    billing_provider: c.billing_provider || (c.stripe_subscription_id ? 'stripe' : null),
    providers: { stripe: stripe.enabled(), mercadopago: mp.enabled() }, mp_price: mp.enabled() ? mp.price() : null,
    has_mp_preapproval: !!c.mp_preapproval_id,
  };
}

// ====================== Auditoria ======================
async function audit(ctx, action, entity, entityId, patientId, details) {
  await q.run('INSERT INTO audit_log(user_id, user_name, action, entity, entity_id, patient_id, details, ip) VALUES (?,?,?,?,?,?,?,?)',
    ctx.user ? ctx.user.id : null, ctx.user ? ctx.user.name : null, action, entity || null, entityId ?? null, patientId ?? null,
    details ? (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 2000) : null, ctx.ip);
}

// ====================== Controle de acesso ======================
const ROLES = ['admin', 'fisio', 'recepcao'];
const CLINICAL = ['admin', 'fisio'];
function requireRole(user, roles) { if (!roles.includes(user.role)) throw new HttpError(403, 'Acesso não permitido para o seu perfil'); }
// Fisioterapeutas veem apenas pacientes sob sua responsabilidade (ou sem responsável definido)
function scope(user, alias = 'p') {
  if (user.role === 'fisio') return { sql: ` AND (${alias}.professional_id = ? OR ${alias}.professional_id IS NULL)`, params: [user.id] };
  return { sql: '', params: [] };
}
async function getPatient(user, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Paciente não encontrado');
  const p = await q.get('SELECT * FROM patients WHERE id = ?', n);
  if (!p) throw new HttpError(404, 'Paciente não encontrado');
  if (user.role === 'fisio' && p.professional_id && p.professional_id !== user.id) throw new HttpError(403, 'Este paciente está sob responsabilidade de outro profissional');
  return p;
}
const idParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Não encontrado'); return n; };

// ====================== Configurações da clínica ======================
const DEFAULT_SETTINGS = {
  clinic_name: '', professional_name: '', crefito: '', professional_cpf: '', phone: '', email: '', address: '', city: '',
  consent_version: '1.0',
  consent_text: `TERMO DE CONSENTIMENTO PARA TRATAMENTO DE DADOS PESSOAIS E DADOS PESSOAIS SENSÍVEIS (LGPD — Lei nº 13.709/2018)

Eu, titular abaixo identificado(a), declaro estar ciente e consinto que o(a) profissional/clínica identificado(a) neste documento, na condição de controlador(a), realize o tratamento dos meus dados pessoais e dados pessoais sensíveis referentes à saúde, nos termos a seguir:

1. FINALIDADE: os dados serão utilizados exclusivamente para avaliação fisioterapêutica, elaboração e execução do plano de tratamento, registro da evolução clínica em prontuário, agendamento de atendimentos, contato com o paciente, emissão de recibos e cumprimento de obrigações legais, regulatórias e fiscais.
2. DADOS TRATADOS: dados de identificação e contato, dados de saúde (anamnese, avaliação, diagnóstico, evolução), dados financeiros relativos aos pagamentos dos atendimentos.
3. COMPARTILHAMENTO: os dados não serão compartilhados com terceiros, salvo por determinação legal, ordem judicial, ou mediante autorização expressa do(a) titular. O sistema de prontuário é hospedado por fornecedor contratado (operador), que trata os dados apenas para prestar o serviço.
4. ARMAZENAMENTO E SEGURANÇA: os dados serão armazenados em sistema com controle de acesso individual, criptografia dos registros clínicos, cópias de segurança e registro de alterações. O prontuário será mantido pelo prazo mínimo exigido pelas normas do conselho profissional (COFFITO) e pela legislação aplicável.
5. DIREITOS DO TITULAR: o(a) titular pode, a qualquer momento, solicitar confirmação da existência de tratamento, acesso, correção, portabilidade, informação sobre compartilhamento e revogação deste consentimento, ressalvadas as hipóteses legais de guarda obrigatória do prontuário.
6. REVOGAÇÃO: a revogação do consentimento não afeta a legalidade do tratamento realizado anteriormente nem a guarda obrigatória do prontuário.

Declaro que li, compreendi e concordo com os termos acima.`,
};
async function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of await q.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  const c = als.getStore()?.clinic;
  if (c) out.timezone = c.timezone;
  return out;
}
const setSetting = (k, v) => q.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);

// ====================== Consentimento para e-mails de marketing ======================
// Registro separado do aceite dos Termos: só recebe marketing quem marcou a opção (LGPD, art. 7º, I e art. 8º).
async function setMarketing(email, name, clinicId, optIn, source) {
  const now = new Date().toISOString();
  await q.run(`INSERT INTO saas.marketing_contacts(email, name, clinic_id, opt_in, source, consent_at, revoked_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (email) DO UPDATE SET name=COALESCE(excluded.name, saas.marketing_contacts.name), clinic_id=COALESCE(excluded.clinic_id, saas.marketing_contacts.clinic_id),
      opt_in=excluded.opt_in, source=excluded.source,
      consent_at=CASE WHEN excluded.opt_in THEN excluded.consent_at ELSE saas.marketing_contacts.consent_at END,
      revoked_at=CASE WHEN excluded.opt_in THEN NULL ELSE excluded.revoked_at END, updated_at=now()`,
  email, name, clinicId, optIn, source, optIn ? now : null, optIn ? null : now);
}
const unsubscribeUrl = (email) => `${APP_URL}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${signToken('unsubscribe', email.toLowerCase())}`;

// ====================== Cadastro da clínica / Autenticação ======================
route('POST', '/api/signup', async (ctx) => {
  const b = ctx.body;
  const rateKey = `signup|${ctx.ip}`;
  await checkRate(rateKey);
  const clinicName = reqStr(b.clinic_name, 'Nome da clínica / consultório', 160);
  const name = reqStr(b.name, 'Seu nome', 120);
  const email = emailField(b.email);
  const crefito = str(b.crefito, 40);
  validatePassword(b.password);
  if (!b.accept_terms) throw new HttpError(400, 'É preciso aceitar os Termos de Uso e a Política de Privacidade');
  await ensureCore();
  if ((await sql.unsafe('SELECT 1 FROM saas.user_index WHERE email=$1', [email]))[0]) throw new HttpError(400, 'Já existe uma conta com este e-mail. Use "Entrar".');
  await failRate(rateKey, 5, 60); // no máximo 5 contas por hora por IP
  const clinic = await createClinic({ name: clinicName, ownerEmail: email, trialDays: trialDays() });
  try {
    await withClinic(clinic, async () => {
      await setSetting('clinic_name', clinicName);
      await setSetting('professional_name', name);
      await setSetting('email', email);
      if (crefito) await setSetting('crefito', crefito);
      await setSetting('terms_accepted_at', new Date().toISOString());
      const r = await q.run("INSERT INTO users(name,email,password_hash,role,crefito) VALUES (?,?,?,'admin',?)", name, email, hashPassword(b.password), crefito);
      const uid = Number(r.lastInsertRowid);
      await q.run('INSERT INTO saas.user_index(email, clinic_id, user_id) VALUES (?,?,?)', email, clinic.id, uid);
      await setMarketing(email, name, clinic.id, !!b.marketing_opt_in, 'cadastro');
      ctx.user = { id: uid, name };
      await audit(ctx, 'criou_conta', 'clinic', clinic.id, null, { clinica: clinicName, teste_dias: trialDays() });
      await createSession(ctx.res, clinic.id, uid, ctx.ip);
    });
  } catch (e) {
    await dropClinic(clinic.id).catch(() => {});
    if (e.code === '23505') throw new HttpError(400, 'Já existe uma conta com este e-mail. Use "Entrar".');
    throw e;
  }
  const owner = (await sql.unsafe('SELECT user_id FROM saas.user_index WHERE email=$1', [email]))[0];
  const sent = owner ? await sendVerification(clinic, { id: owner.user_id, name, email }) : false;
  return { ok: true, verification_sent: sent, email };
}, { public: true });

route('POST', '/api/login', async (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(ctx.body.password || '').slice(0, 200);
  const key = `login|${ctx.ip}|${email}`; const ipKey = `loginip|${ctx.ip}`;
  await ensureCore();
  await checkRate(ipKey); await checkRate(key);
  const idx = (await sql.unsafe('SELECT clinic_id, user_id FROM saas.user_index WHERE email=$1', [email]))[0];
  const clinic = idx ? await getClinic(idx.clinic_id) : null;
  if (!clinic) {
    checkPassword(password, DUMMY_HASH);
    await failRate(key); await failRate(ipKey, 30, 15);
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }
  if (clinicAccess(clinic).mode === 'blocked') throw new HttpError(403, 'O acesso desta clínica está suspenso. Entre em contato com o suporte.');
  const u = await withClinic(clinic, async () => {
    const user = await q.get('SELECT * FROM users WHERE id=?', idx.user_id);
    const ok = checkPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !user.active || !ok) { ctx.user = null; await audit(ctx, 'login_falhou', 'user', user ? user.id : null, null, email); return null; }
    await q.run('UPDATE users SET last_login = now_local() WHERE id=?', user.id);
    ctx.user = user; await audit(ctx, 'login', 'user', user.id);
    await createSession(ctx.res, clinic.id, user.id, ctx.ip);
    return user;
  });
  if (!u) { await failRate(key); await failRate(ipKey, 30, 15); throw new HttpError(401, 'E-mail ou senha incorretos'); }
  await clearRate(key);
  return { ok: true };
}, { public: true });

// ====================== Esqueci minha senha ======================
// Link de uso único, válido por 1 hora, enviado por e-mail (SMTP/Resend do painel /admin).
// A resposta é sempre a mesma, exista ou não a conta (não revela quais e-mails estão cadastrados).
const RESET_TTL_MIN = 60;
const PASSWORD_RE_SENT = 'Se houver uma conta com este e-mail, enviamos um link para criar uma nova senha. Confira a caixa de entrada e o spam. O link vale por 1 hora.';

route('POST', '/api/password/forgot', async (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Informe um e-mail válido');
  await ensureCore();
  // limites: 5 pedidos por IP a cada 30 min e 3 por e-mail a cada hora
  const ipKey = `forgot|${ctx.ip}`; const emailKey = `forgot|${email}`;
  await checkRate(ipKey); await checkRate(emailKey);
  await failRate(ipKey, 5, 30); await failRate(emailKey, 3, 60);
  const started = Date.now();
  const idx = (await sql.unsafe('SELECT clinic_id, user_id FROM saas.user_index WHERE email=$1', [email]))[0];
  const clinic = idx ? await getClinic(idx.clinic_id) : null;
  let user = null;
  if (clinic && clinicAccess(clinic).mode !== 'blocked') {
    user = await withClinic(clinic, () => q.get('SELECT id, name, email, active FROM users WHERE id=?', idx.user_id));
  }
  if (user && user.active) {
    const token = crypto.randomBytes(32).toString('base64url');
    await sql.unsafe('DELETE FROM saas.password_resets WHERE clinic_id=$1 AND user_id=$2', [clinic.id, user.id]); // só o link mais recente vale
    await sql.unsafe('INSERT INTO saas.password_resets(token_hash, clinic_id, user_id, email, expires_at, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [sha(token), clinic.id, user.id, email, Date.now() + RESET_TTL_MIN * 60e3, ctx.ip]);
    const url = `${APP_URL}/#/redefinir-senha?t=${token}`;
    try {
      await notify.sendTemplate('esqueci_senha', { to: email, clinicId: clinic.id, url, vars: { nome: user.name, clinica: clinic.name, validade: `${RESET_TTL_MIN / 60} hora` } });
      await withClinic(clinic, () => { ctx.user = null; return audit(ctx, 'pediu_nova_senha', 'user', user.id, null, { ip: ctx.ip }); });
    } catch (e) {
      console.error('Esqueci minha senha: falha ao enviar e-mail', e.message);
      await sql.unsafe('DELETE FROM saas.password_resets WHERE token_hash=$1', [sha(token)]);
    }
  }
  // tempo de resposta parecido com ou sem conta (não revela se o e-mail existe)
  const wait = 900 + crypto.randomInt(400) - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { ok: true, message: PASSWORD_RE_SENT };
}, { public: true });

async function resetTicket(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const r = (await sql.unsafe('SELECT * FROM saas.password_resets WHERE token_hash=$1', [sha(token)]))[0];
  if (!r || r.used_at || Number(r.expires_at) < Date.now()) return null;
  return r;
}
// a tela confere o link antes de pedir a nova senha
route('POST', '/api/password/check', async (ctx) => {
  await ensureCore();
  const key = `reset|${ctx.ip}`;
  await checkRate(key);
  const r = await resetTicket(ctx.body.token);
  if (!r) { await failRate(key, 10, 30); throw new HttpError(400, 'Este link não é válido ou já expirou. Peça um novo em "Esqueci minha senha".'); }
  return { ok: true, email: r.email };
}, { public: true });
route('POST', '/api/password/reset', async (ctx) => {
  await ensureCore();
  const key = `reset|${ctx.ip}`;
  await checkRate(key);
  const r = await resetTicket(ctx.body.token);
  if (!r) { await failRate(key, 10, 30); throw new HttpError(400, 'Este link não é válido ou já expirou. Peça um novo em "Esqueci minha senha".'); }
  const pw = String(ctx.body.password || '');
  validatePassword(pw);
  const clinic = await getClinic(r.clinic_id);
  if (!clinic || clinicAccess(clinic).mode === 'blocked') throw new HttpError(403, 'O acesso desta clínica está suspenso. Entre em contato com o suporte.');
  // marca como usado antes de trocar (evita uso duplo em requisições simultâneas)
  const claimed = await sql.unsafe('UPDATE saas.password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL RETURNING token_hash', [r.token_hash]);
  if (!claimed.length) throw new HttpError(400, 'Este link já foi usado. Peça um novo em "Esqueci minha senha".');
  const user = await withClinic(clinic, async () => {
    const u = await q.get('SELECT id, name, email, active FROM users WHERE id=?', r.user_id);
    if (!u || !u.active) return null;
    await q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(pw), u.id);
    ctx.user = null; await audit(ctx, 'redefiniu_senha', 'user', u.id, null, { via: 'link por e-mail' });
    return u;
  });
  if (!user) throw new HttpError(400, 'Esta conta está desativada. Fale com o administrador da clínica.');
  // encerra todas as sessões abertas e libera bloqueios de login
  await sql.unsafe('DELETE FROM saas.sessions WHERE clinic_id=$1 AND user_id=$2', [clinic.id, user.id]);
  await sql.unsafe("DELETE FROM saas.login_attempts WHERE key LIKE 'login|%|' || $1", [user.email]);
  try { await notify.sendTemplate('senha_alterada', { to: user.email, clinicId: clinic.id, url: APP_URL, vars: { nome: user.name, clinica: clinic.name } }); }
  catch (e) { console.error('Aviso de senha alterada não enviado', e.message); }
  return { ok: true };
}, { public: true });

// ====================== Confirmação de e-mail ======================
// Enviada no cadastro, quando o administrador da clínica cria um usuário e quando o e-mail de um usuário muda.
// Link de uso único, válido por 48 horas. Contas criadas antes desta função já contam como confirmadas.
const VERIFY_TTL_H = 48;
async function sendVerification(clinic, user, { invitedBy = null } = {}) {
  const db = currentSql();
  const token = crypto.randomBytes(32).toString('base64url');
  await db.unsafe('DELETE FROM saas.email_verifications WHERE clinic_id=$1 AND user_id=$2', [clinic.id, user.id]); // só o link mais recente vale
  await db.unsafe('INSERT INTO saas.email_verifications(token_hash, clinic_id, user_id, email, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [sha(token), clinic.id, user.id, user.email, Date.now() + VERIFY_TTL_H * 3600e3]);
  const url = `${APP_URL}/#/confirmar-email?t=${token}`;
  try {
    const vars = { nome: user.name, clinica: clinic.name, validade: `${VERIFY_TTL_H} horas`, convidado_por: invitedBy || '' };
    await notify.sendTemplate(invitedBy ? 'convite_usuario' : 'confirmar_email', { to: user.email, clinicId: clinic.id, url, vars });
    return true;
  } catch (e) {
    console.error('Confirmação de e-mail não enviada', e.message);
    return false;
  }
}
async function emailVerified(clinicId, userId) {
  const r = (await currentSql().unsafe('SELECT email_verified_at FROM saas.user_index WHERE clinic_id=$1 AND user_id=$2', [clinicId, userId]))[0];
  return !!r?.email_verified_at;
}

route('POST', '/api/email/verify', async (ctx) => {
  await ensureCore();
  const key = `verify|${ctx.ip}`;
  await checkRate(key);
  const token = ctx.body.token;
  const invalid = 'Este link de confirmação não é válido ou expirou. Entre no sistema e clique em "Reenviar link".';
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) { await failRate(key, 10, 30); throw new HttpError(400, invalid); }
  const r = (await sql.unsafe('SELECT * FROM saas.email_verifications WHERE token_hash=$1', [sha(token)]))[0];
  if (!r || Number(r.expires_at) < Date.now()) { await failRate(key, 10, 30); throw new HttpError(400, invalid); }
  if (r.used_at) return { ok: true, email: r.email, already: true };
  // confirma só se o e-mail do usuário ainda for o mesmo do link
  const upd = await sql.unsafe('UPDATE saas.user_index SET email_verified_at=now() WHERE clinic_id=$1 AND user_id=$2 AND email=$3 RETURNING email', [r.clinic_id, r.user_id, r.email]);
  if (!upd.length) throw new HttpError(400, 'O e-mail desta conta foi alterado depois do envio deste link. Use o link mais recente.');
  await sql.unsafe('UPDATE saas.email_verifications SET used_at=now() WHERE token_hash=$1', [r.token_hash]);
  const clinic = await getClinic(r.clinic_id);
  if (clinic) await withClinic(clinic, () => { ctx.user = null; return audit(ctx, 'confirmou_email', 'user', r.user_id, null, { email: r.email }); });
  return { ok: true, email: r.email };
}, { public: true });

route('POST', '/api/email/resend', async (ctx) => {
  if (await emailVerified(ctx.clinic.id, ctx.user.id)) throw new HttpError(400, 'Seu e-mail já está confirmado.');
  const key = `resend|${ctx.clinic.id}|${ctx.user.id}`;
  await checkRate(key);
  await failRate(key, 3, 60);
  const sent = await sendVerification(ctx.clinic, ctx.user);
  if (!sent) throw new HttpError(503, 'Não foi possível enviar o e-mail agora. Tente novamente mais tarde.');
  return { ok: true, email: ctx.user.email };
}, { always: true });

route('POST', '/api/logout', async (ctx) => {
  const token = parseCookies(ctx.req).fisio_sid;
  if (token) await q.run('DELETE FROM saas.sessions WHERE token_hash=?', sha(token));
  setCookie(ctx.res, '', 0);
  await audit(ctx, 'logout', 'user', ctx.user.id);
  return { ok: true };
}, { always: true });

route('GET', '/api/me', async (ctx) => ({ user: { ...ctx.user, email_verified: await emailVerified(ctx.clinic.id, ctx.user.id) }, settings: await getSettings(), clinic: clinicInfo(ctx.clinic) }));

route('GET', '/api/me/marketing', async (ctx) => {
  const r = await q.get('SELECT opt_in FROM saas.marketing_contacts WHERE email=?', ctx.user.email);
  return { opt_in: !!r?.opt_in };
}, { always: true });
route('PUT', '/api/me/marketing', async (ctx) => {
  await setMarketing(ctx.user.email, ctx.user.name, ctx.clinic.id, !!ctx.body.opt_in, 'minha_conta');
  await audit(ctx, ctx.body.opt_in ? 'aceitou_marketing' : 'recusou_marketing', 'user', ctx.user.id);
  return { opt_in: !!ctx.body.opt_in };
}, { always: true });
// Link de descadastro incluído nos e-mails de marketing (sem login; o token é uma assinatura do e-mail)
route('GET', '/api/unsubscribe', async (ctx) => {
  const email = String(ctx.query.get('e') || '').trim().toLowerCase();
  const token = String(ctx.query.get('t') || '');
  const expected = email ? signToken('unsubscribe', email) : '';
  const ok = expected && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (ok) await sql.unsafe("UPDATE saas.marketing_contacts SET opt_in=false, revoked_at=now(), source='descadastro', updated_at=now() WHERE email=$1", [email]);
  const msg = ok ? 'Pronto! Você não receberá mais e-mails de novidades do FisioGestão. Avisos sobre a sua conta continuam sendo enviados.' : 'Link inválido ou expirado. Você também pode desativar os e-mails de novidades em Configurações → Minha conta.';
  return { __html: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Descadastro — FisioGestão</title><link rel="stylesheet" href="/css/legal.css"></head><body><main><h1>E-mails de novidades</h1><p>${msg}</p><p class="back"><a href="/">Ir para o FisioGestão</a></p></main></body></html>` };
}, { public: true });

route('POST', '/api/me/password', async (ctx) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!checkPassword(String(ctx.body.current || ''), u.password_hash)) throw new HttpError(400, 'Senha atual incorreta');
  validatePassword(ctx.body.password);
  await q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(ctx.body.password), u.id);
  await dropSessions(ctx.clinic.id, u.id);
  await createSession(ctx.res, ctx.clinic.id, u.id, ctx.ip);
  await audit(ctx, 'alterou_senha', 'user', u.id);
  return { ok: true };
}, { always: true });

// ====================== Usuários ======================
route('GET', '/api/users', async (ctx) => {
  if (ctx.user.role === 'admin') return q.all('SELECT id,name,email,role,crefito,active,created_at,last_login FROM users ORDER BY name');
  return q.all("SELECT id,name,role,crefito FROM users WHERE active=1 AND role IN ('admin','fisio') ORDER BY name");
});
async function emailFree(email, exceptUserId = null) {
  const hit = await q.get('SELECT clinic_id, user_id FROM saas.user_index WHERE email=?', email);
  return !hit || (exceptUserId && hit.clinic_id === als.getStore().clinic.id && hit.user_id === exceptUserId);
}
route('POST', '/api/users', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const b = ctx.body; validatePassword(b.password);
  const email = emailField(b.email);
  if (!(await emailFree(email))) throw new HttpError(400, 'Este e-mail já é usado por outro usuário do FisioGestão');
  const r = await q.run('INSERT INTO users(name,email,password_hash,role,crefito) VALUES (?,?,?,?,?)',
    reqStr(b.name, 'Nome', 120), email, hashPassword(b.password), oneOf(b.role, ROLES, 'Perfil', 'fisio'), str(b.crefito, 40));
  const id = Number(r.lastInsertRowid);
  await q.run('INSERT INTO saas.user_index(email, clinic_id, user_id) VALUES (?,?,?)', email, ctx.clinic.id, id);
  await audit(ctx, 'criou', 'user', id, null, { email, role: b.role });
  const sent = await sendVerification(ctx.clinic, { id, name: b.name, email }, { invitedBy: ctx.user.name });
  return { id, verification_sent: sent };
});
route('PUT', '/api/users/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = idParam(ctx.params.id); const b = ctx.body;
  const u = await q.get('SELECT * FROM users WHERE id=?', id); if (!u) throw new HttpError(404, 'Usuário não encontrado');
  const role = oneOf(b.role, ROLES, 'Perfil', u.role);
  const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
  if (id === ctx.user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'Você não pode remover seu próprio acesso de administrador');
  const email = b.email !== undefined ? emailField(b.email) : u.email;
  if (email !== u.email && !(await emailFree(email, id))) throw new HttpError(400, 'Este e-mail já é usado por outro usuário do FisioGestão');
  await q.run('UPDATE users SET name=?, email=?, role=?, crefito=?, active=? WHERE id=?',
    reqStr(b.name ?? u.name, 'Nome', 120), email, role, str(b.crefito ?? u.crefito, 40), active, id);
  if (email !== u.email) await q.run('UPDATE saas.user_index SET email=?, email_verified_at=NULL WHERE clinic_id=? AND user_id=?', email, ctx.clinic.id, id);
  if (b.password) { validatePassword(b.password); await q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(b.password), id); }
  if (!active || b.password) await dropSessions(ctx.clinic.id, id);
  await audit(ctx, 'alterou', 'user', id, null, { role, active, senha_redefinida: !!b.password });
  if (email !== u.email && active) await sendVerification(ctx.clinic, { id, name: b.name ?? u.name, email }, { invitedBy: ctx.user.name });
  return { ok: true };
});

// ====================== Configurações ======================
route('GET', '/api/settings', () => getSettings());
route('PUT', '/api/settings', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const allowed = ['clinic_name', 'professional_name', 'crefito', 'professional_cpf', 'phone', 'email', 'address', 'city', 'consent_text', 'consent_version'];
  const before = await getSettings();
  for (const k of allowed) {
    if (ctx.body[k] === undefined) continue;
    let v = str(ctx.body[k], k === 'consent_text' ? 20000 : 300) || '';
    if (k === 'professional_cpf' && v) v = cpfField(v, 'CPF do profissional');
    await setSetting(k, v);
  }
  if (ctx.body.consent_text !== undefined && ctx.body.consent_text !== before.consent_text && ctx.body.consent_version === before.consent_version) {
    const v = (parseFloat(before.consent_version) || 1) + 0.1;
    await setSetting('consent_version', v.toFixed(1));
  }
  if (ctx.body.timezone !== undefined && ctx.body.timezone !== ctx.clinic.timezone) {
    const tz = oneOf(ctx.body.timezone, Object.keys(TIMEZONES), 'Fuso horário', ctx.clinic.timezone);
    await q.run('UPDATE saas.clinics SET timezone=? WHERE id=?', tz, ctx.clinic.id);
    als.getStore().clinic = { ...ctx.clinic, timezone: tz };
  }
  if (ctx.body.clinic_name) await q.run('UPDATE saas.clinics SET name=? WHERE id=?', str(ctx.body.clinic_name, 160), ctx.clinic.id);
  await audit(ctx, 'alterou', 'settings', null);
  return getSettings();
});
route('GET', '/api/timezones', () => TIMEZONES);

// ====================== Dashboard ======================
route('GET', '/api/dashboard', async (ctx) => {
  const s = scope(ctx.user);
  const d = new Date(today() + 'T12:00'); const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const cnt = async (where, ...p) => (await q.get(`SELECT COUNT(*) n FROM patients p WHERE 1=1 ${where} ${s.sql}`, ...p, ...s.params)).n;
  const out = {
    total: await cnt(''),
    em_tratamento: await cnt("AND p.status IN ('em_tratamento','avaliacao')"),
    finalizado: await cnt("AND p.status='finalizado'"),
    agendadas: (await q.get(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.start >= ? AND a.status IN ('agendado','confirmado') ${s.sql}`, nowLocal(), ...s.params)).n,
    realizados_mes: (await q.get(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE substr(a.start,1,7)=? AND a.status='realizado' ${s.sql}`, month, ...s.params)).n,
    faltas_mes: (await q.get(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE substr(a.start,1,7)=? AND a.status='falta' ${s.sql}`, month, ...s.params)).n,
    faturamento_mes: (await q.get(`SELECT COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pago' AND substr(c.paid_at,1,7)=? ${s.sql}`, month, ...s.params)).v,
    pendentes: await q.get(`SELECT COUNT(*) n, COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pendente' ${s.sql}`, ...s.params),
    vencidos: await q.get(`SELECT COUNT(*) n, COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pendente' AND c.due_date < ? ${s.sql}`, today(), ...s.params),
    proximos: await q.all(`SELECT a.*, p.name patient_name, p.phone, u.name professional_name FROM appointments a JOIN patients p ON p.id=a.patient_id LEFT JOIN users u ON u.id=a.professional_id
      WHERE a.start >= ? AND a.status IN ('agendado','confirmado') ${s.sql} ORDER BY a.start LIMIT 12`, `${today()}T00:00`, ...s.params),
    receita_6m: [],
  };
  for (let i = 5; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1); const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    out.receita_6m.push({ month: key, value: (await q.get(`SELECT COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pago' AND substr(c.paid_at,1,7)=? ${s.sql}`, key, ...s.params)).v });
  }
  return out;
});

// ====================== Pacientes ======================
async function patientFields(b, current = null) {
  return [
    reqStr(b.name, 'Nome completo', 160), date(b.birth_date, 'Data de nascimento'), cpfField(b.cpf), str(b.phone, 40), str(b.email, 160),
    str(b.address, 400), str(b.profession, 120), str(b.emergency_name, 160), str(b.emergency_phone, 40), date(b.first_visit, 'Primeiro atendimento'),
    oneOf(b.status, ['avaliacao', 'em_tratamento', 'finalizado', 'inativo'], 'Situação', 'em_tratamento'),
    await responsible(b.professional_id, current), str(b.notes, 4000),
  ];
}
// responsável precisa ser um usuário ativo com perfil clínico (administrador ou fisioterapeuta)
async function responsible(v, current = null) {
  if (!v) return null;
  if (current && Number(v) === current) return current; // mantém o atual mesmo que o usuário tenha sido desativado
  const n = Number(v);
  const u = Number.isInteger(n) ? await q.get("SELECT id FROM users WHERE id=? AND active=1 AND role IN ('admin','fisio')", n) : null;
  if (!u) throw new HttpError(400, 'Fisioterapeuta responsável inválido');
  return u.id;
}
// Fisioterapeuta não pode deixar o paciente sem responsável (isso o tornaria visível a todos os fisioterapeutas)
function keepResponsible(ctx, f, current) {
  if (ctx.user.role === 'fisio' && !f[11]) f[11] = current || ctx.user.id;
}
route('GET', '/api/patients', async (ctx) => {
  const s = scope(ctx.user); const sp = ctx.query;
  let text = `SELECT p.id,p.name,p.birth_date,p.cpf,p.phone,p.status,p.first_visit,p.professional_id,u.name professional_name,
    (SELECT COUNT(*) FROM consents c WHERE c.patient_id=p.id AND c.revoked_at IS NULL) consent,
    (SELECT MAX(a.start) FROM appointments a WHERE a.patient_id=p.id AND a.status='realizado') last_visit,
    (SELECT MIN(a.start) FROM appointments a WHERE a.patient_id=p.id AND a.status IN ('agendado','confirmado') AND a.start>=?) next_visit
    FROM patients p LEFT JOIN users u ON u.id=p.professional_id WHERE 1=1 ${s.sql}`;
  const params = [nowLocal(), ...s.params];
  if (sp.get('q')) { text += ' AND (p.name ILIKE ? OR p.cpf ILIKE ? OR p.phone ILIKE ?)'; const t = `%${sp.get('q')}%`; params.push(t, t, t); }
  if (sp.get('status')) { text += ' AND p.status = ?'; params.push(sp.get('status')); }
  text += ' ORDER BY lower(p.name)';
  return q.all(text, ...params);
});
route('POST', '/api/patients', async (ctx) => {
  const f = await patientFields(ctx.body);
  keepResponsible(ctx, f);
  const r = await q.run(`INSERT INTO patients(name,birth_date,cpf,phone,email,address,profession,emergency_name,emergency_phone,first_visit,status,professional_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...f);
  const id = Number(r.lastInsertRowid);
  await audit(ctx, 'criou', 'patient', id, id);
  let invited = false;
  if (f[4] && (await getSettings()).portal_auto_invite === '1') {
    try { await invitePatient(ctx.clinic, { id, name: f[0], email: f[4] }); invited = true; await audit(ctx, 'convidou_portal', 'patient', id, id, { automatico: true }); }
    catch (e) { console.warn('Convite automático do portal não enviado', e.message); }
  }
  return { id, invited };
});
route('GET', '/api/patients/:id', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const prof = p.professional_id ? await q.get('SELECT name, crefito FROM users WHERE id=?', p.professional_id) : null;
  const consent = await q.get('SELECT * FROM consents WHERE patient_id=? AND revoked_at IS NULL ORDER BY accepted_at DESC LIMIT 1', p.id);
  const counts = {};
  if (CLINICAL.includes(ctx.user.role)) {
    for (const r of await q.all('SELECT type, COUNT(*) n FROM records WHERE patient_id=? AND deleted_at IS NULL GROUP BY type', p.id)) counts[r.type] = r.n;
  }
  counts.realizados = (await q.get("SELECT COUNT(*) n FROM appointments WHERE patient_id=? AND status='realizado'", p.id)).n;
  counts.faltas = (await q.get("SELECT COUNT(*) n FROM appointments WHERE patient_id=? AND status='falta'", p.id)).n;
  counts.pendente = (await q.get("SELECT COALESCE(SUM(amount),0) v FROM charges WHERE patient_id=? AND status='pendente'", p.id)).v;
  const next = await q.get("SELECT * FROM appointments WHERE patient_id=? AND status IN ('agendado','confirmado') AND start>=? ORDER BY start LIMIT 1", p.id, nowLocal());
  await audit(ctx, 'visualizou', 'patient', p.id, p.id);
  return { ...p, professional_name: prof?.name, professional_crefito: prof?.crefito, consent, counts, next };
});
route('PUT', '/api/patients/:id', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const f = await patientFields({ ...p, ...ctx.body }, p.professional_id);
  keepResponsible(ctx, f, p.professional_id);
  await q.run(`UPDATE patients SET name=?,birth_date=?,cpf=?,phone=?,email=?,address=?,profession=?,emergency_name=?,emergency_phone=?,first_visit=?,status=?,professional_id=?,notes=?, updated_at=now_local() WHERE id=?`, ...f, p.id);
  const changed = Object.keys(ctx.body).filter((k) => String(ctx.body[k] ?? '') !== String(p[k] ?? ''));
  await audit(ctx, 'alterou', 'patient', p.id, p.id, { campos: changed });
  return { ok: true };
});
async function patientExport(p) {
  const records = (await q.all('SELECT * FROM records WHERE patient_id=? AND deleted_at IS NULL ORDER BY record_date', p.id))
    .map(({ data_enc, ...r }) => ({ ...r, data: decrypt(data_enc) }));
  return {
    exportado_em: new Date().toISOString(), paciente: p,
    consentimentos: await q.all('SELECT * FROM consents WHERE patient_id=?', p.id), registros_clinicos: records,
    agendamentos: await q.all('SELECT * FROM appointments WHERE patient_id=? ORDER BY start', p.id),
    financeiro: await q.all('SELECT * FROM charges WHERE patient_id=? ORDER BY due_date', p.id),
    programas_exercicios: (await q.all('SELECT * FROM exercise_programs WHERE patient_id=? ORDER BY start_date', p.id)).map(programView),
  };
}
route('DELETE', '/api/patients/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const p = await getPatient(ctx.user, ctx.params.id);
  if (String(ctx.body.confirm || '').trim() !== p.name) throw new HttpError(400, 'Digite o nome completo do paciente para confirmar a exclusão');
  // Guarda legal do prontuário (COFFITO, Res. 414/2012: mínimo de 5 anos a partir do último registro).
  // Registros clínicos (inclusive os excluídos logicamente) impedem a exclusão definitiva dentro do prazo.
  const lastRec = await q.get('SELECT GREATEST(MAX(record_date), MAX(substr(updated_at,1,10))) d, COUNT(*) n FROM records WHERE patient_id=?', p.id);
  if (lastRec.n) {
    const limit = new Date(today() + 'T12:00'); limit.setFullYear(limit.getFullYear() - RETENTION_YEARS);
    if (lastRec.d > ymd(limit)) {
      const until = new Date(lastRec.d + 'T12:00'); until.setFullYear(until.getFullYear() + RETENTION_YEARS);
      throw new HttpError(400, `Este paciente possui prontuário clínico (último registro em ${lastRec.d.split('-').reverse().join('/')}), que deve ser guardado por no mínimo ${RETENTION_YEARS} anos — até ${ymd(until).split('-').reverse().join('/')}. Em vez de excluir, altere a situação do paciente para "Inativo".`);
    }
  }
  // cópia criptografada antes da exclusão (substitui o backup local da versão instalada)
  const snapshot = await patientExport(p);
  await q.run('INSERT INTO deleted_patients(patient_id, name, data_enc, deleted_by) VALUES (?,?,?,?)', p.id, p.name, encrypt(snapshot), ctx.user.id);
  await q.run('DELETE FROM patients WHERE id=?', p.id);
  await audit(ctx, 'excluiu', 'patient', p.id, p.id, { nome: p.name, motivo: str(ctx.body.reason, 500) });
  return { ok: true };
});
// Portabilidade (LGPD art. 18, V) — exporta todos os dados do titular
route('GET', '/api/patients/:id/export', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = await getPatient(ctx.user, ctx.params.id);
  const out = await patientExport(p);
  await audit(ctx, 'exportou_dados', 'patient', p.id, p.id);
  return out;
});

// ====================== Consentimento LGPD ======================
route('GET', '/api/patients/:id/consents', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  return q.all('SELECT c.*, u.name registered_by_name FROM consents c LEFT JOIN users u ON u.id=c.registered_by WHERE patient_id=? ORDER BY accepted_at DESC', p.id);
});
route('POST', '/api/patients/:id/consents', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id); const st = await getSettings();
  const r = await q.run('INSERT INTO consents(patient_id, term_version, term_hash, method, signer_name, accepted_at, registered_by) VALUES (?,?,?,?,?,?,?)',
    p.id, st.consent_version, sha(st.consent_text), oneOf(ctx.body.method, ['assinatura_fisica', 'assinatura_digital', 'aceite_presencial'], 'Forma', 'assinatura_fisica'),
    reqStr(ctx.body.signer_name || p.name, 'Nome do titular/responsável', 160), date(ctx.body.accepted_at, 'Data') || today(), ctx.user.id);
  await audit(ctx, 'registrou_consentimento', 'consent', Number(r.lastInsertRowid), p.id);
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/consents/:id/revoke', async (ctx) => {
  const c = await q.get('SELECT * FROM consents WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Não encontrado');
  await getPatient(ctx.user, c.patient_id);
  await q.run('UPDATE consents SET revoked_at=?, revoke_reason=? WHERE id=?', today(), str(ctx.body.reason, 500), c.id);
  await audit(ctx, 'revogou_consentimento', 'consent', c.id, c.patient_id);
  return { ok: true };
});

// ====================== Registros clínicos ======================
const RECORD_TYPES = ['anamnese', 'avaliacao', 'plano', 'evolucao'];
function recordMeta(r) { const { data_enc, ...rest } = r; return rest; }
route('GET', '/api/records', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const sp = ctx.query; const s = scope(ctx.user);
  let text = `SELECT r.*, p.name patient_name, u.name author_name FROM records r JOIN patients p ON p.id=r.patient_id LEFT JOIN users u ON u.id=r.author_id WHERE r.deleted_at IS NULL ${s.sql}`;
  const params = [...s.params];
  if (sp.get('type')) { text += ' AND r.type=?'; params.push(oneOf(sp.get('type'), RECORD_TYPES, 'Tipo')); }
  if (sp.get('patient_id')) { await getPatient(ctx.user, sp.get('patient_id')); text += ' AND r.patient_id=?'; params.push(Number(sp.get('patient_id'))); }
  if (sp.get('q')) { text += ' AND p.name ILIKE ?'; params.push(`%${sp.get('q')}%`); }
  text += ' ORDER BY r.record_date DESC, r.seq DESC NULLS LAST, r.id DESC LIMIT 500';
  const full = sp.get('full') === '1' && sp.get('patient_id');
  const rows = (await q.all(text, ...params)).map((r) => (full ? { ...recordMeta(r), data: decrypt(r.data_enc) } : recordMeta(r)));
  if (full) await audit(ctx, 'visualizou', 'records', null, Number(sp.get('patient_id')), sp.get('type'));
  return rows;
});
route('GET', '/api/records/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const r = await q.get('SELECT r.*, u.name author_name, u.crefito author_crefito FROM records r LEFT JOIN users u ON u.id=r.author_id WHERE r.id=? AND r.deleted_at IS NULL', idParam(ctx.params.id));
  if (!r) throw new HttpError(404, 'Registro não encontrado');
  await getPatient(ctx.user, r.patient_id);
  const versions = await q.all('SELECT v.id, v.version, v.changed_at, u.name changed_by_name FROM record_versions v LEFT JOIN users u ON u.id=v.changed_by WHERE record_id=? ORDER BY version DESC', r.id);
  await audit(ctx, 'visualizou', 'record', r.id, r.patient_id, r.type);
  return { ...recordMeta(r), data: decrypt(r.data_enc), versions };
});
route('GET', '/api/records/:id/versions/:vid', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const r = await q.get('SELECT * FROM records WHERE id=?', idParam(ctx.params.id)); if (!r) throw new HttpError(404, 'Registro não encontrado');
  await getPatient(ctx.user, r.patient_id);
  const v = await q.get('SELECT * FROM record_versions WHERE id=? AND record_id=?', idParam(ctx.params.vid), r.id); if (!v) throw new HttpError(404, 'Versão não encontrada');
  return { ...recordMeta(v), data: decrypt(v.data_enc) };
});
function recordInput(b, existing) {
  const type = existing ? existing.type : oneOf(b.type, RECORD_TYPES, 'Tipo');
  if (!type) throw new HttpError(400, 'Tipo é obrigatório');
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  if (JSON.stringify(data).length > 200000) throw new HttpError(400, 'Registro muito grande');
  return {
    type,
    record_date: date(b.record_date, 'Data', true),
    seq: type === 'evolucao' ? (b.seq ? Number(b.seq) || null : null) : null,
    status: type === 'plano' ? oneOf(b.status, ['ativo', 'concluido', 'substituido'], 'Situação', 'ativo') : null,
    title: str(b.title, 200),
    data,
  };
}
route('POST', '/api/records', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = await getPatient(ctx.user, ctx.body.patient_id);
  const r = recordInput(ctx.body);
  return tx(async () => {
    if (r.type === 'evolucao' && !r.seq) r.seq = ((await q.get("SELECT MAX(seq) m FROM records WHERE patient_id=? AND type='evolucao' AND deleted_at IS NULL", p.id)).m || 0) + 1;
    if (r.type === 'plano' && r.status === 'ativo') await q.run("UPDATE records SET status='substituido' WHERE patient_id=? AND type='plano' AND status='ativo'", p.id);
    const res = await q.run('INSERT INTO records(patient_id,type,record_date,seq,status,title,author_id,data_enc) VALUES (?,?,?,?,?,?,?,?)',
      p.id, r.type, r.record_date, r.seq, r.status, r.title, ctx.user.id, encrypt(r.data));
    const id = Number(res.lastInsertRowid);
    if (r.type === 'avaliacao' && p.status === 'avaliacao') await q.run("UPDATE patients SET status='em_tratamento' WHERE id=?", p.id);
    await audit(ctx, 'criou', r.type, id, p.id);
    return { id, seq: r.seq };
  });
});
route('PUT', '/api/records/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = await q.get('SELECT * FROM records WHERE id=? AND deleted_at IS NULL', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Registro não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  const r = recordInput({ ...ex, ...ctx.body }, ex);
  return tx(async () => {
    const ver = ((await q.get('SELECT MAX(version) m FROM record_versions WHERE record_id=?', ex.id)).m || 0) + 1;
    await q.run('INSERT INTO record_versions(record_id,version,record_date,status,data_enc,changed_by) VALUES (?,?,?,?,?,?)', ex.id, ver, ex.record_date, ex.status, ex.data_enc, ctx.user.id);
    if (r.type === 'plano' && r.status === 'ativo' && ex.status !== 'ativo') await q.run("UPDATE records SET status='substituido' WHERE patient_id=? AND type='plano' AND status='ativo' AND id<>?", ex.patient_id, ex.id);
    await q.run('UPDATE records SET record_date=?, seq=?, status=?, title=?, data_enc=?, updated_at=now_local() WHERE id=?',
      r.record_date, r.seq ?? ex.seq, r.status, r.title, encrypt(r.data), ex.id);
    await audit(ctx, 'alterou', ex.type, ex.id, ex.patient_id, { versao_anterior: ver });
    return { ok: true };
  });
});
route('DELETE', '/api/records/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = await q.get('SELECT * FROM records WHERE id=? AND deleted_at IS NULL', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Registro não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  if (ctx.user.role !== 'admin' && ex.author_id !== ctx.user.id) throw new HttpError(403, 'Apenas o autor ou o administrador pode excluir este registro');
  // exclusão lógica: o registro permanece guardado para fins de auditoria/guarda legal do prontuário
  await q.run('UPDATE records SET deleted_at=now_local() WHERE id=?', ex.id);
  await audit(ctx, 'excluiu', ex.type, ex.id, ex.patient_id, str(ctx.body.reason, 500));
  return { ok: true };
});

// ====================== Agenda ======================
function apptInput(b) {
  const start = str(b.start, 16);
  if (!start || !realDateTime(start)) throw new HttpError(400, 'Data e horário inválidos');
  return {
    start, duration: Math.max(10, Math.min(480, Number(b.duration) || 50)),
    kind: oneOf(b.kind, ['avaliacao', 'sessao', 'reavaliacao', 'retorno', 'domiciliar', 'teleatendimento'], 'Tipo', 'sessao'),
    status: oneOf(b.status, ['agendado', 'confirmado', 'realizado', 'falta', 'cancelado'], 'Situação', 'agendado'),
    price: num(b.price, 'Valor'), notes: str(b.notes, 1000),
    professional_id: b.professional_id ? Number(b.professional_id) || null : null,
  };
}
async function overlapCheck(a, ignoreId) {
  if (!a.professional_id || ['cancelado', 'falta'].includes(a.status)) return;
  const end = new Date(a.start).getTime() + a.duration * 60e3;
  const day = a.start.slice(0, 10);
  const rows = await q.all("SELECT a.id, a.start, a.duration, p.name FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.professional_id=? AND substr(a.start,1,10)=? AND a.status NOT IN ('cancelado','falta') AND a.id<>?", a.professional_id, day, ignoreId || 0);
  for (const r of rows) {
    const s = new Date(r.start).getTime(); const e = s + r.duration * 60e3;
    if (s < end && new Date(a.start).getTime() < e) return `Conflito de horário com ${r.name} às ${r.start.slice(11)}`;
  }
}
// Gera cobrança automaticamente quando atendimento avulso é marcado como realizado
// valor já lançado para o atendimento fora da cobrança principal (sinal / pagamento antecipado)
async function advanceTotal(a) {
  return Number((await q.get("SELECT COALESCE(SUM(amount),0) t FROM charges WHERE appointment_id=? AND id<>? AND status<>'cancelado'", a.id, a.charge_id || 0)).t) || 0;
}
const cents = (v) => Math.round(v * 100) / 100;
async function syncCharge(ctx, apptId) {
  const a = await q.get('SELECT * FROM appointments WHERE id=?', apptId);
  const ch = a.charge_id ? await q.get('SELECT * FROM charges WHERE id=?', a.charge_id) : null;
  const rest = cents(a.price - await advanceTotal(a));
  if (a.status === 'realizado' && rest > 0 && !ch) {
    const [y, m, d] = a.start.slice(0, 10).split('-');
    const adv = rest < a.price;
    const r = await q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, appointment_id, created_by) VALUES (?,?,?,?,?,?,?)',
      a.patient_id, a.professional_id, `${adv ? 'Restante do atendimento' : 'Atendimento de fisioterapia'} — ${d}/${m}/${y}`, rest, a.start.slice(0, 10), a.id, ctx.user.id);
    await q.run('UPDATE appointments SET charge_id=? WHERE id=?', Number(r.lastInsertRowid), a.id);
  } else if (a.status !== 'realizado' && ch && ch.status === 'pendente') {
    await q.run('DELETE FROM charges WHERE id=?', ch.id);
    await q.run('UPDATE appointments SET charge_id=NULL WHERE id=?', a.id);
  } else if (ch && ch.status === 'pendente') {
    // cobrança pendente acompanha o atendimento (paciente, profissional e valor)
    if (rest <= 0) { await q.run('DELETE FROM charges WHERE id=?', ch.id); await q.run('UPDATE appointments SET charge_id=NULL WHERE id=?', a.id); return; }
    await q.run('UPDATE charges SET patient_id=?, professional_id=?, amount=? WHERE id=?',
      a.patient_id, a.professional_id, a.price > 0 ? rest : ch.amount, ch.id);
  }
}
// Pagamento informado no agendamento: 'depois' (cobra ao realizar), 'sinal' (recebeu uma parte, no valor informado) ou 'pago' (tudo agora)
const PAY_OPTIONS = ['depois', 'sinal', 'pago', 'link_sinal', 'link_total'];
const isLink = (p) => p === 'link_sinal' || p === 'link_total';
// valor da parte (sinal) informado na tela; sem valor (versão antiga da tela) vale metade
function partAmount(ctx, price) {
  const raw = ctx.body.payment_amount;
  if (raw === undefined || raw === null || raw === '') return cents(price / 2);
  const v = cents(num(raw, 'Valor recebido'));
  if (v <= 0) throw new HttpError(400, 'Informe o valor recebido');
  if (v > price + 0.001) throw new HttpError(400, 'O valor informado é maior que o valor do atendimento');
  return v;
}
async function applyPayment(ctx, apptId, payment, method) {
  if (!payment || payment === 'depois' || isLink(payment)) return;
  const a = await q.get('SELECT * FROM appointments WHERE id=?', apptId);
  if (!(a.price > 0)) throw new HttpError(400, 'Informe o valor do atendimento para registrar o pagamento');
  if (!METHODS.includes(method)) throw new HttpError(400, 'Informe a forma de pagamento');
  const ch = a.charge_id ? await q.get('SELECT * FROM charges WHERE id=?', a.charge_id) : null;
  const paid = Number((await q.get("SELECT COALESCE(SUM(amount),0) t FROM charges WHERE appointment_id=? AND status='pago'", a.id)).t) || 0;
  const target = payment === 'sinal' ? Math.min(a.price, cents(paid + partAmount(ctx, a.price))) : a.price;
  let need = cents(target - paid);
  if (need <= 0) return;
  const day = today();
  // já existe a cobrança do restante (atendimento realizado): quita ela
  if (ch && ch.status === 'pendente' && payment === 'pago') {
    await q.run("UPDATE charges SET status='pago', paid_at=?, method=?, receipt_number=? WHERE id=?", day, method, await nextReceipt(day), ch.id);
    await audit(ctx, 'registrou_pagamento', 'charge', ch.id, a.patient_id, { amount: ch.amount, method });
    need = cents(need - ch.amount);
    if (need <= 0) return;
  }
  const [y, m, d] = a.start.slice(0, 10).split('-');
  const desc = need >= a.price ? `Pagamento antecipado — atendimento de ${d}/${m}/${y}` : paid === 0 ? `Sinal — atendimento de ${d}/${m}/${y}` : `Pagamento parcial — atendimento de ${d}/${m}/${y}`;
  const r = await q.run("INSERT INTO charges(patient_id, professional_id, description, amount, due_date, status, paid_at, method, receipt_number, appointment_id, created_by) VALUES (?,?,?,?,?,'pago',?,?,?,?,?)",
    a.patient_id, a.professional_id, desc, need, day, day, method, await nextReceipt(day), a.id, ctx.user.id);
  await audit(ctx, 'registrou_pagamento', 'charge', Number(r.lastInsertRowid), a.patient_id, { amount: need, method, agendamento: a.id, tipo: payment });
  await syncCharge(ctx, a.id);
}
// cria o link do Mercado Pago depois de gravar o agendamento (se o Mercado Pago falhar, a cobrança fica pendente no Financeiro)
async function withPayLink(ctx, out) {
  if (!out.link_charge) return out;
  try { out.pay_link = await payLinkFor(ctx, out.link_charge); } catch (e) { out.pay_link_error = e.message; }
  return out;
}
const paidOf = async (apptId) => Number((await q.get("SELECT COALESCE(SUM(amount),0) t FROM charges WHERE appointment_id=? AND status='pago'", apptId)).t) || 0;
route('GET', '/api/appointments', async (ctx) => {
  const sp = ctx.query; const s = scope(ctx.user);
  let text = `SELECT a.*, p.name patient_name, p.phone, u.name professional_name, c.status charge_status,
    (SELECT COALESCE(SUM(x.amount),0) FROM charges x WHERE x.appointment_id=a.id AND x.status='pago') paid_total,
    (SELECT x.id FROM charges x WHERE x.appointment_id=a.id AND x.status='pendente' AND x.pay_url IS NOT NULL ORDER BY x.id DESC LIMIT 1) pay_link_charge FROM appointments a JOIN patients p ON p.id=a.patient_id
    LEFT JOIN users u ON u.id=a.professional_id LEFT JOIN charges c ON c.id=a.charge_id WHERE 1=1 ${s.sql}`;
  const params = [...s.params];
  if (sp.get('from')) { text += ' AND a.start >= ?'; params.push(sp.get('from')); }
  if (sp.get('to')) { text += ' AND a.start < ?'; params.push(sp.get('to')); }
  if (sp.get('patient_id')) { text += ' AND a.patient_id = ?'; params.push(Number(sp.get('patient_id')) || 0); }
  if (sp.get('professional_id')) { text += ' AND a.professional_id = ?'; params.push(Number(sp.get('professional_id')) || 0); }
  text += ' ORDER BY a.start' + (sp.get('desc') ? ' DESC' : '') + ' LIMIT 2000';
  return q.all(text, ...params);
});
route('POST', '/api/appointments', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.body.patient_id);
  const a = apptInput(ctx.body);
  if (!a.professional_id) a.professional_id = p.professional_id || (ctx.user.role !== 'recepcao' ? ctx.user.id : null);
  const repeat = Math.max(1, Math.min(52, Number(ctx.body.repeat_weeks) || 1));
  const payment = oneOf(ctx.body.payment, PAY_OPTIONS, 'Pagamento', 'depois');
  if (payment !== 'depois' && !(a.price > 0)) throw new HttpError(400, 'Informe o valor do atendimento para registrar o pagamento');
  if (['sinal', 'pago'].includes(payment) && !METHODS.includes(ctx.body.payment_method)) throw new HttpError(400, 'Informe a forma de pagamento');
  if (isLink(payment) && !(await recvAccount(ctx.clinic.id))) throw new HttpError(400, 'Conecte a conta do Mercado Pago da clínica em Configurações → Recebimentos.');
  const starts = [];
  for (let i = 0; i < repeat; i++) {
    const d = new Date(a.start); d.setDate(d.getDate() + 7 * i);
    starts.push(`${ymd(d)}T${a.start.slice(11)}`);
  }
  // verifica conflito em todas as ocorrências da série, não apenas na primeira
  const conflicts = [];
  for (let i = 0; i < starts.length; i++) {
    const c = await overlapCheck({ ...a, start: starts[i], status: i === 0 ? a.status : 'agendado' });
    if (c) conflicts.push(repeat > 1 ? `${starts[i].slice(8, 10)}/${starts[i].slice(5, 7)}: ${c}` : c);
  }
  if (conflicts.length && !ctx.body.force) {
    const more = conflicts.length > 5 ? `\n… e mais ${conflicts.length - 5} conflito(s)` : '';
    throw new HttpError(409, conflicts.slice(0, 5).join('\n') + more);
  }
  const created = await tx(async () => {
    const ids = [];
    for (let i = 0; i < repeat; i++) {
      const r = await q.run('INSERT INTO appointments(patient_id,professional_id,start,duration,kind,status,price,notes) VALUES (?,?,?,?,?,?,?,?)',
        p.id, a.professional_id, starts[i], a.duration, a.kind, i === 0 ? a.status : 'agendado', a.price, a.notes);
      ids.push(Number(r.lastInsertRowid)); await syncCharge(ctx, ids[ids.length - 1]);
    }
    await applyPayment(ctx, ids[0], payment, ctx.body.payment_method);
    await audit(ctx, 'criou', 'appointment', ids[0], p.id, { start: a.start, repeticoes: repeat, pagamento: payment });
    return { ids, link_charge: isLink(payment) ? await linkChargeForAppointment(ctx, ids[0], payment) : null };
  });
  return withPayLink(ctx, created);
});
route('PUT', '/api/appointments/:id', async (ctx) => {
  const ex = await q.get('SELECT * FROM appointments WHERE id=?', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Agendamento não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  const pid = ctx.body.patient_id ? (await getPatient(ctx.user, ctx.body.patient_id)).id : ex.patient_id;
  if (pid !== ex.patient_id && await paidOf(ex.id) > 0) {
    throw new HttpError(400, 'Este atendimento já tem pagamento registrado (recibo emitido) e não pode ser transferido para outro paciente. Estorne o pagamento primeiro.');
  }
  const a = apptInput({ ...ex, ...ctx.body });
  const payment = oneOf(ctx.body.payment, PAY_OPTIONS, 'Pagamento', 'depois');
  const conflict = await overlapCheck(a, ex.id);
  if (conflict && !ctx.body.force) throw new HttpError(409, conflict);
  if (isLink(payment) && !(await recvAccount(ctx.clinic.id))) throw new HttpError(400, 'Conecte a conta do Mercado Pago da clínica em Configurações → Recebimentos.');
  const updated = await tx(async () => {
    await q.run('UPDATE appointments SET patient_id=?, professional_id=?, start=?, duration=?, kind=?, status=?, price=?, notes=? WHERE id=?',
      pid, a.professional_id, a.start, a.duration, a.kind, a.status, a.price, a.notes, ex.id);
    await syncCharge(ctx, ex.id);
    await applyPayment(ctx, ex.id, payment, ctx.body.payment_method);
    await audit(ctx, 'alterou', 'appointment', ex.id, pid, { status: a.status, start: a.start });
    // atendimento cancelado: links de pagamento ainda não pagos deixam de valer
    if (a.status === 'cancelado') await q.run("UPDATE charges SET status='cancelado' WHERE appointment_id=? AND status='pendente' AND pay_url IS NOT NULL", ex.id);
    const paid = await paidOf(ex.id);
    return { ok: true, paid_total: paid, paid_warning: ['cancelado', 'falta'].includes(a.status) && paid > 0,
      link_charge: isLink(payment) && a.status !== 'cancelado' ? await linkChargeForAppointment(ctx, ex.id, payment) : null };
  });
  return withPayLink(ctx, updated);
});
route('DELETE', '/api/appointments/:id', async (ctx) => {
  const ex = await q.get('SELECT * FROM appointments WHERE id=?', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Agendamento não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  if (await paidOf(ex.id) > 0) throw new HttpError(400, 'Este atendimento possui pagamento registrado. Altere a situação em vez de excluir.');
  await tx(async () => {
    if (ex.charge_id) await q.run('DELETE FROM charges WHERE id=?', ex.charge_id);
    await q.run("DELETE FROM charges WHERE appointment_id=? AND status<>'pago'", ex.id);
    await q.run('DELETE FROM appointments WHERE id=?', ex.id);
  });
  await audit(ctx, 'excluiu', 'appointment', ex.id, ex.patient_id, { start: ex.start });
  return { ok: true };
});

// ====================== Financeiro ======================
const METHODS = ['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'transferencia'];
const FIN_ROLES = ['admin', 'fisio', 'recepcao'];
function crud(table, fields, label) {
  route('GET', `/api/${table}`, () => q.all(`SELECT * FROM ${table} ORDER BY active DESC, name`));
  route('POST', `/api/${table}`, async (ctx) => {
    requireRole(ctx.user, ['admin', 'fisio']);
    const vals = fields.map(([k, fn]) => fn(ctx.body[k]));
    const r = await q.run(`INSERT INTO ${table}(${fields.map((f) => f[0]).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...vals);
    await audit(ctx, 'criou', label, Number(r.lastInsertRowid)); return { id: Number(r.lastInsertRowid) };
  });
  route('PUT', `/api/${table}/:id`, async (ctx) => {
    requireRole(ctx.user, ['admin', 'fisio']);
    const ex = await q.get(`SELECT * FROM ${table} WHERE id=?`, idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Não encontrado');
    const vals = fields.map(([k, fn]) => fn(ctx.body[k] ?? ex[k]));
    await q.run(`UPDATE ${table} SET ${fields.map((f) => f[0] + '=?').join(',')}, active=? WHERE id=?`, ...vals, ctx.body.active === undefined ? ex.active : (ctx.body.active ? 1 : 0), ex.id);
    await audit(ctx, 'alterou', label, ex.id); return { ok: true };
  });
}
crud('services', [['name', (v) => reqStr(v, 'Nome', 120)], ['price', (v) => num(v, 'Valor', { required: true })], ['duration', (v) => Math.max(10, Math.min(480, Number(v) || 50))]], 'service');
crud('packages', [['name', (v) => reqStr(v, 'Nome', 120)], ['sessions', (v) => Math.max(1, Math.min(1000, Number(v) || 1))], ['price', (v) => num(v, 'Valor', { required: true })]], 'package');

route('GET', '/api/patient-packages', async (ctx) => {
  const s = scope(ctx.user); const sp = ctx.query;
  let text = `SELECT pp.*, p.name patient_name,
    (SELECT COUNT(*) FROM appointments a WHERE a.patient_id=pp.patient_id AND a.status='realizado' AND substr(a.start,1,10) BETWEEN pp.start_date AND pp.end_date) used,
    (SELECT status FROM charges c WHERE c.patient_package_id=pp.id ORDER BY id LIMIT 1) charge_status
    FROM patient_packages pp JOIN patients p ON p.id=pp.patient_id WHERE 1=1 ${s.sql}`;
  const params = [...s.params];
  if (sp.get('patient_id')) { text += ' AND pp.patient_id=?'; params.push(Number(sp.get('patient_id')) || 0); }
  return q.all(text + ' ORDER BY pp.start_date DESC', ...params);
});
route('POST', '/api/patient-packages', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const p = await getPatient(ctx.user, ctx.body.patient_id); const b = ctx.body;
  const pkg = b.package_id ? await q.get('SELECT * FROM packages WHERE id=?', Number(b.package_id) || 0) : null;
  if (b.package_id && !pkg) throw new HttpError(400, 'Pacote não encontrado');
  if (!pkg && (!Number(b.sessions) || b.price === undefined || b.price === '')) throw new HttpError(400, 'Informe o número de sessões e o valor do pacote');
  const start = date(b.start_date, 'Início', true);
  let end = date(b.end_date, 'Fim');
  if (!end) { const d = new Date(start + 'T12:00'); d.setMonth(d.getMonth() + 1); d.setDate(d.getDate() - 1); end = ymd(d); }
  const name = str(b.name, 120) || pkg?.name || 'Pacote mensal';
  const sessions = Math.max(1, Math.min(1000, Number(b.sessions) || pkg?.sessions || 1));
  const price = b.price !== undefined && b.price !== '' ? num(b.price, 'Valor') : pkg?.price || 0;
  return tx(async () => {
    const r = await q.run('INSERT INTO patient_packages(patient_id,package_id,name,sessions,price,start_date,end_date) VALUES (?,?,?,?,?,?,?)', p.id, pkg?.id || null, name, sessions, price, start, end);
    const id = Number(r.lastInsertRowid);
    if (price > 0) await q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, patient_package_id, created_by) VALUES (?,?,?,?,?,?,?)',
      p.id, p.professional_id, `${name} (${sessions} sessões) — ${start.split('-').reverse().join('/')} a ${end.split('-').reverse().join('/')}`, price, date(b.due_date, 'Vencimento') || start, id, ctx.user.id);
    await audit(ctx, 'criou', 'patient_package', id, p.id);
    return { id };
  });
});
route('PUT', '/api/patient-packages/:id', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const ex = await q.get('SELECT * FROM patient_packages WHERE id=?', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  await q.run('UPDATE patient_packages SET status=? WHERE id=?', oneOf(ctx.body.status, ['ativo', 'encerrado', 'cancelado'], 'Situação', ex.status), ex.id);
  await audit(ctx, 'alterou', 'patient_package', ex.id, ex.patient_id); return { ok: true };
});

function chargeQuery(ctx) {
  const s = scope(ctx.user); const sp = ctx.query;
  let text = `SELECT c.*, p.name patient_name, p.cpf patient_cpf, u.name professional_name FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN users u ON u.id=c.professional_id WHERE 1=1 ${s.sql}`;
  const params = [...s.params];
  if (sp.get('status')) { text += ' AND c.status=?'; params.push(sp.get('status')); }
  if (sp.get('patient_id')) { text += ' AND c.patient_id=?'; params.push(Number(sp.get('patient_id')) || 0); }
  if (sp.get('professional_id')) { text += ' AND c.professional_id=?'; params.push(Number(sp.get('professional_id')) || 0); }
  const field = sp.get('by') === 'paid' ? 'c.paid_at' : 'c.due_date';
  if (sp.get('from')) { text += ` AND ${field} >= ?`; params.push(sp.get('from')); }
  if (sp.get('to')) { text += ` AND ${field} <= ?`; params.push(sp.get('to')); }
  if (sp.get('overdue')) { text += " AND c.status='pendente' AND c.due_date < ?"; params.push(today()); }
  return { text, params };
}
route('GET', '/api/charges', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const { text, params } = chargeQuery(ctx);
  return q.all(text + ' ORDER BY COALESCE(c.paid_at, c.due_date) DESC, c.id DESC LIMIT 3000', ...params);
});
route('GET', '/api/charges/:id', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT c.*, p.name patient_name, p.cpf patient_cpf, p.address patient_address, u.name professional_name, u.crefito professional_crefito FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN users u ON u.id=c.professional_id WHERE c.id=?', idParam(ctx.params.id));
  if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id); return c;
});
// Numeração de recibos: contador anual que nunca retrocede (recibos estornados/cancelados não são reaproveitados).
// O UPDATE na linha do contador trava a linha até o fim da transação, evitando números repetidos em pagamentos simultâneos.
async function nextReceipt(paidAt) {
  const y = paidAt.slice(0, 4);
  const key = `receipt_seq_${y}`;
  const numOf = (r) => Number(String(r || '').split('-')[1]) || 0;
  await q.run("INSERT INTO settings(key,value) VALUES (?, '0') ON CONFLICT(key) DO NOTHING", key);
  let lastN = Number((await q.get('SELECT value FROM settings WHERE key=? FOR UPDATE', key))?.value) || 0;
  const last = await q.get('SELECT receipt_number r FROM charges WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1', `${y}-%`);
  lastN = Math.max(lastN, numOf(last?.r));
  for (const a of await q.all("SELECT details FROM audit_log WHERE action IN ('estornou','cancelou') AND entity='charge' AND details LIKE ?", `%"recibo":"${y}-%`)) {
    try { lastN = Math.max(lastN, numOf(JSON.parse(a.details).recibo)); } catch { /* detalhe ilegível */ }
  }
  const n = lastN + 1;
  await q.run('UPDATE settings SET value=? WHERE key=?', String(n), key);
  return `${y}-${String(n).padStart(5, '0')}`;
}
function payFields(b) {
  return { paid_at: date(b.paid_at, 'Data do pagamento', true), method: oneOf(b.method, METHODS, 'Forma de pagamento'), payer_name: str(b.payer_name, 160), payer_cpf: cpfField(b.payer_cpf, 'CPF do pagador') };
}
route('POST', '/api/charges', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const p = await getPatient(ctx.user, ctx.body.patient_id); const b = ctx.body;
  const amount = num(b.amount, 'Valor', { required: true }); if (amount <= 0) throw new HttpError(400, 'Valor deve ser maior que zero');
  const paid = b.status === 'pago';
  const pf = paid ? payFields(b) : {};
  if (paid && !pf.method) throw new HttpError(400, 'Informe a forma de pagamento');
  return tx(async () => {
    const r = await q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, status, paid_at, method, payer_name, payer_cpf, receipt_number, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      p.id, b.professional_id ? Number(b.professional_id) || null : p.professional_id || (ctx.user.role !== 'recepcao' ? ctx.user.id : null), reqStr(b.description, 'Descrição', 300), amount,
      date(b.due_date, 'Vencimento') || today(), paid ? 'pago' : 'pendente', pf.paid_at || null, pf.method || null, pf.payer_name || null, pf.payer_cpf || null,
      paid ? await nextReceipt(pf.paid_at) : null, str(b.notes, 1000), ctx.user.id);
    await audit(ctx, 'criou', 'charge', Number(r.lastInsertRowid), p.id, { amount, paid });
    return { id: Number(r.lastInsertRowid) };
  });
});
route('PUT', '/api/charges/:id', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT * FROM charges WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id); const b = { ...c, ...ctx.body };
  const amount = num(b.amount, 'Valor', { required: true });
  await q.run('UPDATE charges SET description=?, amount=?, due_date=?, notes=?, professional_id=?, payer_name=?, payer_cpf=?, method=? WHERE id=?',
    reqStr(b.description, 'Descrição', 300), amount, date(b.due_date, 'Vencimento', true), str(b.notes, 1000), b.professional_id ? Number(b.professional_id) || null : null,
    str(b.payer_name, 160), cpfField(b.payer_cpf, 'CPF do pagador'), c.status === 'pago' ? oneOf(b.method, METHODS, 'Forma de pagamento') : c.method, c.id);
  await audit(ctx, 'alterou', 'charge', c.id, c.patient_id, { de: c.amount, para: amount });
  return { ok: true };
});
route('POST', '/api/charges/:id/pay', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT * FROM charges WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id);
  if (c.status === 'pago') throw new HttpError(400, 'Este lançamento já está pago');
  const pf = payFields({ paid_at: today(), ...ctx.body });
  if (!pf.method) throw new HttpError(400, 'Informe a forma de pagamento');
  return tx(async () => {
    await q.run("UPDATE charges SET status='pago', paid_at=?, method=?, payer_name=?, payer_cpf=?, receipt_number=? WHERE id=?",
      pf.paid_at, pf.method, pf.payer_name, pf.payer_cpf, await nextReceipt(pf.paid_at), c.id);
    await audit(ctx, 'registrou_pagamento', 'charge', c.id, c.patient_id, { amount: c.amount, method: pf.method });
    return { ok: true };
  });
});
route('POST', '/api/charges/:id/status', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT * FROM charges WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id);
  const st = oneOf(ctx.body.status, ['pendente', 'cancelado'], 'Situação');
  // estorno: volta para pendente mantendo o número do recibo no histórico de auditoria
  await q.run('UPDATE charges SET status=?, paid_at=NULL, method=NULL, receipt_number=NULL WHERE id=?', st, c.id);
  await audit(ctx, st === 'cancelado' ? 'cancelou' : 'estornou', 'charge', c.id, c.patient_id, { recibo: c.receipt_number, amount: c.amount });
  return { ok: true };
});
route('DELETE', '/api/charges/:id', async (ctx) => {
  requireRole(ctx.user, ['admin', 'fisio']);
  const c = await q.get('SELECT * FROM charges WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id);
  if (c.status === 'pago') throw new HttpError(400, 'Lançamentos pagos não podem ser excluídos. Faça o estorno primeiro.');
  await q.run('UPDATE appointments SET charge_id=NULL WHERE charge_id=?', c.id);
  await q.run('DELETE FROM charges WHERE id=?', c.id);
  await audit(ctx, 'excluiu', 'charge', c.id, c.patient_id, { amount: c.amount, description: c.description });
  return { ok: true };
});
route('GET', '/api/finance/report', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const s = scope(ctx.user); const sp = ctx.query;
  const from = date(sp.get('from'), 'De', true); const to = date(sp.get('to'), 'Até', true);
  const base = `FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pago' AND c.paid_at BETWEEN ? AND ? ${s.sql}`;
  const ps = [from, to, ...s.params];
  return {
    from, to,
    total: await q.get(`SELECT COALESCE(SUM(c.amount),0) v, COUNT(*) n ${base}`, ...ps),
    por_mes: await q.all(`SELECT substr(c.paid_at,1,7) AS month, SUM(c.amount) v, COUNT(*) n ${base} GROUP BY 1 ORDER BY 1`, ...ps),
    por_forma: await q.all(`SELECT c.method, SUM(c.amount) v, COUNT(*) n ${base} GROUP BY c.method ORDER BY v DESC`, ...ps),
    por_paciente: await q.all(`SELECT p.name, SUM(c.amount) v, COUNT(*) n ${base} GROUP BY p.id ORDER BY v DESC LIMIT 50`, ...ps),
    pendente: await q.get(`SELECT COALESCE(SUM(c.amount),0) v, COUNT(*) n FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pendente' AND c.due_date BETWEEN ? AND ? ${s.sql}`, ...ps),
  };
});
// Organização de dados para o Carnê-Leão — apenas consolida receitas; NÃO calcula imposto.
route('GET', '/api/finance/carne-leao', async (ctx) => {
  requireRole(ctx.user, ['admin', 'fisio']);
  const sp = ctx.query; const year = String(sp.get('year') || today().slice(0, 4));
  if (!/^\d{4}$/.test(year)) throw new HttpError(400, 'Ano inválido');
  const s = scope(ctx.user);
  let text = `SELECT c.id, c.paid_at, c.amount, c.method, c.description, c.receipt_number, c.payer_name, c.payer_cpf, p.name patient_name, p.cpf patient_cpf, u.name professional_name, u.id professional_id
    FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN users u ON u.id=c.professional_id WHERE c.status='pago' AND substr(c.paid_at,1,4)=? ${s.sql}`;
  const params = [year, ...s.params];
  if (sp.get('professional_id')) { text += ' AND c.professional_id=?'; params.push(Number(sp.get('professional_id')) || 0); }
  const rows = await q.all(text + ' ORDER BY c.paid_at, c.id', ...params);
  await audit(ctx, 'consultou', 'carne_leao', null, null, year);
  return { year, rows };
});

// ====================== Auditoria ======================
route('GET', '/api/audit', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const sp = ctx.query; let text = 'SELECT * FROM audit_log WHERE 1=1'; const params = [];
  if (sp.get('patient_id')) { text += ' AND patient_id=?'; params.push(Number(sp.get('patient_id')) || 0); }
  if (sp.get('user_id')) { text += ' AND user_id=?'; params.push(Number(sp.get('user_id')) || 0); }
  if (sp.get('from')) { text += ' AND ts >= ?'; params.push(sp.get('from')); }
  if (sp.get('to')) { text += ' AND ts <= ?'; params.push(sp.get('to') + ' 23:59:59'); }
  return q.all(text + ' ORDER BY id DESC LIMIT 1000', ...params);
});
route('GET', '/api/patients/:id/audit', async (ctx) => {
  requireRole(ctx.user, CLINICAL); const p = await getPatient(ctx.user, ctx.params.id);
  return q.all('SELECT ts, user_name, action, entity, entity_id, details FROM audit_log WHERE patient_id=? ORDER BY id DESC LIMIT 500', p.id);
});

// ====================== Dados da clínica (exportação completa — LGPD / portabilidade) ======================
route('GET', '/api/clinic/export', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const tables = ['patients', 'consents', 'appointments', 'services', 'packages', 'patient_packages', 'charges', 'audit_log', 'settings', 'exercises'];
  const out = { exportado_em: new Date().toISOString(), clinica: ctx.clinic.name, formato: 'FisioGestão JSON v1' };
  out.users = await q.all('SELECT id,name,email,role,crefito,active,created_at,last_login FROM users ORDER BY id');
  for (const t of tables) out[t] = await q.all(`SELECT * FROM ${t} ORDER BY 1`);
  out.records = (await q.all('SELECT * FROM records ORDER BY id')).map(({ data_enc, ...r }) => ({ ...r, data: decrypt(data_enc) }));
  out.record_versions = (await q.all('SELECT * FROM record_versions ORDER BY id')).map(({ data_enc, ...r }) => ({ ...r, data: decrypt(data_enc) }));
  out.exercise_programs = (await q.all('SELECT * FROM exercise_programs ORDER BY id')).map(programView);
  await audit(ctx, 'exportou_clinica', 'clinic', ctx.clinic.id);
  return { __download: `fisiogestao-${today()}.json`, body: JSON.stringify(out, null, 2) };
}, { always: true });

// ====================== Biblioteca de exercícios ======================
// Catálogo fixo (server/data/exercicios.json: textos do ExerciseDB v1, licença MIT, traduzidos) + exercícios próprios da clínica.
// Referência de um exercício: "c-0001" (catálogo) ou "p-12" (próprio da clínica).
const CATALOG = require('./data/exercicios.json').exercises;
const CATALOG_BY_CODE = new Map(CATALOG.map((e) => [e.code, e]));
const EX_REGIONS = [...new Set(CATALOG.map((e) => e.region))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
const EX_OBJECTIVES = ['Fortalecimento', 'Alongamento e mobilidade', 'Equilíbrio e propriocepção', 'Condicionamento', 'Funcional', 'Respiratório', 'Outro'];
const EX_EQUIPMENT = ['Peso corporal', 'Elástico', 'Halter / caneleira', 'Bola suíça', 'Medicine ball', 'Bosu', 'Rolo', 'Cadeira / banco', 'Degrau', 'Bastão', 'Outro'];
const catalogView = (e, full) => ({
  ref: `c-${e.code}`, source: 'catalogo', name: e.name, region: e.region, objective: e.objective, equipment: e.equipment,
  target: e.target, muscles: e.muscles, ...(full ? { steps: e.steps, source_name: e.source_name } : {}),
});
const ownView = (e, full) => ({
  ref: `p-${e.id}`, id: e.id, source: 'clinica', name: e.name, region: e.region, objective: e.objective, equipment: e.equipment,
  target: e.target, muscles: e.muscles ? e.muscles.split('\n').filter(Boolean) : [], media_url: e.media_url, based_on: e.based_on,
  ...(full ? { steps: e.steps.split('\n').filter(Boolean) } : {}),
});
const MEDIA_RE = /^https:\/\/[^\s<>"']{4,490}$/;
function exerciseInput(b) {
  const steps = (Array.isArray(b.steps) ? b.steps : String(b.steps || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
  if (!steps.length) throw new HttpError(400, 'Descreva pelo menos um passo de execução');
  if (steps.length > 20) throw new HttpError(400, 'Use no máximo 20 passos');
  steps.forEach((s) => { if (s.length > 500) throw new HttpError(400, 'Cada passo pode ter até 500 caracteres'); });
  const muscles = (Array.isArray(b.muscles) ? b.muscles : String(b.muscles || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 15);
  const media = str(b.media_url, 500);
  if (media && !MEDIA_RE.test(media)) throw new HttpError(400, 'O link de vídeo ou imagem precisa começar com https://');
  return {
    name: reqStr(b.name, 'Nome', 150), region: reqStr(b.region, 'Região', 80),
    objective: oneOf(reqStr(b.objective, 'Objetivo', 80), EX_OBJECTIVES, 'Objetivo'),
    equipment: reqStr(b.equipment, 'Equipamento', 80), target: str(b.target, 120),
    muscles: muscles.join('\n') || null, steps: steps.join('\n'), media_url: media,
  };
}
async function findExercise(ref) {
  const m = /^([cp])-(\w{1,10})$/.exec(String(ref || ''));
  if (!m) return null;
  if (m[1] === 'c') { const e = CATALOG_BY_CODE.get(m[2]); return e ? catalogView(e, true) : null; }
  const e = await q.get('SELECT * FROM exercises WHERE id=? AND active=1', Number(m[2]) || 0);
  return e ? ownView(e, true) : null;
}

route('GET', '/api/exercises/meta', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  return { regions: EX_REGIONS, objectives: EX_OBJECTIVES, equipment: EX_EQUIPMENT, catalog_count: CATALOG.length,
    credit: 'Catálogo baseado no ExerciseDB v1 (via hasaneyldrm/exercises-dataset, licença MIT), traduzido e adaptado pelo FisioGestão.' };
});
route('GET', '/api/exercises', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const own = (await q.all('SELECT * FROM exercises WHERE active=1 ORDER BY name')).map((e) => ownView(e));
  return [...own, ...CATALOG.map((e) => catalogView(e))];
});
route('GET', '/api/exercises/:ref', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const e = await findExercise(ctx.params.ref);
  if (!e) throw new HttpError(404, 'Exercício não encontrado');
  return e;
});
route('POST', '/api/exercises', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const e = exerciseInput(ctx.body);
  const based = ctx.body.based_on && CATALOG_BY_CODE.has(String(ctx.body.based_on).replace(/^c-/, '')) ? String(ctx.body.based_on) : null;
  const res = await q.run('INSERT INTO exercises(name,region,objective,equipment,target,muscles,steps,media_url,based_on,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    e.name, e.region, e.objective, e.equipment, e.target, e.muscles, e.steps, e.media_url, based, ctx.user.id);
  const id = Number(res.lastInsertRowid);
  await audit(ctx, 'criou', 'exercicio', id, null, { nome: e.name });
  return { id, ref: `p-${id}` };
});
route('PUT', '/api/exercises/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = await q.get('SELECT * FROM exercises WHERE id=? AND active=1', idParam(ctx.params.id));
  if (!ex) throw new HttpError(404, 'Exercício não encontrado');
  const e = exerciseInput({ ...ownView(ex, true), ...ctx.body });
  await q.run('UPDATE exercises SET name=?,region=?,objective=?,equipment=?,target=?,muscles=?,steps=?,media_url=?,updated_at=now_local() WHERE id=?',
    e.name, e.region, e.objective, e.equipment, e.target, e.muscles, e.steps, e.media_url, ex.id);
  await audit(ctx, 'alterou', 'exercicio', ex.id, null, { nome: e.name });
  return { ok: true };
});
route('DELETE', '/api/exercises/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = await q.get('SELECT * FROM exercises WHERE id=? AND active=1', idParam(ctx.params.id));
  if (!ex) throw new HttpError(404, 'Exercício não encontrado');
  // exclusão lógica: programas já prescritos guardam uma cópia do exercício e não são afetados
  await q.run('UPDATE exercises SET active=0, updated_at=now_local() WHERE id=?', ex.id);
  await audit(ctx, 'excluiu', 'exercicio', ex.id, null, { nome: ex.name });
  return { ok: true };
});

// ---------- Programas de exercícios (prescrição para o paciente; conteúdo cifrado como o prontuário) ----------
const optNum = (v, label, max) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${label}: valor inválido`);
  return Math.round(n * 10) / 10;
};
async function programInput(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, 'Adicione pelo menos um exercício ao programa');
  if (items.length > 40) throw new HttpError(400, 'Use no máximo 40 exercícios por programa');
  const out = [];
  for (const it of items) {
    // guarda uma cópia do exercício como foi prescrito (edições posteriores na biblioteca não alteram o prontuário)
    const base = it.ref ? await findExercise(it.ref) : null;
    const steps = (Array.isArray(it.steps) ? it.steps : base?.steps || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
    steps.forEach((s) => { if (s.length > 500) throw new HttpError(400, 'Cada passo pode ter até 500 caracteres'); });
    const media = str(it.media_url ?? base?.media_url, 500);
    if (media && !MEDIA_RE.test(media)) throw new HttpError(400, 'O link de vídeo ou imagem precisa começar com https://');
    out.push({
      ref: base ? base.ref : null,
      name: reqStr(it.name ?? base?.name, 'Nome do exercício', 150),
      region: str(it.region ?? base?.region, 80), equipment: str(it.equipment ?? base?.equipment, 80),
      steps, media_url: media,
      sets: optNum(it.sets, 'Séries', 50), reps: str(it.reps, 30), hold_s: optNum(it.hold_s, 'Tempo de sustentação', 3600),
      load: str(it.load, 60), rest_s: optNum(it.rest_s, 'Descanso', 3600), side: str(it.side, 40), notes: str(it.notes, 500),
    });
  }
  return {
    title: reqStr(b.title, 'Título', 120), start_date: date(b.start_date, 'Data de início', true),
    status: oneOf(str(b.status, 20) || 'ativo', ['ativo', 'encerrado'], 'Situação'),
    data: { frequency: str(b.frequency, 120), duration: str(b.duration, 120), notes: str(b.notes, 2000), items: out },
  };
}
const programView = (r) => {
  const { data_enc, ...rest } = r;
  return { ...rest, ...decrypt(data_enc) };
};
route('GET', '/api/patients/:id/programs', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = await getPatient(ctx.user, ctx.params.id);
  const rows = await q.all(`SELECT x.*, u.name author_name, u.crefito author_crefito FROM exercise_programs x LEFT JOIN users u ON u.id=x.author_id
    WHERE x.patient_id=? ORDER BY (x.status='ativo') DESC, x.start_date DESC, x.id DESC`, p.id);
  return rows.map(programView);
});
route('GET', '/api/programs/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const r = await q.get('SELECT x.*, u.name author_name, u.crefito author_crefito FROM exercise_programs x LEFT JOIN users u ON u.id=x.author_id WHERE x.id=?', idParam(ctx.params.id));
  if (!r) throw new HttpError(404, 'Programa não encontrado');
  await getPatient(ctx.user, r.patient_id);
  return programView(r);
});
route('POST', '/api/programs', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = await getPatient(ctx.user, ctx.body.patient_id);
  const x = await programInput(ctx.body);
  const res = await q.run('INSERT INTO exercise_programs(patient_id,author_id,title,start_date,status,data_enc) VALUES (?,?,?,?,?,?)',
    p.id, ctx.user.id, x.title, x.start_date, x.status, encrypt(x.data));
  const id = Number(res.lastInsertRowid);
  await audit(ctx, 'criou', 'programa_exercicios', id, p.id, { exercicios: x.data.items.length });
  return { id };
});
route('PUT', '/api/programs/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = await q.get('SELECT * FROM exercise_programs WHERE id=?', idParam(ctx.params.id));
  if (!ex) throw new HttpError(404, 'Programa não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  const x = await programInput({ ...programView(ex), ...ctx.body });
  await q.run('UPDATE exercise_programs SET title=?, start_date=?, status=?, data_enc=?, updated_at=now_local() WHERE id=?',
    x.title, x.start_date, x.status, encrypt(x.data), ex.id);
  await audit(ctx, 'alterou', 'programa_exercicios', ex.id, ex.patient_id, { situacao: x.status });
  return { ok: true };
});
route('DELETE', '/api/programs/:id', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = await q.get('SELECT * FROM exercise_programs WHERE id=?', idParam(ctx.params.id));
  if (!ex) throw new HttpError(404, 'Programa não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  await q.run('DELETE FROM exercise_programs WHERE id=?', ex.id);
  await audit(ctx, 'excluiu', 'programa_exercicios', ex.id, ex.patient_id, { titulo: ex.title });
  return { ok: true };
});

const NOW_SQL = 'now_local()';
// ====================== Agendamento online ======================
// Página pública /agendar/<endereço> em que o paciente escolhe um horário livre.
// A clínica define dias, horários, profissionais e se confirma cada pedido ou se o horário é marcado na hora.
const BOOKING_DEFAULTS = {
  enabled: false, mode: 'confirmar', slot_minutes: 50, min_hours: 12, days_ahead: 30, professionals: [], intro: '',
  hours: { 1: '08:00-12:00, 13:00-18:00', 2: '08:00-12:00, 13:00-18:00', 3: '08:00-12:00, 13:00-18:00', 4: '08:00-12:00, 13:00-18:00', 5: '08:00-12:00, 13:00-18:00', 6: '', 0: '' },
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const lms = (s) => Date.parse(`${s.length === 16 ? s : `${s}T00:00`}:00Z`); // horário local como número (só para comparar)
function parseWindows(txt) {
  const out = [];
  for (const part of String(txt || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(part);
    if (!m || !TIME_RE.test(m[1]) || !TIME_RE.test(m[2]) || toMin(m[2]) <= toMin(m[1])) throw new HttpError(400, `Horário inválido: "${part}". Use o formato 08:00-12:00, 13:00-18:00`);
    out.push([toMin(m[1]), toMin(m[2])]);
  }
  return out;
}
async function bookingSettings() {
  const raw = (await q.get("SELECT value FROM settings WHERE key='booking'"))?.value;
  let v = {}; try { v = raw ? JSON.parse(raw) : {}; } catch { /* valor antigo inválido */ }
  return { ...BOOKING_DEFAULTS, ...v, hours: { ...BOOKING_DEFAULTS.hours, ...(v.hours || {}) } };
}
async function bookingProfessionals(cfg) {
  const all = await q.all("SELECT id, name, crefito FROM users WHERE active=1 AND role IN ('admin','fisio') ORDER BY name");
  return cfg.professionals?.length ? all.filter((u) => cfg.professionals.includes(u.id)) : all;
}
// horários livres de um profissional entre duas datas (YYYY-MM-DD), no fuso da clínica
async function freeSlots(cfg, profId, fromDate, toDate) {
  const n = nowParts();
  const earliest = lms(`${n.date}T${n.time.slice(0, 5)}`) + cfg.min_hours * 3600e3;
  const lastDay = new Date(`${n.date}T12:00`); lastDay.setDate(lastDay.getDate() + cfg.days_ahead);
  const limit = ymd(lastDay);
  const busy = (await q.all(`SELECT start, duration FROM appointments WHERE professional_id=? AND start >= ? AND start < ? AND status NOT IN ('cancelado','falta')
    UNION ALL SELECT start, duration FROM booking_requests WHERE professional_id=? AND status='pendente' AND start >= ? AND start < ?`,
  profId, `${fromDate}T00:00`, `${toDate}T23:59`, profId, `${fromDate}T00:00`, `${toDate}T23:59`)).map((b) => [lms(b.start), lms(b.start) + b.duration * 60e3]);
  const out = {};
  for (let d = new Date(`${fromDate}T12:00`); ymd(d) <= toDate && ymd(d) <= limit; d.setDate(d.getDate() + 1)) {
    const day = ymd(d); const slots = [];
    for (const [ws, we] of parseWindows(cfg.hours[d.getDay()])) {
      for (let m = ws; m + cfg.slot_minutes <= we; m += cfg.slot_minutes) {
        const s = lms(`${day}T${fromMin(m)}`); const e = s + cfg.slot_minutes * 60e3;
        if (s < earliest) continue;
        if (busy.some(([bs, be]) => bs < e && s < be)) continue;
        slots.push(fromMin(m));
      }
    }
    if (slots.length) out[day] = slots;
  }
  return out;
}
// endereço público -> clínica (só com o agendamento ligado e a clínica ativa)
async function bookingClinic(slug) {
  if (!/^[a-z0-9-]{3,60}$/.test(String(slug))) throw new HttpError(404, 'Página de agendamento não encontrada');
  const link = (await sql.unsafe('SELECT clinic_id FROM saas.booking_links WHERE slug=$1', [slug]))[0];
  const clinic = link ? await getClinic(link.clinic_id) : null;
  if (!clinic) throw new HttpError(404, 'Página de agendamento não encontrada');
  if (clinicAccess(clinic).mode !== 'full') throw new HttpError(404, 'O agendamento online desta clínica não está disponível no momento.');
  return clinic;
}
const bookingUrl = (slug) => `${APP_URL}/agendar/${slug}`;
const fmtDay = (s) => s.slice(0, 10).split('-').reverse().join('/');
async function bookingMail(key, to, clinic, vars, url = null) {
  if (!to) return;
  try { await notify.sendTemplate(key, { to, clinicId: clinic.id, url, vars: { clinica: clinic.name, ...vars } }); }
  catch (e) { console.error(`Agendamento online: e-mail "${key}" não enviado`, e.message); }
}

// ---------- Rotas públicas (sem login) ----------
route('GET', '/api/public/booking/:slug', async (ctx) => {
  const clinic = await bookingClinic(ctx.params.slug);
  return withClinic(clinic, async () => {
    const cfg = await bookingSettings();
    if (!cfg.enabled) throw new HttpError(404, 'O agendamento online desta clínica não está disponível no momento.');
    const s = await getSettings();
    return { clinic: s.clinic_name || clinic.name, address: s.address || null, phone: s.phone || null, intro: cfg.intro || null, slot_minutes: cfg.slot_minutes,
      mode: cfg.mode, professionals: (await bookingProfessionals(cfg)).map((u) => ({ id: u.id, name: u.name })), today: nowParts().date };
  });
}, { public: true });
route('GET', '/api/public/booking/:slug/slots', async (ctx) => {
  const clinic = await bookingClinic(ctx.params.slug);
  return withClinic(clinic, async () => {
    const cfg = await bookingSettings();
    if (!cfg.enabled) throw new HttpError(404, 'O agendamento online desta clínica não está disponível no momento.');
    const prof = (await bookingProfessionals(cfg)).find((u) => u.id === Number(ctx.query.get('professional_id')));
    if (!prof) throw new HttpError(400, 'Escolha um profissional');
    const n = nowParts().date; const end = new Date(`${n}T12:00`); end.setDate(end.getDate() + cfg.days_ahead);
    return { days: await freeSlots(cfg, prof.id, n, ymd(end)) };
  });
}, { public: true });
route('POST', '/api/public/booking/:slug', async (ctx) => {
  const b = ctx.body;
  if (b.website) return { ok: true, status: 'pendente' }; // campo invisível: robôs preenchem, pessoas não
  const ipKey = `booking|${ctx.ip}`;
  await checkRate(ipKey);
  const clinic = await bookingClinic(ctx.params.slug);
  const name = reqStr(b.name, 'Nome', 120);
  const phone = reqStr(b.phone, 'Telefone / WhatsApp', 30);
  if (String(phone).replace(/\D/g, '').length < 10) throw new HttpError(400, 'Informe o telefone com DDD');
  const email = str(b.email, 160)?.toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'E-mail inválido');
  if (!b.consent) throw new HttpError(400, 'Para agendar, é preciso concordar com o uso dos seus dados para o atendimento');
  const start = String(b.start || '');
  if (!DT_RE.test(start)) throw new HttpError(400, 'Escolha um horário');
  await failRate(ipKey, 5, 60); // no máximo 5 pedidos por hora por conexão
  const out = await withClinic(clinic, async () => {
    const cfg = await bookingSettings();
    if (!cfg.enabled) throw new HttpError(404, 'O agendamento online desta clínica não está disponível no momento.');
    const prof = (await bookingProfessionals(cfg)).find((u) => u.id === Number(b.professional_id));
    if (!prof) throw new HttpError(400, 'Escolha um profissional');
    // trava por profissional: dois pedidos ao mesmo tempo não pegam o mesmo horário
    await q.get('SELECT pg_advisory_xact_lock(hashtext(?))', `booking:${clinic.id}:${prof.id}`);
    const day = start.slice(0, 10);
    const free = (await freeSlots(cfg, prof.id, day, day))[day] || [];
    if (!free.includes(start.slice(11))) throw new HttpError(409, 'Este horário acabou de ser ocupado. Escolha outro, por favor.');
    const notes = str(b.notes, 500);
    const r = await q.run(`INSERT INTO booking_requests(professional_id, start, duration, name, phone, email, notes, consent_at, ip) VALUES (?,?,?,?,?,?,?,${NOW_SQL},?)`,
      prof.id, start, cfg.slot_minutes, name, phone, email, notes, ctx.ip);
    const reqId = Number(r.lastInsertRowid);
    ctx.user = null;
    if (cfg.mode === 'automatico') {
      const apptId = await acceptBooking(ctx, reqId, null, { auto: true });
      await audit(ctx, 'agendou_online', 'appointment', apptId, null, { horario: start });
      return { status: 'aceito', cfg, prof, reqId };
    }
    await audit(ctx, 'pedido_agendamento_online', 'booking_request', reqId, null, { horario: start });
    return { status: 'pendente', cfg, prof, reqId };
  });
  const vars = { nome: name, data: fmtDay(start), hora: start.slice(11), profissional: out.prof.name };
  if (out.status === 'pendente') {
    await bookingMail('agendamento_recebido', email, clinic, vars);
    // avisa os administradores da clínica e o profissional escolhido
    const staff = await withClinic(clinic, () => q.all("SELECT name, email FROM users WHERE active=1 AND (role='admin' OR id=?)", out.prof.id));
    for (const s of staff) await bookingMail('agendamento_novo_pedido', s.email, clinic, { ...vars, nome: s.name, paciente: name, telefone: phone }, `${APP_URL}/#/agenda`);
  }
  return { ok: true, status: out.status };
}, { public: true });

// aceita um pedido: vincula/cria o paciente e cria o atendimento
async function acceptBooking(ctx, reqId, patientId, { auto = false } = {}) {
  const r = await q.get('SELECT * FROM booking_requests WHERE id=?', reqId);
  if (!r) throw new HttpError(404, 'Pedido não encontrado');
  if (r.status !== 'pendente') throw new HttpError(400, 'Este pedido já foi respondido.');
  let pid = patientId ? (await getPatient(ctx.user, patientId)).id : null;
  if (!pid) {
    const digits = String(r.phone || '').replace(/\D/g, '');
    const byEmail = r.email ? await q.get('SELECT id FROM patients WHERE lower(email)=?', String(r.email).toLowerCase()) : null;
    const byPhone = !byEmail && digits.length >= 10 ? await q.get("SELECT id, email FROM patients WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = ?", digits) : null;
    // pelo telefone só quando o paciente não tem e-mail (senão, alguém com o telefone de outra pessoa poderia se vincular ao cadastro dela)
    const match = byEmail || (byPhone && !byPhone.email ? byPhone : null);
    pid = match?.id || Number((await q.run('INSERT INTO patients(name, phone, email, professional_id, notes) VALUES (?,?,?,?,?)',
      r.name, r.phone, r.email, r.professional_id, 'Cadastro criado pelo agendamento online')).lastInsertRowid);
  }
  if (!auto) {
    const conflict = await overlapCheck({ professional_id: r.professional_id, start: r.start, duration: r.duration, status: 'agendado' });
    if (conflict) throw new HttpError(409, conflict);
  }
  const a = await q.run("INSERT INTO appointments(patient_id, professional_id, start, duration, kind, status, notes) VALUES (?,?,?,?,'sessao','agendado',?)",
    pid, r.professional_id, r.start, r.duration, `Agendado online${r.notes ? ` — ${r.notes}` : ''}`);
  const apptId = Number(a.lastInsertRowid);
  await q.run(`UPDATE booking_requests SET status='aceito', patient_id=?, appointment_id=?, decided_by=?, decided_at=${NOW_SQL} WHERE id=?`, pid, apptId, ctx.user?.id ?? null, r.id);
  const prof = await q.get('SELECT name FROM users WHERE id=?', r.professional_id);
  const s = await getSettings();
  const clinic = als.getStore().clinic;
  await bookingMail('agendamento_confirmado', r.email, clinic, { nome: r.name, data: fmtDay(r.start), hora: r.start.slice(11), profissional: prof?.name || '',
    endereco: s.address || '', telefone_clinica: s.phone || '' });
  return apptId;
}

// ---------- Rotas da clínica ----------
route('GET', '/api/booking/settings', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const cfg = await bookingSettings();
  let link = (await q.get('SELECT slug FROM saas.booking_links WHERE clinic_id=?', ctx.clinic.id))?.slug;
  if (!link) {
    const base = String(ctx.clinic.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clinica';
    link = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    await q.run('INSERT INTO saas.booking_links(slug, clinic_id) VALUES (?,?) ON CONFLICT (clinic_id) DO NOTHING', link, ctx.clinic.id);
    link = (await q.get('SELECT slug FROM saas.booking_links WHERE clinic_id=?', ctx.clinic.id)).slug;
  }
  const all = await q.all("SELECT id, name FROM users WHERE active=1 AND role IN ('admin','fisio') ORDER BY name");
  return { ...cfg, slug: link, url: bookingUrl(link), all_professionals: all };
});
route('PUT', '/api/booking/settings', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const b = ctx.body; const cur = await bookingSettings();
  const int = (v, lo, hi, label) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${label}: use um número de ${lo} a ${hi}`); return n; };
  const hours = {};
  for (let d = 0; d <= 6; d++) { const t = String(b.hours?.[d] ?? cur.hours[d] ?? '').trim(); parseWindows(t); hours[d] = t; }
  const valid = (await q.all("SELECT id FROM users WHERE active=1 AND role IN ('admin','fisio')")).map((u) => u.id);
  const cfg = {
    enabled: !!b.enabled, mode: oneOf(b.mode, ['confirmar', 'automatico'], 'Modo', 'confirmar'),
    slot_minutes: int(b.slot_minutes ?? cur.slot_minutes, 10, 240, 'Duração do horário (min)'),
    min_hours: int(b.min_hours ?? cur.min_hours, 0, 720, 'Antecedência mínima (horas)'),
    days_ahead: int(b.days_ahead ?? cur.days_ahead, 1, 120, 'Dias à frente'),
    professionals: (Array.isArray(b.professionals) ? b.professionals.map(Number) : cur.professionals).filter((id) => valid.includes(id)),
    intro: str(b.intro, 600) || '', hours,
  };
  if (cfg.enabled && !Object.values(hours).some((t) => t)) throw new HttpError(400, 'Defina os horários de pelo menos um dia da semana');
  await setSetting('booking', JSON.stringify(cfg));
  if (b.slug !== undefined) {
    const slug = String(b.slug).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/.test(slug)) throw new HttpError(400, 'Endereço inválido: use de 3 a 60 letras minúsculas, números e hífen');
    const taken = await q.get('SELECT clinic_id FROM saas.booking_links WHERE slug=?', slug);
    if (taken && taken.clinic_id !== ctx.clinic.id) throw new HttpError(400, 'Este endereço já está em uso por outra clínica');
    await q.run('INSERT INTO saas.booking_links(slug, clinic_id) VALUES (?,?) ON CONFLICT (clinic_id) DO UPDATE SET slug=excluded.slug', slug, ctx.clinic.id);
  }
  await audit(ctx, 'alterou_agendamento_online', 'settings', null, null, { ligado: cfg.enabled, modo: cfg.mode });
  return { ok: true };
});
route('GET', '/api/booking/requests', async (ctx) => {
  const st = oneOf(ctx.query.get('status') || 'pendente', ['pendente', 'aceito', 'recusado', 'todos'], 'Situação', 'pendente');
  return q.all(`SELECT r.*, u.name professional_name FROM booking_requests r LEFT JOIN users u ON u.id=r.professional_id
    ${st === 'todos' ? '' : 'WHERE r.status=?'} ORDER BY r.start LIMIT 300`, ...(st === 'todos' ? [] : [st]));
});
route('POST', '/api/booking/requests/:id/accept', async (ctx) => {
  const id = idParam(ctx.params.id);
  const apptId = await tx(() => acceptBooking(ctx, id, ctx.body.patient_id ? Number(ctx.body.patient_id) : null));
  await audit(ctx, 'aceitou_agendamento_online', 'appointment', apptId);
  return { ok: true, appointment_id: apptId };
});
route('POST', '/api/booking/requests/:id/decline', async (ctx) => {
  const r = await q.get('SELECT * FROM booking_requests WHERE id=?', idParam(ctx.params.id));
  if (!r) throw new HttpError(404, 'Pedido não encontrado');
  if (r.status !== 'pendente') throw new HttpError(400, 'Este pedido já foi respondido.');
  const reason = str(ctx.body.reason, 300);
  await q.run(`UPDATE booking_requests SET status='recusado', decided_by=?, decided_at=${NOW_SQL} WHERE id=?`, ctx.user.id, r.id);
  await audit(ctx, 'recusou_agendamento_online', 'booking_request', r.id, null, { motivo: reason });
  const link = (await q.get('SELECT slug FROM saas.booking_links WHERE clinic_id=?', ctx.clinic.id))?.slug;
  await bookingMail('agendamento_recusado', r.email, ctx.clinic, { nome: r.name, data: fmtDay(r.start), hora: r.start.slice(11),
    motivo: reason || 'O horário não está mais disponível.' }, link ? bookingUrl(link) : APP_URL);
  return { ok: true };
});

// ====================== Assinatura digital (pelo celular do paciente) ======================
// A clínica gera um link de uso único (7 dias) para o termo LGPD ou para o plano de tratamento.
// Guardamos, cifrados: o documento exatamente como foi mostrado, a assinatura desenhada e as evidências
// (nome digitado, data e hora, IP, navegador e o código de verificação do documento).
const SIGN_TTL_DAYS = 7;
const PLANO_FIELDS = [['diagnostico_fisio', 'Diagnóstico fisioterapêutico'], ['objetivo_geral', 'Objetivo geral'], ['objetivos_especificos', 'Objetivos específicos'],
  ['condutas', 'Condutas terapêuticas'], ['tecnicas', 'Técnicas que serão utilizadas'], ['outras_tecnicas', 'Outras técnicas'], ['exercicios', 'Exercícios planejados'],
  ['frequencia', 'Frequência semanal'], ['duracao', 'Previsão de duração do tratamento'], ['criterios_reavaliacao', 'Critérios para reavaliação'], ['orientacoes', 'Orientações domiciliares']];
async function signDocument(p, docType, recordId) {
  const s = await getSettings();
  const controller = [s.clinic_name, s.professional_name, s.crefito ? `CREFITO ${s.crefito}` : ''].filter(Boolean).join(' — ');
  if (docType === 'consentimento') {
    return { title: `Termo de consentimento — LGPD (v${s.consent_version})`, version: s.consent_version, term_hash: sha(s.consent_text),
      sections: [{ h: 'Controlador dos dados', text: controller }, { h: 'Titular', text: `${p.name}${p.cpf ? ` — CPF ${p.cpf}` : ''}` }, { h: '', text: s.consent_text }] };
  }
  const r = await q.get("SELECT * FROM records WHERE id=? AND patient_id=? AND type='plano' AND deleted_at IS NULL", recordId, p.id);
  if (!r) throw new HttpError(404, 'Plano de tratamento não encontrado');
  const data = decrypt(r.data_enc) || {};
  const sections = [{ h: 'Paciente', text: `${p.name}${p.cpf ? ` — CPF ${p.cpf}` : ''}` }, { h: 'Profissional', text: controller }];
  for (const [k, label] of PLANO_FIELDS) {
    const v = Array.isArray(data[k]) ? data[k].join(', ') : String(data[k] ?? '').trim();
    if (v) sections.push({ h: label, text: v });
  }
  sections.push({ h: 'Declaração', text: 'Declaro que recebi as explicações sobre o plano de tratamento fisioterapêutico acima, compreendi os objetivos, as condutas e a frequência propostas, e concordo em realizá-lo. Sei que posso tirar dúvidas e interromper o tratamento a qualquer momento.' });
  return { title: `Plano de tratamento fisioterapêutico — ${fmtDay(r.record_date)}`, sections };
}
const canSign = (user, docType) => docType === 'consentimento' || CLINICAL.includes(user.role);

route('POST', '/api/patients/:id/signatures', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const docType = oneOf(ctx.body.doc_type, ['consentimento', 'plano'], 'Documento');
  if (!canSign(ctx.user, docType)) throw new HttpError(403, 'Acesso não permitido para o seu perfil');
  const recordId = docType === 'plano' ? idParam(ctx.body.record_id) : null;
  const doc = await signDocument(p, docType, recordId);
  const docJson = JSON.stringify(doc);
  const exp = new Date(`${today()}T12:00`); exp.setDate(exp.getDate() + SIGN_TTL_DAYS);
  // pedido anterior do mesmo documento que ainda não foi assinado deixa de valer
  await q.run("UPDATE signature_requests SET status='cancelado' WHERE patient_id=? AND doc_type=? AND coalesce(record_id,0)=? AND status='pendente'", p.id, docType, recordId || 0);
  const r = await q.run('INSERT INTO signature_requests(patient_id, doc_type, record_id, title, expires_at, created_by, doc_hash, doc_enc) VALUES (?,?,?,?,?,?,?,?)',
    p.id, docType, recordId, doc.title, ymd(exp), ctx.user.id, sha(docJson), encrypt(doc));
  const id = Number(r.lastInsertRowid);
  const token = crypto.randomBytes(32).toString('base64url');
  await q.run('INSERT INTO saas.signature_links(token_hash, clinic_id, request_id, expires_at) VALUES (?,?,?,?)', sha(token), ctx.clinic.id, id, Date.now() + SIGN_TTL_DAYS * 86400e3);
  await audit(ctx, 'pediu_assinatura', 'signature_request', id, p.id, { documento: docType });
  const url = `${APP_URL}/assinar/${token}`;
  let emailed = false;
  if (ctx.body.send_email && p.email) {
    try {
      await notify.sendTemplate('assinatura_solicitada', { to: p.email, clinicId: ctx.clinic.id, url,
        vars: { nome: p.name, clinica: (await getSettings()).clinic_name || ctx.clinic.name, documento: doc.title, validade: `${SIGN_TTL_DAYS} dias` } });
      emailed = true;
    } catch (e) { console.error('Assinatura: e-mail não enviado', e.message); }
  }
  return { id, url, emailed, title: doc.title };
});
route('GET', '/api/patients/:id/signatures', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const rows = await q.all('SELECT s.id, s.doc_type, s.record_id, s.title, s.status, s.expires_at, s.created_at, s.signed_at, s.signer_name, u.name created_by_name FROM signature_requests s LEFT JOIN users u ON u.id=s.created_by WHERE s.patient_id=? ORDER BY s.id DESC', p.id);
  return rows.filter((r) => canSign(ctx.user, r.doc_type)).map((r) => ({ ...r, expired: r.status === 'pendente' && r.expires_at < today() }));
});
route('GET', '/api/signatures/:id', async (ctx) => {
  const s = await q.get('SELECT s.*, u.name created_by_name FROM signature_requests s LEFT JOIN users u ON u.id=s.created_by WHERE s.id=?', idParam(ctx.params.id));
  if (!s) throw new HttpError(404, 'Não encontrado');
  const p = await getPatient(ctx.user, s.patient_id);
  if (!canSign(ctx.user, s.doc_type)) throw new HttpError(403, 'Acesso não permitido para o seu perfil');
  const { doc_enc, signature_enc, ...rest } = s;
  return { ...rest, patient_name: p.name, doc: decrypt(doc_enc), signature: signature_enc ? decrypt(signature_enc) : null };
});
route('POST', '/api/signatures/:id/cancel', async (ctx) => {
  const s = await q.get('SELECT * FROM signature_requests WHERE id=?', idParam(ctx.params.id));
  if (!s) throw new HttpError(404, 'Não encontrado');
  await getPatient(ctx.user, s.patient_id);
  if (s.status !== 'pendente') throw new HttpError(400, 'Só é possível cancelar um pedido ainda não assinado.');
  await q.run("UPDATE signature_requests SET status='cancelado' WHERE id=?", s.id);
  await audit(ctx, 'cancelou_pedido_assinatura', 'signature_request', s.id, s.patient_id);
  return { ok: true };
});

// ---------- Página pública de assinatura ----------
async function signLink(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, 'Link de assinatura inválido.');
  const l = (await sql.unsafe('SELECT * FROM saas.signature_links WHERE token_hash=$1', [sha(token)]))[0];
  if (!l) throw new HttpError(404, 'Link de assinatura inválido.');
  const clinic = await getClinic(l.clinic_id);
  if (!clinic || clinicAccess(clinic).mode === 'blocked') throw new HttpError(404, 'Link de assinatura indisponível.');
  return { link: l, clinic };
}
route('GET', '/api/public/sign/:token', async (ctx) => {
  const key = `sign|${ctx.ip}`; await checkRate(key);
  let ctxData;
  try { ctxData = await signLink(ctx.params.token); } catch (e) { await failRate(key, 20, 30); throw e; }
  const { link, clinic } = ctxData;
  return withClinic(clinic, async () => {
    const s = await q.get('SELECT * FROM signature_requests WHERE id=?', link.request_id);
    if (!s) throw new HttpError(404, 'Link de assinatura inválido.');
    const clinicName = (await getSettings()).clinic_name || clinic.name;
    if (s.status === 'assinado') return { status: 'assinado', title: s.title, signed_at: s.signed_at, clinic: clinicName };
    if (s.status === 'cancelado') return { status: 'cancelado', title: s.title, clinic: clinicName };
    if (s.expires_at < today() || Number(link.expires_at) < Date.now()) return { status: 'expirado', title: s.title, clinic: clinicName };
    const p = await q.get('SELECT name FROM patients WHERE id=?', s.patient_id);
    return { status: 'pendente', clinic: clinicName, patient_name: p?.name || '', doc: decrypt(s.doc_enc), code: s.doc_hash.slice(0, 16).toUpperCase() };
  });
}, { public: true });
route('POST', '/api/public/sign/:token', async (ctx) => {
  const key = `sign|${ctx.ip}`; await checkRate(key);
  const { link, clinic } = await signLink(ctx.params.token);
  const name = reqStr(ctx.body.name, 'Nome completo', 160);
  if (name.replace(/[^\p{L}]/gu, '').length < 3) throw new HttpError(400, 'Digite o seu nome completo');
  const cpf = ctx.body.cpf ? cpfField(ctx.body.cpf, 'CPF') : null;
  if (!ctx.body.agree) throw new HttpError(400, 'Marque "Li e concordo" para assinar');
  const sig = String(ctx.body.signature || '');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(sig);
  if (!m || m[1].length > 400000) throw new HttpError(400, 'Desenhe a sua assinatura no quadro');
  const png = Buffer.from(m[1], 'base64');
  if (png.length < 200 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new HttpError(400, 'Assinatura inválida. Desenhe de novo, por favor.');
  await failRate(key, 20, 30);
  const out = await withClinic(clinic, async () => {
    const s = await q.get('SELECT * FROM signature_requests WHERE id=?', link.request_id);
    if (!s || s.status !== 'pendente' || s.expires_at < today() || Number(link.expires_at) < Date.now()) throw new HttpError(400, 'Este link não está mais disponível para assinatura.');
    const doc = decrypt(s.doc_enc);
    if (sha(JSON.stringify(doc)) !== s.doc_hash) throw new HttpError(409, 'O documento foi alterado. Peça um novo link à clínica.');
    const when = nowLocal();
    const ua = String(ctx.req.headers['user-agent'] || '').slice(0, 300);
    const upd = await q.run(`UPDATE signature_requests SET status='assinado', signed_at=?, signer_name=?, signer_cpf=?, ip=?, user_agent=?, signature_enc=?
      WHERE id=? AND status='pendente'`, when, name, cpf, ctx.ip, ua, encrypt(sig), s.id);
    if (!upd.changes) throw new HttpError(400, 'Este documento já foi assinado.');
    let consentId = null;
    if (s.doc_type === 'consentimento') {
      consentId = Number((await q.run('INSERT INTO consents(patient_id, term_version, term_hash, method, signer_name, accepted_at, registered_by) VALUES (?,?,?,?,?,?,?)',
        s.patient_id, doc.version || '1.0', doc.term_hash || s.doc_hash, 'assinatura_digital', name, when.slice(0, 10), s.created_by)).lastInsertRowid);
      await q.run('UPDATE signature_requests SET consent_id=? WHERE id=?', consentId, s.id);
    }
    ctx.user = null;
    await audit(ctx, 'assinou_documento', 'signature_request', s.id, s.patient_id, { documento: s.doc_type, ip: ctx.ip });
    const staff = s.created_by ? await q.get('SELECT name, email FROM users WHERE id=? AND active=1', s.created_by) : null;
    const p = await q.get('SELECT name FROM patients WHERE id=?', s.patient_id);
    return { s, staff, patient: p?.name || name, when };
  });
  if (out.staff) {
    try {
      await notify.sendTemplate('assinatura_concluida', { to: out.staff.email, clinicId: clinic.id, url: `${APP_URL}/#/pacientes/${out.s.patient_id}/lgpd`,
        vars: { nome: out.staff.name, paciente: out.patient, documento: out.s.title, data: `${fmtDay(out.when)} às ${out.when.slice(11, 16)}` } });
    } catch (e) { console.error('Assinatura: aviso à clínica não enviado', e.message); }
  }
  return { ok: true, signed_at: out.when };
}, { public: true });

// ====================== Assinatura (Stripe) ======================
route('GET', '/api/billing', async (ctx) => clinicInfo(ctx.clinic), { always: true });
route('POST', '/api/billing/checkout', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  if (!stripe.enabled()) throw new HttpError(503, 'A cobrança ainda não foi configurada na plataforma.');
  const c = ctx.clinic;
  if (['active', 'trialing', 'past_due'].includes(c.subscription_status)) throw new HttpError(400, 'A clínica já tem uma assinatura. Use "Gerenciar assinatura".');
  let customer = c.stripe_customer_id;
  if (!customer) {
    const cus = await stripe.request('POST', '/v1/customers', { name: c.name, email: ctx.user.email, 'metadata[clinic_id]': String(c.id) }, `customer-clinic-${c.id}`);
    customer = cus.id;
    await q.run('UPDATE saas.clinics SET stripe_customer_id=? WHERE id=?', customer, c.id);
  }
  const session = await stripe.request('POST', '/v1/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: String(c.id), locale: 'pt-BR',
    'line_items[0][price]': stripe.priceId(), 'line_items[0][quantity]': '1',
    'subscription_data[metadata][clinic_id]': String(c.id), 'metadata[clinic_id]': String(c.id),
    allow_promotion_codes: 'true',
    success_url: `${APP_URL}/#/configuracoes/assinatura?status=ok`,
    cancel_url: `${APP_URL}/#/configuracoes/assinatura?status=cancelado`,
  });
  await audit(ctx, 'iniciou_assinatura', 'clinic', c.id);
  return { url: session.url };
}, { always: true });
route('POST', '/api/billing/portal', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  if (!stripe.enabled()) throw new HttpError(503, 'A cobrança ainda não foi configurada na plataforma.');
  if (!ctx.clinic.stripe_customer_id) throw new HttpError(400, 'A clínica ainda não tem assinatura.');
  const s = await stripe.request('POST', '/v1/billing_portal/sessions', { customer: ctx.clinic.stripe_customer_id, return_url: `${APP_URL}/#/configuracoes/assinatura` });
  return { url: s.url };
}, { always: true });

// Webhook do Stripe: mantém a situação da assinatura da clínica sincronizada
async function syncSubscription(sub) {
  const clinicId = Number(sub.metadata?.clinic_id) || null;
  const byCustomer = (await sql.unsafe('SELECT id FROM saas.clinics WHERE stripe_customer_id=$1', [sub.customer]))[0];
  const id = clinicId || byCustomer?.id;
  if (!id) { console.warn('Webhook Stripe: assinatura sem clínica correspondente', sub.id); return; }
  const before = await billingState(id);
  const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
  // não deixa um evento antigo do Stripe derrubar uma assinatura ativa no Mercado Pago
  await sql.unsafe(`UPDATE saas.clinics SET stripe_customer_id=COALESCE(stripe_customer_id,$2), stripe_subscription_id=$3, subscription_status=$4,
    current_period_end=$5, cancel_at_period_end=$6, billing_provider='stripe' WHERE id=$1
    AND (billing_provider IS DISTINCT FROM 'mercadopago' OR subscription_status IS NULL OR subscription_status NOT IN ('active','past_due') OR $4 IN ('active','trialing'))`,
  [id, sub.customer, sub.id, sub.status, periodEnd ? new Date(periodEnd * 1000).toISOString() : null, !!sub.cancel_at_period_end]);
  await lifecycle.onStatusChange(id, before, await billingState(id));
}
// situação da cobrança de uma clínica (para comparar antes e depois de um webhook)
async function billingState(id) {
  return (await currentSql().unsafe('SELECT subscription_status, cancel_at_period_end, current_period_end FROM saas.clinics WHERE id=$1', [id]))[0] || null;
}
route('POST', '/api/stripe/webhook', async (ctx) => {
  const event = stripe.verifyWebhook(ctx.rawBody, ctx.req.headers['stripe-signature']);
  await ensureCore();
  const fresh = await sql.unsafe('INSERT INTO saas.stripe_events(id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [event.id, event.type]);
  if (!fresh.length) return { received: true, duplicate: true };
  try {
    const o = event.data.object;
    if (event.type === 'checkout.session.completed' && o.mode === 'subscription' && o.subscription) {
      const clinicId = Number(o.client_reference_id || o.metadata?.clinic_id);
      if (clinicId) await sql.unsafe('UPDATE saas.clinics SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE id=$1', [clinicId, o.customer]);
      await syncSubscription(await stripe.request('GET', `/v1/subscriptions/${encodeURIComponent(o.subscription)}`));
    } else if (event.type.startsWith('customer.subscription.')) {
      await syncSubscription(o);
    }
  } catch (e) {
    await sql.unsafe('DELETE FROM saas.stripe_events WHERE id=$1', [event.id]); // permite que o Stripe reenvie
    throw e;
  }
  return { received: true };
}, { public: true, webhook: true, raw: true });

// ====================== Assinatura (Mercado Pago) ======================
route('POST', '/api/billing/mp/checkout', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  if (!mp.enabled()) throw new HttpError(503, 'O Mercado Pago ainda não foi configurado na plataforma.');
  const c = ctx.clinic;
  if (['active', 'trialing', 'past_due'].includes(c.subscription_status)) throw new HttpError(400, 'A clínica já tem uma assinatura ativa.');
  const email = String(ctx.body?.payer_email || ctx.user.email).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'Informe um e-mail válido');
  const pre = await mp.request('POST', '/preapproval', {
    reason: 'FisioGestão — assinatura mensal',
    external_reference: String(c.id),
    payer_email: email,
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: mp.price(), currency_id: 'BRL' },
    back_url: `${APP_URL}/#/configuracoes/assinatura?status=ok`,
    status: 'pending',
  });
  if (!pre.id || !pre.init_point) throw new HttpError(502, 'Resposta inesperada do Mercado Pago. Tente novamente.');
  await q.run('UPDATE saas.clinics SET mp_preapproval_id=? WHERE id=?', pre.id, c.id);
  await audit(ctx, 'iniciou_assinatura', 'clinic', c.id, null, { provedor: 'mercadopago' });
  return { url: pre.init_point };
}, { always: true });

// Atualiza a situação da clínica a partir de uma assinatura (preapproval) do Mercado Pago
async function syncPreapproval(p) {
  const clinicId = Number(p.external_reference) || (await currentSql().unsafe('SELECT id FROM saas.clinics WHERE mp_preapproval_id=$1', [p.id]))[0]?.id;
  if (!clinicId) { console.warn('Mercado Pago: assinatura sem clínica correspondente', p.id); return; }
  const status = mp.STATUS[p.status];
  if (!status) return; // pendente (ainda não pagou) ou situação desconhecida: nada muda
  const next = p.next_payment_date ? new Date(p.next_payment_date).toISOString() : null;
  const before = await billingState(clinicId);
  // ignora eventos de assinaturas antigas da mesma clínica e não derruba uma assinatura ativa no Stripe
  await currentSql().unsafe(`UPDATE saas.clinics SET billing_provider='mercadopago', mp_preapproval_id=$2, subscription_status=$3,
      current_period_end = CASE WHEN $3='canceled' THEN COALESCE(current_period_end, $4::timestamptz) ELSE COALESCE($4::timestamptz, current_period_end) END,
      cancel_at_period_end = ($3='canceled')
    WHERE id=$1 AND (mp_preapproval_id IS NULL OR mp_preapproval_id=$2 OR $3='active')
      AND (billing_provider IS DISTINCT FROM 'stripe' OR subscription_status IS NULL OR subscription_status NOT IN ('active','trialing','past_due') OR $3='active')`,
  [clinicId, p.id, status, next]);
  await lifecycle.onStatusChange(clinicId, before, await billingState(clinicId));
}
const getPreapproval = (id) => mp.request('GET', `/preapproval/${encodeURIComponent(id)}`);

// Consulta o Mercado Pago na volta do pagamento (não depende só do webhook)
route('POST', '/api/billing/mp/refresh', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const c = ctx.clinic;
  if (mp.enabled() && c.mp_preapproval_id) await syncPreapproval(await getPreapproval(c.mp_preapproval_id));
  return clinicInfo(await getClinic(c.id));
}, { always: true });

route('POST', '/api/billing/mp/cancel', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const c = ctx.clinic;
  if (c.billing_provider !== 'mercadopago' || !c.mp_preapproval_id || !['active', 'past_due', 'paused'].includes(c.subscription_status)) {
    throw new HttpError(400, 'A clínica não tem assinatura ativa no Mercado Pago.');
  }
  await mp.request('PUT', `/preapproval/${encodeURIComponent(c.mp_preapproval_id)}`, { status: 'cancelled' });
  await syncPreapproval(await getPreapproval(c.mp_preapproval_id));
  await audit(ctx, 'cancelou_assinatura', 'clinic', c.id, null, { provedor: 'mercadopago' });
  return clinicInfo(await getClinic(c.id));
}, { always: true });

// Notificações (webhook) do Mercado Pago
route('POST', '/api/mercadopago/webhook', async (ctx) => {
  let body = {};
  try { body = JSON.parse(ctx.rawBody?.toString('utf8') || '{}'); } catch { /* corpo vazio ou inválido */ }
  const type = body.type || ctx.query.get('type') || ctx.query.get('topic');
  const dataId = String(ctx.query.get('data.id') || body.data?.id || '');
  mp.verifyWebhook(ctx.req.headers, dataId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dataId)) throw new HttpError(400, 'Identificador inválido');
  if (type === 'subscription_preapproval') {
    await syncPreapproval(await getPreapproval(dataId));
  } else if (type === 'subscription_authorized_payment') {
    const ap = await mp.request('GET', `/authorized_payments/${encodeURIComponent(dataId)}`);
    if (ap.preapproval_id) {
      await syncPreapproval(await getPreapproval(ap.preapproval_id));
      // cobrança recusada: o Mercado Pago tenta de novo; a clínica vê o aviso de pagamento atrasado
      if (ap.payment?.status === 'rejected' || ap.status === 'recycling') {
        const hit = await sql.unsafe("UPDATE saas.clinics SET subscription_status='past_due' WHERE mp_preapproval_id=$1 AND subscription_status='active' RETURNING id", [ap.preapproval_id]);
        if (hit.length) await lifecycle.onStatusChange(hit[0].id, { subscription_status: 'active' }, await billingState(hit[0].id));
      }
    }
  }
  return { received: true };
}, { public: true, webhook: true, raw: true });

// ====================== Portal do paciente ======================
// Link pessoal (sem senha) que a clínica envia ao paciente: próximas consultas (com confirmação de presença),
// pagamentos pelo link do Mercado Pago, documentos para assinar, programa de exercícios e diário de dor.
const PORTAL_DAYS = 180;
const portalUrl = (token) => `${APP_URL}/paciente/${token}`;
async function portalAccess(ctx) {
  const token = ctx.params.token;
  if (token === 'eu') { // paciente que entrou com e-mail e senha
    const ses = await pacSession(ctx);
    if (!ses) throw new HttpError(401, 'Entre com seu e-mail e senha.');
    const clinic = await getClinic(ses.clinic_id);
    if (!clinic || clinicAccess(clinic).mode === 'blocked') throw new HttpError(404, 'Portal indisponível no momento. Fale com a clínica.');
    return { link: { clinic_id: ses.clinic_id, patient_id: ses.patient_id, token_hash: null, account: true }, clinic };
  }
  const key = `portal|${ctx.ip}`; await checkRate(key);
  const bad = async () => { await failRate(key, 30, 30); throw new HttpError(404, 'Link do portal inválido ou desativado. Peça um novo link à clínica.'); };
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return bad();
  const l = (await sql.unsafe('SELECT * FROM saas.portal_links WHERE token_hash=$1', [sha(token)]))[0];
  if (!l || l.revoked_at || Number(l.expires_at) < Date.now()) return bad();
  const clinic = await getClinic(l.clinic_id);
  if (!clinic || clinicAccess(clinic).mode === 'blocked') throw new HttpError(404, 'Portal indisponível no momento. Fale com a clínica.');
  return { link: l, clinic };
}
// executa dentro da clínica, garantindo que o paciente ainda existe
async function inPortal(ctx, fn) {
  const { link, clinic } = await portalAccess(ctx);
  return withClinic(clinic, async () => {
    const p = await q.get('SELECT id, name, email, phone FROM patients WHERE id=?', link.patient_id);
    if (!p) throw new HttpError(404, 'Link do portal inválido ou desativado. Peça um novo link à clínica.');
    ctx.user = null;
    return fn({ link, clinic, p });
  });
}
const KIND_PT = { avaliacao: 'Avaliação', sessao: 'Sessão', reavaliacao: 'Reavaliação', retorno: 'Retorno', domiciliar: 'Atendimento domiciliar', teleatendimento: 'Teleatendimento' };

// ---- lado da clínica ----
route('GET', '/api/patients/:id/portal', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const l = (await currentSql().unsafe('SELECT * FROM saas.portal_links WHERE clinic_id=$1 AND patient_id=$2 AND revoked_at IS NULL AND expires_at > $3 ORDER BY created_at DESC LIMIT 1', [ctx.clinic.id, p.id, Date.now()]))[0];
  return l ? { active: true, created_at: l.created_at, expires_at: Number(l.expires_at), last_used_at: l.last_used_at, created_by: l.created_by_name } : { active: false };
});
route('POST', '/api/patients/:id/portal', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const token = crypto.randomBytes(32).toString('base64url');
  // um link ativo por paciente: gerar um novo desativa o anterior
  await q.run('UPDATE saas.portal_links SET revoked_at=? WHERE clinic_id=? AND patient_id=? AND revoked_at IS NULL', Date.now(), ctx.clinic.id, p.id);
  await q.run('INSERT INTO saas.portal_links(token_hash, clinic_id, patient_id, expires_at, created_by_name) VALUES (?,?,?,?,?)', sha(token), ctx.clinic.id, p.id, Date.now() + PORTAL_DAYS * 86400e3, ctx.user.name);
  await audit(ctx, 'gerou_link_portal', 'patient', p.id, p.id, null);
  const url = portalUrl(token);
  let emailed = false;
  if (ctx.body.send_email && p.email) {
    try {
      await notify.sendTemplate('portal_link', { to: p.email, clinicId: ctx.clinic.id, url,
        vars: { nome: p.name.split(' ')[0], clinica: (await getSettings()).clinic_name || ctx.clinic.name, validade: `${PORTAL_DAYS} dias` } });
      emailed = true;
    } catch (e) { console.error('Portal: e-mail não enviado', e.message); }
  }
  return { url, emailed, expires_at: Date.now() + PORTAL_DAYS * 86400e3 };
});
route('POST', '/api/patients/:id/portal/revoke', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  await q.run('UPDATE saas.portal_links SET revoked_at=? WHERE clinic_id=? AND patient_id=? AND revoked_at IS NULL', Date.now(), ctx.clinic.id, p.id);
  await audit(ctx, 'desativou_link_portal', 'patient', p.id, p.id, null);
  return { ok: true };
});
const diaryView = (r) => ({ day: r.day, pain: r.pain, note: r.note_enc ? decrypt(r.note_enc) : '', updated_at: r.updated_at });
route('GET', '/api/patients/:id/diary', async (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = await getPatient(ctx.user, ctx.params.id);
  return (await q.all('SELECT * FROM pain_diary WHERE patient_id=? ORDER BY day DESC LIMIT 180', p.id)).map(diaryView);
});

// ---------- Contas do paciente (e-mail e senha) e link de cadastro da clínica ----------
// O paciente se cadastra pelo link da clínica (ou é cadastrado por ela) e recebe por e-mail o link para criar a senha.
// Depois entra no portal em /paciente com e-mail e senha. A senha só é criada por quem tem acesso ao e-mail.
const PAC_SESSION_DAYS = 30;
const PAC_TOKEN_HOURS = 48;
const pacCookie = (res, token, maxAge) => res.setHeader('Set-Cookie', `fisio_pac=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`);
const normEmail = (e) => String(e || '').trim().toLowerCase();
async function pacSession(ctx) {
  const token = parseCookies(ctx.req).fisio_pac;
  if (!token) return null;
  const s = (await sql.unsafe(`SELECT s.*, a.clinic_id, a.patient_id, a.id account_id FROM saas.patient_sessions s JOIN saas.patient_accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1`, [sha(token)]))[0];
  if (!s || Number(s.expires_at) < Date.now()) return null;
  await sql.unsafe('UPDATE saas.patient_sessions SET expires_at=$2 WHERE token_hash=$1', [s.token_hash, Date.now() + PAC_SESSION_DAYS * 86400e3]);
  pacCookie(ctx.res, token, PAC_SESSION_DAYS * 86400);
  return s;
}
async function pacLogin(ctx, accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await currentSql().unsafe('INSERT INTO saas.patient_sessions(token_hash, account_id, expires_at, ip) VALUES ($1,$2,$3,$4)', [sha(token), accountId, Date.now() + PAC_SESSION_DAYS * 86400e3, ctx.ip]);
  await currentSql().unsafe('UPDATE saas.patient_accounts SET last_login=now() WHERE id=$1', [accountId]);
  pacCookie(ctx.res, token, PAC_SESSION_DAYS * 86400);
}
// cria/atualiza a conta do paciente e envia o link para criar a senha — chamada dentro da clínica
async function invitePatient(clinic, p, { reset = false } = {}) {
  const email = normEmail(p.email);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'O paciente precisa ter um e-mail válido no cadastro.');
  const other = (await currentSql().unsafe('SELECT patient_id FROM saas.patient_accounts WHERE clinic_id=$1 AND lower(email)=$2 AND patient_id<>$3', [clinic.id, email, p.id]))[0];
  if (other) throw new HttpError(400, 'Este e-mail já é usado no portal por outro paciente desta clínica.');
  const acc = (await currentSql().unsafe(`INSERT INTO saas.patient_accounts(clinic_id, patient_id, email) VALUES ($1,$2,$3)
    ON CONFLICT (clinic_id, patient_id) DO UPDATE SET email=excluded.email RETURNING id, password_hash`, [clinic.id, p.id, email]))[0];
  const token = crypto.randomBytes(32).toString('base64url');
  await currentSql().unsafe('INSERT INTO saas.patient_password_tokens(token_hash, account_id, expires_at) VALUES ($1,$2,$3)', [sha(token), acc.id, Date.now() + PAC_TOKEN_HOURS * 3600e3]);
  const s = await getSettings();
  await notify.sendTemplate('portal_criar_senha', { to: email, clinicId: clinic.id, url: `${APP_URL}/paciente/senha/${token}`,
    vars: { nome: p.name.split(' ')[0], clinica: s.clinic_name || clinic.name, validade: `${PAC_TOKEN_HOURS} horas`, acao: acc.password_hash || reset ? 'trocar a sua senha' : 'criar a sua senha' } });
  return acc.id;
}

// --- clínica: configurações do portal (link de cadastro e convite automático) ---
async function signupCode(clinicId) { return (await currentSql().unsafe('SELECT * FROM saas.portal_signup WHERE clinic_id=$1', [clinicId]))[0] || null; }
route('GET', '/api/portal-config', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const c = await signupCode(ctx.clinic.id); const s = await getSettings();
  return { signup_enabled: !!c?.enabled, signup_url: c?.enabled ? `${APP_URL}/paciente/cadastro/${c.code}` : null, auto_invite: s.portal_auto_invite === '1', login_url: `${APP_URL}/paciente` };
});
route('PUT', '/api/portal-config', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const b = ctx.body;
  if (b.auto_invite !== undefined) await setSetting('portal_auto_invite', b.auto_invite ? '1' : '0');
  if (b.signup_enabled !== undefined || b.new_code) {
    const cur = await signupCode(ctx.clinic.id);
    const code = !cur || b.new_code ? crypto.randomBytes(9).toString('base64url') : cur.code;
    await currentSql().unsafe(`INSERT INTO saas.portal_signup(code, clinic_id, enabled) VALUES ($1,$2,$3)
      ON CONFLICT (clinic_id) DO UPDATE SET code=excluded.code, enabled=excluded.enabled`, [code, ctx.clinic.id, b.signup_enabled ?? cur?.enabled ?? true]);
  }
  await audit(ctx, 'alterou_portal', 'clinic', ctx.clinic.id, null, { cadastro: b.signup_enabled, novo_link: !!b.new_code, convite_automatico: b.auto_invite });
  return { ok: true };
});
route('GET', '/api/patients/:id/account', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  const a = (await currentSql().unsafe('SELECT email, password_hash IS NOT NULL has_password, created_at, last_login FROM saas.patient_accounts WHERE clinic_id=$1 AND patient_id=$2', [ctx.clinic.id, p.id]))[0];
  return a ? { exists: true, email: a.email, has_password: a.has_password, last_login: a.last_login } : { exists: false };
});
route('POST', '/api/patients/:id/invite', async (ctx) => {
  const p = await getPatient(ctx.user, ctx.params.id);
  try { await invitePatient(ctx.clinic, p); } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('Convite do portal não enviado', e.message);
    throw new HttpError(502, 'Não foi possível enviar o e-mail agora. Verifique o e-mail do paciente ou tente mais tarde.');
  }
  await audit(ctx, 'convidou_portal', 'patient', p.id, p.id, { email: normEmail(p.email) });
  return { ok: true, email: normEmail(p.email) };
});

// --- público: cadastro pelo link da clínica ---
async function signupByCode(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,20}$/.test(code)) throw new HttpError(404, 'Link de cadastro inválido.');
  const c = (await sql.unsafe('SELECT * FROM saas.portal_signup WHERE code=$1 AND enabled', [code]))[0];
  if (!c) throw new HttpError(404, 'Este link de cadastro não está mais ativo. Peça um novo link à clínica.');
  const clinic = await getClinic(c.clinic_id);
  if (!clinic || clinicAccess(clinic).mode !== 'full') throw new HttpError(404, 'Cadastro indisponível no momento. Fale com a clínica.');
  return clinic;
}
route('GET', '/api/public/portal-signup/:code', async (ctx) => {
  const clinic = await signupByCode(ctx.params.code);
  return withClinic(clinic, async () => {
    const s = await getSettings();
    return { clinic: s.clinic_name || clinic.name, consent_text: s.consent_text, consent_version: s.consent_version };
  });
}, { public: true });
route('POST', '/api/public/portal-signup/:code', async (ctx) => {
  const key = `pacsignup|${ctx.ip}`; await checkRate(key);
  const clinic = await signupByCode(ctx.params.code);
  const b = ctx.body;
  if (b.website) return { ok: true }; // campo invisível preenchido: robô
  const name = reqStr(b.name, 'Nome completo', 160);
  if (name.split(/\s+/).filter(Boolean).length < 2) throw new HttpError(400, 'Digite o nome completo');
  const email = normEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 160) throw new HttpError(400, 'Informe um e-mail válido');
  const phone = reqStr(b.phone, 'Telefone / WhatsApp', 40);
  if (phone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Informe o telefone com DDD');
  const birth = date(b.birth_date, 'Data de nascimento');
  const cpf = b.cpf ? cpfField(b.cpf, 'CPF') : null;
  if (!b.consent) throw new HttpError(400, 'Para se cadastrar, é preciso aceitar o termo de consentimento');
  await failRate(key, 6, 60); // no máximo ~5 cadastros por hora por endereço
  await withClinic(clinic, async () => {
    ctx.user = null;
    const s = await getSettings();
    // já é paciente com este e-mail: não altera o cadastro, só manda o link (quem não tem o e-mail não consegue usar)
    let p = await q.get('SELECT id, name, email FROM patients WHERE lower(email)=? ORDER BY id LIMIT 1', email);
    if (!p) {
      const r = await q.run(`INSERT INTO patients(name, birth_date, cpf, phone, email, status, notes) VALUES (?,?,?,?,?,'avaliacao',?)`,
        name, birth, cpf, phone, email, 'Cadastro feito pelo próprio paciente pelo link de cadastro da clínica.');
      p = { id: Number(r.lastInsertRowid), name, email };
      await audit(ctx, 'paciente_se_cadastrou', 'patient', p.id, p.id, { pelo: 'link de cadastro' });
      const staff = await q.all("SELECT name, email FROM users WHERE role='admin' AND active=1");
      for (const u of staff) {
        await notify.sendTemplate('portal_novo_cadastro', { to: u.email, clinicId: clinic.id, url: `${APP_URL}/#/pacientes/${p.id}`, ref: `pacsignup-${clinic.id}-${p.id}-${u.email}`,
          vars: { nome: u.name, paciente: name, telefone: phone } }).catch(() => {});
      }
    }
    if (!(await q.get('SELECT 1 FROM consents WHERE patient_id=? AND revoked_at IS NULL', p.id))) {
      await q.run('INSERT INTO consents(patient_id, term_version, term_hash, method, signer_name, accepted_at, registered_by) VALUES (?,?,?,?,?,?,?)',
        p.id, s.consent_version, sha(s.consent_text), 'aceite_online', name, today(), null);
    }
    try { await invitePatient(clinic, p); } catch (e) { console.warn('Cadastro do paciente: convite não enviado', e.message); }
  });
  return { ok: true, email };
}, { public: true });

// --- público: criar senha, entrar, sair, esqueci a senha ---
async function pacToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, 'Link inválido.');
  const t = (await sql.unsafe(`SELECT t.*, a.clinic_id, a.patient_id, a.email FROM saas.patient_password_tokens t JOIN saas.patient_accounts a ON a.id=t.account_id
    WHERE t.token_hash=$1`, [sha(token)]))[0];
  if (!t || t.used_at || Number(t.expires_at) < Date.now()) throw new HttpError(404, 'Este link expirou ou já foi usado. Peça um novo na tela de entrada ("Esqueci minha senha").');
  return t;
}
route('GET', '/api/public/portal-password/:token', async (ctx) => {
  const key = `pacpw|${ctx.ip}`; await checkRate(key);
  let t; try { t = await pacToken(ctx.params.token); } catch (e) { await failRate(key, 20, 30); throw e; }
  const clinic = await getClinic(t.clinic_id);
  return withClinic(clinic, async () => {
    const p = await q.get('SELECT name FROM patients WHERE id=?', t.patient_id);
    return { clinic: (await getSettings()).clinic_name || clinic.name, first_name: (p?.name || '').split(' ')[0], email: t.email };
  });
}, { public: true });
route('POST', '/api/public/portal-password/:token', async (ctx) => {
  const key = `pacpw|${ctx.ip}`; await checkRate(key);
  const t = await pacToken(ctx.params.token);
  validatePassword(ctx.body.password);
  await sql.unsafe('UPDATE saas.patient_password_tokens SET used_at=$2 WHERE token_hash=$1', [t.token_hash, Date.now()]);
  await sql.unsafe('UPDATE saas.patient_accounts SET password_hash=$2 WHERE id=$1', [t.account_id, hashPassword(ctx.body.password)]);
  await sql.unsafe('DELETE FROM saas.patient_sessions WHERE account_id=$1', [t.account_id]); // troca de senha encerra outros acessos
  await pacLogin(ctx, t.account_id);
  return { ok: true };
}, { public: true });
route('POST', '/api/public/portal-login', async (ctx) => {
  const email = normEmail(ctx.body.email); const pw = String(ctx.body.password || '');
  const key = `paclogin|${ctx.ip}|${email}`; const ipKey = `loginip|${ctx.ip}`; await checkRate(ipKey); await checkRate(key);
  const rows = EMAIL_RE.test(email) ? await sql.unsafe(`SELECT a.id, a.clinic_id, a.password_hash, c.name clinic FROM saas.patient_accounts a JOIN saas.clinics c ON c.id=a.clinic_id
    WHERE lower(a.email)=$1 AND a.password_hash IS NOT NULL`, [email]) : [];
  const ok = rows.filter((r) => checkPassword(pw, r.password_hash));
  if (!rows.length) checkPassword(pw, DUMMY_HASH);
  const usable = [];
  for (const r of ok) { const c = await getClinic(r.clinic_id); if (c && clinicAccess(c).mode !== 'blocked') usable.push(r); }
  if (!usable.length) { await failRate(key, 8, 15); await failRate(ipKey, 30, 15); throw new HttpError(401, 'E-mail ou senha incorretos.'); }
  await clearRate(key);
  const pick = usable.length === 1 ? usable[0] : usable.find((r) => r.id === Number(ctx.body.account_id));
  if (!pick) return { choose: usable.map((r) => ({ id: r.id, clinic: r.clinic })) }; // mesmo e-mail em mais de uma clínica
  await pacLogin(ctx, pick.id);
  return { ok: true };
}, { public: true });
route('POST', '/api/public/portal-logout', async (ctx) => {
  const token = parseCookies(ctx.req).fisio_pac;
  if (token) await sql.unsafe('DELETE FROM saas.patient_sessions WHERE token_hash=$1', [sha(token)]);
  pacCookie(ctx.res, '', 0);
  return { ok: true };
}, { public: true });
route('POST', '/api/public/portal-forgot', async (ctx) => {
  const key = `pacforgot|${ctx.ip}`; await checkRate(key);
  const email = normEmail(ctx.body.email);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Informe um e-mail válido');
  await failRate(key, 6, 30);
  const rows = await sql.unsafe('SELECT clinic_id, patient_id FROM saas.patient_accounts WHERE lower(email)=$1', [email]);
  for (const r of rows) {
    const clinic = await getClinic(r.clinic_id);
    if (!clinic || clinicAccess(clinic).mode === 'blocked') continue;
    await withClinic(clinic, async () => {
      const p = await q.get('SELECT id, name, email FROM patients WHERE id=?', r.patient_id);
      if (p && normEmail(p.email) === email) await invitePatient(clinic, p, { reset: true }).catch((e) => console.warn('Portal: link de senha não enviado', e.message));
    });
  }
  return { ok: true, message: 'Se houver um cadastro com este e-mail, enviamos um link para criar uma nova senha. O link vale por 48 horas.' };
}, { public: true });

// ---- lado do paciente (público, pelo link) ----
route('GET', '/api/portal/:token', async (ctx) => inPortal(ctx, async ({ link, clinic, p }) => {
  if (link.token_hash) await currentSql().unsafe('UPDATE saas.portal_links SET last_used_at=now() WHERE token_hash=$1', [link.token_hash]);
  const s = await getSettings();
  const now = nowLocal();
  const appts = await q.all(`SELECT a.id, a.start, a.duration, a.kind, a.status, u.name professional FROM appointments a LEFT JOIN users u ON u.id=a.professional_id
    WHERE a.patient_id=? AND a.start >= ? AND a.status IN ('agendado','confirmado') ORDER BY a.start LIMIT 10`, p.id, now.slice(0, 10));
  const canPay = !!(await recvAccount(clinic.id));
  const pending = canPay ? await q.all("SELECT id, description, amount, due_date FROM charges WHERE patient_id=? AND status='pendente' AND amount > 0 ORDER BY due_date, id", p.id) : [];
  const paid = await q.all("SELECT description, amount, paid_at, method, receipt_number FROM charges WHERE patient_id=? AND status='pago' ORDER BY paid_at DESC, id DESC LIMIT 10", p.id);
  const sigs = await q.all("SELECT id, title, expires_at FROM signature_requests WHERE patient_id=? AND status='pendente' AND expires_at >= ? ORDER BY id DESC", p.id, today());
  const programs = (await q.all("SELECT * FROM exercise_programs WHERE patient_id=? AND status='ativo' ORDER BY start_date DESC, id DESC", p.id)).map(programView)
    .map((x) => ({ id: x.id, title: x.title, start_date: x.start_date, frequency: x.frequency, duration: x.duration, notes: x.notes,
      items: x.items.map((it) => ({ name: it.name, steps: it.steps, media_url: it.media_url, sets: it.sets, reps: it.reps, hold_s: it.hold_s, rest_s: it.rest_s, load: it.load, side: it.side, notes: it.notes })) }));
  const diary = (await q.all('SELECT * FROM pain_diary WHERE patient_id=? ORDER BY day DESC LIMIT 60', p.id)).map(diaryView);
  return {
    clinic: { name: s.clinic_name || clinic.name, phone: s.phone || '', email: s.email || '', address: s.address || '' },
    patient: { first_name: p.name.split(' ')[0] }, today: today(), logged_in: !!link.account,
    appointments: appts.map((a) => ({ ...a, kind: KIND_PT[a.kind] || a.kind, can_confirm: a.status === 'agendado' && a.start > now })),
    pending, paid, signatures: sigs, programs, diary, can_pay: canPay,
  };
}), { public: true });
route('POST', '/api/portal/:token/appointments/:id/confirm', async (ctx) => inPortal(ctx, async ({ p }) => {
  const a = await q.get('SELECT * FROM appointments WHERE id=? AND patient_id=?', idParam(ctx.params.id), p.id);
  if (!a) throw new HttpError(404, 'Consulta não encontrada');
  if (a.status === 'confirmado') return { ok: true };
  if (a.status !== 'agendado' || a.start <= nowLocal()) throw new HttpError(400, 'Esta consulta não pode mais ser confirmada.');
  await q.run("UPDATE appointments SET status='confirmado' WHERE id=?", a.id);
  await audit(ctx, 'paciente_confirmou_presenca', 'appointment', a.id, p.id, { pelo: 'portal do paciente' });
  return { ok: true };
}), { public: true });
route('POST', '/api/portal/:token/diary', async (ctx) => inPortal(ctx, async ({ p }) => {
  const pain = Number(ctx.body.pain);
  if (!Number.isInteger(pain) || pain < 0 || pain > 10) throw new HttpError(400, 'Escolha um número de 0 a 10');
  const note = str(ctx.body.note, 500);
  const day = today();
  await q.run(`INSERT INTO pain_diary(patient_id, day, pain, note_enc) VALUES (?,?,?,?)
    ON CONFLICT (patient_id, day) DO UPDATE SET pain=excluded.pain, note_enc=excluded.note_enc, updated_at=now_local()`, p.id, day, pain, note ? encrypt(note) : null);
  return { ok: true, day };
}), { public: true });
// novo link de assinatura para um documento pendente (os links antigos ficam só com a clínica)
route('POST', '/api/portal/:token/sign/:id', async (ctx) => inPortal(ctx, async ({ clinic, p }) => {
  const s = await q.get("SELECT * FROM signature_requests WHERE id=? AND patient_id=? AND status='pendente'", idParam(ctx.params.id), p.id);
  if (!s || s.expires_at < today()) throw new HttpError(404, 'Este documento não está mais disponível para assinatura.');
  const token = crypto.randomBytes(32).toString('base64url');
  await q.run('INSERT INTO saas.signature_links(token_hash, clinic_id, request_id, expires_at) VALUES (?,?,?,?)', sha(token), clinic.id, s.id, new Date(`${s.expires_at}T23:59:00`).getTime());
  return { url: `${APP_URL}/assinar/${token}` };
}), { public: true });
// Pix dentro do portal (sem abrir a página do Mercado Pago): QR Code e "copia e cola" gerados com o token da clínica.
// O mesmo Pix é reaproveitado enquanto vale; a baixa chega pelo webhook ou pela consulta da tela (a cada poucos segundos).
const PIX_MINUTES = 30;
route('POST', '/api/portal/:token/pix/:id', async (ctx) => inPortal(ctx, async ({ clinic, p }) => {
  const c = await q.get("SELECT * FROM charges WHERE id=? AND patient_id=? AND status='pendente'", idParam(ctx.params.id), p.id);
  if (!c) throw new HttpError(404, 'Esta cobrança não está mais em aberto.');
  if (!(c.amount > 0)) throw new HttpError(400, 'Cobrança sem valor.');
  const view = (x) => ({ charge_id: x.id, amount: x.pix_amount, code: x.pix_code, qr: x.pix_qr, expires_at: x.pix_expires_at, description: x.description });
  if (c.pix_payment_id && c.pix_amount === c.amount && c.pix_expires_at && new Date(c.pix_expires_at).getTime() > Date.now() + 2 * 60e3) return view(c);
  let token;
  try { token = await recvToken(clinic.id); } catch { throw new HttpError(400, 'A clínica ainda não recebe pagamentos pelo portal. Fale com a clínica.'); }
  const fee = Math.round(c.amount * recvFeePct()) / 100;
  const exp = new Date(Date.now() + PIX_MINUTES * 60e3);
  const email = p.email && EMAIL_RE.test(p.email) ? p.email.trim().toLowerCase() : `paciente-${clinic.id}-${p.id}@${new URL(APP_URL).hostname}`;
  const [first, ...rest] = p.name.trim().split(/\s+/);
  const body = {
    transaction_amount: c.amount, description: c.description.slice(0, 120), payment_method_id: 'pix',
    payer: { email, first_name: first, last_name: rest.join(' ') || first },
    external_reference: recvRef(clinic.id, c.id),
    notification_url: `${APP_URL}/api/mp/recebimentos/webhook/${clinic.id}`,
    date_of_expiration: exp.toISOString().replace('Z', '+00:00'),
  };
  if (fee > 0) body.application_fee = fee;
  let pay;
  try { pay = await mp.sellerRequest(token, 'POST', '/v1/payments', body); } catch { throw new HttpError(502, 'Não foi possível gerar o Pix agora. Tente de novo em instantes.'); }
  const td = pay.point_of_interaction?.transaction_data || {};
  if (!pay.id || !td.qr_code) throw new HttpError(502, 'O Mercado Pago não devolveu o código Pix. Tente de novo.');
  const qr = td.qr_code_base64 && /^[A-Za-z0-9+/=]+$/.test(td.qr_code_base64) ? `data:image/png;base64,${td.qr_code_base64}` : null;
  await q.run('UPDATE charges SET pix_payment_id=?, pix_code=?, pix_qr=?, pix_expires_at=?, pix_amount=?, platform_fee=? WHERE id=?', String(pay.id), td.qr_code, qr, exp.toISOString(), c.amount, fee, c.id);
  await audit(ctx, 'paciente_gerou_pix', 'charge', c.id, p.id, { valor: c.amount, pagamento_mp: pay.id });
  return view(await q.get('SELECT * FROM charges WHERE id=?', c.id));
}), { public: true });
route('GET', '/api/portal/:token/pix/:id', async (ctx) => inPortal(ctx, async ({ clinic, p }) => {
  const c = await q.get('SELECT * FROM charges WHERE id=? AND patient_id=?', idParam(ctx.params.id), p.id);
  if (!c) throw new HttpError(404, 'Cobrança não encontrada.');
  if (c.status === 'pago') return { status: 'pago', receipt_number: c.receipt_number };
  if (c.status !== 'pendente' || !c.pix_payment_id) return { status: c.status };
  try {
    const pay = await mp.sellerRequest(await recvToken(clinic.id), 'GET', `/v1/payments/${encodeURIComponent(c.pix_payment_id)}`);
    if (pay.status === 'approved') {
      const done = await registerMpPayment(clinic, pay);
      if (done?.status === 'pago') return { status: 'pago', receipt_number: done.receipt_number };
    }
    return { status: 'pendente', mp_status: pay.status };
  } catch { return { status: 'pendente' }; }
}), { public: true });
// link de pagamento atualizado (gera de novo se o anterior venceu)
route('POST', '/api/portal/:token/pay/:id', async (ctx) => inPortal(ctx, async ({ clinic, p }) => {
  const c = await q.get("SELECT id FROM charges WHERE id=? AND patient_id=? AND status='pendente'", idParam(ctx.params.id), p.id);
  if (!c) throw new HttpError(404, 'Esta cobrança não está mais em aberto.');
  try { return { url: (await payLinkFor({ ...ctx, clinic, user: null }, c.id)).url }; } catch { throw new HttpError(400, 'Não foi possível abrir o pagamento agora. Fale com a clínica.'); }
}), { public: true });

// ====================== Recebimentos pelo app (Mercado Pago da clínica) ======================
// A clínica conecta a própria conta do Mercado Pago (OAuth). Os links de pagamento são criados com o token
// dela: o dinheiro cai direto na conta da clínica e a taxa da plataforma (opcional) vai para a conta da
// plataforma (marketplace_fee). A confirmação chega pelo webhook, sempre conferida na API do Mercado Pago.
const PAY_LINK_DAYS = 7;
const recvFeePct = () => { const v = Number(String(config.get('MP_PLATFORM_FEE') || '0').replace(',', '.')); return Number.isFinite(v) && v > 0 && v < 100 ? v : 0; };
const recvAvailable = () => !!(config.get('MP_CLIENT_ID') && config.get('MP_CLIENT_SECRET'));
const recvRedirect = () => `${APP_URL}/api/mp/oauth/callback`;
const recvRef = (clinicId, chargeId) => `fg-${clinicId}-${chargeId}`;
async function recvAccount(clinicId) {
  return (await currentSql().unsafe('SELECT * FROM saas.clinic_mp_accounts WHERE clinic_id=$1', [clinicId]))[0] || null;
}
// token da clínica, renovado quando faltar pouco para vencer (o do Mercado Pago vale 180 dias)
async function recvToken(clinicId) {
  const a = await recvAccount(clinicId);
  if (!a) throw new HttpError(400, 'Conecte a conta do Mercado Pago da clínica em Configurações → Recebimentos.');
  if (a.expires_at && new Date(a.expires_at).getTime() < Date.now() + 15 * 86400e3 && a.refresh_enc && recvAvailable()) {
    try {
      const t = await mp.oauthToken({ client_id: config.get('MP_CLIENT_ID'), client_secret: config.get('MP_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: openPlatform(a.refresh_enc) });
      await currentSql().unsafe('UPDATE saas.clinic_mp_accounts SET access_enc=$2, refresh_enc=$3, expires_at=$4 WHERE clinic_id=$1',
        [clinicId, sealPlatform(t.access_token), t.refresh_token ? sealPlatform(t.refresh_token) : a.refresh_enc, new Date(Date.now() + (Number(t.expires_in) || 15552000) * 1000).toISOString()]);
      return t.access_token;
    } catch (e) { console.error('Mercado Pago: renovação do token falhou', clinicId, e.message); }
  }
  return openPlatform(a.access_enc);
}

route('GET', '/api/recebimentos/mp', async (ctx) => {
  const a = await recvAccount(ctx.clinic.id);
  const out = { available: recvAvailable(), connected: !!a, fee_pct: recvFeePct() };
  if (a && ctx.user.role === 'admin') out.account = { nickname: a.nickname, email: a.email, connected_at: a.connected_at, connected_by: a.connected_by, live_mode: a.live_mode };
  return out;
});
route('POST', '/api/recebimentos/mp/connect', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  if (!recvAvailable()) throw new HttpError(503, 'Os recebimentos pelo Mercado Pago ainda não foram configurados na plataforma.');
  const state = crypto.randomBytes(32).toString('base64url');
  await q.run('DELETE FROM saas.mp_oauth_states WHERE expires_at < ?', Date.now());
  await q.run('INSERT INTO saas.mp_oauth_states(state_hash, clinic_id, user_id, expires_at) VALUES (?,?,?,?)', sha(state), ctx.clinic.id, ctx.user.id, Date.now() + 15 * 60e3);
  const u = new URL(`${mp.AUTH}/authorization`);
  u.search = new URLSearchParams({ client_id: config.get('MP_CLIENT_ID'), response_type: 'code', platform_id: 'mp', state, redirect_uri: recvRedirect() }).toString();
  return { url: u.toString() };
});
// volta do Mercado Pago depois que a clínica autoriza
route('GET', '/api/mp/oauth/callback', async (ctx) => {
  const back = (r) => ({ __redirect: `${APP_URL}/#/configuracoes/recebimentos?mp=${r}` });
  const state = String(ctx.query.get('state') || ''); const code = String(ctx.query.get('code') || '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(state)) return back('erro');
  const st = (await sql.unsafe('DELETE FROM saas.mp_oauth_states WHERE state_hash=$1 RETURNING *', [sha(state)]))[0];
  if (!st || Number(st.expires_at) < Date.now()) return back('expirado');
  if (!code || ctx.query.get('error')) return back('cancelado');
  const clinic = await getClinic(st.clinic_id);
  if (!clinic || clinicAccess(clinic).mode === 'blocked') return back('erro');
  try {
    const t = await mp.oauthToken({ client_id: config.get('MP_CLIENT_ID'), client_secret: config.get('MP_CLIENT_SECRET'), grant_type: 'authorization_code', code, redirect_uri: recvRedirect() });
    if (!t.access_token) throw new Error('sem token');
    const me = await mp.sellerRequest(t.access_token, 'GET', '/users/me').catch(() => ({}));
    await withClinic(clinic, async () => {
      const u = await q.get('SELECT id, name FROM users WHERE id=?', st.user_id);
      await currentSql().unsafe(`INSERT INTO saas.clinic_mp_accounts(clinic_id, mp_user_id, nickname, email, access_enc, refresh_enc, expires_at, live_mode, connected_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (clinic_id) DO UPDATE SET mp_user_id=excluded.mp_user_id, nickname=excluded.nickname, email=excluded.email,
        access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, live_mode=excluded.live_mode, connected_by=excluded.connected_by, connected_at=now()`,
      [clinic.id, String(t.user_id || me.id || ''), me.nickname || null, me.email || null, sealPlatform(t.access_token), t.refresh_token ? sealPlatform(t.refresh_token) : null,
        new Date(Date.now() + (Number(t.expires_in) || 15552000) * 1000).toISOString(), t.live_mode !== false, u?.name || null]);
      ctx.user = u || null;
      await audit(ctx, 'conectou_mercado_pago', 'clinic', clinic.id, null, { conta: me.nickname || me.email || t.user_id });
    });
    return back('ok');
  } catch (e) {
    console.error('Mercado Pago: conexão da clínica falhou', e.message);
    return back('erro');
  }
}, { public: true });
route('POST', '/api/recebimentos/mp/disconnect', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  await q.run('DELETE FROM saas.clinic_mp_accounts WHERE clinic_id=?', ctx.clinic.id);
  await audit(ctx, 'desconectou_mercado_pago', 'clinic', ctx.clinic.id, null, null);
  return { ok: true };
});

// cria (ou reaproveita) o link de pagamento de uma cobrança pendente
async function payLinkFor(ctx, chargeId) {
  const c = await q.get('SELECT c.*, p.name patient_name, p.email patient_email, p.phone patient_phone FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.id=?', chargeId);
  if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  if (c.status !== 'pendente') throw new HttpError(400, 'Só cobranças pendentes podem receber link de pagamento');
  const patient = { name: c.patient_name, email: c.patient_email, phone: c.patient_phone };
  const fresh = c.pay_url && c.pay_amount === c.amount && c.pay_link_at && (Date.now() - new Date(c.pay_link_at).getTime()) < (PAY_LINK_DAYS - 1) * 86400e3;
  if (fresh) return { charge_id: c.id, url: c.pay_url, amount: c.amount, fee: c.platform_fee || 0, description: c.description, patient };
  const token = await recvToken(ctx.clinic.id);
  const fee = Math.round(c.amount * recvFeePct()) / 100;
  const exp = new Date(Date.now() + PAY_LINK_DAYS * 86400e3);
  const pref = {
    items: [{ id: `cobranca-${c.id}`, title: c.description.slice(0, 120), quantity: 1, unit_price: c.amount, currency_id: 'BRL' }],
    payer: { name: c.patient_name, ...(c.patient_email && EMAIL_RE.test(c.patient_email) ? { email: c.patient_email } : {}) },
    external_reference: recvRef(ctx.clinic.id, c.id),
    notification_url: `${APP_URL}/api/mp/recebimentos/webhook/${ctx.clinic.id}`,
    statement_descriptor: String((await getSettings()).clinic_name || ctx.clinic.name).normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22) || undefined,
    expires: true, expiration_date_to: exp.toISOString(),
  };
  if (fee > 0) pref.marketplace_fee = fee;
  const r = await mp.sellerRequest(token, 'POST', '/checkout/preferences', pref);
  if (!r.init_point) throw new HttpError(502, 'O Mercado Pago não devolveu o link de pagamento. Tente novamente.');
  await q.run('UPDATE charges SET pay_url=?, pay_amount=?, mp_preference_id=?, platform_fee=?, pay_link_at=? WHERE id=?', r.init_point, c.amount, r.id || null, fee, new Date().toISOString(), c.id);
  await audit(ctx, 'gerou_link_pagamento', 'charge', c.id, c.patient_id, { valor: c.amount, taxa_plataforma: fee });
  return { charge_id: c.id, url: r.init_point, amount: c.amount, fee, description: c.description, patient };
}
// cobrança pendente para o link do agendamento (uma parte, no valor informado, ou o que falta do total)
async function linkChargeForAppointment(ctx, apptId, kind) {
  const a = await q.get('SELECT * FROM appointments WHERE id=?', apptId);
  if (!(a.price > 0)) throw new HttpError(400, 'Informe o valor do atendimento para enviar o link de pagamento');
  const ch = a.charge_id ? await q.get('SELECT * FROM charges WHERE id=?', a.charge_id) : null;
  if (kind === 'link_total' && ch && ch.status === 'pendente') return ch.id; // já realizado: o link é da cobrança do restante
  const launched = Number((await q.get("SELECT COALESCE(SUM(amount),0) t FROM charges WHERE appointment_id=? AND status<>'cancelado' AND NOT (id=? AND status='pendente')", a.id, a.charge_id || 0)).t) || 0;
  const target = kind === 'link_sinal' ? Math.min(a.price, cents(launched + partAmount(ctx, a.price))) : a.price;
  const need = cents(target - launched);
  if (need <= 0) {
    const open = await q.get("SELECT id FROM charges WHERE appointment_id=? AND status='pendente' ORDER BY id DESC LIMIT 1", a.id);
    if (open) return open.id;
    throw new HttpError(400, 'Este valor já foi pago.');
  }
  const paidBefore = await paidOf(a.id);
  const [y, m, d] = a.start.slice(0, 10).split('-');
  const desc = need < a.price && launched === 0 ? `Sinal — atendimento de ${d}/${m}/${y}` : paidBefore > 0 ? `Restante do atendimento de ${d}/${m}/${y}` : `Atendimento de fisioterapia — ${d}/${m}/${y}`;
  const r = await q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, appointment_id, created_by) VALUES (?,?,?,?,?,?,?)',
    a.patient_id, a.professional_id, desc, need, a.start.slice(0, 10) < today() ? today() : a.start.slice(0, 10), a.id, ctx.user.id);
  await syncCharge(ctx, a.id);
  return Number(r.lastInsertRowid);
}
route('POST', '/api/charges/:id/pay-link', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT patient_id FROM charges WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id);
  return payLinkFor(ctx, idParam(ctx.params.id));
});
route('POST', '/api/charges/:id/pay-link/email', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT c.*, p.name patient_name, p.email patient_email FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.id=?', idParam(ctx.params.id));
  if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id);
  if (!c.patient_email) throw new HttpError(400, 'O paciente não tem e-mail cadastrado.');
  const link = await payLinkFor(ctx, c.id);
  await notify.sendTemplate('pagamento_link', { to: c.patient_email, clinicId: ctx.clinic.id, url: link.url,
    vars: { nome: c.patient_name, clinica: (await getSettings()).clinic_name || ctx.clinic.name, descricao: c.description, valor: brl(c.amount), validade: `${PAY_LINK_DAYS} dias` } });
  await audit(ctx, 'enviou_link_pagamento', 'charge', c.id, c.patient_id, { para: c.patient_email });
  return { ok: true };
});
const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const MP_METHOD = (p) => (p.payment_method_id === 'pix' ? 'pix' : p.payment_type_id === 'credit_card' ? 'cartao_credito' : p.payment_type_id === 'debit_card' ? 'cartao_debito' : 'transferencia');
// registra um pagamento aprovado no Mercado Pago (já conferido na API) — chamada dentro de withClinic
async function registerMpPayment(clinic, p) {
  const m = /^fg-(\d+)-(\d+)$/.exec(String(p.external_reference || ''));
  if (!m || Number(m[1]) !== clinic.id || p.status !== 'approved') return null;
  const c = await q.get('SELECT * FROM charges WHERE id=?', Number(m[2]));
  if (!c) return null;
  const actx = { user: null, ip: null };
  if (c.mp_payment_id === String(p.id)) return c; // notificação repetida
  if (c.status === 'pago') {
    await audit(actx, 'pagamento_mp_em_dobro', 'charge', c.id, c.patient_id, { pagamento_mp: p.id, valor: p.transaction_amount });
    return c;
  }
  if (Number(p.transaction_amount) + 0.01 < c.amount) {
    await audit(actx, 'pagamento_mp_valor_diferente', 'charge', c.id, c.patient_id, { pagamento_mp: p.id, valor: p.transaction_amount, esperado: c.amount });
    return c;
  }
  const day = today();
  await tx(async () => {
    await q.run("UPDATE charges SET status='pago', paid_at=?, method=?, receipt_number=?, mp_payment_id=? WHERE id=? AND status<>'pago'",
      day, MP_METHOD(p), await nextReceipt(day), String(p.id), c.id);
    await audit(actx, 'pagamento_mercado_pago', 'charge', c.id, c.patient_id, { valor: p.transaction_amount, forma: MP_METHOD(p), pagamento_mp: p.id, taxa_plataforma: c.platform_fee || 0 });
    // registro central para o relatório de recebimentos do /admin (taxas reais informadas pelo Mercado Pago)
    const fees = Array.isArray(p.fee_details) ? p.fee_details : [];
    const feeOf = (t) => { const f = fees.filter((x) => x.type === t); return f.length ? f.reduce((a, x) => a + Number(x.amount || 0), 0) : null; };
    await q.run(`INSERT INTO saas.mp_receipts(mp_payment_id, clinic_id, charge_id, amount, platform_fee, mp_fee, method, approved_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (mp_payment_id) DO NOTHING`,
    String(p.id), clinic.id, c.id, Number(p.transaction_amount) || c.amount, feeOf('application_fee') ?? (c.platform_fee || 0), feeOf('mercadopago_fee'), MP_METHOD(p),
    p.date_approved ? new Date(p.date_approved).toISOString() : new Date().toISOString());
  });
  // avisa quem gerou a cobrança (ou os administradores)
  try {
    const pat = await q.get('SELECT name FROM patients WHERE id=?', c.patient_id);
    const staff = c.created_by ? await q.all('SELECT name, email FROM users WHERE id=? AND active=1', c.created_by) : [];
    const to = staff.length ? staff : await q.all("SELECT name, email FROM users WHERE role='admin' AND active=1");
    for (const u of to) {
      await notify.sendTemplate('pagamento_recebido', { to: u.email, clinicId: clinic.id, ref: `mp-${p.id}-${u.email}`, url: `${APP_URL}/#/financeiro`,
        vars: { nome: u.name, paciente: pat?.name || '', descricao: c.description, valor: brl(c.amount), forma: LABEL_METHOD[MP_METHOD(p)] } }).catch(() => {});
    }
  } catch (e) { console.error('Pagamento recebido: aviso não enviado', e.message); }
  return q.get('SELECT * FROM charges WHERE id=?', c.id);
}
const LABEL_METHOD = { pix: 'Pix', cartao_credito: 'cartão de crédito', cartao_debito: 'cartão de débito', transferencia: 'saldo/transferência no Mercado Pago' };
// confere no Mercado Pago se a cobrança já foi paga (não depende só do webhook)
route('POST', '/api/charges/:id/pay-link/check', async (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = await q.get('SELECT * FROM charges WHERE id=?', idParam(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  await getPatient(ctx.user, c.patient_id);
  if (c.status === 'pago' || !c.pay_url) return { status: c.status };
  const token = await recvToken(ctx.clinic.id);
  const r = await mp.sellerRequest(token, 'GET', `/v1/payments/search?${new URLSearchParams({ external_reference: recvRef(ctx.clinic.id, c.id), sort: 'date_created', criteria: 'desc' })}`);
  for (const p of r.results || []) if (p.status === 'approved') { await registerMpPayment(ctx.clinic, p); break; }
  return { status: (await q.get('SELECT status FROM charges WHERE id=?', c.id)).status };
});
// notificações do Mercado Pago para os pagamentos das clínicas
route('POST', '/api/mp/recebimentos/webhook/:clinicId', async (ctx) => {
  let body = {};
  try { body = JSON.parse(ctx.rawBody?.toString('utf8') || '{}'); } catch { /* corpo vazio */ }
  const type = body.type || body.topic || ctx.query.get('type') || ctx.query.get('topic');
  const id = String(body.data?.id || ctx.query.get('data.id') || ctx.query.get('id') || '');
  if (type !== 'payment' || !/^\d{1,30}$/.test(id)) return { received: true };
  const hookKey = `mphook|${ctx.ip}`; await checkRate(hookKey);
  const bad = () => failRate(hookKey, 30, 30); // avisos que não correspondem a pagamento nenhum da clínica
  const clinic = await getClinic(Number(ctx.params.clinicId) || 0);
  if (!clinic) { await bad(); return { received: true }; }
  const res = await withClinic(clinic, async () => {
    if (!(await recvAccount(clinic.id))) return 'bad';
    // nunca confia no corpo da notificação: busca o pagamento na API com o token da clínica
    let p;
    try { p = await mp.sellerRequest(await recvToken(clinic.id), 'GET', `/v1/payments/${id}`); } catch (e) { return e; }
    if (!String(p.external_reference || '').startsWith(`fg-${clinic.id}-`)) return 'bad';
    await registerMpPayment(clinic, p);
    return 'ok';
  });
  if (res === 'bad') await bad();
  else if (res instanceof Error) { await bad(); throw res; }
  return { received: true };
}, { public: true, webhook: true, raw: true });

// ====================== Área administrativa da plataforma ======================
const adminArea = require('./admin')({ hashPassword, checkPassword, validatePassword, sha, DUMMY_HASH, checkRate, failRate, clearRate, clinicAccess, unsubscribeUrl, COOKIE_SECURE, runDaily: () => lifecycle.daily() });

// ====================== Tratamento das requisições ======================
function clientIp(req) {
  if (ON_VERCEL) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket?.remoteAddress || null;
}
async function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'Endereço inválido' }); }
  const ctx = { req, res, query: url.searchParams, ip: clientIp(req), user: null, body: {} };
  try {
    const m = match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Rota não encontrada');
    const opts = m.route.opts;
    // Proteção CSRF: requisições que alteram dados precisam do cabeçalho customizado (além do cookie SameSite=Strict)
    if (req.method !== 'GET' && !opts.webhook && req.headers['x-requested-with'] !== 'fisio') throw new HttpError(403, 'Requisição bloqueada');
    ctx.params = m.params;
    await ensureCore(); // cria a estrutura da plataforma na primeira requisição (uma vez por instância)
    await config.load(); // chaves de API e parâmetros da plataforma (cache de 30 s)
    if (req.method !== 'GET') {
      if (opts.raw) ctx.rawBody = await readBody(req, 1024 * 1024, true);
      else ctx.body = await readBody(req);
    }
    let out;
    if (opts.public) {
      out = await als.run({}, () => m.route.handler(ctx));
    } else {
      const token = parseCookies(req).fisio_sid;
      if (!token) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
      await ensureCore();
      const s = (await sql.unsafe('SELECT * FROM saas.sessions WHERE token_hash=$1', [sha(token)]))[0];
      if (!s || s.expires_at < Date.now()) {
        if (s) await sql.unsafe('DELETE FROM saas.sessions WHERE token_hash=$1', [s.token_hash]);
        throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
      }
      const clinic = await getClinic(s.clinic_id);
      if (!clinic) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
      const access = clinicAccess(clinic);
      if (access.mode === 'blocked') throw new HttpError(403, 'O acesso desta clínica está suspenso. Entre em contato com o suporte.');
      if (access.mode === 'readonly' && req.method !== 'GET' && !opts.always) {
        throw new HttpError(402, access.reason === 'trial_ended'
          ? 'O período de teste gratuito terminou. Assine o FisioGestão para continuar registrando atendimentos — seus dados continuam disponíveis para consulta.'
          : 'A assinatura da clínica não está ativa. Regularize em Configurações → Assinatura — seus dados continuam disponíveis para consulta.');
      }
      out = await withClinic(clinic, async () => {
        const u = await q.get('SELECT id, name, email, role, crefito, active FROM users WHERE id=?', s.user_id);
        if (!u || !u.active) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
        // renovação deslizante: no banco e no cookie (a sessão expira após 10 h de INATIVIDADE)
        await q.run('UPDATE saas.sessions SET expires_at=? WHERE token_hash=?', Date.now() + SESSION_HOURS * 3600e3, s.token_hash);
        setCookie(res, token, SESSION_HOURS * 3600);
        ctx.user = u;
        Object.defineProperty(ctx, 'clinic', { get: () => als.getStore().clinic, configurable: true });
        return m.route.handler(ctx);
      });
    }
    if (out && out.__redirect) {
      res.writeHead(302, { Location: out.__redirect, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (out && out.__html) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out.__html);
    }
    if (out && out.__download) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.__download}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(out.body);
    }
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (!(e instanceof HttpError)) {
      console.error(e);
      const msg = e.code === '23505' ? 'Registro duplicado' : 'Erro interno do servidor';
      return send(res, 500, { error: msg });
    }
    send(res, e.status, { error: e.message });
  }
}

// Limpeza de sessões vencidas e contadores de tentativas antigos (chamada pelo cron da Vercel ou pelo servidor local)
// e-mails automáticos do ciclo do cliente (boas-vindas, teste grátis, pagamentos)
const lifecycle = require('./lifecycle')({ clinicAccess, APP_URL });
async function housekeeping() {
  await ensureCore();
  await sql.unsafe('DELETE FROM saas.sessions WHERE expires_at < $1', [Date.now()]);
  await sql.unsafe('DELETE FROM saas.login_attempts WHERE lock_until < $1 AND last < $2', [Date.now(), Date.now() - 24 * 3600e3]);
  await sql.unsafe('DELETE FROM saas.password_resets WHERE expires_at < $1', [Date.now() - 24 * 3600e3]);
  await sql.unsafe('DELETE FROM saas.email_verifications WHERE expires_at < $1', [Date.now() - 7 * 24 * 3600e3]);
  await sql.unsafe("DELETE FROM saas.email_log WHERE created_at < now() - interval '180 days'");
  await adminArea.cleanup();
  await adminArea.continueCampaigns().catch((e) => console.error('Campanhas:', e.message));
  return lifecycle.daily();
}
route('GET', '/api/cron/housekeeping', async (ctx) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || ctx.req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Não autorizado');
  await housekeeping();
  return { ok: true };
}, { public: true });

module.exports = { handler, housekeeping };

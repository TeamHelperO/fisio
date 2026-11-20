'use strict';
// API do FisioGestão (SaaS multi-clínica). Exporta `handler(req, res)`, usado pela Vercel (api/index.js)
// e pelo servidor local de desenvolvimento (server/server.js).
const crypto = require('crypto');
const { q, tx, sql, als, encrypt, decrypt, nowParts, TIMEZONES, signToken, ensureCore, withClinic, getClinic, createClinic, dropClinic } = require('./core');
const { HttpError, route, match, readBody, parseCookies, send, SECURITY_HEADERS } = require('./http');
const stripe = require('./stripe');
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
async function checkRate(key) {
  const a = (await sql.unsafe('SELECT lock_until FROM saas.login_attempts WHERE key=$1', [key]))[0];
  if (a && a.lock_until > Date.now()) throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil((a.lock_until - Date.now()) / 60000)} min.`);
}
async function failRate(key, max = 5, lockMin = 15) {
  const now = Date.now();
  await sql.unsafe(`INSERT INTO saas.login_attempts(key, n, last) VALUES ($1, 1, $2)
    ON CONFLICT (key) DO UPDATE SET n = CASE WHEN saas.login_attempts.last < $2 - 3600000 THEN 1 ELSE saas.login_attempts.n + 1 END, last = $2`, [key, now]);
  await sql.unsafe('UPDATE saas.login_attempts SET lock_until=$2, n=0 WHERE key=$1 AND n >= $3', [key, now + lockMin * 60e3, max]);
}
async function clearRate(key) { await sql.unsafe('DELETE FROM saas.login_attempts WHERE key=$1', [key]); }

// ====================== Assinatura (acesso da clínica) ======================
// full = uso normal · readonly = teste/assinatura vencidos (consulta e exportação liberadas) · blocked = suspensa pela plataforma
function clinicAccess(c) {
  const now = Date.now();
  const trialEnd = new Date(c.trial_ends_at).getTime();
  const trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / 86400e3));
  let mode; let reason;
  if (c.manual_access) { mode = c.manual_access; reason = 'manual'; }
  else if (['active', 'trialing'].includes(c.subscription_status)) { mode = 'full'; reason = 'subscription'; }
  else if (c.subscription_status === 'past_due') { mode = 'full'; reason = 'past_due'; } // o Stripe ainda está tentando cobrar
  else if (trialEnd > now) { mode = 'full'; reason = 'trial'; }
  else { mode = 'readonly'; reason = c.subscription_status ? 'subscription_ended' : 'trial_ended'; }
  return { mode, reason, trial_days_left: trialDaysLeft };
}
function clinicInfo(c) {
  return {
    id: c.id, name: c.name, timezone: c.timezone, trial_ends_at: c.trial_ends_at,
    subscription_status: c.subscription_status, current_period_end: c.current_period_end, cancel_at_period_end: c.cancel_at_period_end,
    access: clinicAccess(c), billing_enabled: stripe.enabled(),
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
  return { ok: true };
}, { public: true });

route('POST', '/api/login', async (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(ctx.body.password || '').slice(0, 200);
  const key = `login|${ctx.ip}|${email}`;
  await ensureCore();
  await checkRate(key);
  const idx = (await sql.unsafe('SELECT clinic_id, user_id FROM saas.user_index WHERE email=$1', [email]))[0];
  const clinic = idx ? await getClinic(idx.clinic_id) : null;
  if (!clinic) {
    checkPassword(password, DUMMY_HASH);
    await failRate(key);
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
  if (!u) { await failRate(key); throw new HttpError(401, 'E-mail ou senha incorretos'); }
  await clearRate(key);
  return { ok: true };
}, { public: true });

route('POST', '/api/logout', async (ctx) => {
  const token = parseCookies(ctx.req).fisio_sid;
  if (token) await q.run('DELETE FROM saas.sessions WHERE token_hash=?', sha(token));
  setCookie(ctx.res, '', 0);
  await audit(ctx, 'logout', 'user', ctx.user.id);
  return { ok: true };
}, { always: true });

route('GET', '/api/me', async (ctx) => ({ user: ctx.user, settings: await getSettings(), clinic: clinicInfo(ctx.clinic) }));

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
  return { id };
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
  if (email !== u.email) await q.run('UPDATE saas.user_index SET email=? WHERE clinic_id=? AND user_id=?', email, ctx.clinic.id, id);
  if (b.password) { validatePassword(b.password); await q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(b.password), id); }
  if (!active || b.password) await dropSessions(ctx.clinic.id, id);
  await audit(ctx, 'alterou', 'user', id, null, { role, active, senha_redefinida: !!b.password });
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
  return { id };
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
async function syncCharge(ctx, apptId) {
  const a = await q.get('SELECT * FROM appointments WHERE id=?', apptId);
  const ch = a.charge_id ? await q.get('SELECT * FROM charges WHERE id=?', a.charge_id) : null;
  if (a.status === 'realizado' && a.price > 0 && !ch) {
    const [y, m, d] = a.start.slice(0, 10).split('-');
    const r = await q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, appointment_id, created_by) VALUES (?,?,?,?,?,?,?)',
      a.patient_id, a.professional_id, `Atendimento de fisioterapia — ${d}/${m}/${y}`, a.price, a.start.slice(0, 10), a.id, ctx.user.id);
    await q.run('UPDATE appointments SET charge_id=? WHERE id=?', Number(r.lastInsertRowid), a.id);
  } else if (a.status !== 'realizado' && ch && ch.status === 'pendente') {
    await q.run('DELETE FROM charges WHERE id=?', ch.id);
    await q.run('UPDATE appointments SET charge_id=NULL WHERE id=?', a.id);
  } else if (ch && ch.status === 'pendente') {
    // cobrança pendente acompanha o atendimento (paciente, profissional e valor)
    await q.run('UPDATE charges SET patient_id=?, professional_id=?, amount=? WHERE id=?',
      a.patient_id, a.professional_id, a.price > 0 ? a.price : ch.amount, ch.id);
  }
}
route('GET', '/api/appointments', async (ctx) => {
  const sp = ctx.query; const s = scope(ctx.user);
  let text = `SELECT a.*, p.name patient_name, p.phone, u.name professional_name, c.status charge_status FROM appointments a JOIN patients p ON p.id=a.patient_id
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
  return tx(async () => {
    const ids = [];
    for (let i = 0; i < repeat; i++) {
      const r = await q.run('INSERT INTO appointments(patient_id,professional_id,start,duration,kind,status,price,notes) VALUES (?,?,?,?,?,?,?,?)',
        p.id, a.professional_id, starts[i], a.duration, a.kind, i === 0 ? a.status : 'agendado', a.price, a.notes);
      ids.push(Number(r.lastInsertRowid)); await syncCharge(ctx, ids[ids.length - 1]);
    }
    await audit(ctx, 'criou', 'appointment', ids[0], p.id, { start: a.start, repeticoes: repeat });
    return { ids };
  });
});
route('PUT', '/api/appointments/:id', async (ctx) => {
  const ex = await q.get('SELECT * FROM appointments WHERE id=?', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Agendamento não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  const pid = ctx.body.patient_id ? (await getPatient(ctx.user, ctx.body.patient_id)).id : ex.patient_id;
  if (pid !== ex.patient_id && ex.charge_id && await q.get("SELECT 1 FROM charges WHERE id=? AND status='pago'", ex.charge_id)) {
    throw new HttpError(400, 'Este atendimento já tem pagamento registrado (recibo emitido) e não pode ser transferido para outro paciente. Estorne o pagamento primeiro.');
  }
  const a = apptInput({ ...ex, ...ctx.body });
  const conflict = await overlapCheck(a, ex.id);
  if (conflict && !ctx.body.force) throw new HttpError(409, conflict);
  return tx(async () => {
    await q.run('UPDATE appointments SET patient_id=?, professional_id=?, start=?, duration=?, kind=?, status=?, price=?, notes=? WHERE id=?',
      pid, a.professional_id, a.start, a.duration, a.kind, a.status, a.price, a.notes, ex.id);
    await syncCharge(ctx, ex.id);
    await audit(ctx, 'alterou', 'appointment', ex.id, pid, { status: a.status, start: a.start });
    return { ok: true };
  });
});
route('DELETE', '/api/appointments/:id', async (ctx) => {
  const ex = await q.get('SELECT * FROM appointments WHERE id=?', idParam(ctx.params.id)); if (!ex) throw new HttpError(404, 'Agendamento não encontrado');
  await getPatient(ctx.user, ex.patient_id);
  if (ex.charge_id && await q.get("SELECT 1 FROM charges WHERE id=? AND status='pago'", ex.charge_id)) throw new HttpError(400, 'Este atendimento possui pagamento registrado. Altere a situação em vez de excluir.');
  await tx(async () => { if (ex.charge_id) await q.run('DELETE FROM charges WHERE id=?', ex.charge_id); await q.run('DELETE FROM appointments WHERE id=?', ex.id); });
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
  const tables = ['patients', 'consents', 'appointments', 'services', 'packages', 'patient_packages', 'charges', 'audit_log', 'settings'];
  const out = { exportado_em: new Date().toISOString(), clinica: ctx.clinic.name, formato: 'FisioGestão JSON v1' };
  out.users = await q.all('SELECT id,name,email,role,crefito,active,created_at,last_login FROM users ORDER BY id');
  for (const t of tables) out[t] = await q.all(`SELECT * FROM ${t} ORDER BY 1`);
  out.records = (await q.all('SELECT * FROM records ORDER BY id')).map(({ data_enc, ...r }) => ({ ...r, data: decrypt(data_enc) }));
  out.record_versions = (await q.all('SELECT * FROM record_versions ORDER BY id')).map(({ data_enc, ...r }) => ({ ...r, data: decrypt(data_enc) }));
  await audit(ctx, 'exportou_clinica', 'clinic', ctx.clinic.id);
  return { __download: `fisiogestao-${today()}.json`, body: JSON.stringify(out, null, 2) };
}, { always: true });

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
  const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
  await sql.unsafe(`UPDATE saas.clinics SET stripe_customer_id=COALESCE(stripe_customer_id,$2), stripe_subscription_id=$3, subscription_status=$4,
    current_period_end=$5, cancel_at_period_end=$6 WHERE id=$1`,
  [id, sub.customer, sub.id, sub.status, periodEnd ? new Date(periodEnd * 1000).toISOString() : null, !!sub.cancel_at_period_end]);
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

// ====================== Área administrativa da plataforma ======================
const adminArea = require('./admin')({ hashPassword, checkPassword, validatePassword, sha, DUMMY_HASH, checkRate, failRate, clearRate, clinicAccess, unsubscribeUrl, COOKIE_SECURE });

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
async function housekeeping() {
  await ensureCore();
  await sql.unsafe('DELETE FROM saas.sessions WHERE expires_at < $1', [Date.now()]);
  await sql.unsafe('DELETE FROM saas.login_attempts WHERE lock_until < $1 AND last < $2', [Date.now(), Date.now() - 24 * 3600e3]);
  await adminArea.cleanup();
}
route('GET', '/api/cron/housekeeping', async (ctx) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || ctx.req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Não autorizado');
  await housekeeping();
  return { ok: true };
}, { public: true });

module.exports = { handler, housekeeping };

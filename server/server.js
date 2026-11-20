'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { q, tx, encrypt, decrypt, getSettings, backup, listBackups, BACKUP_DIR } = require('./db');
const { HttpError, route, match, readBody, parseCookies, send, serveStatic } = require('./http');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_HOURS = 10;
const RETENTION_YEARS = 5; // prazo mínimo de guarda do prontuário
const PUBLIC_DIR = process.env.FISIO_PUBLIC_DIR ? path.resolve(process.env.FISIO_PUBLIC_DIR) : path.join(__dirname, '..', 'public');

// ====================== Utilidades ======================
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const nowLocal = () => { const d = new Date(); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

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
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'A senha deve conter letras e números');
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.run('INSERT INTO sessions(token_hash, user_id, expires_at, ip) VALUES (?,?,?,?)', sha(token), userId, Date.now() + SESSION_HOURS * 3600e3, ip);
  setCookie(res, token, SESSION_HOURS * 3600);
}
function setCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `fisio_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`);
}
function sessionUser(req, res) {
  const token = parseCookies(req).fisio_sid;
  if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
  if (!s || s.expires_at < Date.now()) { if (s) q.run('DELETE FROM sessions WHERE token_hash=?', s.token_hash); return null; }
  const u = q.get('SELECT id, name, email, role, crefito, active FROM users WHERE id = ?', s.user_id);
  if (!u || !u.active) return null;
  // renovação deslizante: no banco e no cookie (a sessão expira após 10 h de INATIVIDADE)
  q.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() + SESSION_HOURS * 3600e3, s.token_hash);
  if (res) setCookie(res, token, SESSION_HOURS * 3600);
  return u;
}

// Limite de tentativas de login (força bruta)
const attempts = new Map();
function checkRate(key) {
  const a = attempts.get(key);
  if (a && a.lockUntil > Date.now()) throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil((a.lockUntil - Date.now()) / 60000)} min.`);
}
function failRate(key) {
  const a = attempts.get(key) || { n: 0, lockUntil: 0 };
  a.n++; a.last = Date.now();
  if (a.n >= 5) { a.lockUntil = Date.now() + 15 * 60e3; a.n = 0; }
  attempts.set(key, a);
}
// limpeza periódica: remove contadores antigos para o mapa não crescer indefinidamente
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.lockUntil < now && now - (a.last || 0) > 60 * 60e3) attempts.delete(k);
}, 10 * 60e3).unref();
// hash fictício: o login gasta o mesmo tempo exista ou não o e-mail (evita descobrir contas pelo tempo de resposta)
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ====================== Auditoria ======================
function audit(ctx, action, entity, entityId, patientId, details) {
  q.run('INSERT INTO audit_log(user_id, user_name, action, entity, entity_id, patient_id, details, ip) VALUES (?,?,?,?,?,?,?,?)',
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
function getPatient(user, id) {
  const p = q.get('SELECT * FROM patients WHERE id = ?', Number(id));
  if (!p) throw new HttpError(404, 'Paciente não encontrado');
  if (user.role === 'fisio' && p.professional_id && p.professional_id !== user.id) throw new HttpError(403, 'Este paciente está sob responsabilidade de outro profissional');
  return p;
}

// ====================== Setup / Autenticação ======================
route('GET', '/api/setup-status', () => ({ needsSetup: !q.get('SELECT 1 FROM users LIMIT 1') }), { public: true });

route('POST', '/api/setup', (ctx) => {
  if (q.get('SELECT 1 FROM users LIMIT 1')) throw new HttpError(400, 'Sistema já configurado');
  const b = ctx.body;
  const name = reqStr(b.name, 'Nome', 120); const email = reqStr(b.email, 'E-mail', 160);
  validatePassword(b.password);
  const r = q.run("INSERT INTO users(name,email,password_hash,role,crefito) VALUES (?,?,?,'admin',?)", name, email, hashPassword(b.password), str(b.crefito, 40));
  q.run("UPDATE settings SET value=? WHERE key='professional_name'", name);
  if (b.crefito) q.run("UPDATE settings SET value=? WHERE key='crefito'", str(b.crefito, 40));
  ctx.user = { id: Number(r.lastInsertRowid), name };
  audit(ctx, 'setup', 'user', ctx.user.id);
  createSession(ctx.res, ctx.user.id, ctx.ip);
  return { ok: true };
}, { public: true });

route('POST', '/api/login', (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const key = `${ctx.ip}|${email}`;
  checkRate(key);
  const u = q.get('SELECT * FROM users WHERE email = ?', email);
  const passOk = checkPassword(String(ctx.body.password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !u.active || !passOk) {
    failRate(key);
    ctx.user = null; audit(ctx, 'login_falhou', 'user', u ? u.id : null, null, email);
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }
  attempts.delete(key);
  q.run("UPDATE users SET last_login = datetime('now','localtime') WHERE id=?", u.id);
  ctx.user = u; audit(ctx, 'login', 'user', u.id);
  createSession(ctx.res, u.id, ctx.ip);
  return { ok: true };
}, { public: true });

route('POST', '/api/logout', (ctx) => {
  const token = parseCookies(ctx.req).fisio_sid;
  if (token) q.run('DELETE FROM sessions WHERE token_hash=?', sha(token));
  setCookie(ctx.res, '', 0);
  audit(ctx, 'logout', 'user', ctx.user.id);
  return { ok: true };
});

route('GET', '/api/me', (ctx) => ({ user: ctx.user, settings: getSettings() }));

route('POST', '/api/me/password', (ctx) => {
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!checkPassword(String(ctx.body.current || ''), u.password_hash)) throw new HttpError(400, 'Senha atual incorreta');
  validatePassword(ctx.body.password);
  q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(ctx.body.password), u.id);
  q.run('DELETE FROM sessions WHERE user_id=?', u.id);
  createSession(ctx.res, u.id, ctx.ip);
  audit(ctx, 'alterou_senha', 'user', u.id);
  return { ok: true };
});

// ====================== Usuários ======================
route('GET', '/api/users', (ctx) => {
  if (ctx.user.role === 'admin') return q.all('SELECT id,name,email,role,crefito,active,created_at,last_login FROM users ORDER BY name');
  return q.all("SELECT id,name,role,crefito FROM users WHERE active=1 AND role IN ('admin','fisio') ORDER BY name");
});
route('POST', '/api/users', (ctx) => {
  requireRole(ctx.user, ['admin']);
  const b = ctx.body; validatePassword(b.password);
  const email = reqStr(b.email, 'E-mail', 160).toLowerCase();
  if (q.get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(400, 'E-mail já cadastrado');
  const r = q.run('INSERT INTO users(name,email,password_hash,role,crefito) VALUES (?,?,?,?,?)',
    reqStr(b.name, 'Nome', 120), email, hashPassword(b.password), oneOf(b.role, ROLES, 'Perfil', 'fisio'), str(b.crefito, 40));
  audit(ctx, 'criou', 'user', Number(r.lastInsertRowid), null, { email, role: b.role });
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/users/:id', (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = Number(ctx.params.id); const b = ctx.body;
  const u = q.get('SELECT * FROM users WHERE id=?', id); if (!u) throw new HttpError(404, 'Usuário não encontrado');
  const role = oneOf(b.role, ROLES, 'Perfil', u.role);
  const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
  if (id === ctx.user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'Você não pode remover seu próprio acesso de administrador');
  q.run('UPDATE users SET name=?, email=?, role=?, crefito=?, active=? WHERE id=?',
    reqStr(b.name ?? u.name, 'Nome', 120), reqStr(b.email ?? u.email, 'E-mail', 160).toLowerCase(), role, str(b.crefito ?? u.crefito, 40), active, id);
  if (b.password) { validatePassword(b.password); q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(b.password), id); }
  if (!active || b.password) q.run('DELETE FROM sessions WHERE user_id=?', id);
  audit(ctx, 'alterou', 'user', id, null, { role, active, senha_redefinida: !!b.password });
  return { ok: true };
});

// ====================== Configurações ======================
route('GET', '/api/settings', () => getSettings());
route('PUT', '/api/settings', (ctx) => {
  requireRole(ctx.user, ['admin']);
  const allowed = ['clinic_name', 'professional_name', 'crefito', 'professional_cpf', 'phone', 'email', 'address', 'city', 'consent_text', 'consent_version'];
  const before = getSettings();
  for (const k of allowed) {
    if (ctx.body[k] === undefined) continue;
    let v = str(ctx.body[k], k === 'consent_text' ? 20000 : 300) || '';
    if (k === 'professional_cpf' && v) v = cpfField(v, 'CPF do profissional');
    q.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
  }
  if (ctx.body.consent_text !== undefined && ctx.body.consent_text !== before.consent_text && ctx.body.consent_version === before.consent_version) {
    const v = (parseFloat(before.consent_version) || 1) + 0.1;
    q.run("UPDATE settings SET value=? WHERE key='consent_version'", v.toFixed(1));
  }
  audit(ctx, 'alterou', 'settings', null);
  return getSettings();
});

// ====================== Dashboard ======================
route('GET', '/api/dashboard', (ctx) => {
  const s = scope(ctx.user);
  const d = new Date(); const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const cnt = (where, ...p) => q.get(`SELECT COUNT(*) n FROM patients p WHERE 1=1 ${where} ${s.sql}`, ...p, ...s.params).n;
  const out = {
    total: cnt(''),
    em_tratamento: cnt("AND p.status IN ('em_tratamento','avaliacao')"),
    finalizado: cnt("AND p.status='finalizado'"),
    agendadas: q.get(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.start >= ? AND a.status IN ('agendado','confirmado') ${s.sql}`, nowLocal(), ...s.params).n,
    realizados_mes: q.get(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE substr(a.start,1,7)=? AND a.status='realizado' ${s.sql}`, month, ...s.params).n,
    faltas_mes: q.get(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE substr(a.start,1,7)=? AND a.status='falta' ${s.sql}`, month, ...s.params).n,
    faturamento_mes: q.get(`SELECT COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pago' AND substr(c.paid_at,1,7)=? ${s.sql}`, month, ...s.params).v,
    pendentes: q.get(`SELECT COUNT(*) n, COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pendente' ${s.sql}`, ...s.params),
    vencidos: q.get(`SELECT COUNT(*) n, COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pendente' AND c.due_date < ? ${s.sql}`, today(), ...s.params),
    proximos: q.all(`SELECT a.*, p.name patient_name, p.phone, u.name professional_name FROM appointments a JOIN patients p ON p.id=a.patient_id LEFT JOIN users u ON u.id=a.professional_id
      WHERE a.start >= ? AND a.status IN ('agendado','confirmado') ${s.sql} ORDER BY a.start LIMIT 12`, `${today()}T00:00`, ...s.params),
    receita_6m: [],
  };
  for (let i = 5; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1); const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    out.receita_6m.push({ month: key, value: q.get(`SELECT COALESCE(SUM(c.amount),0) v FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pago' AND substr(c.paid_at,1,7)=? ${s.sql}`, key, ...s.params).v });
  }
  if (ctx.user.role === 'recepcao') { /* recepção vê indicadores administrativos, sem dados clínicos */ }
  return out;
});

// ====================== Pacientes ======================
function patientFields(b, current = null) {
  return [
    reqStr(b.name, 'Nome completo', 160), date(b.birth_date, 'Data de nascimento'), cpfField(b.cpf), str(b.phone, 40), str(b.email, 160),
    str(b.address, 400), str(b.profession, 120), str(b.emergency_name, 160), str(b.emergency_phone, 40), date(b.first_visit, 'Primeiro atendimento'),
    oneOf(b.status, ['avaliacao', 'em_tratamento', 'finalizado', 'inativo'], 'Situação', 'em_tratamento'),
    responsible(b.professional_id, current), str(b.notes, 4000),
  ];
}
// responsável precisa ser um usuário ativo com perfil clínico (administrador ou fisioterapeuta)
function responsible(v, current = null) {
  if (!v) return null;
  if (current && Number(v) === current) return current; // mantém o atual mesmo que o usuário tenha sido desativado
  const u = q.get("SELECT id FROM users WHERE id=? AND active=1 AND role IN ('admin','fisio')", Number(v));
  if (!u) throw new HttpError(400, 'Fisioterapeuta responsável inválido');
  return u.id;
}
// Fisioterapeuta não pode deixar o paciente sem responsável (isso o tornaria visível a todos os fisioterapeutas)
function keepResponsible(ctx, f, current) {
  if (ctx.user.role === 'fisio' && !f[11]) f[11] = current || ctx.user.id;
}
route('GET', '/api/patients', (ctx) => {
  const s = scope(ctx.user); const sp = ctx.query;
  let sql = `SELECT p.id,p.name,p.birth_date,p.cpf,p.phone,p.status,p.first_visit,p.professional_id,u.name professional_name,
    (SELECT COUNT(*) FROM consents c WHERE c.patient_id=p.id AND c.revoked_at IS NULL) consent,
    (SELECT MAX(a.start) FROM appointments a WHERE a.patient_id=p.id AND a.status='realizado') last_visit,
    (SELECT MIN(a.start) FROM appointments a WHERE a.patient_id=p.id AND a.status IN ('agendado','confirmado') AND a.start>=?) next_visit
    FROM patients p LEFT JOIN users u ON u.id=p.professional_id WHERE 1=1 ${s.sql}`;
  const params = [nowLocal(), ...s.params];
  if (sp.get('q')) { sql += ' AND (p.name LIKE ? OR p.cpf LIKE ? OR p.phone LIKE ?)'; const t = `%${sp.get('q')}%`; params.push(t, t, t); }
  if (sp.get('status')) { sql += ' AND p.status = ?'; params.push(sp.get('status')); }
  sql += ' ORDER BY p.name COLLATE NOCASE';
  return q.all(sql, ...params);
});
route('POST', '/api/patients', (ctx) => {
  const f = patientFields(ctx.body);
  keepResponsible(ctx, f);
  const r = q.run(`INSERT INTO patients(name,birth_date,cpf,phone,email,address,profession,emergency_name,emergency_phone,first_visit,status,professional_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...f);
  const id = Number(r.lastInsertRowid);
  audit(ctx, 'criou', 'patient', id, id);
  return { id };
});
route('GET', '/api/patients/:id', (ctx) => {
  const p = getPatient(ctx.user, ctx.params.id);
  const prof = p.professional_id ? q.get('SELECT name, crefito FROM users WHERE id=?', p.professional_id) : null;
  const consent = q.get('SELECT * FROM consents WHERE patient_id=? AND revoked_at IS NULL ORDER BY accepted_at DESC LIMIT 1', p.id);
  const counts = {};
  if (CLINICAL.includes(ctx.user.role)) {
    for (const r of q.all('SELECT type, COUNT(*) n FROM records WHERE patient_id=? AND deleted_at IS NULL GROUP BY type', p.id)) counts[r.type] = r.n;
  }
  counts.realizados = q.get("SELECT COUNT(*) n FROM appointments WHERE patient_id=? AND status='realizado'", p.id).n;
  counts.faltas = q.get("SELECT COUNT(*) n FROM appointments WHERE patient_id=? AND status='falta'", p.id).n;
  counts.pendente = q.get("SELECT COALESCE(SUM(amount),0) v FROM charges WHERE patient_id=? AND status='pendente'", p.id).v;
  const next = q.get("SELECT * FROM appointments WHERE patient_id=? AND status IN ('agendado','confirmado') AND start>=? ORDER BY start LIMIT 1", p.id, nowLocal());
  audit(ctx, 'visualizou', 'patient', p.id, p.id);
  return { ...p, professional_name: prof?.name, professional_crefito: prof?.crefito, consent, counts, next };
});
route('PUT', '/api/patients/:id', (ctx) => {
  const p = getPatient(ctx.user, ctx.params.id);
  const f = patientFields({ ...p, ...ctx.body }, p.professional_id);
  keepResponsible(ctx, f, p.professional_id);
  q.run(`UPDATE patients SET name=?,birth_date=?,cpf=?,phone=?,email=?,address=?,profession=?,emergency_name=?,emergency_phone=?,first_visit=?,status=?,professional_id=?,notes=?, updated_at=datetime('now','localtime') WHERE id=?`, ...f, p.id);
  const changed = Object.keys(ctx.body).filter((k) => String(ctx.body[k] ?? '') !== String(p[k] ?? ''));
  audit(ctx, 'alterou', 'patient', p.id, p.id, { campos: changed });
  return { ok: true };
});
route('DELETE', '/api/patients/:id', (ctx) => {
  requireRole(ctx.user, ['admin']);
  const p = getPatient(ctx.user, ctx.params.id);
  if (String(ctx.body.confirm || '').trim() !== p.name) throw new HttpError(400, 'Digite o nome completo do paciente para confirmar a exclusão');
  // Guarda legal do prontuário (COFFITO, Res. 414/2012: mínimo de 5 anos a partir do último registro).
  // Registros clínicos (inclusive os excluídos logicamente) impedem a exclusão definitiva dentro do prazo.
  const lastRec = q.get('SELECT MAX(MAX(record_date), MAX(substr(updated_at,1,10))) d, COUNT(*) n FROM records WHERE patient_id=?', p.id);
  if (lastRec.n) {
    const limit = new Date(); limit.setFullYear(limit.getFullYear() - RETENTION_YEARS);
    if (lastRec.d > ymd(limit)) {
      const until = new Date(lastRec.d + 'T12:00'); until.setFullYear(until.getFullYear() + RETENTION_YEARS);
      throw new HttpError(400, `Este paciente possui prontuário clínico (último registro em ${lastRec.d.split('-').reverse().join('/')}), que deve ser guardado por no mínimo ${RETENTION_YEARS} anos — até ${ymd(until).split('-').reverse().join('/')}. Em vez de excluir, altere a situação do paciente para "Inativo".`);
    }
  }
  backup('antes-exclusao');
  q.run('DELETE FROM patients WHERE id=?', p.id);
  audit(ctx, 'excluiu', 'patient', p.id, p.id, { nome: p.name, motivo: str(ctx.body.reason, 500) });
  return { ok: true };
});
// Portabilidade (LGPD art. 18, V) — exporta todos os dados do titular
route('GET', '/api/patients/:id/export', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = getPatient(ctx.user, ctx.params.id);
  const records = q.all('SELECT id,type,record_date,seq,status,created_at,updated_at FROM records r WHERE patient_id=? AND deleted_at IS NULL ORDER BY record_date', p.id)
    .map((r) => ({ ...r, data: decrypt(q.get('SELECT data_enc FROM records WHERE id=?', r.id).data_enc) }));
  audit(ctx, 'exportou_dados', 'patient', p.id, p.id);
  return {
    exportado_em: new Date().toISOString(), paciente: p,
    consentimentos: q.all('SELECT * FROM consents WHERE patient_id=?', p.id), registros_clinicos: records,
    agendamentos: q.all('SELECT * FROM appointments WHERE patient_id=? ORDER BY start', p.id),
    financeiro: q.all('SELECT * FROM charges WHERE patient_id=? ORDER BY due_date', p.id),
  };
});

// ====================== Consentimento LGPD ======================
route('GET', '/api/patients/:id/consents', (ctx) => {
  const p = getPatient(ctx.user, ctx.params.id);
  return q.all('SELECT c.*, u.name registered_by_name FROM consents c LEFT JOIN users u ON u.id=c.registered_by WHERE patient_id=? ORDER BY accepted_at DESC', p.id);
});
route('POST', '/api/patients/:id/consents', (ctx) => {
  const p = getPatient(ctx.user, ctx.params.id); const st = getSettings();
  const r = q.run('INSERT INTO consents(patient_id, term_version, term_hash, method, signer_name, accepted_at, registered_by) VALUES (?,?,?,?,?,?,?)',
    p.id, st.consent_version, sha(st.consent_text), oneOf(ctx.body.method, ['assinatura_fisica', 'assinatura_digital', 'aceite_presencial'], 'Forma', 'assinatura_fisica'),
    reqStr(ctx.body.signer_name || p.name, 'Nome do titular/responsável', 160), date(ctx.body.accepted_at, 'Data') || today(), ctx.user.id);
  audit(ctx, 'registrou_consentimento', 'consent', Number(r.lastInsertRowid), p.id);
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/consents/:id/revoke', (ctx) => {
  const c = q.get('SELECT * FROM consents WHERE id=?', Number(ctx.params.id)); if (!c) throw new HttpError(404, 'Não encontrado');
  getPatient(ctx.user, c.patient_id);
  q.run('UPDATE consents SET revoked_at=?, revoke_reason=? WHERE id=?', today(), str(ctx.body.reason, 500), c.id);
  audit(ctx, 'revogou_consentimento', 'consent', c.id, c.patient_id);
  return { ok: true };
});

// ====================== Registros clínicos ======================
const RECORD_TYPES = ['anamnese', 'avaliacao', 'plano', 'evolucao'];
function recordMeta(r) { const { data_enc, ...rest } = r; return rest; }
route('GET', '/api/records', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const sp = ctx.query; const s = scope(ctx.user);
  let sql = `SELECT r.*, p.name patient_name, u.name author_name FROM records r JOIN patients p ON p.id=r.patient_id LEFT JOIN users u ON u.id=r.author_id WHERE r.deleted_at IS NULL ${s.sql}`;
  const params = [...s.params];
  if (sp.get('type')) { sql += ' AND r.type=?'; params.push(oneOf(sp.get('type'), RECORD_TYPES, 'Tipo')); }
  if (sp.get('patient_id')) { getPatient(ctx.user, sp.get('patient_id')); sql += ' AND r.patient_id=?'; params.push(Number(sp.get('patient_id'))); }
  if (sp.get('q')) { sql += ' AND p.name LIKE ?'; params.push(`%${sp.get('q')}%`); }
  sql += ' ORDER BY r.record_date DESC, r.seq DESC, r.id DESC LIMIT 500';
  const full = sp.get('full') === '1' && sp.get('patient_id');
  const rows = q.all(sql, ...params).map((r) => (full ? { ...recordMeta(r), data: decrypt(r.data_enc) } : recordMeta(r)));
  if (full) audit(ctx, 'visualizou', 'records', null, Number(sp.get('patient_id')), sp.get('type'));
  return rows;
});
route('GET', '/api/records/:id', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const r = q.get('SELECT r.*, u.name author_name, u.crefito author_crefito FROM records r LEFT JOIN users u ON u.id=r.author_id WHERE r.id=? AND r.deleted_at IS NULL', Number(ctx.params.id));
  if (!r) throw new HttpError(404, 'Registro não encontrado');
  getPatient(ctx.user, r.patient_id);
  const versions = q.all('SELECT v.id, v.version, v.changed_at, u.name changed_by_name FROM record_versions v LEFT JOIN users u ON u.id=v.changed_by WHERE record_id=? ORDER BY version DESC', r.id);
  audit(ctx, 'visualizou', 'record', r.id, r.patient_id, r.type);
  return { ...recordMeta(r), data: decrypt(r.data_enc), versions };
});
route('GET', '/api/records/:id/versions/:vid', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const r = q.get('SELECT * FROM records WHERE id=?', Number(ctx.params.id)); if (!r) throw new HttpError(404, 'Registro não encontrado');
  getPatient(ctx.user, r.patient_id);
  const v = q.get('SELECT * FROM record_versions WHERE id=? AND record_id=?', Number(ctx.params.vid), r.id); if (!v) throw new HttpError(404, 'Versão não encontrada');
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
    seq: type === 'evolucao' ? (b.seq ? Number(b.seq) : null) : null,
    status: type === 'plano' ? oneOf(b.status, ['ativo', 'concluido', 'substituido'], 'Situação', 'ativo') : null,
    title: str(b.title, 200),
    data,
  };
}
route('POST', '/api/records', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const p = getPatient(ctx.user, ctx.body.patient_id);
  const r = recordInput(ctx.body);
  return tx(() => {
    if (r.type === 'evolucao' && !r.seq) r.seq = (q.get("SELECT MAX(seq) m FROM records WHERE patient_id=? AND type='evolucao' AND deleted_at IS NULL", p.id).m || 0) + 1;
    if (r.type === 'plano' && r.status === 'ativo') q.run("UPDATE records SET status='substituido' WHERE patient_id=? AND type='plano' AND status='ativo'", p.id);
    const res = q.run('INSERT INTO records(patient_id,type,record_date,seq,status,title,author_id,data_enc) VALUES (?,?,?,?,?,?,?,?)',
      p.id, r.type, r.record_date, r.seq, r.status, r.title, ctx.user.id, encrypt(r.data));
    const id = Number(res.lastInsertRowid);
    if (r.type === 'avaliacao' && p.status === 'avaliacao') q.run("UPDATE patients SET status='em_tratamento' WHERE id=?", p.id);
    audit(ctx, 'criou', r.type, id, p.id);
    return { id, seq: r.seq };
  });
});
route('PUT', '/api/records/:id', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = q.get('SELECT * FROM records WHERE id=? AND deleted_at IS NULL', Number(ctx.params.id)); if (!ex) throw new HttpError(404, 'Registro não encontrado');
  getPatient(ctx.user, ex.patient_id);
  const r = recordInput({ ...ex, ...ctx.body }, ex);
  return tx(() => {
    const ver = (q.get('SELECT MAX(version) m FROM record_versions WHERE record_id=?', ex.id).m || 0) + 1;
    q.run('INSERT INTO record_versions(record_id,version,record_date,status,data_enc,changed_by) VALUES (?,?,?,?,?,?)', ex.id, ver, ex.record_date, ex.status, ex.data_enc, ctx.user.id);
    if (r.type === 'plano' && r.status === 'ativo' && ex.status !== 'ativo') q.run("UPDATE records SET status='substituido' WHERE patient_id=? AND type='plano' AND status='ativo' AND id<>?", ex.patient_id, ex.id);
    q.run("UPDATE records SET record_date=?, seq=?, status=?, title=?, data_enc=?, updated_at=datetime('now','localtime') WHERE id=?",
      r.record_date, r.seq ?? ex.seq, r.status, r.title, encrypt(r.data), ex.id);
    audit(ctx, 'alterou', ex.type, ex.id, ex.patient_id, { versao_anterior: ver });
    return { ok: true };
  });
});
route('DELETE', '/api/records/:id', (ctx) => {
  requireRole(ctx.user, CLINICAL);
  const ex = q.get('SELECT * FROM records WHERE id=? AND deleted_at IS NULL', Number(ctx.params.id)); if (!ex) throw new HttpError(404, 'Registro não encontrado');
  getPatient(ctx.user, ex.patient_id);
  if (ctx.user.role !== 'admin' && ex.author_id !== ctx.user.id) throw new HttpError(403, 'Apenas o autor ou o administrador pode excluir este registro');
  // exclusão lógica: o registro permanece guardado para fins de auditoria/guarda legal do prontuário
  q.run("UPDATE records SET deleted_at=datetime('now','localtime') WHERE id=?", ex.id);
  audit(ctx, 'excluiu', ex.type, ex.id, ex.patient_id, str(ctx.body.reason, 500));
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
    professional_id: b.professional_id ? Number(b.professional_id) : null,
  };
}
function overlapCheck(a, ignoreId) {
  if (!a.professional_id || ['cancelado', 'falta'].includes(a.status)) return;
  const end = new Date(a.start).getTime() + a.duration * 60e3;
  const day = a.start.slice(0, 10);
  const rows = q.all("SELECT a.id, a.start, a.duration, p.name FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.professional_id=? AND substr(a.start,1,10)=? AND a.status NOT IN ('cancelado','falta') AND a.id<>?", a.professional_id, day, ignoreId || 0);
  for (const r of rows) {
    const s = new Date(r.start).getTime(); const e = s + r.duration * 60e3;
    if (s < end && new Date(a.start).getTime() < e) return `Conflito de horário com ${r.name} às ${r.start.slice(11)}`;
  }
}
// Gera cobrança automaticamente quando atendimento avulso é marcado como realizado
function syncCharge(ctx, apptId) {
  const a = q.get('SELECT * FROM appointments WHERE id=?', apptId);
  const ch = a.charge_id ? q.get('SELECT * FROM charges WHERE id=?', a.charge_id) : null;
  if (a.status === 'realizado' && a.price > 0 && !ch) {
    const [y, m, d] = a.start.slice(0, 10).split('-');
    const r = q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, appointment_id, created_by) VALUES (?,?,?,?,?,?,?)',
      a.patient_id, a.professional_id, `Atendimento de fisioterapia — ${d}/${m}/${y}`, a.price, a.start.slice(0, 10), a.id, ctx.user.id);
    q.run('UPDATE appointments SET charge_id=? WHERE id=?', Number(r.lastInsertRowid), a.id);
  } else if (a.status !== 'realizado' && ch && ch.status === 'pendente') {
    q.run('DELETE FROM charges WHERE id=?', ch.id);
    q.run('UPDATE appointments SET charge_id=NULL WHERE id=?', a.id);
  } else if (ch && ch.status === 'pendente') {
    // cobrança pendente acompanha o atendimento (paciente, profissional e valor)
    q.run('UPDATE charges SET patient_id=?, professional_id=?, amount=? WHERE id=?',
      a.patient_id, a.professional_id, a.price > 0 ? a.price : ch.amount, ch.id);
  }
}
route('GET', '/api/appointments', (ctx) => {
  const sp = ctx.query; const s = scope(ctx.user);
  let sql = `SELECT a.*, p.name patient_name, p.phone, u.name professional_name, c.status charge_status FROM appointments a JOIN patients p ON p.id=a.patient_id
    LEFT JOIN users u ON u.id=a.professional_id LEFT JOIN charges c ON c.id=a.charge_id WHERE 1=1 ${s.sql}`;
  const params = [...s.params];
  if (sp.get('from')) { sql += ' AND a.start >= ?'; params.push(sp.get('from')); }
  if (sp.get('to')) { sql += ' AND a.start < ?'; params.push(sp.get('to')); }
  if (sp.get('patient_id')) { sql += ' AND a.patient_id = ?'; params.push(Number(sp.get('patient_id'))); }
  if (sp.get('professional_id')) { sql += ' AND a.professional_id = ?'; params.push(Number(sp.get('professional_id'))); }
  sql += ' ORDER BY a.start' + (sp.get('desc') ? ' DESC' : '') + ' LIMIT 2000';
  return q.all(sql, ...params);
});
route('POST', '/api/appointments', (ctx) => {
  const p = getPatient(ctx.user, ctx.body.patient_id);
  const a = apptInput(ctx.body);
  if (!a.professional_id) a.professional_id = p.professional_id || (ctx.user.role !== 'recepcao' ? ctx.user.id : null);
  const repeat = Math.max(1, Math.min(52, Number(ctx.body.repeat_weeks) || 1));
  const starts = [];
  for (let i = 0; i < repeat; i++) {
    const d = new Date(a.start); d.setDate(d.getDate() + 7 * i);
    starts.push(`${ymd(d)}T${a.start.slice(11)}`);
  }
  // verifica conflito em todas as ocorrências da série, não apenas na primeira
  const conflicts = starts.map((start, i) => {
    const c = overlapCheck({ ...a, start, status: i === 0 ? a.status : 'agendado' });
    return c && (repeat > 1 ? `${start.slice(8, 10)}/${start.slice(5, 7)}: ${c}` : c);
  }).filter(Boolean);
  if (conflicts.length && !ctx.body.force) {
    const more = conflicts.length > 5 ? `\n… e mais ${conflicts.length - 5} conflito(s)` : '';
    throw new HttpError(409, conflicts.slice(0, 5).join('\n') + more);
  }
  return tx(() => {
    const ids = [];
    for (let i = 0; i < repeat; i++) {
      const start = starts[i];
      const r = q.run('INSERT INTO appointments(patient_id,professional_id,start,duration,kind,status,price,notes) VALUES (?,?,?,?,?,?,?,?)',
        p.id, a.professional_id, start, a.duration, a.kind, i === 0 ? a.status : 'agendado', a.price, a.notes);
      ids.push(Number(r.lastInsertRowid)); syncCharge(ctx, ids[ids.length - 1]);
    }
    audit(ctx, 'criou', 'appointment', ids[0], p.id, { start: a.start, repeticoes: repeat });
    return { ids };
  });
});
route('PUT', '/api/appointments/:id', (ctx) => {
  const ex = q.get('SELECT * FROM appointments WHERE id=?', Number(ctx.params.id)); if (!ex) throw new HttpError(404, 'Agendamento não encontrado');
  getPatient(ctx.user, ex.patient_id);
  const pid = ctx.body.patient_id ? getPatient(ctx.user, ctx.body.patient_id).id : ex.patient_id;
  if (pid !== ex.patient_id && ex.charge_id && q.get("SELECT 1 FROM charges WHERE id=? AND status='pago'", ex.charge_id)) {
    throw new HttpError(400, 'Este atendimento já tem pagamento registrado (recibo emitido) e não pode ser transferido para outro paciente. Estorne o pagamento primeiro.');
  }
  const a = apptInput({ ...ex, ...ctx.body });
  const conflict = overlapCheck(a, ex.id);
  if (conflict && !ctx.body.force) throw new HttpError(409, conflict);
  return tx(() => {
    q.run('UPDATE appointments SET patient_id=?, professional_id=?, start=?, duration=?, kind=?, status=?, price=?, notes=? WHERE id=?',
      pid, a.professional_id, a.start, a.duration, a.kind, a.status, a.price, a.notes, ex.id);
    syncCharge(ctx, ex.id);
    audit(ctx, 'alterou', 'appointment', ex.id, pid, { status: a.status, start: a.start });
    return { ok: true };
  });
});
route('DELETE', '/api/appointments/:id', (ctx) => {
  const ex = q.get('SELECT * FROM appointments WHERE id=?', Number(ctx.params.id)); if (!ex) throw new HttpError(404, 'Agendamento não encontrado');
  getPatient(ctx.user, ex.patient_id);
  if (ex.charge_id && q.get("SELECT 1 FROM charges WHERE id=? AND status='pago'", ex.charge_id)) throw new HttpError(400, 'Este atendimento possui pagamento registrado. Altere a situação em vez de excluir.');
  tx(() => { if (ex.charge_id) q.run('DELETE FROM charges WHERE id=?', ex.charge_id); q.run('DELETE FROM appointments WHERE id=?', ex.id); });
  audit(ctx, 'excluiu', 'appointment', ex.id, ex.patient_id, { start: ex.start });
  return { ok: true };
});

// ====================== Financeiro ======================
const METHODS = ['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'transferencia'];
const FIN_ROLES = ['admin', 'fisio', 'recepcao'];
function crud(table, fields, label) {
  route('GET', `/api/${table}`, () => q.all(`SELECT * FROM ${table} ORDER BY active DESC, name`));
  route('POST', `/api/${table}`, (ctx) => {
    requireRole(ctx.user, ['admin', 'fisio']);
    const vals = fields.map(([k, fn]) => fn(ctx.body[k]));
    const r = q.run(`INSERT INTO ${table}(${fields.map((f) => f[0]).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...vals);
    audit(ctx, 'criou', label, Number(r.lastInsertRowid)); return { id: Number(r.lastInsertRowid) };
  });
  route('PUT', `/api/${table}/:id`, (ctx) => {
    requireRole(ctx.user, ['admin', 'fisio']);
    const ex = q.get(`SELECT * FROM ${table} WHERE id=?`, Number(ctx.params.id)); if (!ex) throw new HttpError(404, 'Não encontrado');
    const vals = fields.map(([k, fn]) => fn(ctx.body[k] ?? ex[k]));
    q.run(`UPDATE ${table} SET ${fields.map((f) => f[0] + '=?').join(',')}, active=? WHERE id=?`, ...vals, ctx.body.active === undefined ? ex.active : (ctx.body.active ? 1 : 0), ex.id);
    audit(ctx, 'alterou', label, ex.id); return { ok: true };
  });
}
crud('services', [['name', (v) => reqStr(v, 'Nome', 120)], ['price', (v) => num(v, 'Valor', { required: true })], ['duration', (v) => Number(v) || 50]], 'service');
crud('packages', [['name', (v) => reqStr(v, 'Nome', 120)], ['sessions', (v) => Math.max(1, Number(v) || 1)], ['price', (v) => num(v, 'Valor', { required: true })]], 'package');

route('GET', '/api/patient-packages', (ctx) => {
  const s = scope(ctx.user); const sp = ctx.query;
  let sql = `SELECT pp.*, p.name patient_name,
    (SELECT COUNT(*) FROM appointments a WHERE a.patient_id=pp.patient_id AND a.status='realizado' AND substr(a.start,1,10) BETWEEN pp.start_date AND pp.end_date) used,
    (SELECT status FROM charges c WHERE c.patient_package_id=pp.id ORDER BY id LIMIT 1) charge_status
    FROM patient_packages pp JOIN patients p ON p.id=pp.patient_id WHERE 1=1 ${s.sql}`;
  const params = [...s.params];
  if (sp.get('patient_id')) { sql += ' AND pp.patient_id=?'; params.push(Number(sp.get('patient_id'))); }
  return q.all(sql + ' ORDER BY pp.start_date DESC', ...params);
});
route('POST', '/api/patient-packages', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const p = getPatient(ctx.user, ctx.body.patient_id); const b = ctx.body;
  const pkg = b.package_id ? q.get('SELECT * FROM packages WHERE id=?', Number(b.package_id)) : null;
  if (b.package_id && !pkg) throw new HttpError(400, 'Pacote não encontrado');
  if (!pkg && (!Number(b.sessions) || b.price === undefined || b.price === '')) throw new HttpError(400, 'Informe o número de sessões e o valor do pacote');
  const start = date(b.start_date, 'Início', true);
  let end = date(b.end_date, 'Fim');
  if (!end) { const d = new Date(start + 'T12:00'); d.setMonth(d.getMonth() + 1); d.setDate(d.getDate() - 1); end = ymd(d); }
  const name = str(b.name, 120) || pkg?.name || 'Pacote mensal';
  const sessions = Number(b.sessions) || pkg?.sessions || 1;
  const price = b.price !== undefined && b.price !== '' ? num(b.price, 'Valor') : pkg?.price || 0;
  return tx(() => {
    const r = q.run('INSERT INTO patient_packages(patient_id,package_id,name,sessions,price,start_date,end_date) VALUES (?,?,?,?,?,?,?)', p.id, pkg?.id || null, name, sessions, price, start, end);
    const id = Number(r.lastInsertRowid);
    if (price > 0) q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, patient_package_id, created_by) VALUES (?,?,?,?,?,?,?)',
      p.id, p.professional_id, `${name} (${sessions} sessões) — ${start.split('-').reverse().join('/')} a ${end.split('-').reverse().join('/')}`, price, date(b.due_date, 'Vencimento') || start, id, ctx.user.id);
    audit(ctx, 'criou', 'patient_package', id, p.id);
    return { id };
  });
});
route('PUT', '/api/patient-packages/:id', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const ex = q.get('SELECT * FROM patient_packages WHERE id=?', Number(ctx.params.id)); if (!ex) throw new HttpError(404, 'Não encontrado');
  getPatient(ctx.user, ex.patient_id);
  q.run('UPDATE patient_packages SET status=? WHERE id=?', oneOf(ctx.body.status, ['ativo', 'encerrado', 'cancelado'], 'Situação', ex.status), ex.id);
  audit(ctx, 'alterou', 'patient_package', ex.id, ex.patient_id); return { ok: true };
});

function chargeQuery(ctx) {
  const s = scope(ctx.user); const sp = ctx.query;
  let sql = `SELECT c.*, p.name patient_name, p.cpf patient_cpf, u.name professional_name FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN users u ON u.id=c.professional_id WHERE 1=1 ${s.sql}`;
  const params = [...s.params];
  if (sp.get('status')) { sql += ' AND c.status=?'; params.push(sp.get('status')); }
  if (sp.get('patient_id')) { sql += ' AND c.patient_id=?'; params.push(Number(sp.get('patient_id'))); }
  if (sp.get('professional_id')) { sql += ' AND c.professional_id=?'; params.push(Number(sp.get('professional_id'))); }
  const field = sp.get('by') === 'paid' ? 'c.paid_at' : 'c.due_date';
  if (sp.get('from')) { sql += ` AND ${field} >= ?`; params.push(sp.get('from')); }
  if (sp.get('to')) { sql += ` AND ${field} <= ?`; params.push(sp.get('to')); }
  if (sp.get('overdue')) { sql += " AND c.status='pendente' AND c.due_date < ?"; params.push(today()); }
  return { sql, params };
}
route('GET', '/api/charges', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const { sql, params } = chargeQuery(ctx);
  return q.all(sql + ' ORDER BY COALESCE(c.paid_at, c.due_date) DESC, c.id DESC LIMIT 3000', ...params);
});
route('GET', '/api/charges/:id', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = q.get('SELECT c.*, p.name patient_name, p.cpf patient_cpf, p.address patient_address, u.name professional_name, u.crefito professional_crefito FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN users u ON u.id=c.professional_id WHERE c.id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  getPatient(ctx.user, c.patient_id); return c;
});
// Numeração de recibos: contador anual que nunca retrocede (recibos estornados/cancelados não são reaproveitados).
// Usar sempre dentro de tx() para que contador e lançamento sejam gravados juntos.
function nextReceipt(paidAt) {
  const y = paidAt.slice(0, 4);
  const key = `receipt_seq_${y}`;
  const numOf = (r) => Number(String(r || '').split('-')[1]) || 0;
  let lastN = Number(q.get('SELECT value FROM settings WHERE key=?', key)?.value) || 0;
  // maior número ainda presente nos lançamentos
  const last = q.get('SELECT receipt_number r FROM charges WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1', `${y}-%`);
  lastN = Math.max(lastN, numOf(last?.r));
  // números já emitidos e depois estornados/cancelados (registrados apenas na auditoria — bases anteriores ao contador)
  for (const a of q.all("SELECT details FROM audit_log WHERE action IN ('estornou','cancelou') AND entity='charge' AND details LIKE ?", `%"recibo":"${y}-%`)) {
    try { lastN = Math.max(lastN, numOf(JSON.parse(a.details).recibo)); } catch { /* detalhe ilegível */ }
  }
  const n = lastN + 1;
  q.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(n));
  return `${y}-${String(n).padStart(5, '0')}`;
}
function payFields(b) {
  return { paid_at: date(b.paid_at, 'Data do pagamento', true), method: oneOf(b.method, METHODS, 'Forma de pagamento'), payer_name: str(b.payer_name, 160), payer_cpf: cpfField(b.payer_cpf, 'CPF do pagador') };
}
route('POST', '/api/charges', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const p = getPatient(ctx.user, ctx.body.patient_id); const b = ctx.body;
  const amount = num(b.amount, 'Valor', { required: true }); if (amount <= 0) throw new HttpError(400, 'Valor deve ser maior que zero');
  const paid = b.status === 'pago';
  const pf = paid ? payFields(b) : {};
  if (paid && !pf.method) throw new HttpError(400, 'Informe a forma de pagamento');
  return tx(() => {
    const r = q.run('INSERT INTO charges(patient_id, professional_id, description, amount, due_date, status, paid_at, method, payer_name, payer_cpf, receipt_number, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      p.id, b.professional_id ? Number(b.professional_id) : p.professional_id || (ctx.user.role !== 'recepcao' ? ctx.user.id : null), reqStr(b.description, 'Descrição', 300), amount,
      date(b.due_date, 'Vencimento') || today(), paid ? 'pago' : 'pendente', pf.paid_at || null, pf.method || null, pf.payer_name || null, pf.payer_cpf || null,
      paid ? nextReceipt(pf.paid_at) : null, str(b.notes, 1000), ctx.user.id);
    audit(ctx, 'criou', 'charge', Number(r.lastInsertRowid), p.id, { amount, paid });
    return { id: Number(r.lastInsertRowid) };
  });
});
route('PUT', '/api/charges/:id', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = q.get('SELECT * FROM charges WHERE id=?', Number(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  getPatient(ctx.user, c.patient_id); const b = { ...c, ...ctx.body };
  const amount = num(b.amount, 'Valor', { required: true });
  q.run('UPDATE charges SET description=?, amount=?, due_date=?, notes=?, professional_id=?, payer_name=?, payer_cpf=?, method=? WHERE id=?',
    reqStr(b.description, 'Descrição', 300), amount, date(b.due_date, 'Vencimento', true), str(b.notes, 1000), b.professional_id ? Number(b.professional_id) : null,
    str(b.payer_name, 160), cpfField(b.payer_cpf, 'CPF do pagador'), c.status === 'pago' ? oneOf(b.method, METHODS, 'Forma de pagamento') : c.method, c.id);
  audit(ctx, 'alterou', 'charge', c.id, c.patient_id, { de: c.amount, para: amount });
  return { ok: true };
});
route('POST', '/api/charges/:id/pay', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = q.get('SELECT * FROM charges WHERE id=?', Number(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  getPatient(ctx.user, c.patient_id);
  if (c.status === 'pago') throw new HttpError(400, 'Este lançamento já está pago');
  const pf = payFields({ paid_at: today(), ...ctx.body });
  if (!pf.method) throw new HttpError(400, 'Informe a forma de pagamento');
  return tx(() => {
    q.run("UPDATE charges SET status='pago', paid_at=?, method=?, payer_name=?, payer_cpf=?, receipt_number=? WHERE id=?",
      pf.paid_at, pf.method, pf.payer_name, pf.payer_cpf, nextReceipt(pf.paid_at), c.id);
    audit(ctx, 'registrou_pagamento', 'charge', c.id, c.patient_id, { amount: c.amount, method: pf.method });
    return { ok: true };
  });
});
route('POST', '/api/charges/:id/status', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const c = q.get('SELECT * FROM charges WHERE id=?', Number(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  getPatient(ctx.user, c.patient_id);
  const st = oneOf(ctx.body.status, ['pendente', 'cancelado'], 'Situação');
  // estorno: volta para pendente mantendo o número do recibo no histórico de auditoria
  q.run('UPDATE charges SET status=?, paid_at=NULL, method=NULL, receipt_number=NULL WHERE id=?', st, c.id);
  audit(ctx, st === 'cancelado' ? 'cancelou' : 'estornou', 'charge', c.id, c.patient_id, { recibo: c.receipt_number, amount: c.amount });
  return { ok: true };
});
route('DELETE', '/api/charges/:id', (ctx) => {
  requireRole(ctx.user, ['admin', 'fisio']);
  const c = q.get('SELECT * FROM charges WHERE id=?', Number(ctx.params.id)); if (!c) throw new HttpError(404, 'Lançamento não encontrado');
  getPatient(ctx.user, c.patient_id);
  if (c.status === 'pago') throw new HttpError(400, 'Lançamentos pagos não podem ser excluídos. Faça o estorno primeiro.');
  q.run('UPDATE appointments SET charge_id=NULL WHERE charge_id=?', c.id);
  q.run('DELETE FROM charges WHERE id=?', c.id);
  audit(ctx, 'excluiu', 'charge', c.id, c.patient_id, { amount: c.amount, description: c.description });
  return { ok: true };
});
route('GET', '/api/finance/report', (ctx) => {
  requireRole(ctx.user, FIN_ROLES);
  const s = scope(ctx.user); const sp = ctx.query;
  const from = date(sp.get('from'), 'De', true); const to = date(sp.get('to'), 'Até', true);
  const base = `FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pago' AND c.paid_at BETWEEN ? AND ? ${s.sql}`;
  const ps = [from, to, ...s.params];
  return {
    from, to,
    total: q.get(`SELECT COALESCE(SUM(c.amount),0) v, COUNT(*) n ${base}`, ...ps),
    por_mes: q.all(`SELECT substr(c.paid_at,1,7) month, SUM(c.amount) v, COUNT(*) n ${base} GROUP BY month ORDER BY month`, ...ps),
    por_forma: q.all(`SELECT c.method, SUM(c.amount) v, COUNT(*) n ${base} GROUP BY c.method ORDER BY v DESC`, ...ps),
    por_paciente: q.all(`SELECT p.name, SUM(c.amount) v, COUNT(*) n ${base} GROUP BY p.id ORDER BY v DESC LIMIT 50`, ...ps),
    pendente: q.get(`SELECT COALESCE(SUM(c.amount),0) v, COUNT(*) n FROM charges c JOIN patients p ON p.id=c.patient_id WHERE c.status='pendente' AND c.due_date BETWEEN ? AND ? ${s.sql}`, ...ps),
  };
});
// Organização de dados para o Carnê-Leão — apenas consolida receitas; NÃO calcula imposto.
route('GET', '/api/finance/carne-leao', (ctx) => {
  requireRole(ctx.user, ['admin', 'fisio']);
  const sp = ctx.query; const year = String(sp.get('year') || new Date().getFullYear());
  if (!/^\d{4}$/.test(year)) throw new HttpError(400, 'Ano inválido');
  const s = scope(ctx.user);
  let sql = `SELECT c.id, c.paid_at, c.amount, c.method, c.description, c.receipt_number, c.payer_name, c.payer_cpf, p.name patient_name, p.cpf patient_cpf, u.name professional_name, u.id professional_id
    FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN users u ON u.id=c.professional_id WHERE c.status='pago' AND substr(c.paid_at,1,4)=? ${s.sql}`;
  const params = [year, ...s.params];
  if (sp.get('professional_id')) { sql += ' AND c.professional_id=?'; params.push(Number(sp.get('professional_id'))); }
  const rows = q.all(sql + ' ORDER BY c.paid_at, c.id', ...params);
  audit(ctx, 'consultou', 'carne_leao', null, null, year);
  return { year, rows };
});

// ====================== Auditoria e Backup ======================
route('GET', '/api/audit', (ctx) => {
  requireRole(ctx.user, ['admin']);
  const sp = ctx.query; let sql = 'SELECT * FROM audit_log WHERE 1=1'; const params = [];
  if (sp.get('patient_id')) { sql += ' AND patient_id=?'; params.push(Number(sp.get('patient_id'))); }
  if (sp.get('user_id')) { sql += ' AND user_id=?'; params.push(Number(sp.get('user_id'))); }
  if (sp.get('from')) { sql += ' AND ts >= ?'; params.push(sp.get('from')); }
  if (sp.get('to')) { sql += ' AND ts <= ?'; params.push(sp.get('to') + ' 23:59:59'); }
  return q.all(sql + ' ORDER BY id DESC LIMIT 1000', ...params);
});
route('GET', '/api/patients/:id/audit', (ctx) => {
  requireRole(ctx.user, CLINICAL); const p = getPatient(ctx.user, ctx.params.id);
  return q.all('SELECT ts, user_name, action, entity, entity_id, details FROM audit_log WHERE patient_id=? ORDER BY id DESC LIMIT 500', p.id);
});
route('GET', '/api/backups', (ctx) => { requireRole(ctx.user, ['admin']); return listBackups(); });
route('POST', '/api/backups', (ctx) => { requireRole(ctx.user, ['admin']); const name = backup('manual'); audit(ctx, 'backup', null, null, null, name); return { name }; });
route('GET', '/api/backups/:name', (ctx) => {
  requireRole(ctx.user, ['admin']);
  const name = ctx.params.name; if (!/^fisio-[\w-]+\.sqlite$/.test(name)) throw new HttpError(400, 'Nome inválido');
  const file = path.join(BACKUP_DIR, name); if (!fs.existsSync(file)) throw new HttpError(404, 'Backup não encontrado');
  audit(ctx, 'baixou_backup', null, null, null, name);
  return { __file: file, name };
});

// ====================== Servidor ======================
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Endereço inválido'); }
  if (!url.pathname.startsWith('/api/')) {
    try { return serveStatic(PUBLIC_DIR, req, res, url.pathname); }
    catch (e) { console.error(e); if (!res.headersSent) send(res, 500, 'Erro interno do servidor'); return; }
  }
  const ctx = { req, res, query: url.searchParams, ip: req.socket.remoteAddress, user: null, body: {} };
  try {
    const m = match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Rota não encontrada');
    // Proteção CSRF: requisições que alteram dados precisam do cabeçalho customizado (além do cookie SameSite=Strict)
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fisio') throw new HttpError(403, 'Requisição bloqueada');
    if (!m.route.opts.public) {
      ctx.user = sessionUser(req, res);
      if (!ctx.user) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
    }
    ctx.params = m.params;
    if (req.method !== 'GET') ctx.body = await readBody(req);
    const out = await m.route.handler(ctx);
    if (out && out.__file) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${out.name}"`, 'Cache-Control': 'no-store' });
      return fs.createReadStream(out.__file).pipe(res);
    }
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (!(e instanceof HttpError)) {
      console.error(e);
      const msg = /UNIQUE/.test(e.message) ? 'Registro duplicado' : 'Erro interno do servidor';
      return send(res, 500, { error: msg });
    }
    send(res, e.status, { error: e.message });
  }
});

// Backup automático: na inicialização (se o último tiver mais de 20h) e verificação a cada 6h
function autoBackup() {
  try {
    const last = listBackups().find((b) => b.name.endsWith('-auto.sqlite'));
    if (!last || Date.now() - new Date(last.mtime).getTime() > 20 * 3600e3) console.log('Backup automático:', backup('auto'));
  } catch (e) { console.error('Falha no backup automático', e); }
}
autoBackup();
setInterval(autoBackup, 6 * 3600e3).unref();
setInterval(() => q.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 3600e3).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  FisioGestão rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
});

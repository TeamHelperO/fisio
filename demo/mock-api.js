/* FisioGestão — modo demonstração.
 * Reimplementa a API do servidor dentro do navegador (intercepta fetch('/api/...')).
 * Os dados ficam apenas no navegador de quem está testando (localStorage), com dados fictícios iniciais. */
(function () {
  'use strict';
  window.FISIO_DEMO = true;

  // Dentro do iframe de documentos, reutiliza o backend da página principal (mesma origem)
  try {
    if (window.parent !== window && window.parent.FISIO_BACKEND) { installFetch(window.parent.FISIO_BACKEND); return; }
  } catch (e) { /* origem diferente: segue */ }

  const KEY = 'fisio-demo-v2';
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const nowLocal = () => { const d = new Date(); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const stamp = () => { const d = new Date(); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

  // ---------------- Armazenamento ----------------
  let db = null; let seeding = false;
  function blank() {
    return { seq: {}, users: [], patients: [], consents: [], records: [], record_versions: [], appointments: [], services: [], packages: [], patient_packages: [], charges: [], audit_log: [], settings: {}, session: null };
  }
  function load() { try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { /* indisponível */ } return null; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* memória apenas */ } }
  const nextId = (t) => (db.seq[t] = (db.seq[t] || 0) + 1);
  const insert = (t, row) => { const r = { id: nextId(t), ...row }; db[t].push(r); return r; };
  const byId = (t, id) => db[t].find((r) => r.id === Number(id));

  // ---------------- Validação (igual ao servidor) ----------------
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  function str(v, max = 500) { if (v === undefined || v === null) return null; const s = String(v).trim(); if (!s) return null; if (s.length > max) throw new HttpError(400, `Texto muito longo (máx. ${max} caracteres)`); return s; }
  function reqStr(v, label, max) { const s = str(v, max); if (!s) throw new HttpError(400, `${label} é obrigatório`); return s; }
  function date(v, label, required = false) { const s = str(v, 10); if (!s) { if (required) throw new HttpError(400, `${label} é obrigatório`); return null; } if (!DATE_RE.test(s)) throw new HttpError(400, `${label}: data inválida`); return s; }
  function num(v, label, { required = false } = {}) { if (v === '' || v === null || v === undefined) { if (required) throw new HttpError(400, `${label} é obrigatório`); return 0; } const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label}: valor inválido`); return Math.round(n * 100) / 100; }
  function oneOf(v, list, label, def) { if (v === undefined || v === null || v === '') return def; if (!list.includes(v)) throw new HttpError(400, `${label}: opção inválida`); return v; }
  function validCPF(cpf) {
    const c = String(cpf).replace(/\D/g, ''); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    let s = 0; for (let i = 0; i < 9; i++) s += +c[i] * (10 - i); let d = (s * 10) % 11 % 10; if (d !== +c[9]) return false;
    s = 0; for (let i = 0; i < 10; i++) s += +c[i] * (11 - i); d = (s * 10) % 11 % 10; return d === +c[10];
  }
  function cpfField(v, label = 'CPF') { const s = str(v, 20); if (!s) return null; if (!validCPF(s)) throw new HttpError(400, `${label} inválido`); const c = s.replace(/\D/g, ''); return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`; }

  // ---------------- Acesso ----------------
  const CLINICAL = ['admin', 'fisio']; const ROLES = ['admin', 'fisio', 'recepcao'];
  const requireRole = (u, roles) => { if (!roles.includes(u.role)) throw new HttpError(403, 'Acesso não permitido para o seu perfil'); };
  const inScope = (u, p) => u.role !== 'fisio' || !p.professional_id || p.professional_id === u.id;
  function getPatient(u, id) {
    const p = byId('patients', id); if (!p) throw new HttpError(404, 'Paciente não encontrado');
    if (!inScope(u, p)) throw new HttpError(403, 'Este paciente está sob responsabilidade de outro profissional');
    return p;
  }
  const scoped = (u) => db.patients.filter((p) => inScope(u, p));
  const pubUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, crefito: u.crefito, active: u.active };
  function audit(ctx, action, entity, entity_id, patient_id, details) {
    insert('audit_log', { ts: stamp(), user_id: ctx.user?.id ?? null, user_name: ctx.user?.name ?? null, action, entity: entity || null, entity_id: entity_id ?? null, patient_id: patient_id ?? null,
      details: details ? (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 2000) : null, ip: 'navegador (demo)' });
  }
  const userName = (id) => byId('users', id)?.name;
  const patName = (id) => byId('patients', id)?.name;

  // ---------------- Rotas ----------------
  const routes = [];
  function route(method, pattern, handler, opts = {}) {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, opts });
  }

  route('GET', '/api/setup-status', () => ({ needsSetup: false }), { public: true });
  route('POST', '/api/login', (ctx) => {
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const u = db.users.find((x) => x.email === email);
    if (!u || !u.active || String(ctx.body.password || '') !== u.password) { ctx.user = null; audit(ctx, 'login_falhou', 'user', u?.id, null, email); throw new HttpError(401, 'E-mail ou senha incorretos'); }
    u.last_login = stamp(); db.session = u.id; ctx.user = u; audit(ctx, 'login', 'user', u.id); return { ok: true };
  }, { public: true });
  route('POST', '/api/logout', (ctx) => { audit(ctx, 'logout', 'user', ctx.user.id); db.session = null; return { ok: true }; });
  route('GET', '/api/me', (ctx) => ({ user: pubUser(ctx.user), settings: { ...db.settings } }));
  route('POST', '/api/me/password', (ctx) => {
    const u = ctx.user; if (String(ctx.body.current || '') !== u.password) throw new HttpError(400, 'Senha atual incorreta');
    if (typeof ctx.body.password !== 'string' || ctx.body.password.length < 8 || !/[A-Za-z]/.test(ctx.body.password) || !/\d/.test(ctx.body.password)) throw new HttpError(400, 'A senha deve ter pelo menos 8 caracteres, com letras e números');
    u.password = ctx.body.password; audit(ctx, 'alterou_senha', 'user', u.id); return { ok: true };
  });

  route('GET', '/api/users', (ctx) => {
    if (ctx.user.role === 'admin') return db.users.map((u) => ({ ...pubUser(u), created_at: u.created_at, last_login: u.last_login })).sort((a, b) => a.name.localeCompare(b.name));
    return db.users.filter((u) => u.active && u.role !== 'recepcao').map((u) => ({ id: u.id, name: u.name, role: u.role, crefito: u.crefito }));
  });
  route('POST', '/api/users', (ctx) => {
    requireRole(ctx.user, ['admin']); const b = ctx.body;
    if (typeof b.password !== 'string' || b.password.length < 8) throw new HttpError(400, 'A senha deve ter pelo menos 8 caracteres');
    const email = reqStr(b.email, 'E-mail', 160).toLowerCase(); if (db.users.some((u) => u.email === email)) throw new HttpError(400, 'E-mail já cadastrado');
    const u = insert('users', { name: reqStr(b.name, 'Nome', 120), email, password: b.password, role: oneOf(b.role, ROLES, 'Perfil', 'fisio'), crefito: str(b.crefito, 40), active: 1, created_at: stamp(), last_login: null });
    audit(ctx, 'criou', 'user', u.id, null, { email, role: u.role }); return { id: u.id };
  });
  route('PUT', '/api/users/:id', (ctx) => {
    requireRole(ctx.user, ['admin']); const u = byId('users', ctx.params.id); if (!u) throw new HttpError(404, 'Usuário não encontrado'); const b = ctx.body;
    const role = oneOf(b.role, ROLES, 'Perfil', u.role); const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
    if (u.id === ctx.user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'Você não pode remover seu próprio acesso de administrador');
    Object.assign(u, { name: reqStr(b.name ?? u.name, 'Nome', 120), email: reqStr(b.email ?? u.email, 'E-mail', 160).toLowerCase(), role, crefito: str(b.crefito ?? u.crefito, 40), active });
    if (b.password) u.password = b.password;
    audit(ctx, 'alterou', 'user', u.id, null, { role, active }); return { ok: true };
  });

  route('GET', '/api/settings', () => ({ ...db.settings }));
  route('PUT', '/api/settings', (ctx) => {
    requireRole(ctx.user, ['admin']);
    const before = { ...db.settings };
    for (const k of ['clinic_name', 'professional_name', 'crefito', 'professional_cpf', 'phone', 'email', 'address', 'city', 'consent_text', 'consent_version']) {
      if (ctx.body[k] === undefined) continue; let v = str(ctx.body[k], k === 'consent_text' ? 20000 : 300) || '';
      if (k === 'professional_cpf' && v) v = cpfField(v, 'CPF do profissional'); db.settings[k] = v;
    }
    if (ctx.body.consent_text !== undefined && ctx.body.consent_text !== before.consent_text && ctx.body.consent_version === before.consent_version) db.settings.consent_version = ((parseFloat(before.consent_version) || 1) + 0.1).toFixed(1);
    audit(ctx, 'alterou', 'settings'); return { ...db.settings };
  });

  route('GET', '/api/dashboard', (ctx) => {
    const ps = scoped(ctx.user); const ids = new Set(ps.map((p) => p.id));
    const d = new Date(); const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const ap = db.appointments.filter((a) => ids.has(a.patient_id)); const ch = db.charges.filter((c) => ids.has(c.patient_id));
    const sum = (l) => l.reduce((s, c) => s + c.amount, 0);
    const pend = ch.filter((c) => c.status === 'pendente'); const venc = pend.filter((c) => c.due_date < today());
    const out = {
      total: ps.length, em_tratamento: ps.filter((p) => ['em_tratamento', 'avaliacao'].includes(p.status)).length, finalizado: ps.filter((p) => p.status === 'finalizado').length,
      agendadas: ap.filter((a) => a.start >= nowLocal() && ['agendado', 'confirmado'].includes(a.status)).length,
      realizados_mes: ap.filter((a) => a.start.slice(0, 7) === month && a.status === 'realizado').length,
      faltas_mes: ap.filter((a) => a.start.slice(0, 7) === month && a.status === 'falta').length,
      faturamento_mes: sum(ch.filter((c) => c.status === 'pago' && (c.paid_at || '').slice(0, 7) === month)),
      pendentes: { n: pend.length, v: sum(pend) }, vencidos: { n: venc.length, v: sum(venc) },
      proximos: ap.filter((a) => a.start >= `${today()}T00:00` && ['agendado', 'confirmado'].includes(a.status)).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 12)
        .map((a) => ({ ...a, patient_name: patName(a.patient_id), phone: byId('patients', a.patient_id)?.phone, professional_name: userName(a.professional_id) })),
      receita_6m: [],
    };
    for (let i = 5; i >= 0; i--) { const m = new Date(d.getFullYear(), d.getMonth() - i, 1); const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`; out.receita_6m.push({ month: key, value: sum(ch.filter((c) => c.status === 'pago' && (c.paid_at || '').slice(0, 7) === key)) }); }
    return out;
  });

  // ---------------- Pacientes ----------------
  function patientFields(b) {
    return { name: reqStr(b.name, 'Nome completo', 160), birth_date: date(b.birth_date, 'Data de nascimento'), cpf: cpfField(b.cpf), phone: str(b.phone, 40), email: str(b.email, 160),
      address: str(b.address, 400), profession: str(b.profession, 120), emergency_name: str(b.emergency_name, 160), emergency_phone: str(b.emergency_phone, 40),
      first_visit: date(b.first_visit, 'Primeiro atendimento'), status: oneOf(b.status, ['avaliacao', 'em_tratamento', 'finalizado', 'inativo'], 'Situação', 'em_tratamento'),
      professional_id: b.professional_id ? Number(b.professional_id) : null, notes: str(b.notes, 4000) };
  }
  route('GET', '/api/patients', (ctx) => {
    const t = (ctx.query.get('q') || '').toLowerCase(); const st = ctx.query.get('status'); const now = nowLocal();
    return scoped(ctx.user).filter((p) => (!t || [p.name, p.cpf, p.phone].some((x) => (x || '').toLowerCase().includes(t))) && (!st || p.status === st))
      .map((p) => {
        const ap = db.appointments.filter((a) => a.patient_id === p.id);
        const done = ap.filter((a) => a.status === 'realizado').map((a) => a.start).sort(); const next = ap.filter((a) => ['agendado', 'confirmado'].includes(a.status) && a.start >= now).map((a) => a.start).sort();
        return { id: p.id, name: p.name, birth_date: p.birth_date, cpf: p.cpf, phone: p.phone, status: p.status, first_visit: p.first_visit, professional_id: p.professional_id, professional_name: userName(p.professional_id),
          consent: db.consents.filter((c) => c.patient_id === p.id && !c.revoked_at).length, last_visit: done[done.length - 1] || null, next_visit: next[0] || null };
      }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  });
  route('POST', '/api/patients', (ctx) => {
    const f = patientFields(ctx.body); if (ctx.user.role === 'fisio' && !f.professional_id) f.professional_id = ctx.user.id;
    const p = insert('patients', { ...f, created_at: stamp(), updated_at: stamp() }); audit(ctx, 'criou', 'patient', p.id, p.id); return { id: p.id };
  });
  route('GET', '/api/patients/:id', (ctx) => {
    const p = getPatient(ctx.user, ctx.params.id); const prof = byId('users', p.professional_id);
    const consent = db.consents.filter((c) => c.patient_id === p.id && !c.revoked_at).sort((a, b) => b.accepted_at.localeCompare(a.accepted_at))[0] || null;
    const counts = {};
    if (CLINICAL.includes(ctx.user.role)) for (const r of db.records.filter((r) => r.patient_id === p.id && !r.deleted_at)) counts[r.type] = (counts[r.type] || 0) + 1;
    const ap = db.appointments.filter((a) => a.patient_id === p.id);
    counts.realizados = ap.filter((a) => a.status === 'realizado').length; counts.faltas = ap.filter((a) => a.status === 'falta').length;
    counts.pendente = db.charges.filter((c) => c.patient_id === p.id && c.status === 'pendente').reduce((s, c) => s + c.amount, 0);
    const next = ap.filter((a) => ['agendado', 'confirmado'].includes(a.status) && a.start >= nowLocal()).sort((a, b) => a.start.localeCompare(b.start))[0] || null;
    audit(ctx, 'visualizou', 'patient', p.id, p.id);
    return { ...p, professional_name: prof?.name, professional_crefito: prof?.crefito, consent, counts, next };
  });
  route('PUT', '/api/patients/:id', (ctx) => {
    const p = getPatient(ctx.user, ctx.params.id); const f = patientFields({ ...p, ...ctx.body });
    const changed = Object.keys(ctx.body).filter((k) => String(ctx.body[k] ?? '') !== String(p[k] ?? ''));
    Object.assign(p, f, { updated_at: stamp() }); audit(ctx, 'alterou', 'patient', p.id, p.id, { campos: changed }); return { ok: true };
  });
  route('DELETE', '/api/patients/:id', (ctx) => {
    requireRole(ctx.user, ['admin']); const p = getPatient(ctx.user, ctx.params.id);
    if (String(ctx.body.confirm || '').trim() !== p.name) throw new HttpError(400, 'Digite o nome completo do paciente para confirmar a exclusão');
    for (const t of ['consents', 'records', 'appointments', 'patient_packages', 'charges']) db[t] = db[t].filter((r) => r.patient_id !== p.id);
    db.patients = db.patients.filter((x) => x.id !== p.id); audit(ctx, 'excluiu', 'patient', p.id, p.id, { nome: p.name }); return { ok: true };
  });
  route('GET', '/api/patients/:id/export', (ctx) => {
    requireRole(ctx.user, CLINICAL); const p = getPatient(ctx.user, ctx.params.id); audit(ctx, 'exportou_dados', 'patient', p.id, p.id);
    return { exportado_em: new Date().toISOString(), paciente: p, consentimentos: db.consents.filter((c) => c.patient_id === p.id), registros_clinicos: db.records.filter((r) => r.patient_id === p.id && !r.deleted_at),
      agendamentos: db.appointments.filter((a) => a.patient_id === p.id), financeiro: db.charges.filter((c) => c.patient_id === p.id) };
  });
  route('GET', '/api/patients/:id/consents', (ctx) => { const p = getPatient(ctx.user, ctx.params.id); return db.consents.filter((c) => c.patient_id === p.id).map((c) => ({ ...c, registered_by_name: userName(c.registered_by) })).sort((a, b) => b.accepted_at.localeCompare(a.accepted_at)); });
  route('POST', '/api/patients/:id/consents', (ctx) => {
    const p = getPatient(ctx.user, ctx.params.id);
    const c = insert('consents', { patient_id: p.id, term_version: db.settings.consent_version, term_hash: 'demo', method: oneOf(ctx.body.method, ['assinatura_fisica', 'assinatura_digital', 'aceite_presencial'], 'Forma', 'assinatura_fisica'),
      signer_name: reqStr(ctx.body.signer_name || p.name, 'Nome do titular/responsável', 160), accepted_at: date(ctx.body.accepted_at, 'Data') || today(), registered_by: ctx.user.id, revoked_at: null, revoke_reason: null });
    audit(ctx, 'registrou_consentimento', 'consent', c.id, p.id); return { id: c.id };
  });
  route('POST', '/api/consents/:id/revoke', (ctx) => {
    const c = byId('consents', ctx.params.id); if (!c) throw new HttpError(404, 'Não encontrado'); getPatient(ctx.user, c.patient_id);
    c.revoked_at = today(); c.revoke_reason = str(ctx.body.reason, 500); audit(ctx, 'revogou_consentimento', 'consent', c.id, c.patient_id); return { ok: true };
  });
  route('GET', '/api/patients/:id/audit', (ctx) => {
    requireRole(ctx.user, CLINICAL); const p = getPatient(ctx.user, ctx.params.id);
    return db.audit_log.filter((l) => l.patient_id === p.id).slice(-500).reverse().map(({ ts, user_name, action, entity, entity_id, details }) => ({ ts, user_name, action, entity, entity_id, details }));
  });

  // ---------------- Registros clínicos ----------------
  const RTYPES = ['anamnese', 'avaliacao', 'plano', 'evolucao'];
  const withNames = (r) => ({ ...r, patient_name: patName(r.patient_id), author_name: userName(r.author_id) });
  const meta = (r) => { const { data, ...rest } = r; return rest; };
  route('GET', '/api/records', (ctx) => {
    requireRole(ctx.user, CLINICAL); const q = ctx.query;
    const ids = new Set(scoped(ctx.user).map((p) => p.id));
    if (q.get('patient_id')) getPatient(ctx.user, q.get('patient_id'));
    const t = (q.get('q') || '').toLowerCase();
    const full = q.get('full') === '1' && q.get('patient_id');
    const rows = db.records.filter((r) => !r.deleted_at && ids.has(r.patient_id) && (!q.get('type') || r.type === q.get('type')) && (!q.get('patient_id') || r.patient_id === Number(q.get('patient_id'))) && (!t || (patName(r.patient_id) || '').toLowerCase().includes(t)))
      .sort((a, b) => b.record_date.localeCompare(a.record_date) || (b.seq || 0) - (a.seq || 0) || b.id - a.id).slice(0, 500).map(withNames);
    if (full) audit(ctx, 'visualizou', 'records', null, Number(q.get('patient_id')), q.get('type'));
    return rows.map((r) => (full ? JSON.parse(JSON.stringify(r)) : meta(r)));
  });
  route('GET', '/api/records/:id', (ctx) => {
    requireRole(ctx.user, CLINICAL); const r = byId('records', ctx.params.id); if (!r || r.deleted_at) throw new HttpError(404, 'Registro não encontrado');
    getPatient(ctx.user, r.patient_id);
    const versions = db.record_versions.filter((v) => v.record_id === r.id).sort((a, b) => b.version - a.version).map((v) => ({ id: v.id, version: v.version, changed_at: v.changed_at, changed_by_name: userName(v.changed_by) }));
    audit(ctx, 'visualizou', 'record', r.id, r.patient_id, r.type);
    return JSON.parse(JSON.stringify({ ...withNames(r), author_crefito: byId('users', r.author_id)?.crefito, versions }));
  });
  route('GET', '/api/records/:id/versions/:vid', (ctx) => {
    requireRole(ctx.user, CLINICAL); const r = byId('records', ctx.params.id); if (!r) throw new HttpError(404, 'Registro não encontrado'); getPatient(ctx.user, r.patient_id);
    const v = db.record_versions.find((x) => x.id === Number(ctx.params.vid) && x.record_id === r.id); if (!v) throw new HttpError(404, 'Versão não encontrada');
    return JSON.parse(JSON.stringify(v));
  });
  function recordInput(b, ex) {
    const type = ex ? ex.type : oneOf(b.type, RTYPES, 'Tipo'); if (!type) throw new HttpError(400, 'Tipo é obrigatório');
    return { type, record_date: date(b.record_date, 'Data', true), seq: type === 'evolucao' ? (b.seq ? Number(b.seq) : null) : null,
      status: type === 'plano' ? oneOf(b.status, ['ativo', 'concluido', 'substituido'], 'Situação', 'ativo') : null, title: str(b.title, 200), data: b.data && typeof b.data === 'object' ? b.data : {} };
  }
  route('POST', '/api/records', (ctx) => {
    requireRole(ctx.user, CLINICAL); const p = getPatient(ctx.user, ctx.body.patient_id); const r = recordInput(ctx.body);
    if (r.type === 'evolucao' && !r.seq) r.seq = Math.max(0, ...db.records.filter((x) => x.patient_id === p.id && x.type === 'evolucao' && !x.deleted_at).map((x) => x.seq || 0)) + 1;
    if (r.type === 'plano' && r.status === 'ativo') db.records.filter((x) => x.patient_id === p.id && x.type === 'plano' && x.status === 'ativo').forEach((x) => (x.status = 'substituido'));
    const rec = insert('records', { patient_id: p.id, ...r, author_id: ctx.user.id, created_at: seeding ? r.record_date + ' 18:30:00' : stamp(), updated_at: seeding ? r.record_date + ' 18:30:00' : stamp(), deleted_at: null });
    if (r.type === 'avaliacao' && p.status === 'avaliacao') p.status = 'em_tratamento';
    audit(ctx, 'criou', r.type, rec.id, p.id); return { id: rec.id, seq: rec.seq };
  });
  route('PUT', '/api/records/:id', (ctx) => {
    requireRole(ctx.user, CLINICAL); const ex = byId('records', ctx.params.id); if (!ex || ex.deleted_at) throw new HttpError(404, 'Registro não encontrado');
    getPatient(ctx.user, ex.patient_id); const r = recordInput({ ...ex, ...ctx.body }, ex);
    const ver = Math.max(0, ...db.record_versions.filter((v) => v.record_id === ex.id).map((v) => v.version)) + 1;
    insert('record_versions', { record_id: ex.id, version: ver, record_date: ex.record_date, status: ex.status, data: JSON.parse(JSON.stringify(ex.data)), changed_by: ctx.user.id, changed_at: stamp() });
    if (r.type === 'plano' && r.status === 'ativo' && ex.status !== 'ativo') db.records.filter((x) => x.patient_id === ex.patient_id && x.type === 'plano' && x.status === 'ativo' && x.id !== ex.id).forEach((x) => (x.status = 'substituido'));
    Object.assign(ex, { record_date: r.record_date, seq: r.seq ?? ex.seq, status: r.status, title: r.title, data: r.data, updated_at: stamp() });
    audit(ctx, 'alterou', ex.type, ex.id, ex.patient_id, { versao_anterior: ver }); return { ok: true };
  });
  route('DELETE', '/api/records/:id', (ctx) => {
    requireRole(ctx.user, CLINICAL); const ex = byId('records', ctx.params.id); if (!ex || ex.deleted_at) throw new HttpError(404, 'Registro não encontrado');
    getPatient(ctx.user, ex.patient_id);
    if (ctx.user.role !== 'admin' && ex.author_id !== ctx.user.id) throw new HttpError(403, 'Apenas o autor ou o administrador pode excluir este registro');
    ex.deleted_at = stamp(); audit(ctx, 'excluiu', ex.type, ex.id, ex.patient_id, str(ctx.body.reason, 500)); return { ok: true };
  });

  // ---------------- Agenda ----------------
  function apptInput(b) {
    const start = str(b.start, 16); if (!start || !DT_RE.test(start)) throw new HttpError(400, 'Data e horário inválidos');
    return { start, duration: Math.max(10, Math.min(480, Number(b.duration) || 50)), kind: oneOf(b.kind, ['avaliacao', 'sessao', 'reavaliacao', 'retorno', 'domiciliar', 'teleatendimento'], 'Tipo', 'sessao'),
      status: oneOf(b.status, ['agendado', 'confirmado', 'realizado', 'falta', 'cancelado'], 'Situação', 'agendado'), price: num(b.price, 'Valor'), notes: str(b.notes, 1000), professional_id: b.professional_id ? Number(b.professional_id) : null };
  }
  function overlap(a, ignore) {
    if (!a.professional_id || ['cancelado', 'falta'].includes(a.status)) return null;
    const s0 = new Date(a.start).getTime(); const e0 = s0 + a.duration * 60e3;
    for (const r of db.appointments) {
      if (r.id === ignore || r.professional_id !== a.professional_id || ['cancelado', 'falta'].includes(r.status) || r.start.slice(0, 10) !== a.start.slice(0, 10)) continue;
      const s = new Date(r.start).getTime(); if (s < e0 && s0 < s + r.duration * 60e3) return `Conflito de horário com ${patName(r.patient_id)} às ${r.start.slice(11)}`;
    }
    return null;
  }
  function syncCharge(ctx, a) {
    const ch = a.charge_id ? byId('charges', a.charge_id) : null;
    if (a.status === 'realizado' && a.price > 0 && !ch) {
      const [y, m, d] = a.start.slice(0, 10).split('-');
      const c = insert('charges', { patient_id: a.patient_id, professional_id: a.professional_id, description: `Atendimento de fisioterapia — ${d}/${m}/${y}`, amount: a.price, due_date: a.start.slice(0, 10), status: 'pendente', paid_at: null, method: null, payer_name: null, payer_cpf: null, receipt_number: null, appointment_id: a.id, patient_package_id: null, notes: null, created_by: ctx.user.id, created_at: stamp() });
      a.charge_id = c.id;
    } else if (a.status !== 'realizado' && ch && ch.status === 'pendente') { db.charges = db.charges.filter((c) => c.id !== ch.id); a.charge_id = null; }
    else if (ch && ch.status === 'pendente' && ch.amount !== a.price && a.price > 0) ch.amount = a.price;
  }
  const apptOut = (a) => ({ ...a, patient_name: patName(a.patient_id), phone: byId('patients', a.patient_id)?.phone, professional_name: userName(a.professional_id), charge_status: a.charge_id ? byId('charges', a.charge_id)?.status : null });
  route('GET', '/api/appointments', (ctx) => {
    const q = ctx.query; const ids = new Set(scoped(ctx.user).map((p) => p.id));
    const rows = db.appointments.filter((a) => ids.has(a.patient_id) && (!q.get('from') || a.start >= q.get('from')) && (!q.get('to') || a.start < q.get('to'))
      && (!q.get('patient_id') || a.patient_id === Number(q.get('patient_id'))) && (!q.get('professional_id') || a.professional_id === Number(q.get('professional_id'))))
      .sort((a, b) => a.start.localeCompare(b.start));
    if (q.get('desc')) rows.reverse(); return rows.slice(0, 2000).map(apptOut);
  });
  route('POST', '/api/appointments', (ctx) => {
    const p = getPatient(ctx.user, ctx.body.patient_id); const a = apptInput(ctx.body);
    if (!a.professional_id) a.professional_id = p.professional_id || (ctx.user.role !== 'recepcao' ? ctx.user.id : null);
    const c = overlap(a); if (c && !ctx.body.force) throw new HttpError(409, c);
    const n = Math.max(1, Math.min(52, Number(ctx.body.repeat_weeks) || 1)); const ids = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(a.start); d.setDate(d.getDate() + 7 * i);
      const row = insert('appointments', { patient_id: p.id, ...a, start: `${ymd(d)}T${a.start.slice(11)}`, status: i === 0 ? a.status : 'agendado', charge_id: null, created_at: stamp() });
      ids.push(row.id); syncCharge(ctx, row);
    }
    audit(ctx, 'criou', 'appointment', ids[0], p.id, { start: a.start, repeticoes: n }); return { ids };
  });
  route('PUT', '/api/appointments/:id', (ctx) => {
    const ex = byId('appointments', ctx.params.id); if (!ex) throw new HttpError(404, 'Agendamento não encontrado'); getPatient(ctx.user, ex.patient_id);
    const pid = ctx.body.patient_id ? getPatient(ctx.user, ctx.body.patient_id).id : ex.patient_id; const a = apptInput({ ...ex, ...ctx.body });
    const c = overlap(a, ex.id); if (c && !ctx.body.force) throw new HttpError(409, c);
    Object.assign(ex, a, { patient_id: pid }); syncCharge(ctx, ex); audit(ctx, 'alterou', 'appointment', ex.id, pid, { status: a.status, start: a.start }); return { ok: true };
  });
  route('DELETE', '/api/appointments/:id', (ctx) => {
    const ex = byId('appointments', ctx.params.id); if (!ex) throw new HttpError(404, 'Agendamento não encontrado'); getPatient(ctx.user, ex.patient_id);
    if (ex.charge_id && byId('charges', ex.charge_id)?.status === 'pago') throw new HttpError(400, 'Este atendimento possui pagamento registrado. Altere a situação em vez de excluir.');
    if (ex.charge_id) db.charges = db.charges.filter((c) => c.id !== ex.charge_id);
    db.appointments = db.appointments.filter((x) => x.id !== ex.id); audit(ctx, 'excluiu', 'appointment', ex.id, ex.patient_id); return { ok: true };
  });

  // ---------------- Financeiro ----------------
  const METHODS = ['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'transferencia']; const FIN = ['admin', 'fisio', 'recepcao'];
  for (const [table, fields] of [['services', [['name', (v) => reqStr(v, 'Nome', 120)], ['price', (v) => num(v, 'Valor', { required: true })], ['duration', (v) => Number(v) || 50]]],
    ['packages', [['name', (v) => reqStr(v, 'Nome', 120)], ['sessions', (v) => Math.max(1, Number(v) || 1)], ['price', (v) => num(v, 'Valor', { required: true })]]]]) {
    route('GET', `/api/${table}`, () => [...db[table]].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name)));
    route('POST', `/api/${table}`, (ctx) => { requireRole(ctx.user, CLINICAL); const row = { active: 1 }; for (const [k, fn] of fields) row[k] = fn(ctx.body[k]); const r = insert(table, row); audit(ctx, 'criou', table, r.id); return { id: r.id }; });
    route('PUT', `/api/${table}/:id`, (ctx) => {
      requireRole(ctx.user, CLINICAL); const ex = byId(table, ctx.params.id); if (!ex) throw new HttpError(404, 'Não encontrado');
      for (const [k, fn] of fields) ex[k] = fn(ctx.body[k] ?? ex[k]); if (ctx.body.active !== undefined) ex.active = ctx.body.active ? 1 : 0; audit(ctx, 'alterou', table, ex.id); return { ok: true };
    });
  }
  route('GET', '/api/patient-packages', (ctx) => {
    const ids = new Set(scoped(ctx.user).map((p) => p.id)); const pid = ctx.query.get('patient_id');
    return db.patient_packages.filter((pp) => ids.has(pp.patient_id) && (!pid || pp.patient_id === Number(pid))).sort((a, b) => b.start_date.localeCompare(a.start_date)).map((pp) => ({
      ...pp, patient_name: patName(pp.patient_id),
      used: db.appointments.filter((a) => a.patient_id === pp.patient_id && a.status === 'realizado' && a.start.slice(0, 10) >= pp.start_date && a.start.slice(0, 10) <= pp.end_date).length,
      charge_status: db.charges.find((c) => c.patient_package_id === pp.id)?.status || null,
    }));
  });
  route('POST', '/api/patient-packages', (ctx) => {
    requireRole(ctx.user, FIN); const p = getPatient(ctx.user, ctx.body.patient_id); const b = ctx.body;
    const pkg = b.package_id ? byId('packages', b.package_id) : null;
    if (b.package_id && !pkg) throw new HttpError(400, 'Pacote não encontrado');
    if (!pkg && (!Number(b.sessions) || b.price === undefined || b.price === '')) throw new HttpError(400, 'Informe o número de sessões e o valor do pacote');
    const start = date(b.start_date, 'Início', true); let end = date(b.end_date, 'Fim');
    if (!end) { const d = new Date(start + 'T12:00'); d.setMonth(d.getMonth() + 1); d.setDate(d.getDate() - 1); end = ymd(d); }
    const name = str(b.name, 120) || pkg?.name || 'Pacote mensal'; const sessions = Number(b.sessions) || pkg?.sessions || 1;
    const price = b.price !== undefined && b.price !== '' ? num(b.price, 'Valor') : pkg?.price || 0;
    const pp = insert('patient_packages', { patient_id: p.id, package_id: pkg?.id || null, name, sessions, price, start_date: start, end_date: end, status: 'ativo', created_at: stamp() });
    if (price > 0) insert('charges', { patient_id: p.id, professional_id: p.professional_id, description: `${name} (${sessions} sessões) — ${start.split('-').reverse().join('/')} a ${end.split('-').reverse().join('/')}`, amount: price, due_date: date(b.due_date, 'Vencimento') || start, status: 'pendente', paid_at: null, method: null, payer_name: null, payer_cpf: null, receipt_number: null, appointment_id: null, patient_package_id: pp.id, notes: null, created_by: ctx.user.id, created_at: stamp() });
    audit(ctx, 'criou', 'patient_package', pp.id, p.id); return { id: pp.id };
  });
  route('PUT', '/api/patient-packages/:id', (ctx) => {
    requireRole(ctx.user, FIN); const ex = byId('patient_packages', ctx.params.id); if (!ex) throw new HttpError(404, 'Não encontrado'); getPatient(ctx.user, ex.patient_id);
    ex.status = oneOf(ctx.body.status, ['ativo', 'encerrado', 'cancelado'], 'Situação', ex.status); audit(ctx, 'alterou', 'patient_package', ex.id, ex.patient_id); return { ok: true };
  });
  const chargeOut = (c) => { const p = byId('patients', c.patient_id); const u = byId('users', c.professional_id); return { ...c, patient_name: p?.name, patient_cpf: p?.cpf, patient_address: p?.address, professional_name: u?.name, professional_crefito: u?.crefito }; };
  route('GET', '/api/charges', (ctx) => {
    requireRole(ctx.user, FIN); const q = ctx.query; const ids = new Set(scoped(ctx.user).map((p) => p.id)); const f = q.get('by') === 'paid' ? 'paid_at' : 'due_date';
    return db.charges.filter((c) => ids.has(c.patient_id) && (!q.get('status') || c.status === q.get('status')) && (!q.get('patient_id') || c.patient_id === Number(q.get('patient_id')))
      && (!q.get('professional_id') || c.professional_id === Number(q.get('professional_id'))) && (!q.get('from') || (c[f] && c[f] >= q.get('from'))) && (!q.get('to') || (c[f] && c[f] <= q.get('to')))
      && (!q.get('overdue') || (c.status === 'pendente' && c.due_date < today())))
      .sort((a, b) => (b.paid_at || b.due_date).localeCompare(a.paid_at || a.due_date) || b.id - a.id).map(chargeOut);
  });
  route('GET', '/api/charges/:id', (ctx) => { requireRole(ctx.user, FIN); const c = byId('charges', ctx.params.id); if (!c) throw new HttpError(404, 'Lançamento não encontrado'); getPatient(ctx.user, c.patient_id); return chargeOut(c); });
  function nextReceipt(paidAt) { const y = paidAt.slice(0, 4); const n = db.charges.filter((c) => (c.receipt_number || '').startsWith(y + '-')).map((c) => Number(c.receipt_number.split('-')[1])); return `${y}-${String(Math.max(0, ...n) + 1).padStart(5, '0')}`; }
  const payFields = (b) => ({ paid_at: date(b.paid_at, 'Data do pagamento', true), method: oneOf(b.method, METHODS, 'Forma de pagamento'), payer_name: str(b.payer_name, 160), payer_cpf: cpfField(b.payer_cpf, 'CPF do pagador') });
  route('POST', '/api/charges', (ctx) => {
    requireRole(ctx.user, FIN); const p = getPatient(ctx.user, ctx.body.patient_id); const b = ctx.body;
    const amount = num(b.amount, 'Valor', { required: true }); if (amount <= 0) throw new HttpError(400, 'Valor deve ser maior que zero');
    const paid = b.status === 'pago'; const pf = paid ? payFields(b) : {}; if (paid && !pf.method) throw new HttpError(400, 'Informe a forma de pagamento');
    const c = insert('charges', { patient_id: p.id, professional_id: b.professional_id ? Number(b.professional_id) : p.professional_id || (ctx.user.role !== 'recepcao' ? ctx.user.id : null), description: reqStr(b.description, 'Descrição', 300), amount,
      due_date: date(b.due_date, 'Vencimento') || today(), status: paid ? 'pago' : 'pendente', paid_at: pf.paid_at || null, method: pf.method || null, payer_name: pf.payer_name || null, payer_cpf: pf.payer_cpf || null,
      receipt_number: paid ? nextReceipt(pf.paid_at) : null, appointment_id: null, patient_package_id: null, notes: str(b.notes, 1000), created_by: ctx.user.id, created_at: stamp() });
    audit(ctx, 'criou', 'charge', c.id, p.id, { amount, paid }); return { id: c.id };
  });
  route('PUT', '/api/charges/:id', (ctx) => {
    requireRole(ctx.user, FIN); const c = byId('charges', ctx.params.id); if (!c) throw new HttpError(404, 'Lançamento não encontrado'); getPatient(ctx.user, c.patient_id);
    const b = { ...c, ...ctx.body }; const before = c.amount;
    Object.assign(c, { description: reqStr(b.description, 'Descrição', 300), amount: num(b.amount, 'Valor', { required: true }), due_date: date(b.due_date, 'Vencimento', true), notes: str(b.notes, 1000),
      professional_id: b.professional_id ? Number(b.professional_id) : null, payer_name: str(b.payer_name, 160), payer_cpf: cpfField(b.payer_cpf, 'CPF do pagador'), method: c.status === 'pago' ? oneOf(b.method, METHODS, 'Forma de pagamento') : c.method });
    audit(ctx, 'alterou', 'charge', c.id, c.patient_id, { de: before, para: c.amount }); return { ok: true };
  });
  route('POST', '/api/charges/:id/pay', (ctx) => {
    requireRole(ctx.user, FIN); const c = byId('charges', ctx.params.id); if (!c) throw new HttpError(404, 'Lançamento não encontrado'); getPatient(ctx.user, c.patient_id);
    if (c.status === 'pago') throw new HttpError(400, 'Este lançamento já está pago');
    const pf = payFields({ paid_at: today(), ...ctx.body }); if (!pf.method) throw new HttpError(400, 'Informe a forma de pagamento');
    Object.assign(c, pf, { status: 'pago', receipt_number: nextReceipt(pf.paid_at) }); audit(ctx, 'registrou_pagamento', 'charge', c.id, c.patient_id, { amount: c.amount, method: pf.method }); return { ok: true };
  });
  route('POST', '/api/charges/:id/status', (ctx) => {
    requireRole(ctx.user, FIN); const c = byId('charges', ctx.params.id); if (!c) throw new HttpError(404, 'Lançamento não encontrado'); getPatient(ctx.user, c.patient_id);
    const st = oneOf(ctx.body.status, ['pendente', 'cancelado'], 'Situação'); const rec = c.receipt_number;
    Object.assign(c, { status: st, paid_at: null, method: null, receipt_number: null }); audit(ctx, st === 'cancelado' ? 'cancelou' : 'estornou', 'charge', c.id, c.patient_id, { recibo: rec, amount: c.amount }); return { ok: true };
  });
  route('DELETE', '/api/charges/:id', (ctx) => {
    requireRole(ctx.user, CLINICAL); const c = byId('charges', ctx.params.id); if (!c) throw new HttpError(404, 'Lançamento não encontrado'); getPatient(ctx.user, c.patient_id);
    if (c.status === 'pago') throw new HttpError(400, 'Lançamentos pagos não podem ser excluídos. Faça o estorno primeiro.');
    db.appointments.forEach((a) => { if (a.charge_id === c.id) a.charge_id = null; }); db.charges = db.charges.filter((x) => x.id !== c.id);
    audit(ctx, 'excluiu', 'charge', c.id, c.patient_id, { amount: c.amount }); return { ok: true };
  });
  route('GET', '/api/finance/report', (ctx) => {
    requireRole(ctx.user, FIN); const from = date(ctx.query.get('from'), 'De', true); const to = date(ctx.query.get('to'), 'Até', true);
    const ids = new Set(scoped(ctx.user).map((p) => p.id));
    const paid = db.charges.filter((c) => ids.has(c.patient_id) && c.status === 'pago' && c.paid_at >= from && c.paid_at <= to);
    const group = (keyFn) => { const m = new Map(); for (const c of paid) { const k = keyFn(c); const g = m.get(k) || { v: 0, n: 0 }; g.v += c.amount; g.n++; m.set(k, g); } return [...m.entries()]; };
    const pend = db.charges.filter((c) => ids.has(c.patient_id) && c.status === 'pendente' && c.due_date >= from && c.due_date <= to);
    return { from, to, total: { v: paid.reduce((s, c) => s + c.amount, 0), n: paid.length },
      por_mes: group((c) => c.paid_at.slice(0, 7)).map(([month, g]) => ({ month, ...g })).sort((a, b) => a.month.localeCompare(b.month)),
      por_forma: group((c) => c.method).map(([method, g]) => ({ method, ...g })).sort((a, b) => b.v - a.v),
      por_paciente: group((c) => c.patient_id).map(([id, g]) => ({ name: patName(id), ...g })).sort((a, b) => b.v - a.v).slice(0, 50),
      pendente: { v: pend.reduce((s, c) => s + c.amount, 0), n: pend.length } };
  });
  route('GET', '/api/finance/carne-leao', (ctx) => {
    requireRole(ctx.user, CLINICAL); const year = String(ctx.query.get('year') || new Date().getFullYear()); const prof = ctx.query.get('professional_id');
    const ids = new Set(scoped(ctx.user).map((p) => p.id));
    const rows = db.charges.filter((c) => ids.has(c.patient_id) && c.status === 'pago' && (c.paid_at || '').slice(0, 4) === year && (!prof || c.professional_id === Number(prof)))
      .sort((a, b) => a.paid_at.localeCompare(b.paid_at) || a.id - b.id)
      .map((c) => { const o = chargeOut(c); return { id: c.id, paid_at: c.paid_at, amount: c.amount, method: c.method, description: c.description, receipt_number: c.receipt_number, payer_name: c.payer_name, payer_cpf: c.payer_cpf, patient_name: o.patient_name, patient_cpf: o.patient_cpf, professional_name: o.professional_name, professional_id: c.professional_id }; });
    audit(ctx, 'consultou', 'carne_leao', null, null, year); return { year, rows };
  });
  route('GET', '/api/audit', (ctx) => {
    requireRole(ctx.user, ['admin']); const q = ctx.query;
    return db.audit_log.filter((l) => (!q.get('patient_id') || l.patient_id === Number(q.get('patient_id'))) && (!q.get('user_id') || l.user_id === Number(q.get('user_id')))
      && (!q.get('from') || l.ts >= q.get('from')) && (!q.get('to') || l.ts <= q.get('to') + ' 23:59:59')).slice(-1000).reverse();
  });
  route('GET', '/api/backups', (ctx) => { requireRole(ctx.user, ['admin']); return []; });
  route('POST', '/api/backups', () => { throw new HttpError(400, 'Na demonstração o backup fica desativado. Na versão instalada, ele é feito automaticamente todos os dias.'); });

  // ---------------- Dados fictícios ----------------
  function cpfFrom(base9) {
    const d = String(base9).split('').map(Number);
    let s = 0; for (let i = 0; i < 9; i++) s += d[i] * (10 - i); d.push((s * 10) % 11 % 10);
    s = 0; for (let i = 0; i < 10; i++) s += d[i] * (11 - i); d.push((s * 10) % 11 % 10);
    const c = d.join(''); return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
  }
  function seed() {
    seeding = true;
    db = blank();
    db.settings = {
      clinic_name: 'Clínica Movimento (demonstração)', professional_name: 'Dra. Helena Prado', crefito: '123456-F', professional_cpf: cpfFrom(529982247),
      phone: '(31) 3333-0000', email: 'contato@clinicamovimento.demo', address: 'Av. Exemplo, 1000 — sala 204 — Centro', city: 'Belo Horizonte/MG', consent_version: '1.0',
      consent_text: 'TERMO DE CONSENTIMENTO PARA TRATAMENTO DE DADOS PESSOAIS E DADOS PESSOAIS SENSÍVEIS (LGPD — Lei nº 13.709/2018)\n\nEu, titular abaixo identificado(a), declaro estar ciente e consinto que o(a) profissional/clínica identificado(a) neste documento, na condição de controlador(a), realize o tratamento dos meus dados pessoais e dados pessoais sensíveis referentes à saúde, nos termos a seguir:\n\n1. FINALIDADE: avaliação fisioterapêutica, elaboração e execução do plano de tratamento, registro da evolução clínica em prontuário, agendamento, contato, emissão de recibos e cumprimento de obrigações legais, regulatórias e fiscais.\n2. DADOS TRATADOS: identificação e contato, dados de saúde (anamnese, avaliação, diagnóstico, evolução) e dados financeiros relativos aos atendimentos.\n3. COMPARTILHAMENTO: os dados não serão compartilhados com terceiros, salvo por determinação legal, ordem judicial ou autorização expressa do(a) titular.\n4. ARMAZENAMENTO E SEGURANÇA: sistema com controle de acesso individual, criptografia dos registros clínicos, cópias de segurança e registro de alterações. O prontuário será mantido pelo prazo mínimo exigido pelas normas do COFFITO e pela legislação aplicável.\n5. DIREITOS DO TITULAR: confirmação, acesso, correção, portabilidade, informação sobre compartilhamento e revogação deste consentimento, ressalvada a guarda obrigatória do prontuário.\n6. REVOGAÇÃO: a revogação não afeta a legalidade do tratamento realizado anteriormente nem a guarda obrigatória do prontuário.\n\nDeclaro que li, compreendi e concordo com os termos acima.',
    };
    const PW = 'demo1234';
    const admin = insert('users', { name: 'Dra. Helena Prado', email: 'admin@demo.fisio', password: PW, role: 'admin', crefito: '123456-F', active: 1, created_at: stamp(), last_login: null });
    const fisio = insert('users', { name: 'Dr. Bruno Tavares', email: 'fisio@demo.fisio', password: PW, role: 'fisio', crefito: '234567-F', active: 1, created_at: stamp(), last_login: null });
    insert('users', { name: 'Patrícia Nunes', email: 'recepcao@demo.fisio', password: PW, role: 'recepcao', crefito: null, active: 1, created_at: stamp(), last_login: null });
    const A = { user: admin }; const F = { user: fisio };
    const call = (ctx, method, path, body = {}) => { const r = dispatch(method, path, body, ctx.user); if (r.status !== 200) throw new Error(path + ': ' + r.body.error); return r.body; };

    call(A, 'POST', '/api/services', { name: 'Sessão de fisioterapia', price: 150, duration: 50 });
    call(A, 'POST', '/api/services', { name: 'Avaliação fisioterapêutica', price: 200, duration: 60 });
    call(A, 'POST', '/api/services', { name: 'Atendimento domiciliar', price: 220, duration: 60 });
    const pk = call(A, 'POST', '/api/packages', { name: 'Pacote mensal 2x/semana', sessions: 8, price: 960 });
    call(A, 'POST', '/api/packages', { name: 'Pacote mensal 3x/semana', sessions: 12, price: 1320 });

    const methods = ['pix', 'pix', 'cartao_debito', 'dinheiro', 'pix', 'cartao_credito', 'transferencia'];
    // Cria sessões passadas (realizadas + evolução + pagamento) e futuras
    function course(ctx, pid, { startDay, every = [0, 3], count, price, painFrom, painTo, evo, paidUntil = count, faltas = [], hour = '08:00', area = '', extra = () => ({}) }) {
      const days = []; let d = startDay; let i = 0;
      while (days.length < count) { days.push(d); d += every[i % every.length] === 0 ? (i % 2 ? 4 : 3) : every[i % every.length]; i++; }
      let seq = 0;
      days.forEach((off, k) => {
        const day = addDays(off); const start = `${day}T${hour}`;
        if (off > 0 || (off === 0 && hour > nowLocal().slice(11))) { call(ctx, 'POST', '/api/appointments', { patient_id: pid, start, price, kind: 'sessao', status: k === days.length - 1 ? 'agendado' : 'confirmado', force: true }); return; }
        if (faltas.includes(k)) { call(ctx, 'POST', '/api/appointments', { patient_id: pid, start, price, status: 'falta', force: true }); return; }
        call(ctx, 'POST', '/api/appointments', { patient_id: pid, start, price, status: 'realizado', force: true });
        seq++;
        const t = count > 1 ? (seq - 1) / Math.max(1, count - 1) : 0;
        const pi = Math.round(painFrom - (painFrom - painTo) * t * 1.4); const p0 = Math.max(painTo, Math.min(painFrom, pi));
        call(ctx, 'POST', '/api/records', { type: 'evolucao', patient_id: pid, record_date: day, data: { ...evo(seq, p0, Math.max(0, p0 - 2)), ...(area ? { area } : {}), ...extra(seq, count) } });
        if (price > 0 && k < paidUntil) {
          const ch = db.charges.find((c) => c.patient_id === pid && c.due_date === day && c.status === 'pendente');
          if (ch) call(ctx, 'POST', `/api/charges/${ch.id}/pay`, { paid_at: day, method: methods[(pid + k) % methods.length] });
        }
      });
    }

    // 1 — Lombalgia
    const p1 = call(A, 'POST', '/api/patients', { name: 'Marcos Antônio Ribeiro', birth_date: '1974-03-18', cpf: cpfFrom(318274651), phone: '(31) 99812-4410', email: 'marcos.ribeiro@exemplo.demo', address: 'Rua das Acácias, 245 — Funcionários — Belo Horizonte/MG', profession: 'Motorista de aplicativo', emergency_name: 'Sandra Ribeiro (esposa)', emergency_phone: '(31) 99877-1020', first_visit: addDays(-38), status: 'em_tratamento', professional_id: admin.id }).id;
    call(A, 'POST', `/api/patients/${p1}/consents`, { method: 'assinatura_fisica', accepted_at: addDays(-38) });
    call(A, 'POST', '/api/records', { type: 'anamnese', patient_id: p1, record_date: addDays(-38), data: { diagnostico_medico: 'Lombalgia crônica inespecífica; protrusão discal L4-L5 (RM)', cid: 'M54.5', medico_solicitante: 'Dr. Paulo Mendes — Ortopedia', queixa_principal: 'Dor na região lombar que piora após longos períodos dirigindo.', hda: 'Dor lombar há cerca de 8 meses, de início insidioso, com piora progressiva. Relata irradiação ocasional para a nádega esquerda. Fez uso de anti-inflamatório com melhora parcial.', inicio_sintomas: addDays(-250), mecanismo_lesao: 'Postura sentada prolongada (10 h/dia dirigindo)', historico_saude: 'Sem internações prévias.', doencas_associadas: ['Hipertensão', 'Obesidade'], medicamentos: 'Losartana 50 mg/dia; Ciclobenzaprina 5 mg se necessário', cirurgias: 'Apendicectomia (2009)', historico_familiar: 'Pai com hérnia de disco lombar.', alergias: 'Dipirona', exames: 'RM coluna lombar: protrusão discal L4-L5 sem compressão radicular.', atividade_fisica: 'Sedentário', tabagismo: 'Ex-fumante', etilismo: 'Social', sono: 'Regular', habitos: 'Alimentação irregular, longos períodos sentado.' } });
    call(A, 'POST', '/api/records', { type: 'avaliacao', patient_id: p1, record_date: addDays(-38), title: 'Avaliação inicial · Traumato-ortopédica', data: { area: 'ortopedica', o_segmento: 'Coluna lombar (L4-S1)', o_lado: 'Bilateral', o_fase: 'Crônica', o_palpacao: 'Dor à palpação de paravertebrais L4-L5 à E; sem edema.', o_testes_ortopedicos: 'Lasègue (−) bilateral; Slump (−); instabilidade em prono (+).', o_carga: 'Total', tipo: 'Avaliação inicial', dor_presente: 'Sim', dor_localizacao: 'Lombar baixa, com irradiação para glúteo E', dor_intensidade: 7, dor_tipo: ['Peso', 'Irradiada', 'Intermitente'], dor_fatores: 'Piora: sentado > 1 h, flexão de tronco. Melhora: deitado, calor local.', inspecao: 'Hiperlordose lombar discreta, anteriorização de pelve. Tensão em paravertebrais lombares.', adm: 'Flexão de tronco: dedos a 25 cm do solo (dor ao final). Extensão: 15°. Inclinações preservadas.', forca: 'Abdominais grau 3; glúteo médio D 4 / E 3+ (Oxford).', mobilidade: 'Hipomobilidade em segmentos L4-L5 e L5-S1.', equilibrio: 'Preservado.', marcha: 'Sem alterações.', limitacoes: 'Dificuldade para permanecer sentado e para calçar sapatos.', testes: 'Lasègue negativo bilateral. Slump negativo. Teste de instabilidade em prono positivo.', escalas: 'Oswestry: 38% (incapacidade moderada).', observacoes: 'Paciente motivado; orientado sobre pausas durante a jornada.' } });
    call(A, 'POST', '/api/records', { type: 'plano', patient_id: p1, record_date: addDays(-37), status: 'ativo', data: { diagnostico_fisio: 'Disfunção cinético-funcional lombar com déficit de controle motor do core e hipomobilidade segmentar L4-S1.', objetivo_geral: 'Reduzir a dor e restaurar a capacidade funcional para a jornada de trabalho.', objetivos_especificos: 'Reduzir dor para EVA ≤ 2\nAumentar força de abdominais e glúteos para grau 4+\nMelhorar flexibilidade de cadeia posterior\nReduzir Oswestry para < 20%', condutas: 'Terapia manual para mobilização segmentar, exercícios de estabilização lombopélvica progressivos, educação em dor e ergonomia ao dirigir.', tecnicas: ['Cinesioterapia', 'Terapia manual', 'Mobilização articular', 'Termoterapia', 'Pilates'], exercicios: 'Ponte, prancha ventral e lateral, bird-dog, dead bug, alongamento de isquiotibiais, mobilidade de quadril.', frequencia: '2x por semana', duracao: '10 semanas / 20 sessões', criterios_reavaliacao: 'Reavaliação a cada 10 sessões ou se houver piora da dor por mais de 1 semana.', orientacoes: 'Pausas a cada 1 h dirigindo; apoio lombar no banco; caminhada de 20 min diária.' } });
    course(A, p1, { area: 'ortopedica', extra: (s) => ({ o_adm: `Flexão de tronco: dedos a ${Math.max(5, 25 - s * 2)} cm do solo` }), startDay: -35, count: 13, price: 150, painFrom: 7, painTo: 2, faltas: [5], paidUntil: 9, evo: (s, a, b) => ({ queixa: s < 4 ? 'Ainda sente dor ao final do dia de trabalho.' : s < 8 ? 'Refere melhora; consegue dirigir 2 h sem dor forte.' : 'Dor apenas ocasional, após jornadas longas.', dor_inicio: a, condicao_inicial: s < 4 ? 'Rigidez matinal, tensão em paravertebrais.' : 'Boa mobilidade, sem rigidez.', exercicios: s < 5 ? 'Ponte 3x12; dead bug 3x10; alongamento de isquiotibiais 3x30 s.' : 'Prancha ventral 3x30 s; prancha lateral 3x20 s; bird-dog 3x12; ponte unilateral 3x10.', tecnicas: s < 5 ? 'Termoterapia (15 min), mobilização PA central L4-L5 grau III.' : 'Mobilização grau III-IV, Pilates solo.', series_repeticoes: s < 5 ? '3x10 a 3x12' : '3x12 / isometrias 30 s', tempo: '50 min', resposta: s < 4 ? 'Boa tolerância, leve desconforto ao final.' : 'Executou todos os exercícios sem dor.', dor_fim: b, evolucao: s < 4 ? 'Redução da tensão muscular após a mobilização.' : s < 8 ? 'Ganho de controle lombopélvico; progressão de carga.' : 'Mantém ganhos; iniciar treino funcional para o trabalho.', intercorrencias: '', orientacoes: 'Manter exercícios domiciliares 1x/dia e pausas ao dirigir.' }) });

    // 2 — Pós-operatório de LCA
    const p2 = call(F, 'POST', '/api/patients', { name: 'Luciana Ferreira Costa', birth_date: '1991-09-02', cpf: cpfFrom(402918377), phone: '(31) 98734-2201', email: 'luciana.costa@exemplo.demo', address: 'Rua Pernambuco, 1200 — Savassi — Belo Horizonte/MG', profession: 'Professora de educação física', emergency_name: 'Rogério Costa (irmão)', emergency_phone: '(31) 99120-5544', first_visit: addDays(-30), status: 'em_tratamento', professional_id: fisio.id }).id;
    call(F, 'POST', `/api/patients/${p2}/consents`, { method: 'assinatura_digital', accepted_at: addDays(-30) });
    call(F, 'POST', '/api/records', { type: 'anamnese', patient_id: p2, record_date: addDays(-30), data: { diagnostico_medico: 'Pós-operatório de reconstrução do LCA joelho direito (enxerto de flexores) — 3 semanas', cid: 'S83.5', medico_solicitante: 'Dra. Fernanda Lopes — Cirurgia do joelho', queixa_principal: 'Dificuldade para dobrar o joelho e insegurança para andar sem muletas.', hda: 'Entorse em partida de futebol há 4 meses, com ruptura completa do LCA. Cirurgia realizada há 3 semanas, sem intercorrências.', inicio_sintomas: addDays(-140), mecanismo_lesao: 'Entorse em rotação com pé fixo (esporte)', historico_saude: 'Saudável, atleta amadora.', doencas_associadas: [], medicamentos: 'Paracetamol se necessário', cirurgias: 'Reconstrução de LCA joelho D', historico_familiar: 'Nada digno de nota.', alergias: 'Nega', atividade_fisica: '5x ou mais por semana', tabagismo: 'Não', etilismo: 'Social', sono: 'Boa' } });
    call(F, 'POST', '/api/records', { type: 'avaliacao', patient_id: p2, record_date: addDays(-30), title: 'Avaliação inicial · Esportiva', data: { area: 'esportiva', e_modalidade: 'Futebol society / atacante', e_nivel: 'Amador competitivo', e_volume: '6 h/semana (antes da lesão)', e_temporada: 'Afastado', e_retorno: 'Retorno ao treino em 6 meses, após liberação da cirurgiã', e_criterios: 'LSI ≥ 90% em hop tests e força de quadríceps; sem derrame; ADM completa; ACL-RSI ≥ 65.', tipo: 'Avaliação inicial', dor_presente: 'Sim', dor_localizacao: 'Joelho D, região anteromedial', dor_intensidade: 5, dor_tipo: ['Peso', 'Contínua'], inspecao: 'Edema moderado (perimetria +2,5 cm em relação ao lado E). Cicatrizes em bom aspecto.', adm: 'Flexão joelho D: 70°; extensão: -5°. Joelho E: 0–140°.', forca: 'Quadríceps D grau 3 (déficit de ativação do vasto medial).', mobilidade: 'Patela com mobilidade reduzida em sentido medial.', equilibrio: 'Apoio unipodal D: 8 s com oscilação.', marcha: 'Com duas muletas, descarga parcial de peso, extensão incompleta do joelho no apoio.', limitacoes: 'Subir escadas, agachar, marcha sem auxílio.', testes: 'Lachman: endpoint firme (enxerto íntegro).', escalas: 'Lysholm: 52.' } });
    call(F, 'POST', '/api/records', { type: 'plano', patient_id: p2, record_date: addDays(-30), status: 'ativo', data: { diagnostico_fisio: 'Déficit de ADM e força do joelho D no pós-operatório de LCA, com alteração de marcha.', objetivo_geral: 'Retorno às atividades de vida diária em 12 semanas e ao esporte após liberação médica.', objetivos_especificos: 'Extensão completa até a 4ª semana\nFlexão ≥ 120° até a 8ª semana\nMarcha sem muletas\nForça de quadríceps ≥ 80% do lado contralateral', condutas: 'Protocolo acelerado de reabilitação de LCA, controle de edema, ativação de quadríceps, treino de marcha e propriocepção progressiva.', tecnicas: ['Cinesioterapia', 'Eletroterapia (TENS/FES)', 'Crioterapia', 'Propriocepção', 'Treino de marcha'], exercicios: 'Isometria de quadríceps com FES, deslizamento de calcanhar, elevação de perna estendida, mini-agachamento, bicicleta ergométrica, propriocepção em superfícies instáveis.', frequencia: '3x por semana', duracao: '12 semanas / 36 sessões', criterios_reavaliacao: 'Reavaliação a cada 4 semanas com perimetria, goniometria e testes funcionais.' } });
    course(F, p2, { area: 'esportiva', extra: (s) => ({ e_fase: s < 5 ? 'Proteção' : s < 10 ? 'Controle motor' : 'Fortalecimento', e_carga: `PSE ${Math.min(7, 3 + Math.floor(s / 3))}/10` }), startDay: -28, every: [2, 2, 3], count: 14, price: 150, painFrom: 5, painTo: 1, paidUntil: 11, hour: '17:00', evo: (s, a, b) => ({ queixa: s < 4 ? 'Joelho ainda inchado ao final do dia.' : 'Sem queixas de dor; insegurança na escada.', dor_inicio: a, condicao_inicial: `Flexão aproximada: ${Math.min(130, 70 + s * 6)}°.`, exercicios: s < 5 ? 'Isometria de quadríceps com FES 10 min; deslizamento de calcanhar 3x15; elevação de perna estendida 3x10.' : 'Mini-agachamento 3x12; step-up 3x10; bicicleta 15 min; apoio unipodal em disco 3x30 s.', tecnicas: s < 5 ? 'FES, crioterapia 20 min, mobilização patelar.' : 'Propriocepção, treino de marcha sem muletas.', series_repeticoes: '3x10 a 3x15', tempo: '60 min', resposta: 'Boa adesão.', dor_fim: b, evolucao: s < 5 ? 'Redução do edema; ganho de ADM.' : 'Marcha independente; progressão de carga.', orientacoes: 'Gelo 20 min 3x/dia; exercícios domiciliares.' }) });

    // 3 — AVC, pacote, domiciliar
    const p3 = call(A, 'POST', '/api/patients', { name: 'Sebastião Moreira', birth_date: '1950-12-07', cpf: cpfFrom(150127004), phone: '(31) 3442-8810', address: 'Rua Tupis, 88 — Centro — Belo Horizonte/MG', profession: 'Aposentado (comerciante)', emergency_name: 'Cláudia Moreira (filha)', emergency_phone: '(31) 99654-3302', first_visit: addDays(-24), status: 'em_tratamento', professional_id: admin.id, notes: 'Pagamentos feitos pela filha (Cláudia).' }).id;
    call(A, 'POST', `/api/patients/${p3}/consents`, { method: 'assinatura_fisica', signer_name: 'Cláudia Moreira (responsável)', accepted_at: addDays(-24) });
    call(A, 'POST', '/api/records', { type: 'anamnese', patient_id: p3, record_date: addDays(-24), data: { diagnostico_medico: 'Sequela de AVC isquêmico (hemiparesia à esquerda) — 4 meses', cid: 'I69.3', queixa_principal: 'Fraqueza no lado esquerdo e medo de cair.', hda: 'AVC isquêmico há 4 meses, internado por 12 dias. Recebeu alta com hemiparesia à esquerda, deambulando com bengala.', doencas_associadas: ['Hipertensão', 'Diabetes', 'Cardiopatia'], medicamentos: 'AAS 100 mg; Atorvastatina 40 mg; Metformina 850 mg; Enalapril 10 mg', cirurgias: 'Nega', historico_familiar: 'Mãe com AVC aos 70 anos.', alergias: 'Nega', atividade_fisica: 'Sedentário', tabagismo: 'Ex-fumante', etilismo: 'Não', sono: 'Regular' } });
    call(A, 'POST', '/api/records', { type: 'avaliacao', patient_id: p3, record_date: addDays(-24), title: 'Avaliação inicial · Neurofuncional', data: { area: 'neurologica', n_lado: 'Esquerdo', n_consciencia: 'Alerta', n_cognicao: 'MEEM 25/30', n_comunicacao: 'Disartria', n_tonus: 'Flexores de cotovelo E: 1+; flexores plantares E: 2 (Ashworth modificada)', n_controle_tronco: 'Parcial', n_transferencias: ['Rolar', 'Deitado para sentado'], n_dispositivo: 'Bengala', n_escalas: 'Berg 38/56; TUG 21 s; Barthel 75/100', tipo: 'Avaliação inicial', dor_presente: 'Não', dor_intensidade: 1, inspecao: 'Postura assimétrica, ombro E rebaixado.', adm: 'ADM passiva preservada; ombro E com limitação dolorosa acima de 120° de flexão.', forca: 'MSE grau 3; MIE grau 3+ (dorsiflexores grau 2).', mobilidade: 'Transferências com supervisão.', equilibrio: 'Berg: 38/56 (alto risco de quedas). TUG: 21 s.', marcha: 'Com bengala, padrão ceifante à E, redução de dorsiflexão.', limitacoes: 'Subir escadas, banho sem auxílio, caminhar fora de casa.', escalas: 'Berg 38/56; TUG 21 s.' } });
    call(A, 'POST', '/api/records', { type: 'plano', patient_id: p3, record_date: addDays(-24), status: 'ativo', data: { diagnostico_fisio: 'Hemiparesia E pós-AVC com déficit de equilíbrio e alto risco de quedas.', objetivo_geral: 'Melhorar independência funcional e reduzir o risco de quedas.', objetivos_especificos: 'Berg ≥ 45\nTUG < 14 s\nMarcha comunitária com bengala', condutas: 'Treino de equilíbrio, fortalecimento, treino de marcha e de transferências; orientação à família para adaptação domiciliar.', tecnicas: ['Cinesioterapia', 'Treino de marcha', 'Propriocepção', 'Treino funcional'], frequencia: '2x por semana', duracao: '16 semanas', criterios_reavaliacao: 'Reavaliar Berg e TUG a cada 8 sessões.' } });
    call(A, 'POST', '/api/patient-packages', { patient_id: p3, package_id: pk.id, start_date: addDays(-24) });
    const pkgCharge = db.charges.find((c) => c.patient_id === p3 && c.patient_package_id);
    call(A, 'POST', `/api/charges/${pkgCharge.id}/pay`, { paid_at: addDays(-23), method: 'transferencia', payer_name: 'Cláudia Moreira', payer_cpf: cpfFrom(298114503) });
    course(A, p3, { area: 'neurologica', extra: (s) => ({ n_controle_tronco: s < 5 ? 'Parcial' : 'Adequado', n_marcha: `Com bengala, ${40 + s * 15} m sem pausa` }), startDay: -21, count: 9, price: 0, painFrom: 2, painTo: 0, hour: '10:00', evo: (s, a, b) => ({ queixa: s < 3 ? 'Sente-se cansado após caminhar dentro de casa.' : 'Mais confiante para caminhar.', dor_inicio: a, condicao_inicial: 'PA 130/80 mmHg antes da sessão.', exercicios: 'Sentar e levantar 3x8; marcha em barras paralelas; apoio unipodal assistido; transferência de peso lateral.', tecnicas: 'Treino de equilíbrio e marcha; fortalecimento de MIE.', series_repeticoes: '3x8', tempo: '50 min', resposta: s < 3 ? 'Fadiga moderada.' : 'Boa tolerância.', dor_fim: b, evolucao: s < 3 ? 'Melhora da transferência de peso para a E.' : `TUG ${Math.max(15, 21 - s)} s.`, orientacoes: 'Retirar tapetes soltos; barra de apoio no banheiro.' }) });

    // 4 — Finalizado
    const p4 = call(F, 'POST', '/api/patients', { name: 'Renata Campos Vieira', birth_date: '1985-06-25', cpf: cpfFrom(256850119), phone: '(31) 99201-7788', profession: 'Analista de sistemas', address: 'Rua Grão Mogol, 510 — Sion — Belo Horizonte/MG', first_visit: addDays(-90), status: 'finalizado', professional_id: fisio.id }).id;
    call(F, 'POST', `/api/patients/${p4}/consents`, { method: 'assinatura_digital', accepted_at: addDays(-90) });
    call(F, 'POST', '/api/records', { type: 'anamnese', patient_id: p4, record_date: addDays(-90), data: { diagnostico_medico: 'Cervicalgia tensional', cid: 'M54.2', queixa_principal: 'Dor no pescoço e cefaleia ao final do expediente.', hda: 'Dor cervical há 6 meses, relacionada ao trabalho em computador.', atividade_fisica: 'Irregular', sono: 'Ruim' } });
    call(F, 'POST', '/api/records', { type: 'avaliacao', patient_id: p4, record_date: addDays(-90), title: 'Avaliação inicial · Traumato-ortopédica', data: { area: 'ortopedica', o_segmento: 'Coluna cervical', o_fase: 'Crônica', tipo: 'Avaliação inicial', dor_presente: 'Sim', dor_localizacao: 'Cervical e trapézio superior bilateral', dor_intensidade: 6, adm: 'Rotação cervical D 55° / E 60°.', forca: 'Flexores profundos do pescoço: 18 s (teste de resistência).', limitacoes: 'Trabalhar mais de 2 h seguidas.' } });
    call(F, 'POST', '/api/records', { type: 'plano', patient_id: p4, record_date: addDays(-89), status: 'concluido', data: { diagnostico_fisio: 'Disfunção cervical com déficit de resistência dos flexores profundos.', objetivo_geral: 'Eliminar a dor e prevenir recidivas.', tecnicas: ['Terapia manual', 'Liberação miofascial', 'Cinesioterapia'], frequencia: '2x por semana', duracao: '6 semanas' } });
    course(F, p4, { startDay: -86, count: 10, price: 150, painFrom: 6, painTo: 0, hour: '19:00', evo: (s, a, b) => ({ queixa: s < 5 ? 'Cefaleia 2x na semana.' : 'Sem cefaleia na última semana.', dor_inicio: a, exercicios: 'Flexão crânio-cervical com biofeedback 3x10; retração escapular 3x12.', tecnicas: 'Liberação miofascial de trapézio; mobilização cervical.', series_repeticoes: '3x10', tempo: '50 min', resposta: 'Boa.', dor_fim: b, evolucao: s < 10 ? 'Melhora progressiva.' : 'Objetivos atingidos — alta.', orientacoes: 'Ajuste ergonômico da estação de trabalho.' }) });
    call(F, 'POST', '/api/records', { type: 'avaliacao', patient_id: p4, record_date: addDays(-52), title: 'Alta', data: { tipo: 'Alta', dor_presente: 'Não', dor_intensidade: 0, adm: 'Rotação cervical 80° bilateral.', forca: 'Flexores profundos: 38 s.', observacoes: 'Objetivos atingidos. Alta com orientação de exercícios domiciliares.' } });

    // 7 — Respiratória
    const p7 = call(A, 'POST', '/api/patients', { name: 'Antônio Carlos Nogueira', birth_date: '1956-05-11', cpf: cpfFrom(561105233), phone: '(31) 99411-2087', profession: 'Aposentado (metalúrgico)', address: 'Rua Itambé, 72 — Floresta — Belo Horizonte/MG', emergency_name: 'Marta Nogueira (esposa)', emergency_phone: '(31) 99411-2090', first_visit: addDays(-20), status: 'em_tratamento', professional_id: admin.id }).id;
    call(A, 'POST', `/api/patients/${p7}/consents`, { method: 'assinatura_fisica', accepted_at: addDays(-20) });
    call(A, 'POST', '/api/records', { type: 'anamnese', patient_id: p7, record_date: addDays(-20), data: { diagnostico_medico: 'DPOC (GOLD 3) com exacerbação recente', cid: 'J44.1', medico_solicitante: 'Dr. Ricardo Alves — Pneumologia', queixa_principal: 'Falta de ar para tomar banho e tosse com catarro que não consegue eliminar.', hda: 'Internado há 5 semanas por exacerbação infecciosa da DPOC (7 dias). Após a alta, mantém dispneia aos pequenos esforços e acúmulo de secreção pela manhã.', inicio_sintomas: addDays(-36), historico_saude: 'DPOC diagnosticada há 8 anos. Duas internações no último ano.', doencas_associadas: ['Hipertensão', 'Doença respiratória'], medicamentos: 'Formoterol + budesonida inalatório; tiotrópio; salbutamol se necessário; losartana', cirurgias: 'Nega', historico_familiar: 'Pai com enfisema.', alergias: 'Nega', exames: 'Espirometria: VEF1 42% do previsto, VEF1/CVF 0,52. RX: hiperinsuflação.', atividade_fisica: 'Sedentário', tabagismo: 'Ex-fumante', etilismo: 'Não', sono: 'Ruim', habitos: 'Fumou 40 maços-ano; parou há 3 anos. Dorme com 2 travesseiros.' } });
    call(A, 'POST', '/api/records', { type: 'avaliacao', patient_id: p7, record_date: addDays(-20), title: 'Avaliação inicial · Respiratória', data: { area: 'respiratoria', tipo: 'Avaliação inicial', dor_presente: 'Não', r_fr: '26', r_spo2: '89% em ar ambiente / 93% com O₂ 1 L/min', r_fc: '98', r_pa: '138/84', r_o2: 'Cateter nasal', r_o2_fluxo: '1 L/min aos esforços', r_torax: 'Tonel', r_padrao: 'Costal superior', r_ritmo: 'Taquipneia', r_expansibilidade: 'Diminuída bilateralmente', r_sinais: ['Uso de musculatura acessória', 'Respiração com lábios franzidos', 'Baqueteamento digital'], r_cirtometria: 'Axilar 2 cm / xifoide 1,5 cm / basal 1 cm', r_mv: 'Diminuído', r_ruidos: ['Roncos', 'Sibilos', 'Estertores subcrepitantes'], r_ausculta_local: 'Roncos difusos; subcrepitantes em base D', r_tosse: 'Presente — ineficaz', r_tosse_tipo: 'Produtiva', r_secrecao_qtd: 'Moderada', r_secrecao_aspecto: 'Mucopurulenta', r_secrecao_cor: 'Amarelada', r_secrecao_viscosidade: 'Espessa', r_mrc: '3 — para após ~100 m no plano', r_borg: '3 — moderada', r_pimax: '−48 / +62 cmH₂O', r_peakflow: '180 L/min', r_tc6: '240 m; SpO₂ mínima 84% (sem O₂); Borg 7', limitacoes: 'Banho, vestir-se, subir 1 lance de escada.', escalas: 'CAT 26; mMRC 3', observacoes: 'Paciente e esposa orientados sobre técnicas de remoção de secreção e conservação de energia.' } });
    call(A, 'POST', '/api/records', { type: 'plano', patient_id: p7, record_date: addDays(-20), status: 'ativo', data: { diagnostico_fisio: 'Disfunção ventilatória obstrutiva com hipersecreção, tosse ineficaz, fraqueza muscular inspiratória e intolerância ao esforço.', objetivo_geral: 'Melhorar a higiene brônquica, reduzir a dispneia e aumentar a tolerância ao exercício.', objetivos_especificos: 'Tornar a tosse eficaz\nReduzir secreção para pequena quantidade\nPImáx ≥ −70 cmH₂O\nAumentar o TC6 em ≥ 30 m', condutas: 'Higiene brônquica (ELTGOL, AFE, huffing, PEP oscilante), treinamento muscular inspiratório, reabilitação pulmonar com exercício aeróbico intervalado e fortalecimento periférico.', tecnicas: ['Fisioterapia respiratória', 'Cinesioterapia', 'Treino funcional'], outras_tecnicas: 'TMI com threshold a 30% da PImáx; Shaker', exercicios: 'Esteira intervalada 2 min/1 min; fortalecimento de MMSS e MMII; respiração diafragmática e frenolabial.', frequencia: '3x por semana', duracao: '12 semanas', criterios_reavaliacao: 'Reavaliar PImáx, TC6 e CAT a cada 12 sessões ou após nova exacerbação.', orientacoes: 'Huffing 3x/dia; Shaker antes de dormir; não suspender as medicações inalatórias.' } });
    course(A, p7, { area: 'respiratoria', startDay: -18, every: [2, 2, 3], count: 11, price: 150, painFrom: 0, painTo: 0, paidUntil: 8, hour: '15:00',
      extra: (s) => ({ r_fr: `${Math.max(18, 26 - s)} / ${Math.max(17, 24 - s)}`, r_spo2: `${Math.min(94, 89 + Math.floor(s / 2))} / ${Math.min(96, 91 + Math.floor(s / 2))}`, r_fc: `${96 - s} / ${100 - s}`, r_o2: s < 5 ? 'Cateter nasal' : 'Ar ambiente', r_ruidos: s < 4 ? ['Roncos', 'Estertores subcrepitantes'] : s < 8 ? ['Roncos'] : ['Sem ruídos'], r_tosse: s < 5 ? 'Presente — ineficaz' : 'Presente — eficaz', r_secrecao_qtd: s < 4 ? 'Moderada' : s < 8 ? 'Pequena' : 'Ausente', r_secrecao_aspecto: s < 4 ? 'Mucopurulenta' : 'Mucoide', r_borg: s < 4 ? '5 — intensa' : s < 8 ? '4 — pouco intensa' : '3 — moderada' }),
      evo: (s) => ({ queixa: s < 4 ? 'Muito catarro pela manhã; cansaço para o banho.' : s < 8 ? 'Catarro sai com mais facilidade.' : 'Tomou banho sem precisar parar.', condicao_inicial: s < 5 ? 'Em uso de O₂ 1 L/min.' : 'Em ar ambiente, estável.', exercicios: s < 4 ? 'Respiração diafragmática; TMI 3x10; cicloergômetro de MMSS 10 min.' : 'Esteira intervalada 15 min; TMI 3x15; fortalecimento de MMII com caneleira 1 kg.', tecnicas: 'ELTGOL, AFE lenta, huffing; Shaker 3 séries de 10.', series_repeticoes: '3x10 a 3x15', tempo: '50 min', resposta: s < 4 ? 'Expectorou secreção mucopurulenta em moderada quantidade.' : 'Boa resposta à higiene brônquica.', evolucao: s < 5 ? 'Melhora da ausculta após as manobras.' : 'Tosse eficaz; redução da dispneia aos esforços.', orientacoes: 'Huffing 3x/dia; hidratação; Shaker antes de dormir.' }) });

    // 5 — Em avaliação
    const p5 = call(A, 'POST', '/api/patients', { name: 'Pedro Henrique Alves', birth_date: '2003-02-14', cpf: cpfFrom(377920148), phone: '(31) 98455-9031', profession: 'Estudante', first_visit: today(), status: 'avaliacao', professional_id: admin.id }).id;
    call(A, 'POST', `/api/patients/${p5}/consents`, { method: 'aceite_presencial' });
    call(A, 'POST', '/api/records', { type: 'anamnese', patient_id: p5, record_date: today(), data: { diagnostico_medico: 'Entorse de tornozelo E grau II', cid: 'S93.4', queixa_principal: 'Dor e inchaço no tornozelo ao caminhar.', hda: 'Entorse em inversão jogando basquete há 10 dias.', inicio_sintomas: addDays(-10), atividade_fisica: '3–4x por semana' } });
    call(A, 'POST', '/api/appointments', { patient_id: p5, start: `${addDays(1)}T14:00`, kind: 'avaliacao', price: 200, force: true });
    call(A, 'POST', '/api/appointments', { patient_id: p5, start: `${addDays(3)}T14:00`, price: 150, force: true });

    // 6 — Novo, sem consentimento
    const p6 = call(A, 'POST', '/api/patients', { name: 'Beatriz Lopes Martins', birth_date: '1996-08-30', phone: '(31) 99300-6612', profession: 'Designer', first_visit: addDays(2), status: 'avaliacao' }).id;
    call(A, 'POST', '/api/appointments', { patient_id: p6, start: `${addDays(2)}T09:00`, kind: 'avaliacao', price: 200, professional_id: fisio.id, force: true });
    const ap6 = call(A, 'POST', '/api/appointments', { patient_id: p6, start: `${addDays(-6)}T09:00`, kind: 'avaliacao', price: 200, professional_id: fisio.id, force: true });
    call(A, 'PUT', `/api/appointments/${ap6.ids[0]}`, { status: 'cancelado', notes: 'Paciente remarcou.' });

    // Um lançamento avulso pendente e vencido
    call(A, 'POST', '/api/charges', { patient_id: p1, description: 'Avaliação fisioterapêutica', amount: 200, due_date: addDays(-38), status: 'pago', paid_at: addDays(-38), method: 'pix' });

    db.audit_log = db.audit_log.map((l) => ({ ...l, details: l.details, ip: 'dados de exemplo' }));
    db.session = null; seeding = false; save();
  }

  // ---------------- Despacho ----------------
  function dispatch(method, pathname, body, asUser, query = new URLSearchParams()) {
    const ctx = { query, body: body || {}, user: asUser || null, params: {} };
    try {
      const r = routes.find((x) => x.method === method && x.re.test(pathname));
      if (!r) throw new HttpError(404, 'Rota não encontrada');
      const m = pathname.match(r.re); r.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
      if (!r.opts.public && !ctx.user) { const u = byId('users', db.session); if (!u || !u.active) throw new HttpError(401, 'Sessão expirada. Faça login novamente.'); ctx.user = u; }
      const out = r.handler(ctx);
      if (method !== 'GET' || /\/records|\/patients\/\d+$|carne-leao/.test(pathname)) save();
      return { status: 200, body: out ?? { ok: true } };
    } catch (e) {
      if (!(e instanceof HttpError)) { console.error(e); return { status: 500, body: { error: 'Erro interno' } }; }
      return { status: e.status, body: { error: e.message } };
    }
  }

  db = load();
  if (!db || !db.users || !db.users.length) seed();

  const backend = {
    handle(method, url, body) { const u = new URL(url, 'http://demo.local'); return dispatch(method, u.pathname, body, null, u.searchParams); },
    reset() { seed(); },
  };
  window.FISIO_BACKEND = backend;
  installFetch(backend);

  function installFetch(be) {
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('/api/')) return orig(input, init);
      let body = null; if (init.body) { try { body = JSON.parse(init.body); } catch (e) { body = {}; } }
      await new Promise((r) => setTimeout(r, 40));
      const out = be.handle((init.method || 'GET').toUpperCase(), url, body);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
    };
  }
})();

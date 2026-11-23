'use strict';
// Área administrativa da PLATAFORMA (dono do SaaS): métricas, clínicas, financeiro, chaves de API,
// usuários/contatos de marketing e administradores.
//
// Princípio: o administrador da plataforma NÃO acessa dados clínicos nem cadastros de pacientes.
// Das clínicas ele vê apenas dados de conta/assinatura e contagens agregadas (LGPD: a plataforma é operadora).
const crypto = require('crypto');
const { sql, withClinic, getClinic, ensureCore } = require('./core');
const { HttpError, route, parseCookies } = require('./http');
const config = require('./config');
const stripe = require('./stripe');
const mp = require('./mercadopago');

const SESSION_HOURS = 4;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function registerAdmin(deps) {
  const { hashPassword, checkPassword, validatePassword, sha, DUMMY_HASH, checkRate, failRate, clearRate, clinicAccess, unsubscribeUrl, COOKIE_SECURE } = deps;

  // ---------- Sessão do administrador (cookie próprio, restrito a /api/admin) ----------
  const setCookie = (res, token, maxAge) => res.setHeader('Set-Cookie',
    `fisio_adm=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`);
  async function createSession(res, adminId, ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    await sql.unsafe('INSERT INTO saas.admin_sessions(token_hash, admin_id, expires_at, ip) VALUES ($1,$2,$3,$4)', [sha(token), adminId, Date.now() + SESSION_HOURS * 3600e3, ip]);
    setCookie(res, token, SESSION_HOURS * 3600);
  }
  async function currentAdmin(ctx) {
    const token = parseCookies(ctx.req).fisio_adm;
    if (!token) return null;
    const s = (await sql.unsafe('SELECT * FROM saas.admin_sessions WHERE token_hash=$1', [sha(token)]))[0];
    if (!s || s.expires_at < Date.now()) { if (s) await sql.unsafe('DELETE FROM saas.admin_sessions WHERE token_hash=$1', [s.token_hash]); return null; }
    const a = (await sql.unsafe('SELECT id, name, email, active FROM saas.admins WHERE id=$1', [s.admin_id]))[0];
    if (!a || !a.active) return null;
    await sql.unsafe('UPDATE saas.admin_sessions SET expires_at=$2 WHERE token_hash=$1', [s.token_hash, Date.now() + SESSION_HOURS * 3600e3]);
    setCookie(ctx.res, token, SESSION_HOURS * 3600);
    return a;
  }
  async function log(ctx, action, target, details) {
    await sql.unsafe('INSERT INTO saas.admin_audit(admin_id, admin_name, action, target, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [ctx.admin?.id ?? null, ctx.admin?.name ?? null, action, target ?? null, details ? JSON.stringify(details).slice(0, 2000) : null, ctx.ip]);
  }
  // Registra rota protegida: exige administrador logado
  const adminRoute = (method, path, fn) => route(method, path, async (ctx) => {
    ctx.admin = await currentAdmin(ctx);
    if (!ctx.admin) throw new HttpError(401, 'Sessão de administrador expirada. Entre novamente.');
    return fn(ctx);
  }, { public: true, always: true });

  // ---------- Primeiro acesso, login e logout ----------
  route('GET', '/api/admin/status', async (ctx) => {
    const count = (await sql.unsafe('SELECT COUNT(*) n FROM saas.admins'))[0].n;
    return { needsSetup: count === 0, setupEnabled: !!process.env.ADMIN_SETUP_TOKEN, admin: await currentAdmin(ctx) };
  }, { public: true });

  // O primeiro administrador só pode ser criado por quem conhece ADMIN_SETUP_TOKEN (variável cadastrada na Vercel)
  route('POST', '/api/admin/setup', async (ctx) => {
    const b = ctx.body; const rateKey = `admin-setup|${ctx.ip}`;
    await checkRate(rateKey);
    const expected = process.env.ADMIN_SETUP_TOKEN || '';
    if (!expected) throw new HttpError(403, 'Defina a variável ADMIN_SETUP_TOKEN na Vercel para criar o primeiro administrador.');
    const given = String(b.token || '');
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) { await failRate(rateKey); throw new HttpError(403, 'Código de configuração incorreto'); }
    if ((await sql.unsafe('SELECT COUNT(*) n FROM saas.admins'))[0].n > 0) throw new HttpError(400, 'O administrador inicial já foi criado. Use "Entrar".');
    const name = String(b.name || '').trim().slice(0, 120); const email = String(b.email || '').trim().toLowerCase().slice(0, 160);
    if (!name) throw new HttpError(400, 'Nome é obrigatório');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'E-mail inválido');
    validatePassword(b.password);
    if (String(b.password).length < 12) throw new HttpError(400, 'Para o administrador da plataforma, use uma senha com pelo menos 12 caracteres');
    const [a] = await sql.unsafe('INSERT INTO saas.admins(name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email', [name, email, hashPassword(b.password)]);
    await clearRate(rateKey);
    ctx.admin = a; await log(ctx, 'criou_admin_inicial', email);
    await createSession(ctx.res, a.id, ctx.ip);
    return { ok: true };
  }, { public: true });

  route('POST', '/api/admin/login', async (ctx) => {
    const email = String(ctx.body.email || '').trim().toLowerCase().slice(0, 160);
    const password = String(ctx.body.password || '').slice(0, 200);
    const key = `admin|${ctx.ip}|${email}`;
    await checkRate(key);
    const a = (await sql.unsafe('SELECT * FROM saas.admins WHERE email=$1', [email]))[0];
    const ok = checkPassword(password, a ? a.password_hash : DUMMY_HASH);
    if (!a || !a.active || !ok) {
      await failRate(key, 5, 30);
      ctx.admin = null; await log(ctx, 'login_falhou', email);
      throw new HttpError(401, 'E-mail ou senha incorretos');
    }
    await clearRate(key);
    await sql.unsafe('UPDATE saas.admins SET last_login=now() WHERE id=$1', [a.id]);
    ctx.admin = a; await log(ctx, 'login');
    await createSession(ctx.res, a.id, ctx.ip);
    return { ok: true };
  }, { public: true });

  adminRoute('POST', '/api/admin/logout', async (ctx) => {
    const token = parseCookies(ctx.req).fisio_adm;
    if (token) await sql.unsafe('DELETE FROM saas.admin_sessions WHERE token_hash=$1', [sha(token)]);
    setCookie(ctx.res, '', 0);
    return { ok: true };
  });
  adminRoute('GET', '/api/admin/me', async (ctx) => ({ admin: ctx.admin }));

  // ---------- Clínicas: dados de conta + contagens agregadas (sem conteúdo clínico) ----------
  async function clinicStats(c) {
    try {
      return await withClinic(c, async () => {
        const { q } = require('./core');
        return {
          users: (await q.get('SELECT COUNT(*) n FROM users WHERE active=1')).n,
          patients: (await q.get('SELECT COUNT(*) n FROM patients')).n,
          appts_30d: (await q.get("SELECT COUNT(*) n FROM appointments WHERE start >= to_char(now() - interval '30 days', 'YYYY-MM-DD')")).n,
          last_login: (await q.get('SELECT MAX(last_login) v FROM users')).v,
        };
      });
    } catch (e) { console.error('Estatísticas da clínica', c.id, e.message); return null; }
  }
  const view = (c) => ({
    id: c.id, name: c.name, owner_email: c.owner_email, created_at: c.created_at, trial_ends_at: c.trial_ends_at, timezone: c.timezone,
    subscription_status: c.subscription_status, current_period_end: c.current_period_end, cancel_at_period_end: c.cancel_at_period_end,
    stripe_customer_id: c.stripe_customer_id, mp_preapproval_id: c.mp_preapproval_id,
    billing_provider: c.billing_provider || (c.stripe_subscription_id ? 'stripe' : null), manual_access: c.manual_access, access: clinicAccess(c),
  });

  adminRoute('GET', '/api/admin/clinics', async (ctx) => {
    const withStats = ctx.query.get('stats') === '1';
    const rows = await sql.unsafe('SELECT * FROM saas.clinics ORDER BY created_at DESC');
    const out = [];
    for (const c of rows) out.push({ ...view(c), stats: withStats ? await clinicStats(c) : undefined });
    return out;
  });
  adminRoute('PUT', '/api/admin/clinics/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const c = Number.isInteger(id) ? await getClinic(id) : null;
    if (!c) throw new HttpError(404, 'Clínica não encontrada');
    const b = ctx.body; const changes = {};
    if (b.extend_trial_days !== undefined) {
      const d = Number(b.extend_trial_days);
      if (!Number.isInteger(d) || d < 1 || d > 365) throw new HttpError(400, 'Informe de 1 a 365 dias');
      await sql.unsafe("UPDATE saas.clinics SET trial_ends_at = GREATEST(trial_ends_at, now()) + ($2 || ' days')::interval WHERE id=$1", [id, String(d)]);
      changes.estendeu_teste_dias = d;
    }
    if (b.manual_access !== undefined) {
      const v = b.manual_access === '' || b.manual_access === null ? null : b.manual_access;
      if (v !== null && !['full', 'readonly', 'blocked'].includes(v)) throw new HttpError(400, 'Opção de acesso inválida');
      await sql.unsafe('UPDATE saas.clinics SET manual_access=$2 WHERE id=$1', [id, v]);
      if (v === 'blocked') await sql.unsafe('DELETE FROM saas.sessions WHERE clinic_id=$1', [id]);
      changes.acesso_manual = v ?? 'automático';
    }
    await log(ctx, 'alterou_clinica', `#${id} ${c.name}`, changes);
    return view(await getClinic(id));
  });

  // ---------- Dashboard ----------
  adminRoute('GET', '/api/admin/dashboard', async () => {
    const clinics = await sql.unsafe('SELECT * FROM saas.clinics');
    const now = Date.now();
    const count = { total: clinics.length, trial: 0, trial_ending_3d: 0, paying: 0, past_due: 0, readonly: 0, blocked: 0 };
    for (const c of clinics) {
      const a = clinicAccess(c);
      if (a.mode === 'blocked') count.blocked++;
      else if (a.reason === 'trial') { count.trial++; if (new Date(c.trial_ends_at).getTime() - now < 3 * 86400e3) count.trial_ending_3d++; }
      else if (a.reason === 'subscription') count.paying++;
      else if (a.reason === 'past_due') count.past_due++;
      else if (a.mode === 'readonly') count.readonly++;
    }
    const decided = clinics.filter((c) => c.subscription_status || new Date(c.trial_ends_at).getTime() < now).length;
    const signups = await sql.unsafe(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COUNT(c.id) AS n
      FROM generate_series(current_date - 29, current_date, interval '1 day') d
      LEFT JOIN saas.clinics c ON c.created_at::date = d::date GROUP BY d ORDER BY d`);
    const users = (await sql.unsafe('SELECT COUNT(*) n FROM saas.user_index'))[0].n;
    const optIn = (await sql.unsafe('SELECT COUNT(*) n FROM saas.marketing_contacts WHERE opt_in'))[0].n;
    const recent = (await sql.unsafe('SELECT * FROM saas.clinics ORDER BY created_at DESC LIMIT 8')).map(view);
    let mrr = null;
    const addMrr = (m) => { for (const [cur, v] of Object.entries(m || {})) mrr[cur] = Math.round(((mrr[cur] || 0) + v) * 100) / 100; };
    if (stripe.enabled() || mp.enabled()) {
      mrr = {};
      try {
        if (stripe.enabled()) addMrr((await stripeSummary()).mrr);
        if (mp.enabled()) addMrr((await mpSummary()).mrr);
      } catch (e) { mrr = { error: e.message }; }
    }
    return {
      count, users, marketing_opt_in: optIn,
      conversion: decided ? Math.round((clinics.filter((c) => ['active', 'past_due'].includes(c.subscription_status)).length / decided) * 1000) / 10 : null,
      signups_30d: signups.map((r) => ({ day: r.day, n: r.n })), recent, mrr, billing_enabled: stripe.enabled() || mp.enabled(),
    };
  });

  // ---------- Financeiro (dados do Stripe) ----------
  let finCache = null; let finAt = 0;
  async function stripeSummary(force = false) {
    if (!force && finCache && Date.now() - finAt < 5 * 60e3) return finCache;
    const per = { day: 30, week: 52 / 12, month: 1, year: 1 / 12 };
    const subs = []; let starting_after;
    for (let page = 0; page < 10; page++) {
      const r = await stripe.request('GET', '/v1/subscriptions', { status: 'all', limit: 100, 'expand[]': 'data.items.data.price', starting_after });
      subs.push(...r.data); if (!r.has_more) break; starting_after = r.data[r.data.length - 1].id;
    }
    const mrr = {};
    for (const s of subs) {
      if (!['active', 'past_due'].includes(s.status)) continue;
      for (const it of s.items?.data || []) {
        const p = it.price || {}; const cur = (p.currency || 'brl').toUpperCase();
        const monthly = ((p.unit_amount || 0) / 100) * (it.quantity || 1) * (per[p.recurring?.interval] ?? 1) / (p.recurring?.interval_count || 1);
        mrr[cur] = Math.round(((mrr[cur] || 0) + monthly) * 100) / 100;
      }
    }
    const since = Math.floor(Date.now() / 1000) - 365 * 86400;
    const invoices = []; starting_after = undefined;
    for (let page = 0; page < 10; page++) {
      const r = await stripe.request('GET', '/v1/invoices', { status: 'paid', limit: 100, 'created[gte]': since, starting_after });
      invoices.push(...r.data); if (!r.has_more) break; starting_after = r.data[r.data.length - 1].id;
    }
    const names = Object.fromEntries((await sql.unsafe('SELECT stripe_customer_id, name FROM saas.clinics WHERE stripe_customer_id IS NOT NULL')).map((r) => [r.stripe_customer_id, r.name]));
    const byMonth = {};
    for (const i of invoices) {
      const m = new Date(i.created * 1000).toISOString().slice(0, 7); const cur = (i.currency || 'brl').toUpperCase();
      byMonth[m] = byMonth[m] || {}; byMonth[m][cur] = Math.round(((byMonth[m][cur] || 0) + i.amount_paid / 100) * 100) / 100;
    }
    finCache = {
      mrr,
      subscriptions: subs.reduce((acc, s) => ((acc[s.status] = (acc[s.status] || 0) + 1), acc), {}),
      revenue_by_month: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
      recent_invoices: invoices.slice(0, 25).map((i) => ({ id: i.id, number: i.number, clinic: names[i.customer] || i.customer_email || i.customer, amount: i.amount_paid / 100, currency: (i.currency || 'brl').toUpperCase(), created: new Date(i.created * 1000).toISOString(), url: i.hosted_invoice_url })),
      fetched_at: new Date().toISOString(),
    };
    finAt = Date.now();
    return finCache;
  }
  // ---------- Financeiro (dados do Mercado Pago) ----------
  let mpCache = null; let mpAt = 0;
  async function mpSummary(force = false) {
    if (!force && mpCache && Date.now() - mpAt < 5 * 60e3) return mpCache;
    const all = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const r = await mp.request('GET', `/preapproval/search?limit=100&offset=${offset}`);
      const page = r.results || [];
      all.push(...page);
      if (page.length < 100) break;
    }
    const names = Object.fromEntries((await sql.unsafe('SELECT id, name FROM saas.clinics')).map((r) => [String(r.id), r.name]));
    const mrr = {}; const statuses = {};
    for (const p of all) {
      statuses[p.status] = (statuses[p.status] || 0) + 1;
      if (p.status !== 'authorized') continue;
      const ar = p.auto_recurring || {}; const cur = (ar.currency_id || 'BRL').toUpperCase();
      const freq = ar.frequency || 1;
      const monthly = (ar.transaction_amount || 0) * (ar.frequency_type === 'days' ? 30 / freq : 1 / freq);
      mrr[cur] = Math.round(((mrr[cur] || 0) + monthly) * 100) / 100;
    }
    mpCache = {
      mrr,
      subscriptions: { authorized: statuses.authorized || 0, paused: statuses.paused || 0, cancelled: statuses.cancelled || 0, pending: statuses.pending || 0 },
      active_list: all.filter((p) => ['authorized', 'paused'].includes(p.status)).slice(0, 50).map((p) => ({
        id: p.id, clinic: names[String(p.external_reference)] || p.payer_email || p.id, status: p.status,
        amount: p.auto_recurring?.transaction_amount || 0, currency: (p.auto_recurring?.currency_id || 'BRL').toUpperCase(),
        next_payment_date: p.next_payment_date || null,
      })),
      fetched_at: new Date().toISOString(),
    };
    mpAt = Date.now();
    return mpCache;
  }

  adminRoute('GET', '/api/admin/finance', async (ctx) => {
    const force = ctx.query.get('refresh') === '1';
    const out = { billing_enabled: stripe.enabled() || mp.enabled(), stripe_enabled: stripe.enabled(), mp_enabled: mp.enabled() };
    if (stripe.enabled()) Object.assign(out, await stripeSummary(force));
    if (mp.enabled()) { try { out.mercadopago = await mpSummary(force); } catch (e) { out.mercadopago = { error: e.message }; } }
    return out;
  });

  // ---------- Chaves de API e parâmetros ----------
  adminRoute('GET', '/api/admin/config', async () => config.describe());
  adminRoute('PUT', '/api/admin/config', async (ctx) => {
    const key = String(ctx.body.key || '');
    try { await config.set(key, ctx.body.value, ctx.admin.email); }
    catch (e) { throw new HttpError(e.status || 500, e.message); }
    await log(ctx, ctx.body.value ? 'alterou_config' : 'removeu_config', key); // o valor nunca vai para a auditoria
    if (key.startsWith('STRIPE_')) finCache = null;
    if (key.startsWith('MP_')) mpCache = null;
    return config.describe();
  });

  // ---------- Usuários das clínicas e contatos de marketing ----------
  adminRoute('GET', '/api/admin/users', async () => {
    const clinics = await sql.unsafe('SELECT * FROM saas.clinics ORDER BY name');
    const mk = Object.fromEntries((await sql.unsafe('SELECT * FROM saas.marketing_contacts')).map((r) => [r.email, r]));
    const out = [];
    for (const c of clinics) {
      let users = [];
      try {
        users = await withClinic(c, async () => {
          const { q } = require('./core');
          return q.all('SELECT name, email, role, active, last_login, created_at FROM users ORDER BY name');
        });
      } catch (e) { console.error('Usuários da clínica', c.id, e.message); }
      const access = clinicAccess(c);
      for (const u of users) {
        const m = mk[u.email];
        out.push({ ...u, clinic_id: c.id, clinic: c.name, clinic_status: access.mode === 'full' ? access.reason : access.mode, owner: u.email === c.owner_email, marketing: !!m?.opt_in, consent_at: m?.consent_at || null });
      }
    }
    return out;
  });
  // Exporta SOMENTE quem aceitou receber marketing, com o link de descadastro de cada contato
  adminRoute('GET', '/api/admin/marketing/export', async (ctx) => {
    const rows = await sql.unsafe(`SELECT m.email, m.name, m.consent_at, c.name clinic FROM saas.marketing_contacts m
      LEFT JOIN saas.clinics c ON c.id=m.clinic_id WHERE m.opt_in ORDER BY m.consent_at`);
    await log(ctx, 'exportou_marketing', null, { contatos: rows.length });
    return rows.map((r) => ({ ...r, unsubscribe_url: unsubscribeUrl(r.email) }));
  });

  // ---------- Administradores da plataforma ----------
  adminRoute('GET', '/api/admin/admins', async () => sql.unsafe('SELECT id, name, email, active, created_at, last_login FROM saas.admins ORDER BY name'));
  adminRoute('POST', '/api/admin/admins', async (ctx) => {
    const b = ctx.body; const name = String(b.name || '').trim().slice(0, 120); const email = String(b.email || '').trim().toLowerCase();
    if (!name) throw new HttpError(400, 'Nome é obrigatório');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'E-mail inválido');
    validatePassword(b.password);
    if (String(b.password).length < 12) throw new HttpError(400, 'Use uma senha com pelo menos 12 caracteres');
    if ((await sql.unsafe('SELECT 1 FROM saas.admins WHERE email=$1', [email]))[0]) throw new HttpError(400, 'Já existe um administrador com este e-mail');
    const [a] = await sql.unsafe('INSERT INTO saas.admins(name, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [name, email, hashPassword(b.password)]);
    await log(ctx, 'criou_admin', email);
    return { id: a.id };
  });
  adminRoute('PUT', '/api/admin/admins/:id', async (ctx) => {
    const id = Number(ctx.params.id); const b = ctx.body;
    const a = (await sql.unsafe('SELECT * FROM saas.admins WHERE id=$1', [id]))[0];
    if (!a) throw new HttpError(404, 'Administrador não encontrado');
    if (b.active !== undefined) {
      if (id === ctx.admin.id && !b.active) throw new HttpError(400, 'Você não pode desativar o seu próprio acesso');
      await sql.unsafe('UPDATE saas.admins SET active=$2 WHERE id=$1', [id, !!b.active]);
      if (!b.active) await sql.unsafe('DELETE FROM saas.admin_sessions WHERE admin_id=$1', [id]);
    }
    if (b.password) {
      validatePassword(b.password);
      if (String(b.password).length < 12) throw new HttpError(400, 'Use uma senha com pelo menos 12 caracteres');
      if (id === ctx.admin.id && !checkPassword(String(b.current || ''), a.password_hash)) throw new HttpError(400, 'Senha atual incorreta');
      await sql.unsafe('UPDATE saas.admins SET password_hash=$2 WHERE id=$1', [id, hashPassword(b.password)]);
      await sql.unsafe('DELETE FROM saas.admin_sessions WHERE admin_id=$1', [id]);
      if (id === ctx.admin.id) await createSession(ctx.res, id, ctx.ip);
    }
    await log(ctx, 'alterou_admin', a.email, { ativo: b.active, senha_redefinida: !!b.password });
    return { ok: true };
  });
  adminRoute('GET', '/api/admin/audit', async () => sql.unsafe('SELECT * FROM saas.admin_audit ORDER BY id DESC LIMIT 500'));

  // limpeza de sessões administrativas vencidas (chamada junto com a limpeza geral)
  return { cleanup: async () => { await ensureCore(); await sql.unsafe('DELETE FROM saas.admin_sessions WHERE expires_at < $1', [Date.now()]); } };
};

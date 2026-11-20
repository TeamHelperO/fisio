'use strict';
// Configurações da plataforma (chaves de API etc.), editáveis na área administrativa.
// Os valores ficam cifrados em saas.platform_config; se não houver valor no banco, vale a variável de ambiente.
const { sql, sealPlatform, openPlatform, ensureCore } = require('./core');

// Campos conhecidos. secret = nunca é devolvido por inteiro para a tela.
const FIELDS = {
  STRIPE_SECRET_KEY: { group: 'Stripe', label: 'Chave secreta (sk_live_… ou sk_test_…)', secret: true, pattern: /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/ },
  STRIPE_PRICE_ID: { group: 'Stripe', label: 'ID do preço da assinatura (price_…)', pattern: /^price_[A-Za-z0-9]+$/ },
  STRIPE_WEBHOOK_SECRET: { group: 'Stripe', label: 'Segredo do webhook (whsec_…)', secret: true, pattern: /^whsec_[A-Za-z0-9]+$/ },
  RESEND_API_KEY: { group: 'E-mail (Resend)', label: 'Chave de API do Resend (re_…)', secret: true, pattern: /^re_[A-Za-z0-9_]+$/ },
  EMAIL_FROM: { group: 'E-mail (Resend)', label: 'Remetente (ex.: FisioGestão <contato@seudominio.com.br>)', pattern: /^.{3,200}$/ },
  SUPPORT_EMAIL: { group: 'Geral', label: 'E-mail de suporte exibido aos clientes', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  TRIAL_DAYS: { group: 'Geral', label: 'Dias de teste grátis para novas clínicas', pattern: /^([1-9]|[1-8][0-9]|90)$/ },
};

let cache = null; let cachedAt = 0;
const TTL = 30e3;

async function load(force = false) {
  if (!force && cache && Date.now() - cachedAt < TTL) return cache;
  await ensureCore();
  const out = {};
  for (const r of await sql.unsafe('SELECT key, value_enc, updated_at, updated_by FROM saas.platform_config')) {
    try { out[r.key] = { value: openPlatform(r.value_enc), updated_at: r.updated_at, updated_by: r.updated_by }; } catch { /* chave mestra trocada */ }
  }
  cache = out; cachedAt = Date.now();
  return cache;
}
// Leitura síncrona (após load() no início da requisição): banco → variável de ambiente
function get(key) {
  const v = cache?.[key]?.value;
  return v !== undefined && v !== '' ? v : process.env[key] || '';
}
function mask(v) { return v.length <= 8 ? '••••' : `${v.slice(0, 7)}…${v.slice(-4)}`; }
// Visão para a tela de administração (sem expor segredos)
function describe() {
  return Object.entries(FIELDS).map(([key, f]) => {
    const db = cache?.[key];
    const value = get(key);
    return {
      key, group: f.group, label: f.label, secret: !!f.secret,
      source: db?.value ? 'painel' : process.env[key] ? 'variável de ambiente' : null,
      display: value ? (f.secret ? mask(value) : value) : '',
      updated_at: db?.updated_at || null, updated_by: db?.updated_by || null,
    };
  });
}
async function set(key, value, by) {
  const f = FIELDS[key];
  if (!f) throw Object.assign(new Error('Configuração desconhecida'), { status: 400 });
  const v = String(value ?? '').trim();
  if (!v) { await sql.unsafe('DELETE FROM saas.platform_config WHERE key=$1', [key]); }
  else {
    if (!f.pattern.test(v)) throw Object.assign(new Error(`${f.label}: formato inválido`), { status: 400 });
    await sql.unsafe(`INSERT INTO saas.platform_config(key, value_enc, updated_by) VALUES ($1,$2,$3)
      ON CONFLICT (key) DO UPDATE SET value_enc=excluded.value_enc, updated_at=now(), updated_by=excluded.updated_by`, [key, sealPlatform(v), by]);
  }
  await load(true);
}

module.exports = { FIELDS, load, get, describe, set };

'use strict';
// Configurações da plataforma (chaves de API etc.), editáveis na área administrativa.
// Os valores ficam cifrados em saas.platform_config; se não houver valor no banco, vale a variável de ambiente.
const { sql, sealPlatform, openPlatform, ensureCore } = require('./core');

// Campos conhecidos. secret = nunca é devolvido por inteiro para a tela.
const FIELDS = {
  STRIPE_SECRET_KEY: { group: 'Stripe', label: 'Chave secreta (sk_live_… ou sk_test_…)', secret: true, pattern: /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/ },
  STRIPE_PRICE_ID: { group: 'Stripe', label: 'ID do preço da assinatura (price_…)', pattern: /^price_[A-Za-z0-9]+$/ },
  STRIPE_WEBHOOK_SECRET: { group: 'Stripe', label: 'Segredo do webhook (whsec_…)', secret: true, pattern: /^whsec_[A-Za-z0-9]+$/ },
  MP_ACCESS_TOKEN: { group: 'Mercado Pago', label: 'Access Token (APP_USR-… ou TEST-…)', secret: true, pattern: /^(APP_USR|TEST)-[A-Za-z0-9-]{10,}$/ },
  MP_PRICE: { group: 'Mercado Pago', label: 'Valor da assinatura mensal em R$ (ex.: 79,90)', pattern: /^\d{1,5}([.,]\d{1,2})?$/ },
  MP_WEBHOOK_SECRET: { group: 'Mercado Pago', label: 'Assinatura secreta das notificações (webhook)', secret: true, pattern: /^[A-Za-z0-9]{16,128}$/ },
  MP_CLIENT_ID: { group: 'Recebimentos das clínicas (Mercado Pago)', label: 'Client ID da aplicação (para as clínicas conectarem a conta)', pattern: /^\d{4,30}$/ },
  MP_CLIENT_SECRET: { group: 'Recebimentos das clínicas (Mercado Pago)', label: 'Client Secret da aplicação', secret: true, pattern: /^[A-Za-z0-9_-]{16,128}$/ },
  MP_PLATFORM_FEE: { group: 'Recebimentos das clínicas (Mercado Pago)', label: 'Taxa da plataforma sobre cada pagamento recebido pelo app, em % (0 = sem taxa)', pattern: /^\d{1,2}([.,]\d{1,2})?$/ },
  EMAIL_FROM: { group: 'E-mail', label: 'Remetente (ex.: FisioGestão <contato@seudominio.com.br>)', pattern: /^([^\r\n<>]{0,100}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/ },
  SMTP_HOST: { group: 'E-mail (SMTP)', label: 'Servidor SMTP (ex.: smtp.gmail.com, smtp.office365.com)', pattern: /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/ },
  SMTP_PORT: { group: 'E-mail (SMTP)', label: 'Porta (587 para STARTTLS, 465 para SSL)', pattern: /^([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/ },
  SMTP_SECURITY: { group: 'E-mail (SMTP)', label: 'Segurança da conexão', pattern: /^(starttls|ssl|nenhuma)$/,
    options: [['starttls', 'STARTTLS (porta 587) — recomendado'], ['ssl', 'SSL/TLS direto (porta 465)'], ['nenhuma', 'Sem criptografia (não recomendado)']] },
  SMTP_USER: { group: 'E-mail (SMTP)', label: 'Usuário (geralmente o e-mail da conta)', pattern: /^[^\r\n]{1,200}$/ },
  SMTP_PASS: { group: 'E-mail (SMTP)', label: 'Senha ou senha de app', secret: true, maskAll: true, pattern: /^[^\r\n]{1,300}$/ },
  RESEND_API_KEY: { group: 'E-mail (Resend)', label: 'Chave de API do Resend (re_…) — usada só se o SMTP não estiver configurado', secret: true, pattern: /^re_[A-Za-z0-9_]+$/ },
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
// chaves de API: mostra o começo e o fim para identificar; senhas: nada
function mask(v, all) { return all || v.length <= 8 ? '••••••••' : `${v.slice(0, 7)}…${v.slice(-4)}`; }
// Visão para a tela de administração (sem expor segredos)
function describe() {
  return Object.entries(FIELDS).map(([key, f]) => {
    const db = cache?.[key];
    const value = get(key);
    return {
      key, group: f.group, label: f.label, secret: !!f.secret, options: f.options || null,
      source: db?.value ? 'painel' : process.env[key] ? 'variável de ambiente' : null,
      display: value ? (f.secret ? mask(value, f.maskAll) : value) : '',
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

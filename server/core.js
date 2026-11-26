'use strict';
// Núcleo multi-clínica (SaaS): conexão Postgres, isolamento por schema, criptografia por clínica.
//
// Organização do banco:
//   schema "saas"   → dados da plataforma: clínicas, assinaturas, sessões, índice de e-mails, tentativas de login
//   schema "c_<id>" → um schema por clínica, com as tabelas do prontuário (pacientes, registros, agenda, financeiro...)
//
// Cada requisição autenticada roda dentro de uma transação com `search_path` apontando para o schema da clínica,
// então as consultas da aplicação nunca enxergam dados de outra clínica.
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

// DATABASE_URL (manual) ou POSTGRES_URL (criada pela integração Supabase ↔ Vercel, conexão pelo pooler)
const RAW_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!RAW_URL) throw new Error('Defina DATABASE_URL (ou instale a integração Supabase na Vercel, que cria POSTGRES_URL).');
// Remove parâmetros da URL (sslmode, supa, pgbouncer...): o driver os repassaria ao servidor como configurações
// desconhecidas. O SSL é configurado abaixo.
function cleanUrl(u) { try { const x = new URL(u); x.search = ''; return x.toString(); } catch { return u; } }
const DATABASE_URL = cleanUrl(RAW_URL);

const LOCAL_DB = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
// O driver "postgres" é um módulo ES: é carregado com import() dinâmico, que funciona tanto no Node local
// quanto no runtime da Vercel (onde require() de módulos ES não é suportado).
const sqlReady = import('postgres').then(({ default: postgres }) => postgres(DATABASE_URL, {
  max: Number(process.env.PG_POOL_MAX || 3),
  prepare: false, // compatível com o pooler do Supabase em modo transação (porta 6543)
  max_pipeline: 1, // uma consulta por vez em cada conexão: o pooler em modo transação trava com consultas "empilhadas"
  ssl: LOCAL_DB || process.env.PG_SSL === '0' ? false : 'require',
  idle_timeout: 20,
  connect_timeout: 15,
  onnotice: () => {},
  // int8 (COUNT, SUM de inteiros) e numeric chegam como número em JS
  types: { bigint: { to: 20, from: [20, 1700], serialize: String, parse: Number } },
}));
// Fachada com a mesma interface usada no resto do código (sql.unsafe / sql.begin / sql.end)
const sql = {
  unsafe: async (...a) => (await sqlReady).unsafe(...a),
  begin: async (...a) => (await sqlReady).begin(...a),
  end: async (...a) => (await sqlReady).end(...a),
};

// ---------- Contexto da requisição (transação + clínica + chave) ----------
const als = new AsyncLocalStorage();
const ctxStore = () => als.getStore();
function currentSql() { const s = als.getStore(); return (s && s.tx) || sql; }

// Converte placeholders "?" (estilo SQLite) para "$1, $2..." do Postgres
const PH_CACHE = new Map();
function toPg(text) {
  let out = PH_CACHE.get(text);
  if (!out) { let i = 0; out = text.replace(/\?/g, () => `$${++i}`); PH_CACHE.set(text, out); }
  return out;
}
const norm = (params) => params.map((v) => (v === undefined ? null : v));
const q = {
  get: async (text, ...p) => (await currentSql().unsafe(toPg(text), norm(p)))[0],
  all: async (text, ...p) => [...(await currentSql().unsafe(toPg(text), norm(p)))],
  // INSERT devolve o id criado (equivalente ao lastInsertRowid do SQLite)
  run: async (text, ...p) => {
    const isInsert = /^\s*insert/i.test(text) && !/returning/i.test(text);
    const rows = await currentSql().unsafe(toPg(isInsert ? `${text} RETURNING *` : text), norm(p));
    return { changes: rows.count, lastInsertRowid: isInsert && rows[0] ? rows[0].id : undefined };
  },
};
// A requisição inteira já roda numa transação; tx() abre um savepoint (tudo ou nada dentro do bloco)
async function tx(fn) {
  const s = als.getStore();
  if (!s || !s.tx) return sql.begin(async (t) => als.run({ ...(s || {}), tx: t }, fn));
  return s.tx.savepoint(async (sp) => als.run({ ...s, tx: sp }, fn));
}

// ---------- Criptografia: chave por clínica, protegida pela chave mestra ----------
function masterKey() {
  const hex = process.env.MASTER_KEY || '';
  const k = Buffer.from(hex, 'hex');
  if (k.length !== 32) throw new Error('Defina MASTER_KEY com 64 caracteres hexadecimais (gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
  return k;
}
function sealWith(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function openWith(key, str) {
  const b = Buffer.from(str, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
const keyCache = new Map();
function clinicKey(clinic) {
  let k = keyCache.get(clinic.id);
  if (!k) { k = openWith(masterKey(), clinic.key_enc); keyCache.set(clinic.id, k); }
  return k;
}
function currentKey() {
  const s = als.getStore();
  if (!s || !s.clinic) throw new Error('Operação de criptografia fora do contexto de uma clínica');
  return clinicKey(s.clinic);
}
// Subchaves derivadas da chave mestra para usos da plataforma (nunca a mesma chave para propósitos diferentes)
const subkeyCache = new Map();
function subkey(purpose) {
  let k = subkeyCache.get(purpose);
  if (!k) { k = Buffer.from(crypto.hkdfSync('sha256', masterKey(), Buffer.alloc(0), `fisiogestao:${purpose}`, 32)); subkeyCache.set(purpose, k); }
  return k;
}
const sealPlatform = (text) => sealWith(subkey('platform-config'), Buffer.from(String(text), 'utf8'));
const openPlatform = (str) => openWith(subkey('platform-config'), str).toString('utf8');
const signToken = (purpose, value) => crypto.createHmac('sha256', subkey(purpose)).update(String(value)).digest('base64url');
const encrypt = (obj) => sealWith(currentKey(), Buffer.from(JSON.stringify(obj), 'utf8'));
const decrypt = (str) => JSON.parse(openWith(currentKey(), str).toString('utf8'));

// ---------- Data/hora no fuso da clínica (o servidor da Vercel roda em UTC) ----------
const TIMEZONES = {
  'America/Sao_Paulo': 'Brasília (SP, RJ, MG, Sul, Nordeste, GO, DF)',
  'America/Manaus': 'Amazonas, MT, MS, RO, RR (−1h)',
  'America/Rio_Branco': 'Acre (−2h)',
  'America/Noronha': 'Fernando de Noronha (+1h)',
  'America/Belem': 'Pará, Amapá', 'America/Fortaleza': 'Ceará, RN, PB, PI, MA',
  'America/Recife': 'Pernambuco', 'America/Bahia': 'Bahia', 'America/Cuiaba': 'Mato Grosso', 'America/Campo_Grande': 'Mato Grosso do Sul',
};
const fmtCache = new Map();
function nowParts(tz) {
  tz = tz || als.getStore()?.clinic?.timezone || 'America/Sao_Paulo';
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); fmtCache.set(tz, f); }
  const o = Object.fromEntries(f.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}

// ---------- Estrutura do banco ----------
const CORE_DDL = `
CREATE SCHEMA IF NOT EXISTS saas;
CREATE OR REPLACE FUNCTION saas.now_local() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT to_char(now() AT TIME ZONE coalesce(nullif(current_setting('app.tz', true), ''), 'America/Sao_Paulo'), 'YYYY-MM-DD HH24:MI:SS')
$f$;
CREATE TABLE IF NOT EXISTS saas.clinics (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  schema_name text NOT NULL UNIQUE,
  schema_version integer NOT NULL DEFAULT 0,
  key_enc text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  owner_email text NOT NULL,
  trial_ends_at timestamptz NOT NULL,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  subscription_status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  manual_access text CHECK (manual_access IS NULL OR manual_access IN ('full','readonly','blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas.user_index (
  email text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  user_id integer NOT NULL
);
CREATE INDEX IF NOT EXISTS user_index_clinic ON saas.user_index(clinic_id, user_id);
CREATE TABLE IF NOT EXISTS saas.sessions (
  token_hash text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  user_id integer NOT NULL,
  expires_at bigint NOT NULL,
  ip text
);
CREATE INDEX IF NOT EXISTS sessions_user ON saas.sessions(clinic_id, user_id);
CREATE TABLE IF NOT EXISTS saas.login_attempts (
  key text PRIMARY KEY,
  n integer NOT NULL DEFAULT 0,
  lock_until bigint NOT NULL DEFAULT 0,
  last bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS saas.stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
-- Área administrativa da plataforma (dono do SaaS) — separada dos usuários das clínicas
CREATE TABLE IF NOT EXISTS saas.admins (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz
);
CREATE TABLE IF NOT EXISTS saas.admin_sessions (
  token_hash text PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES saas.admins(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  ip text
);
CREATE TABLE IF NOT EXISTS saas.admin_audit (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  admin_id integer, admin_name text, action text NOT NULL, target text, details text, ip text
);
-- Chaves de API e parâmetros da plataforma (valores cifrados com subchave da MASTER_KEY)
CREATE TABLE IF NOT EXISTS saas.platform_config (
  key text PRIMARY KEY,
  value_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
-- Contatos e consentimento para e-mails de marketing (LGPD: opt-in separado dos Termos)
CREATE TABLE IF NOT EXISTS saas.marketing_contacts (
  email text PRIMARY KEY,
  name text,
  clinic_id integer REFERENCES saas.clinics(id) ON DELETE SET NULL,
  opt_in boolean NOT NULL DEFAULT false,
  source text,
  consent_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Esqueci minha senha: links de uso único (guarda só o hash do token)
CREATE TABLE IF NOT EXISTS saas.password_resets (
  token_hash text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  user_id integer NOT NULL,
  email text NOT NULL,
  expires_at bigint NOT NULL,
  used_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Confirmação de e-mail. Na primeira vez a coluna nasce preenchida (contas antigas = confirmadas);
-- depois o padrão é removido e contas novas começam sem confirmação.
ALTER TABLE saas.user_index ADD COLUMN IF NOT EXISTS email_verified_at timestamptz DEFAULT now();
ALTER TABLE saas.user_index ALTER COLUMN email_verified_at DROP DEFAULT;
CREATE TABLE IF NOT EXISTS saas.email_verifications (
  token_hash text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  user_id integer NOT NULL,
  email text NOT NULL,
  expires_at bigint NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Modelos de e-mail personalizados no painel (sem linha = usa o texto padrão do sistema)
CREATE TABLE IF NOT EXISTS saas.email_templates (
  key text PRIMARY KEY,
  subject text NOT NULL,
  body text NOT NULL,
  button text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
ALTER TABLE saas.email_templates ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
-- Histórico de e-mails enviados (sem o conteúdo). "ref" impede que o mesmo e-mail automático saia duas vezes.
CREATE TABLE IF NOT EXISTS saas.email_log (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id integer REFERENCES saas.clinics(id) ON DELETE SET NULL,
  template text NOT NULL,
  recipient text NOT NULL,
  ref text,
  status text NOT NULL,
  provider text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_log_ref ON saas.email_log(clinic_id, template, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_log_created ON saas.email_log(created_at);
-- Segurança dos administradores da plataforma: verificação em duas etapas (TOTP) e "esqueci minha senha"
ALTER TABLE saas.admins ADD COLUMN IF NOT EXISTS totp_secret_enc text;
ALTER TABLE saas.admins ADD COLUMN IF NOT EXISTS totp_pending_enc text;
ALTER TABLE saas.admins ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE saas.admins ADD COLUMN IF NOT EXISTS totp_last_step bigint NOT NULL DEFAULT 0;
ALTER TABLE saas.admins ADD COLUMN IF NOT EXISTS recovery_codes text;
CREATE TABLE IF NOT EXISTS saas.admin_login_tickets (
  token_hash text PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES saas.admins(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS saas.admin_password_resets (
  token_hash text PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES saas.admins(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Campanhas de e-mail marketing (só para quem aceitou receber novidades)
CREATE TABLE IF NOT EXISTS saas.campaigns (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  audience text NOT NULL DEFAULT 'todos',
  subject text NOT NULL,
  body text NOT NULL,
  button text NOT NULL DEFAULT '',
  button_url text,
  status text NOT NULL DEFAULT 'rascunho',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS saas.campaign_sends (
  campaign_id integer NOT NULL REFERENCES saas.campaigns(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  clinic_name text,
  status text NOT NULL DEFAULT 'pendente',
  error text,
  sent_at timestamptz,
  PRIMARY KEY (campaign_id, email)
);
-- Agendamento online: endereço público de cada clínica
CREATE TABLE IF NOT EXISTS saas.booking_links (
  slug text PRIMARY KEY,
  clinic_id integer NOT NULL UNIQUE REFERENCES saas.clinics(id) ON DELETE CASCADE
);
-- Assinatura digital: link público de uso único -> pedido de assinatura da clínica
CREATE TABLE IF NOT EXISTS saas.signature_links (
  token_hash text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  request_id integer NOT NULL,
  expires_at bigint NOT NULL
);
-- Mercado Pago (assinaturas "preapproval") como segunda forma de pagamento
ALTER TABLE saas.clinics ADD COLUMN IF NOT EXISTS billing_provider text;
ALTER TABLE saas.clinics ADD COLUMN IF NOT EXISTS mp_preapproval_id text;
CREATE UNIQUE INDEX IF NOT EXISTS clinics_mp_preapproval ON saas.clinics(mp_preapproval_id);
-- Recebimentos pelo app: conta do Mercado Pago de cada clínica (tokens cifrados com a chave da plataforma)
CREATE TABLE IF NOT EXISTS saas.clinic_mp_accounts (
  clinic_id integer PRIMARY KEY REFERENCES saas.clinics(id) ON DELETE CASCADE,
  mp_user_id text NOT NULL, nickname text, email text,
  access_enc text NOT NULL, refresh_enc text, expires_at timestamptz, live_mode boolean,
  connected_by text, connected_at timestamptz NOT NULL DEFAULT now()
);
-- Registro central dos pagamentos recebidos pelas clínicas via Mercado Pago (relatório de taxas do /admin; sem dados de pacientes)
CREATE TABLE IF NOT EXISTS saas.mp_receipts (
  mp_payment_id text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  charge_id integer NOT NULL,
  amount numeric(12,2) NOT NULL, platform_fee numeric(12,2) NOT NULL DEFAULT 0, mp_fee numeric(12,2),
  method text, approved_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mp_receipts_approved ON saas.mp_receipts(approved_at);
-- Portal do paciente: link pessoal (só o hash do código é guardado)
CREATE TABLE IF NOT EXISTS saas.portal_links (
  token_hash text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  patient_id integer NOT NULL, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at bigint NOT NULL, revoked_at bigint, last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS portal_links_patient ON saas.portal_links(clinic_id, patient_id);
-- Contas do paciente no portal (e-mail e senha), sessões, links de senha e link de cadastro da clínica
CREATE TABLE IF NOT EXISTS saas.patient_accounts (
  id serial PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  patient_id integer NOT NULL, email text NOT NULL, password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(), last_login timestamptz,
  UNIQUE (clinic_id, patient_id)
);
CREATE INDEX IF NOT EXISTS patient_accounts_email ON saas.patient_accounts(lower(email));
CREATE TABLE IF NOT EXISTS saas.patient_password_tokens (
  token_hash text PRIMARY KEY,
  account_id integer NOT NULL REFERENCES saas.patient_accounts(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL, used_at bigint
);
CREATE TABLE IF NOT EXISTS saas.patient_sessions (
  token_hash text PRIMARY KEY,
  account_id integer NOT NULL REFERENCES saas.patient_accounts(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL, ip text
);
CREATE TABLE IF NOT EXISTS saas.portal_signup (
  code text PRIMARY KEY,
  clinic_id integer NOT NULL UNIQUE REFERENCES saas.clinics(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas.mp_oauth_states (
  state_hash text PRIMARY KEY,
  clinic_id integer NOT NULL REFERENCES saas.clinics(id) ON DELETE CASCADE,
  user_id integer NOT NULL, expires_at bigint NOT NULL
);
`;

// Tabelas de cada clínica. Datas ficam como texto (YYYY-MM-DD / YYYY-MM-DDTHH:MM) como na versão original.
const NOW = 'saas.now_local()';
const TENANT_MIGRATIONS = [
  `
CREATE TABLE users (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','fisio','recepcao')),
  crefito text,
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL DEFAULT ${NOW},
  last_login text
);
CREATE TABLE settings (key text PRIMARY KEY, value text);
CREATE TABLE patients (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL, birth_date text, cpf text, phone text, email text, address text, profession text,
  emergency_name text, emergency_phone text, first_visit text,
  status text NOT NULL DEFAULT 'em_tratamento' CHECK (status IN ('avaliacao','em_tratamento','finalizado','inativo')),
  professional_id integer REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_at text NOT NULL DEFAULT ${NOW},
  updated_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX patients_name ON patients(lower(name));
CREATE TABLE consents (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  term_version text NOT NULL, term_hash text NOT NULL, method text NOT NULL, signer_name text,
  accepted_at text NOT NULL, registered_by integer REFERENCES users(id), revoked_at text, revoke_reason text
);
CREATE TABLE records (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('anamnese','avaliacao','plano','evolucao')),
  record_date text NOT NULL, seq integer, status text, title text,
  author_id integer REFERENCES users(id),
  data_enc text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW},
  updated_at text NOT NULL DEFAULT ${NOW},
  deleted_at text
);
CREATE INDEX records_patient ON records(patient_id, type);
CREATE TABLE record_versions (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  record_id integer NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  version integer NOT NULL, record_date text, status text, data_enc text NOT NULL,
  changed_by integer REFERENCES users(id),
  changed_at text NOT NULL DEFAULT ${NOW}
);
CREATE TABLE appointments (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  professional_id integer REFERENCES users(id) ON DELETE SET NULL,
  start text NOT NULL, duration integer NOT NULL DEFAULT 50, kind text NOT NULL DEFAULT 'sessao',
  status text NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado','confirmado','realizado','falta','cancelado')),
  price double precision NOT NULL DEFAULT 0, notes text, charge_id integer,
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX appt_start ON appointments(start);
CREATE INDEX appt_patient ON appointments(patient_id);
CREATE TABLE services (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL, price double precision NOT NULL, duration integer NOT NULL DEFAULT 50, active integer NOT NULL DEFAULT 1
);
CREATE TABLE packages (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL, sessions integer NOT NULL, price double precision NOT NULL, active integer NOT NULL DEFAULT 1
);
CREATE TABLE patient_packages (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  package_id integer REFERENCES packages(id) ON DELETE SET NULL,
  name text NOT NULL, sessions integer NOT NULL, price double precision NOT NULL,
  start_date text NOT NULL, end_date text NOT NULL,
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','encerrado','cancelado')),
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE TABLE charges (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  professional_id integer REFERENCES users(id) ON DELETE SET NULL,
  description text NOT NULL, amount double precision NOT NULL, due_date text NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','cancelado')),
  paid_at text,
  method text CHECK (method IS NULL OR method IN ('pix','dinheiro','cartao_credito','cartao_debito','transferencia')),
  payer_name text, payer_cpf text, receipt_number text UNIQUE, appointment_id integer, patient_package_id integer, notes text,
  created_by integer REFERENCES users(id),
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX charges_patient ON charges(patient_id);
CREATE INDEX charges_status ON charges(status, due_date);
CREATE TABLE audit_log (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ts text NOT NULL DEFAULT ${NOW},
  user_id integer, user_name text, action text NOT NULL, entity text, entity_id integer, patient_id integer, details text, ip text
);
CREATE INDEX audit_ts ON audit_log(ts);
CREATE INDEX audit_patient ON audit_log(patient_id);
-- Cópia criptografada do cadastro excluído (substitui o backup local feito antes de exclusões)
CREATE TABLE deleted_patients (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL, name text NOT NULL, data_enc text NOT NULL,
  deleted_by integer, deleted_at text NOT NULL DEFAULT ${NOW}
);
`,
  // v2 — Biblioteca de exercícios: exercícios próprios da clínica e programas de exercícios por paciente
  `
CREATE TABLE exercises (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL, region text NOT NULL, objective text NOT NULL, equipment text NOT NULL,
  target text, muscles text, steps text NOT NULL, media_url text, based_on text,
  active integer NOT NULL DEFAULT 1,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at text NOT NULL DEFAULT ${NOW}, updated_at text
);
CREATE TABLE exercise_programs (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  author_id integer REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL, start_date text NOT NULL,
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','encerrado')),
  data_enc text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}, updated_at text
);
CREATE INDEX exercise_programs_patient ON exercise_programs(patient_id);
`,
  // v3 — Agendamento online (pedidos feitos pela página pública)
  `
CREATE TABLE booking_requests (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  professional_id integer REFERENCES users(id) ON DELETE SET NULL,
  start text NOT NULL, duration integer NOT NULL,
  name text NOT NULL, phone text, email text, notes text,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aceito','recusado','cancelado')),
  patient_id integer REFERENCES patients(id) ON DELETE SET NULL, appointment_id integer,
  consent_at text NOT NULL, ip text, decided_by integer, decided_at text,
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX booking_requests_status ON booking_requests(status, start);
`,
  // v4 — Assinatura digital de documentos pelo paciente
  `
CREATE TABLE signature_requests (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('consentimento','plano')),
  record_id integer, title text NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','assinado','cancelado')),
  expires_at text NOT NULL, created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at text NOT NULL DEFAULT ${NOW},
  signed_at text, signer_name text, signer_cpf text, ip text, user_agent text,
  doc_hash text NOT NULL, doc_enc text NOT NULL, signature_enc text, consent_id integer
);
CREATE INDEX signature_requests_patient ON signature_requests(patient_id);
`,
  // v5 — Link de pagamento do Mercado Pago nas cobranças
  `
ALTER TABLE charges ADD COLUMN pay_url text, ADD COLUMN pay_amount double precision, ADD COLUMN mp_preference_id text,
  ADD COLUMN mp_payment_id text, ADD COLUMN platform_fee double precision, ADD COLUMN pay_link_at text;
`,
  // v6 — Diário de dor registrado pelo paciente no portal (observação cifrada)
  `
CREATE TABLE pain_diary (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  day text NOT NULL, pain integer NOT NULL CHECK (pain BETWEEN 0 AND 10), note_enc text,
  created_at text NOT NULL DEFAULT ${NOW}, updated_at text NOT NULL DEFAULT ${NOW},
  UNIQUE (patient_id, day)
);
`,
];

let coreReady = null;
function ensureCore() {
  if (!coreReady) {
    coreReady = sql.begin(async (t) => {
      await t.unsafe('SELECT pg_advisory_xact_lock(727001)');
      await t.unsafe(CORE_DDL);
    }).catch((e) => { coreReady = null; throw e; });
  }
  return coreReady;
}

const quoteIdent = (s) => {
  if (!/^c_\d+$/.test(s)) throw new Error('Nome de schema inválido');
  return `"${s}"`;
};
// Aplica as migrações pendentes do schema da clínica (chamado na criação e, depois, a cada versão nova)
async function migrateTenant(t, clinic) {
  if (clinic.schema_version >= TENANT_MIGRATIONS.length) return clinic;
  await t.unsafe('SELECT pg_advisory_xact_lock(727002, $1)', [clinic.id]);
  const cur = (await t.unsafe('SELECT schema_version FROM saas.clinics WHERE id=$1', [clinic.id]))[0].schema_version;
  if (cur < TENANT_MIGRATIONS.length) {
    await t.unsafe(`SET LOCAL search_path TO ${quoteIdent(clinic.schema_name)}, saas`);
    for (let v = cur; v < TENANT_MIGRATIONS.length; v++) await t.unsafe(TENANT_MIGRATIONS[v]);
    await t.unsafe('UPDATE saas.clinics SET schema_version=$1 WHERE id=$2', [TENANT_MIGRATIONS.length, clinic.id]);
  }
  return { ...clinic, schema_version: TENANT_MIGRATIONS.length };
}

// Executa fn dentro de uma transação no schema da clínica (isolamento por search_path)
async function withClinic(clinic, fn, extra = {}) {
  await ensureCore();
  return sql.begin(async (t) => {
    const c = await migrateTenant(t, clinic);
    await t.unsafe(`SET LOCAL search_path TO ${quoteIdent(c.schema_name)}, saas`);
    await t.unsafe("SELECT set_config('app.tz', $1, true)", [c.timezone || 'America/Sao_Paulo']);
    return als.run({ ...extra, tx: t, clinic: c }, fn);
  });
}

async function getClinic(id) {
  await ensureCore();
  return (await currentSql().unsafe('SELECT * FROM saas.clinics WHERE id=$1', [id]))[0];
}

// Cria a clínica: registro na plataforma + schema próprio + chave de criptografia própria
async function createClinic({ name, ownerEmail, trialDays }) {
  await ensureCore();
  const key = crypto.randomBytes(32);
  const keyEnc = sealWith(masterKey(), key);
  return sql.begin(async (t) => {
    const [c] = await t.unsafe(
      `INSERT INTO saas.clinics(name, schema_name, key_enc, owner_email, trial_ends_at)
       VALUES ($1, 'c_pendente_' || md5(random()::text), $2, $3, now() + ($4 || ' days')::interval) RETURNING *`,
      [name, keyEnc, ownerEmail, String(trialDays)]);
    const schema = `c_${c.id}`;
    await t.unsafe('UPDATE saas.clinics SET schema_name=$1 WHERE id=$2', [schema, c.id]);
    await t.unsafe(`CREATE SCHEMA ${quoteIdent(schema)}`);
    return { ...c, schema_name: schema };
  });
}

// Exclusão definitiva de uma clínica inteira (LGPD: término do contrato). Irreversível.
async function dropClinic(id) {
  const c = await getClinic(id);
  if (!c) return false;
  await sql.begin(async (t) => {
    await t.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(c.schema_name)} CASCADE`);
    await t.unsafe('DELETE FROM saas.clinics WHERE id=$1', [id]);
  });
  keyCache.delete(id);
  return true;
}

module.exports = {
  sql, currentSql, q, tx, als, ctxStore, encrypt, decrypt, nowParts, TIMEZONES, sealPlatform, openPlatform, signToken,
  ensureCore, withClinic, getClinic, createClinic, dropClinic,
};

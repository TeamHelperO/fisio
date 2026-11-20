'use strict';
// Banco de dados SQLite (módulo nativo node:sqlite — sem dependências externas)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.FISIO_DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'fisio.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','fisio','recepcao')),
  crefito TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  birth_date TEXT,
  cpf TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  profession TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  first_visit TEXT,
  status TEXT NOT NULL DEFAULT 'em_tratamento' CHECK (status IN ('avaliacao','em_tratamento','finalizado','inativo')),
  professional_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  term_version TEXT NOT NULL,
  term_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  signer_name TEXT,
  accepted_at TEXT NOT NULL,
  registered_by INTEGER REFERENCES users(id),
  revoked_at TEXT,
  revoke_reason TEXT
);
-- Registros clínicos (anamnese, avaliação, plano, evolução). Conteúdo criptografado (AES-256-GCM).
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('anamnese','avaliacao','plano','evolucao')),
  record_date TEXT NOT NULL,
  seq INTEGER,
  status TEXT,
  title TEXT,
  author_id INTEGER REFERENCES users(id),
  data_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_patient ON records(patient_id, type);
CREATE TABLE IF NOT EXISTS record_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  record_date TEXT,
  status TEXT,
  data_enc TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  professional_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 50,
  kind TEXT NOT NULL DEFAULT 'sessao',
  status TEXT NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado','confirmado','realizado','falta','cancelado')),
  price REAL NOT NULL DEFAULT 0,
  notes TEXT,
  charge_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  duration INTEGER NOT NULL DEFAULT 50,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS patient_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  price REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','encerrado','cancelado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  professional_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','cancelado')),
  paid_at TEXT,
  method TEXT CHECK (method IS NULL OR method IN ('pix','dinheiro','cartao_credito','cartao_debito','transferencia')),
  payer_name TEXT,
  payer_cpf TEXT,
  receipt_number TEXT,
  appointment_id INTEGER,
  patient_package_id INTEGER,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_charges_patient ON charges(patient_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  patient_id INTEGER,
  details TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`);

// ---------- Criptografia de dados clínicos ----------
function loadKey() {
  if (process.env.FISIO_KEY) {
    const k = Buffer.from(process.env.FISIO_KEY, 'hex');
    if (k.length !== 32) throw new Error('FISIO_KEY deve ter 64 caracteres hexadecimais');
    return k;
  }
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(str) {
  const b = Buffer.from(str, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

// ---------- Helpers ----------
const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const DEFAULT_SETTINGS = {
  clinic_name: '',
  professional_name: '',
  crefito: '',
  professional_cpf: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  consent_version: '1.0',
  consent_text: `TERMO DE CONSENTIMENTO PARA TRATAMENTO DE DADOS PESSOAIS E DADOS PESSOAIS SENSÍVEIS (LGPD — Lei nº 13.709/2018)

Eu, titular abaixo identificado(a), declaro estar ciente e consinto que o(a) profissional/clínica identificado(a) neste documento, na condição de controlador(a), realize o tratamento dos meus dados pessoais e dados pessoais sensíveis referentes à saúde, nos termos a seguir:

1. FINALIDADE: os dados serão utilizados exclusivamente para avaliação fisioterapêutica, elaboração e execução do plano de tratamento, registro da evolução clínica em prontuário, agendamento de atendimentos, contato com o paciente, emissão de recibos e cumprimento de obrigações legais, regulatórias e fiscais.
2. DADOS TRATADOS: dados de identificação e contato, dados de saúde (anamnese, avaliação, diagnóstico, evolução), dados financeiros relativos aos pagamentos dos atendimentos.
3. COMPARTILHAMENTO: os dados não serão compartilhados com terceiros, salvo por determinação legal, ordem judicial, ou mediante autorização expressa do(a) titular.
4. ARMAZENAMENTO E SEGURANÇA: os dados serão armazenados em sistema com controle de acesso individual, criptografia dos registros clínicos, cópias de segurança e registro de alterações. O prontuário será mantido pelo prazo mínimo exigido pelas normas do conselho profissional (COFFITO) e pela legislação aplicável.
5. DIREITOS DO TITULAR: o(a) titular pode, a qualquer momento, solicitar confirmação da existência de tratamento, acesso, correção, portabilidade, informação sobre compartilhamento e revogação deste consentimento, ressalvadas as hipóteses legais de guarda obrigatória do prontuário.
6. REVOGAÇÃO: a revogação do consentimento não afeta a legalidade do tratamento realizado anteriormente nem a guarda obrigatória do prontuário.

Declaro que li, compreendi e concordo com os termos acima.`,
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  q.run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', k, v);
}
function getSettings() {
  const out = {};
  for (const r of q.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

// ---------- Backup ----------
function backup(label = 'auto') {
  const ts = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `fisio-${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}-${label}.sqlite`;
  const dest = path.join(BACKUP_DIR, name);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  // mantém os 30 backups mais recentes
  const files = listBackups();
  for (const f of files.slice(30)) fs.unlinkSync(path.join(BACKUP_DIR, f.name));
  return name;
}
function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => { const s = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: s.size, mtime: s.mtime.toISOString() }; })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

module.exports = { db, q, tx, encrypt, decrypt, getSettings, backup, listBackups, BACKUP_DIR, DATA_DIR };

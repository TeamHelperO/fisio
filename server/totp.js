'use strict';
// Códigos de 6 dígitos de app autenticador (TOTP, RFC 6238: HMAC-SHA1, 30 segundos).
// Funciona com Google Authenticator, Microsoft Authenticator, Authy, 1Password etc.
const crypto = require('crypto');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | ALPHA.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newSecret = () => base32(crypto.randomBytes(20)); // 160 bits

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1e6).padStart(6, '0');
}
// Confere o código aceitando 30 s de diferença de relógio para cada lado.
// Devolve o "passo" usado (para impedir reuso do mesmo código) ou null.
function verify(secret, code, { lastStep = -1, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    const exp = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return s;
  }
  return null;
}
const otpauthUrl = (secret, account, issuer = 'FisioGestão Admin') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Códigos de recuperação (uso único) para quando o celular for perdido
const newRecoveryCodes = (n = 10) => Array.from({ length: n }, () => {
  const r = base32(crypto.randomBytes(5)).toLowerCase(); // 8 caracteres
  return `${r.slice(0, 4)}-${r.slice(4, 8)}`;
});
const normRecovery = (s) => String(s || '').toLowerCase().replace(/[^a-z2-7]/g, '');

module.exports = { newSecret, verify, codeAt, otpauthUrl, newRecoveryCodes, normRecovery, base32, unbase32 };

'use strict';
// Integração mínima com o Stripe (assinaturas), via API REST — sem SDK.
const crypto = require('crypto');
const { HttpError } = require('./http');

const API = process.env.STRIPE_API_BASE || 'https://api.stripe.com'; // STRIPE_API_BASE só para testes locais
const enabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const priceId = () => process.env.STRIPE_PRICE_ID;

function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function request(method, path, params, idempotencyKey) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, 'A cobrança ainda não foi configurada na plataforma.');
  const headers = { Authorization: `Bearer ${key}` };
  let url = API + path; let body;
  if (method === 'GET') { const qs = form(params).toString(); if (qs) url += '?' + qs; }
  else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = form(params).toString(); }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe', method, path, res.status, data.error?.message);
    throw new HttpError(502, 'Não foi possível falar com o sistema de pagamentos. Tente novamente em instantes.');
  }
  return data;
}

// Confere a assinatura do webhook (cabeçalho Stripe-Signature: t=...,v1=...)
function verifyWebhook(raw, header, toleranceSec = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'Webhook não configurado');
  if (!raw || !header) throw new HttpError(400, 'Assinatura ausente');
  const parts = String(header).split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw new HttpError(400, 'Assinatura inválida');
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new HttpError(400, 'Assinatura expirada');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new HttpError(400, 'Assinatura inválida');
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

module.exports = { enabled, priceId, request, verifyWebhook };

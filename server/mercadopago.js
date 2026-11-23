'use strict';
// Integração mínima com o Mercado Pago (assinaturas recorrentes "preapproval"), via API REST — sem SDK.
// Aceita cartão de crédito; a cobrança mensal é feita pelo próprio Mercado Pago.
const crypto = require('crypto');
const { HttpError } = require('./http');
const config = require('./config');

const API = process.env.MP_API_BASE || 'https://api.mercadopago.com'; // MP_API_BASE só para testes locais

// Valor mensal em reais, aceitando "79,90" ou "79.90"
function price() {
  const v = Number(String(config.get('MP_PRICE') || '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}
const enabled = () => !!(config.get('MP_ACCESS_TOKEN') && price());

async function request(method, path, body, idempotencyKey) {
  const token = config.get('MP_ACCESS_TOKEN');
  if (!token) throw new HttpError(503, 'O Mercado Pago ainda não foi configurado na plataforma.');
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Mercado Pago', method, path, res.status, data.message || data.error);
    const msg = /payer_email|email/i.test(String(data.message || ''))
      ? 'O Mercado Pago recusou o e-mail informado. Use o e-mail da sua conta do Mercado Pago.'
      : 'Não foi possível falar com o Mercado Pago. Tente novamente em instantes.';
    throw new HttpError(502, msg);
  }
  return data;
}

// Confere a assinatura da notificação (cabeçalho x-signature: ts=...,v1=...)
// Manifesto: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
function verifyWebhook(headers, dataId, toleranceSec = 600) {
  const secret = config.get('MP_WEBHOOK_SECRET');
  if (!secret) throw new HttpError(503, 'Webhook do Mercado Pago não configurado');
  const header = headers['x-signature'];
  if (!header || !dataId) throw new HttpError(400, 'Assinatura ausente');
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=').map((s) => s.trim())));
  if (!parts.ts || !parts.v1) throw new HttpError(400, 'Assinatura inválida');
  let ts = Number(parts.ts); if (ts > 1e12) ts /= 1000; // o Mercado Pago pode enviar em milissegundos
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) throw new HttpError(400, 'Assinatura expirada');
  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : String(dataId);
  let manifest = `id:${id};`;
  if (headers['x-request-id']) manifest += `request-id:${headers['x-request-id']};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  const got = Buffer.from(String(parts.v1), 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new HttpError(400, 'Assinatura inválida');
}

// Situação do Mercado Pago → situação interna (a mesma usada para o Stripe)
const STATUS = { authorized: 'active', paused: 'paused', cancelled: 'canceled', pending: null };

module.exports = { enabled, price, request, verifyWebhook, STATUS };

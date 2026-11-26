'use strict';
// Cliente mínimo da Evolution API (WhatsApp), via REST — sem SDK.
// O servidor da Evolution e a chave global ficam na área administrativa (EVOLUTION_URL / EVOLUTION_API_KEY);
// cada clínica tem a sua própria "instância" (o WhatsApp dela, conectado pelo QR Code).
const { HttpError } = require('./http');
const config = require('./config');

const EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];
const enabled = () => !!(config.get('EVOLUTION_URL') && config.get('EVOLUTION_API_KEY'));
const base = () => config.get('EVOLUTION_URL').replace(/\/+$/, '');

async function call(method, path, body, { quiet = false } = {}) {
  if (!enabled()) throw new HttpError(503, 'O WhatsApp ainda não foi configurado na plataforma.');
  let res;
  try {
    res = await fetch(base() + path, {
      method, headers: { apikey: config.get('EVOLUTION_API_KEY'), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    console.error('Evolution', method, path, e.message);
    throw new HttpError(502, 'Não foi possível falar com o servidor do WhatsApp. Tente novamente em instantes.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!quiet) console.error('Evolution', method, path, res.status, JSON.stringify(data.response?.message || data.message || data.error || '').slice(0, 300));
    const err = new HttpError(502, 'O servidor do WhatsApp recusou o pedido. Tente novamente em instantes.');
    err.upstream = res.status;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;
const webhookBody = (url) => ({ enabled: true, url, byEvents: false, base64: false, events: EVENTS });

module.exports = {
  enabled,
  // cria a instância já com o webhook; se o nome já existir, só reconfigura o webhook
  async createInstance(name, webhookUrl) {
    try {
      await call('POST', '/instance/create', { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook: webhookBody(webhookUrl) }, { quiet: true });
    } catch (e) {
      if (e.upstream !== 403 && e.upstream !== 409) throw e; // 403/409: nome já em uso (instância criada antes)
    }
    await call('POST', `/webhook/set/${enc(name)}`, { webhook: webhookBody(webhookUrl) }).catch(() => {});
  },
  // QR Code para escanear (data:image/png;base64,...) — enquanto a instância não estiver conectada
  async connect(name) {
    const r = await call('GET', `/instance/connect/${enc(name)}`);
    const qr = r.base64 || r.qrcode?.base64 || null;
    return { qr: qr && !qr.startsWith('data:') ? `data:image/png;base64,${qr}` : qr, pairingCode: r.pairingCode || null };
  },
  // 'open' (conectado), 'connecting' (aguardando o QR) ou 'close'
  async state(name) {
    try {
      const r = await call('GET', `/instance/connectionState/${enc(name)}`, null, { quiet: true });
      return r.instance?.state || r.state || 'close';
    } catch (e) { if (e.upstream === 404) return 'close'; throw e; }
  },
  // número conectado (só os dígitos)
  async owner(name) {
    const r = await call('GET', `/instance/fetchInstances?instanceName=${enc(name)}`, null, { quiet: true }).catch(() => null);
    const it = Array.isArray(r) ? r[0] : r;
    const jid = it?.ownerJid || it?.instance?.owner || it?.owner || it?.number || '';
    const d = String(jid).split('@')[0].replace(/\D/g, '');
    return d || null;
  },
  async remove(name) {
    await call('DELETE', `/instance/logout/${enc(name)}`, null, { quiet: true }).catch(() => {});
    await call('DELETE', `/instance/delete/${enc(name)}`, null, { quiet: true }).catch(() => {});
  },
  // envia texto; devolve o "jid" de destino informado pelo WhatsApp (usado para reconhecer a resposta)
  async sendText(name, number, text) {
    const r = await call('POST', `/message/sendText/${enc(name)}`, { number, text });
    return { jid: r.key?.remoteJid || null, id: r.key?.id || null };
  },
};

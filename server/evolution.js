'use strict';
// Cliente mínimo da Evolution API (WhatsApp), via REST — sem SDK.
// O servidor da Evolution e a chave global ficam na área administrativa (EVOLUTION_URL / EVOLUTION_API_KEY);
// cada clínica tem a sua própria "instância" (o WhatsApp dela, conectado pelo QR Code).
const { HttpError } = require('./http');
const config = require('./config');

const EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];
const enabled = () => !!(config.get('EVOLUTION_URL') && config.get('EVOLUTION_API_KEY'));
const base = () => config.get('EVOLUTION_URL').replace(/\/+$/, '');

// motivo legível para falhas de rede (o servidor da plataforma não alcançou o endereço da Evolution)
function netReason(code) {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'o endereço não existe (domínio não encontrado). Confira o EVOLUTION_URL no painel administrativo.';
  if (code === 'ECONNREFUSED') return 'o servidor recusou a conexão (a Evolution está desligada ou a porta está errada).';
  if (code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'o servidor não respondeu (firewall bloqueando a porta ou endereço só acessível na rede local).';
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) return 'o certificado HTTPS do servidor é inválido. Use um certificado válido (ex.: Let\'s Encrypt).';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'a conexão foi interrompida (confira se o endereço usa http ou https corretamente).';
  return `falha de rede (${code || 'desconhecida'}). Confira o EVOLUTION_URL no painel administrativo.`;
}

async function call(method, path, body, { quiet = false } = {}) {
  if (!enabled()) throw new HttpError(503, 'O WhatsApp ainda não foi configurado na plataforma.');
  let res;
  try {
    res = await fetch(base() + path, {
      method, headers: { apikey: config.get('EVOLUTION_API_KEY'), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const code = e.cause?.code || e.name || '';
    console.error('Evolution', method, path, e.message, code, e.cause?.message || '');
    throw new HttpError(502, `Não foi possível falar com o servidor do WhatsApp: ${netReason(code)}`);
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
  // foto de perfil do número conectado, baixada pelo servidor e devolvida como data: URL (só de servidores do WhatsApp)
  async profilePhoto(name, number) {
    let url = null;
    const r = await call('GET', `/instance/fetchInstances?instanceName=${enc(name)}`, null, { quiet: true }).catch(() => null);
    const it = Array.isArray(r) ? r[0] : r;
    url = it?.profilePicUrl || it?.instance?.profilePictureUrl || null;
    if (!url && number) {
      const p = await call('POST', `/chat/fetchProfilePictureUrl/${enc(name)}`, { number }, { quiet: true }).catch(() => null);
      url = p?.profilePictureUrl || null;
    }
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || !/(^|\.)(whatsapp\.net|fbcdn\.net)$/.test(u.hostname)) return null;
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !/^image\/(jpeg|png|webp)$/.test(type.split(';')[0])) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length && buf.length < 400 * 1024 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null;
    } catch { return null; }
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

'use strict';
// Envio de e-mail da plataforma: SMTP (configurado no painel /admin) ou, na falta, a API do Resend.
// Cliente SMTP próprio, sem dependências: SSL direto (465), STARTTLS (587) e AUTH PLAIN/LOGIN.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');
const config = require('./config');

class MailError extends Error {}
const TIMEOUT = 20000;
const noBreak = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const ADDR_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

// "Nome <email@x>" ou "email@x" → { name, address }
function parseAddress(v) {
  const s = noBreak(v);
  const m = /^(.*)<([^<>]+)>$/.exec(s);
  const address = (m ? m[2] : s).trim();
  if (!ADDR_RE.test(address)) throw new MailError(`Endereço de e-mail inválido: ${address || '(vazio)'}`);
  return { name: m ? m[1].trim().replace(/^"|"$/g, '') : '', address };
}
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const fmtAddr = ({ name, address }) => (name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/"/g, '')}"` : encWord(name)} <${address}>` : address);
const b64lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

function buildMessage({ from, to, replyTo, subject, text, html }) {
  const id = `<${crypto.randomUUID()}@${from.address.split('@')[1]}>`;
  const head = [
    `From: ${fmtAddr(from)}`, `To: ${to.map(fmtAddr).join(', ')}`, replyTo ? `Reply-To: ${fmtAddr(replyTo)}` : null,
    `Subject: ${encWord(noBreak(subject))}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
  ].filter(Boolean);
  let body;
  if (html) {
    const b = `=_fg_${crypto.randomBytes(12).toString('hex')}`;
    head.push(`Content-Type: multipart/alternative; boundary="${b}"`);
    body = [`--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(text || ''),
      `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(html), `--${b}--`, ''].join('\r\n');
  } else {
    head.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    body = b64lines(text || '');
  }
  return { raw: `${head.join('\r\n')}\r\n\r\n${body}`, messageId: id };
}

// ---------- Sessão SMTP ----------
function smtpSession(socket) {
  let buf = ''; let waiting = null; const lines = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) { // última linha da resposta
        const all = lines.splice(0); const code = Number(line.slice(0, 3));
        if (waiting) { const w = waiting; waiting = null; w.resolve({ code, lines: all }); }
      }
    }
  };
  const fail = (e) => { if (waiting) { const w = waiting; waiting = null; w.reject(e); } };
  const attach = (s) => { s.on('data', onData); s.on('error', fail); s.on('close', () => fail(new MailError('O servidor SMTP fechou a conexão.'))); };
  attach(socket);
  const read = () => new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  return {
    get socket() { return socket; },
    read,
    async cmd(line, expect, { hide = false } = {}) {
      const p = read();
      socket.write(`${line}\r\n`);
      const r = await p;
      if (expect && !expect.includes(r.code)) {
        throw new MailError(`O servidor SMTP recusou ${hide ? 'a autenticação' : `"${line.split(' ')[0]}"`}: ${r.lines.join(' ').slice(0, 300)}`);
      }
      return r;
    },
    upgrade(next) { socket.removeAllListeners('data'); socket.removeAllListeners('error'); socket.removeAllListeners('close'); socket = next; attach(next); },
  };
}

function connect({ host, port, security }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host, timeout: TIMEOUT };
    const s = security === 'ssl' ? tls.connect(opts) : net.connect(opts);
    const ok = () => { s.setTimeout(TIMEOUT); s.removeListener('error', bad); resolve(s); };
    const bad = (e) => reject(new MailError(`Não foi possível conectar a ${host}:${port} (${e.code || e.message}).`));
    s.once(security === 'ssl' ? 'secureConnect' : 'connect', ok);
    s.once('error', bad);
    s.once('timeout', () => { s.destroy(); reject(new MailError(`Tempo esgotado ao conectar a ${host}:${port}.`)); });
  });
}

// dica para o erro mais comum: porta e modo de segurança trocados
function withHint(cfg, e) {
  const hint = cfg.port === 465 && cfg.security !== 'ssl' ? ' A porta 465 usa "SSL/TLS direto" — mude a segurança da conexão.'
    : cfg.security === 'ssl' && [25, 587, 2525].includes(cfg.port) ? ' Esta porta normalmente usa STARTTLS — mude a segurança da conexão.' : '';
  return new MailError(`${e.message}${hint}`);
}
async function sendSmtp(cfg, msg, envelope) {
  const socket = await connect(cfg).catch((e) => { throw withHint(cfg, e); });
  const sess = smtpSession(socket);
  socket.on('timeout', () => socket.destroy(new MailError('Tempo esgotado na conversa com o servidor SMTP.')));
  const host = noBreak(os.hostname()).replace(/[^A-Za-z0-9.-]/g, '') || 'fisiogestao';
  try {
    const greet = await sess.read();
    if (greet.code !== 220) throw new MailError(`Resposta inesperada do servidor SMTP: ${greet.lines.join(' ')}`);
    let ehlo = await sess.cmd(`EHLO ${host}`, [250]);
    if (cfg.security === 'starttls') {
      if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new MailError('O servidor não oferece STARTTLS. Use "SSL (porta 465)" ou confira a porta.');
      await sess.cmd('STARTTLS', [220]);
      const secure = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sess.socket, servername: cfg.host }, () => resolve(t));
        t.once('error', (e) => reject(new MailError(`Falha no TLS: ${e.message}`)));
      });
      sess.upgrade(secure);
      secure.setTimeout(TIMEOUT);
      secure.on('timeout', () => secure.destroy(new MailError('Tempo esgotado na conversa com o servidor SMTP.')));
      ehlo = await sess.cmd(`EHLO ${host}`, [250]);
    }
    if (cfg.user) {
      const auth = ehlo.lines.join(' ').toUpperCase();
      if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
        await sess.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64')}`, [235], { hide: true });
      } else {
        await sess.cmd('AUTH LOGIN', [334], { hide: true });
        await sess.cmd(Buffer.from(cfg.user, 'utf8').toString('base64'), [334], { hide: true });
        await sess.cmd(Buffer.from(cfg.pass, 'utf8').toString('base64'), [235], { hide: true });
      }
    }
    await sess.cmd(`MAIL FROM:<${envelope.from}>`, [250]);
    for (const rcpt of envelope.to) await sess.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await sess.cmd('DATA', [354]);
    // "dot-stuffing": linhas que começam com ponto ganham um ponto extra
    const data = msg.raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const done = await sess.cmd(`${data}\r\n.`, [250]);
    await sess.cmd('QUIT').catch(() => {});
    return done.lines.join(' ').slice(0, 200);
  } catch (e) {
    throw withHint(cfg, e);
  } finally {
    sess.socket.destroy();
  }
}

function smtpConfig() {
  const host = config.get('SMTP_HOST');
  if (!host) return null;
  const security = config.get('SMTP_SECURITY') || 'starttls';
  const port = Number(config.get('SMTP_PORT')) || (security === 'ssl' ? 465 : security === 'starttls' ? 587 : 25);
  return { host, port, security, user: config.get('SMTP_USER'), pass: config.get('SMTP_PASS') };
}
function provider() {
  if (smtpConfig()) return 'smtp';
  if (config.get('RESEND_API_KEY')) return 'resend';
  return null;
}
function status() {
  const s = smtpConfig(); const p = provider();
  return {
    provider: p, from: config.get('EMAIL_FROM') || null,
    detail: p === 'smtp' ? `${s.host}:${s.port} · ${{ ssl: 'SSL', starttls: 'STARTTLS', nenhuma: 'sem criptografia' }[s.security] || s.security}${s.user ? ` · usuário ${s.user}` : ''}` : p === 'resend' ? 'API do Resend' : null,
  };
}

// send({ to, subject, text, html, replyTo }) → { provider, id, response }
async function send({ to, subject, text, html, replyTo }) {
  const fromRaw = config.get('EMAIL_FROM');
  if (!fromRaw) throw new MailError('Configure o remetente (EMAIL_FROM) no painel.');
  const from = parseAddress(fromRaw);
  const rcpts = (Array.isArray(to) ? to : [to]).map(parseAddress);
  if (!rcpts.length || rcpts.length > 50) throw new MailError('Informe de 1 a 50 destinatários.');
  if (!subject) throw new MailError('Assunto vazio.');
  const reply = replyTo ? parseAddress(replyTo) : null;
  const p = provider();
  if (p === 'smtp') {
    const cfg = smtpConfig();
    if (cfg.user && !cfg.pass) throw new MailError('Informe a senha do SMTP no painel.');
    const msg = buildMessage({ from, to: rcpts, replyTo: reply, subject, text, html });
    const response = await sendSmtp(cfg, msg, { from: from.address, to: rcpts.map((r) => r.address) });
    return { provider: 'smtp', id: msg.messageId, response };
  }
  if (p === 'resend') {
    const res = await fetch(process.env.RESEND_API_BASE || 'https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT),
      headers: { Authorization: `Bearer ${config.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fmtAddr(from), to: rcpts.map((r) => r.address), subject: noBreak(subject), text, html, reply_to: reply ? reply.address : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new MailError(`O Resend recusou o envio: ${data.message || res.status}`);
    return { provider: 'resend', id: data.id, response: 'aceito pelo Resend' };
  }
  throw new MailError('Nenhum serviço de e-mail configurado. Preencha o SMTP (ou a chave do Resend) no painel.');
}

module.exports = { send, status, provider, MailError, parseAddress, buildMessage };

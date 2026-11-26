'use strict';
// WhatsApp da clínica (Evolution API): conexão por QR Code, lembretes automáticos de consulta
// (48 h, 24 h, 3 h e 1 h antes) e confirmação pelo paciente respondendo SIM ou NÃO.
//
// Lembretes: sweep() roda a cada poucos minutos (cron externo, ou o servidor local). Para cada consulta futura,
// envia o lembrete da menor antecedência ligada que já "venceu" — quem marca com 20 h de antecedência recebe só o de 24 h.
// Cada (consulta, antecedência) é registrado em wa_reminders antes do envio, então nunca sai duas vezes.
const crypto = require('crypto');
const { sql, q, als, currentSql, withClinic, getClinic } = require('./core');
const { HttpError } = require('./http');
const evo = require('./evolution');

const OFFSETS = [48, 24, 3, 1];
const DEFAULTS = {
  enabled: false,
  quiet: true, // não envia entre 22h e 6h (horário da clínica)
  reminders: {
    48: { on: false, ask: true, text: 'Olá, {paciente}! Passando para lembrar da sua consulta na {clinica} em {dia_semana}, {data}, às {hora}.' },
    24: { on: true, ask: true, text: 'Olá, {paciente}! Sua consulta na {clinica} é amanhã, {data}, às {hora}.' },
    3: { on: true, ask: false, text: 'Olá, {paciente}! Sua consulta na {clinica} é hoje às {hora}. Endereço: {endereco}' },
    1: { on: false, ask: false, text: '{paciente}, sua consulta na {clinica} começa em 1 hora, às {hora}. Até já!' },
  },
  ask_text: 'Responda *SIM* para confirmar ou *NÃO* para desmarcar.',
  confirm_reply: 'Presença confirmada! Até {data} às {hora}. 😊',
  cancel_reply: 'Tudo bem, sua consulta de {data} às {hora} foi desmarcada. Para remarcar, é só responder esta mensagem.',
};
const VARS = ['paciente', 'nome_completo', 'clinica', 'data', 'hora', 'dia_semana', 'profissional', 'endereco', 'telefone'];
const WEEK = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MAX_TEXT = 1000;

// ---------- horário da clínica ----------
const fmtCache = new Map();
function partsAt(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); fmtCache.set(tz, f); }
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}
const localAt = (ms, tz) => { const o = partsAt(ms, tz); return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`; };
// "2026-12-01T09:00" no fuso da clínica → instante (ms)
function localToMs(s, tz) {
  const [d, t] = s.split('T'); const [y, m, da] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, da, hh, mm);
  const off = (ms) => { const o = partsAt(ms, tz); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000; };
  let ms = guess - off(guess);
  const o2 = off(ms); if (guess - o2 !== ms) ms = guess - o2;
  return ms;
}

// ---------- telefones ----------
// número para envio: só dígitos, com DDI 55 quando vier no formato nacional
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 15 ? d : null;
}
// chave de comparação: DDI+DDD + últimos 8 dígitos (o WhatsApp às vezes omite o 9º dígito dos celulares do Brasil)
function phoneKey(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d.slice(0, 4) + d.slice(-8);
  return d;
}

function render(text, vars) { return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] ?? '' : m)).trim(); }
// "sim" / "não" na resposta do paciente (ignora acentos, maiúsculas, pontuação e emojis de positivo)
function intent(text) {
  const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s👍👎]/gu, ' ').trim();
  if (!t) return null;
  const w = t.split(/\s+/);
  const yes = ['sim', 's', 'confirmo', 'confirmado', 'confirmar', 'confirma', 'ok', '1', '👍', 'certo', 'combinado', 'yes'];
  const no = ['nao', 'n', 'desmarcar', 'desmarca', 'cancelar', 'cancela', 'cancelo', '2', '👎', 'no'];
  if (w.length > 6) return null; // mensagem longa: a clínica responde à mão
  if (no.includes(w[0]) || /^nao\b|\b(desmarcar|cancelar)\b/.test(t)) return 'nao';
  if (yes.includes(w[0]) || /\bconfirm/.test(t)) return 'sim';
  return null;
}

module.exports = function whatsapp({ route, requireRole, audit, clinicAccess, APP_URL, sha, checkRate, failRate }) {
  const sha256 = sha;
  async function account(clinicId) { return (await currentSql().unsafe('SELECT * FROM saas.clinic_whatsapp WHERE clinic_id=$1', [clinicId]))[0] || null; }
  async function loadCfg() {
    const r = await q.get("SELECT value FROM settings WHERE key='whatsapp'");
    let saved = {}; try { saved = r ? JSON.parse(r.value) : {}; } catch { /* inválido */ }
    const out = { ...DEFAULTS, ...saved, reminders: {} };
    for (const h of OFFSETS) out.reminders[h] = { ...DEFAULTS.reminders[h], ...(saved.reminders?.[h] || {}) };
    return out;
  }
  async function clinicVars() {
    const s = Object.fromEntries((await q.all("SELECT key, value FROM settings WHERE key IN ('clinic_name','professional_name','address','city','phone')")).map((r) => [r.key, r.value]));
    return { clinica: s.clinic_name || s.professional_name || 'clínica', endereco: [s.address, s.city].filter(Boolean).join(' — '), telefone: s.phone || '' };
  }
  function apptVars(a, base) {
    const [y, m, d] = a.start.slice(0, 10).split('-');
    return { ...base, paciente: String(a.patient_name || '').split(/\s+/)[0], nome_completo: a.patient_name || '', data: `${d}/${m}`, hora: a.start.slice(11, 16),
      dia_semana: WEEK[new Date(Date.UTC(+y, +m - 1, +d)).getUTCDay()], profissional: a.professional_name || '' };
  }

  // ---------- rotas da clínica ----------
  async function status(ctx) {
    const a = await account(ctx.clinic.id);
    const cfg = await loadCfg();
    return { available: evo.enabled(), connected: a?.state === 'open', state: a?.state || null, phone: a?.phone || null, connected_at: a?.connected_at || null,
      settings: cfg, defaults: DEFAULTS, vars: VARS, offsets: OFFSETS };
  }
  route('GET', '/api/whatsapp', async (ctx) => { requireRole(ctx.user, ['admin']); return status(ctx); });

  // cria a instância (se preciso) e devolve o QR Code
  route('POST', '/api/whatsapp/connect', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    if (!evo.enabled()) throw new HttpError(503, 'O WhatsApp ainda não foi configurado na plataforma.');
    let a = await account(ctx.clinic.id);
    if (a?.state === 'open') return { state: 'open' };
    const secret = crypto.randomBytes(24).toString('base64url');
    const instance = a?.instance || `fisio-${ctx.clinic.id}-${crypto.randomBytes(4).toString('hex')}`;
    await evo.createInstance(instance, `${APP_URL}/api/whatsapp/webhook/${ctx.clinic.id}/${secret}`);
    await currentSql().unsafe(`INSERT INTO saas.clinic_whatsapp(clinic_id, instance, hook_hash, state, created_by) VALUES ($1,$2,$3,'connecting',$4)
      ON CONFLICT (clinic_id) DO UPDATE SET instance=excluded.instance, hook_hash=excluded.hook_hash, state='connecting', phone=NULL, connected_at=NULL, created_by=excluded.created_by, updated_at=now()`,
    [ctx.clinic.id, instance, sha256(secret), ctx.user.name]);
    a = await account(ctx.clinic.id);
    const st = await evo.state(instance);
    if (st === 'open') return markOpen(ctx, a);
    return { state: 'connecting', ...(await evo.connect(instance)) };
  });
  // conexão concluída (vista pela tela ou pelo aviso da Evolution): grava o número e registra na auditoria uma vez só
  async function markOpen(ctx, a) {
    if (a.state === 'open' && a.connected_at && a.phone) return { state: 'open', phone: a.phone };
    const phone = (await evo.owner(a.instance)) || a.phone;
    const upd = await currentSql().unsafe("UPDATE saas.clinic_whatsapp SET state='open', phone=$2, connected_at=now(), updated_at=now() WHERE clinic_id=$1 AND connected_at IS NULL RETURNING clinic_id", [a.clinic_id, phone]);
    if (upd.length) await audit(ctx, 'conectou_whatsapp', 'clinic', a.clinic_id, null, { numero: phone ? `…${phone.slice(-4)}` : null });
    else await currentSql().unsafe("UPDATE saas.clinic_whatsapp SET state='open', phone=coalesce($2, phone), updated_at=now() WHERE clinic_id=$1", [a.clinic_id, phone]);
    return { state: 'open', phone };
  }
  // a tela consulta a cada poucos segundos enquanto mostra o QR Code (o código muda a cada ~40 s)
  route('GET', '/api/whatsapp/qr', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    const a = await account(ctx.clinic.id);
    if (!a) return { state: null };
    const st = await evo.state(a.instance);
    if (st === 'open') return markOpen(ctx, a);
    if (a.state === 'open') await currentSql().unsafe("UPDATE saas.clinic_whatsapp SET state='close', updated_at=now() WHERE clinic_id=$1", [a.clinic_id]);
    return { state: 'connecting', ...(await evo.connect(a.instance)) };
  });
  // foto de perfil do WhatsApp conectado (a tela carrega depois, sem atrasar o resto)
  route('GET', '/api/whatsapp/photo', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    const a = await account(ctx.clinic.id);
    if (a?.state !== 'open') return { photo: null };
    return { photo: await evo.profilePhoto(a.instance, a.phone).catch(() => null) };
  });
  route('POST', '/api/whatsapp/disconnect', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    const a = await account(ctx.clinic.id);
    if (a) await evo.remove(a.instance).catch(() => {});
    await currentSql().unsafe('DELETE FROM saas.clinic_whatsapp WHERE clinic_id=$1', [ctx.clinic.id]);
    await audit(ctx, 'desconectou_whatsapp', 'clinic', ctx.clinic.id, null, null);
    return { ok: true };
  });

  route('PUT', '/api/whatsapp/settings', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    const b = ctx.body || {};
    const cur = await loadCfg();
    const txt = (v, label, fallback) => {
      if (v === undefined) return fallback;
      const s = String(v ?? '').trim();
      if (!s) throw new HttpError(400, `${label}: escreva a mensagem`);
      if (s.length > MAX_TEXT) throw new HttpError(400, `${label}: no máximo ${MAX_TEXT} caracteres`);
      return s;
    };
    const out = { enabled: b.enabled === undefined ? cur.enabled : !!b.enabled, quiet: b.quiet === undefined ? cur.quiet : !!b.quiet, reminders: {} };
    for (const h of OFFSETS) {
      const r = b.reminders?.[h] || {}; const c = cur.reminders[h];
      out.reminders[h] = { on: r.on === undefined ? c.on : !!r.on, ask: r.ask === undefined ? c.ask : !!r.ask, text: txt(r.text, `Lembrete de ${h} h`, c.text) };
    }
    out.ask_text = txt(b.ask_text, 'Pedido de confirmação', cur.ask_text);
    out.confirm_reply = txt(b.confirm_reply, 'Resposta ao confirmar', cur.confirm_reply);
    out.cancel_reply = txt(b.cancel_reply, 'Resposta ao desmarcar', cur.cancel_reply);
    await q.run("INSERT INTO settings(key,value) VALUES ('whatsapp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(out));
    await audit(ctx, 'alterou_lembretes_whatsapp', 'settings', null, null, { ligado: out.enabled, lembretes: OFFSETS.filter((h) => out.reminders[h].on).map((h) => `${h}h`) });
    return out;
  });

  route('POST', '/api/whatsapp/test', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    const a = await account(ctx.clinic.id);
    if (a?.state !== 'open') throw new HttpError(400, 'Conecte o WhatsApp da clínica primeiro.');
    const number = waNumber(ctx.body?.phone);
    if (!number) throw new HttpError(400, 'Informe um celular com DDD.');
    await checkRate(`watest|${ctx.clinic.id}`); await failRate(`watest|${ctx.clinic.id}`, 10, 60); // até 10 testes por hora
    const cfg = await loadCfg();
    const h = OFFSETS.find((x) => cfg.reminders[x].on) || 24;
    const d = new Date(Date.now() + h * 3600e3); const loc = localAt(d.getTime(), ctx.clinic.timezone || 'America/Sao_Paulo');
    const vars = apptVars({ start: loc, patient_name: 'Maria Exemplo', professional_name: ctx.user.name }, await clinicVars());
    const text = `${render(cfg.reminders[h].text, vars)}${cfg.reminders[h].ask ? `\n\n${render(cfg.ask_text, vars)}` : ''}\n\n(mensagem de teste)`;
    await evo.sendText(a.instance, number, text);
    return { ok: true, text };
  });

  route('GET', '/api/whatsapp/log', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    return q.all(`SELECT r.id, r.offset_h, r.status, r.error, r.reply, r.replied_at, r.sent_at, r.created_at, r.ask, a.start, a.status appt_status, p.name patient
      FROM wa_reminders r JOIN appointments a ON a.id=r.appointment_id JOIN patients p ON p.id=a.patient_id ORDER BY r.id DESC LIMIT 100`);
  });

  // ---------- avisos da Evolution (mensagens recebidas e situação da conexão) ----------
  route('POST', '/api/whatsapp/webhook/:clinicId/:secret', async (ctx) => {
    const hookKey = `wahook|${ctx.ip}`; await checkRate(hookKey);
    const clinic = await getClinic(Number(ctx.params.clinicId) || 0);
    const a = clinic ? (await sql.unsafe('SELECT * FROM saas.clinic_whatsapp WHERE clinic_id=$1', [clinic.id]))[0] : null;
    const given = sha256(String(ctx.params.secret || ''));
    if (!a || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(a.hook_hash))) { await failRate(hookKey, 20, 30); return { received: true }; }
    let body = {};
    try { body = JSON.parse(ctx.rawBody?.toString('utf8') || '{}'); } catch { return { received: true }; }
    const event = String(body.event || '').toLowerCase().replace(/_/g, '.');
    if (event === 'connection.update') {
      const st = body.data?.state;
      if (st === 'open') await withClinic(clinic, () => { ctx.user = null; return markOpen(ctx, a); });
      else if (st === 'close' || st === 'connecting') await sql.unsafe('UPDATE saas.clinic_whatsapp SET state=$2, updated_at=now() WHERE clinic_id=$1', [clinic.id, st]);
      return { received: true };
    }
    if (event !== 'messages.upsert' || clinicAccess(clinic).mode === 'blocked') return { received: true };
    for (const m of [].concat(body.data || [])) {
      const key = m.key || {};
      if (key.fromMe) continue;
      const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn, m.senderPn, key.participant].filter((j) => typeof j === 'string' && /@(s\.whatsapp\.net|lid)$/.test(j));
      if (!jids.length) continue; // grupos, status etc.
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.buttonsResponseMessage?.selectedDisplayText || '';
      const want = intent(text);
      if (!want) continue;
      const keys = jids.filter((j) => j.endsWith('@s.whatsapp.net')).map((j) => phoneKey(j.split('@')[0]));
      const res = await withClinic(clinic, () => applyReply(ctx, clinic, jids, keys, want));
      if (res) await evo.sendText(a.instance, res.to, res.text).catch((e) => console.error('WhatsApp: resposta não enviada', clinic.id, e.message));
    }
    return { received: true };
  }, { public: true, webhook: true, raw: true });

  async function applyReply(ctx, clinic, jids, keys, want) {
    const tz = clinic.timezone || 'America/Sao_Paulo';
    const now = localAt(Date.now(), tz);
    const r = await q.get(`SELECT r.*, a.status appt_status, a.start, a.patient_id, p.name patient_name FROM wa_reminders r
      JOIN appointments a ON a.id=r.appointment_id JOIN patients p ON p.id=a.patient_id
      WHERE r.ask AND r.status='enviado' AND (r.jid = ANY(?::text[]) OR r.phone_key = ANY(?::text[]))
        AND a.start > ? AND a.status IN ('agendado','confirmado')
      ORDER BY r.id DESC LIMIT 1`, `{${jids.map((j) => `"${j}"`).join(',')}}`, `{${keys.map((k) => `"${k}"`).join(',')}}`, now);
    if (!r) return null;
    if (r.reply === want) return null; // resposta repetida
    const cfg = await loadCfg();
    const vars = apptVars({ start: r.start, patient_name: r.patient_name }, await clinicVars());
    ctx.user = null;
    if (want === 'sim') {
      if (r.appt_status === 'agendado') await q.run("UPDATE appointments SET status='confirmado' WHERE id=?", r.appointment_id);
      await audit(ctx, 'paciente_confirmou_whatsapp', 'appointment', r.appointment_id, r.patient_id, { inicio: r.start });
    } else {
      await q.run("UPDATE appointments SET status='cancelado' WHERE id=?", r.appointment_id);
      // links de pagamento ainda não pagos deixam de valer (igual ao cancelamento pela agenda)
      await q.run("UPDATE charges SET status='cancelado' WHERE appointment_id=? AND status='pendente' AND pay_url IS NOT NULL", r.appointment_id);
      await audit(ctx, 'paciente_desmarcou_whatsapp', 'appointment', r.appointment_id, r.patient_id, { inicio: r.start });
    }
    await q.run('UPDATE wa_reminders SET reply=?, replied_at=? WHERE id=?', want, now, r.id);
    return { to: r.jid || r.phone, text: render(want === 'sim' ? cfg.confirm_reply : cfg.cancel_reply, vars) };
  }

  // ---------- envio dos lembretes ----------
  // Fase 1 (transação curta): reserva os lembretes devidos. Fase 2: envia fora da transação. Fase 3: grava o resultado.
  // diag (opcional) recebe o motivo de cada consulta não lembrada — usado pelo botão "Enviar lembretes agora"
  async function sweepClinic(clinic, a, budget, diag = null) {
    const tz = clinic.timezone || 'America/Sao_Paulo';
    const nowMs = Date.now();
    // dentro de uma requisição da própria clínica já existe a transação: usa a mesma (evita abrir outra conexão)
    const inClinic = (fn) => (als.getStore()?.clinic?.id === clinic.id ? fn() : withClinic(clinic, fn));
    const note = (k) => { if (diag) diag[k] = (diag[k] || 0) + 1; };
    const due = await inClinic(async () => {
      const cfg = await loadCfg();
      if (!cfg.enabled) { if (diag) diag.desligado = true; return []; }
      const on = OFFSETS.filter((h) => cfg.reminders[h].on).sort((x, y) => x - y);
      if (!on.length) { if (diag) diag.nenhum_horario = true; return []; }
      if (cfg.quiet) { const hr = Number(partsAt(nowMs, tz).hour); if (hr >= 22 || hr < 6) { if (diag) diag.horario_silencio = true; return []; } }
      const from = localAt(nowMs, tz); const to = localAt(nowMs + (Math.max(...on) * 3600e3) + 60e3, tz);
      const rows = await q.all(`SELECT a.id, a.start, a.status, p.name patient_name, p.phone, u.name professional_name FROM appointments a
        JOIN patients p ON p.id=a.patient_id LEFT JOIN users u ON u.id=a.professional_id
        WHERE a.start > ? AND a.start <= ? AND a.status IN ('agendado','confirmado') ORDER BY a.start LIMIT 500`, from, to);
      const base = await clinicVars();
      const out = [];
      for (const ap of rows) {
        if (out.length >= budget) break;
        const left = (localToMs(ap.start, tz) - nowMs) / 3600e3;
        if (left <= 0) continue;
        const h = on.find((x) => x >= left); // menor antecedência ligada que já chegou
        if (!h) { note('fora_do_horario'); continue; }
        const number = waNumber(ap.phone);
        if (!number) { note('sem_celular'); continue; }
        const ask = cfg.reminders[h].ask && ap.status === 'agendado';
        const claim = await q.get(`INSERT INTO wa_reminders(appointment_id, offset_h, phone, phone_key, ask) VALUES (?,?,?,?,?)
          ON CONFLICT (appointment_id, offset_h) DO UPDATE SET status='enviando', attempts=wa_reminders.attempts+1, error=NULL
            WHERE wa_reminders.status='falhou' AND wa_reminders.attempts < 3
          RETURNING id`, ap.id, h, number, phoneKey(number), ask);
        if (!claim) { note('ja_enviado'); continue; }
        const vars = apptVars(ap, base);
        out.push({ id: claim.id, number, text: `${render(cfg.reminders[h].text, vars)}${ask ? `\n\n${render(cfg.ask_text, vars)}` : ''}` });
      }
      return out;
    });
    const results = [];
    for (const m of due) {
      try { const r = await evo.sendText(a.instance, m.number, m.text); results.push({ id: m.id, ok: true, jid: r.jid, msg: r.id }); }
      catch (e) { results.push({ id: m.id, ok: false, error: e.message }); }
    }
    if (results.length) {
      await inClinic(async () => {
        for (const r of results) {
          if (r.ok) await q.run("UPDATE wa_reminders SET status='enviado', jid=?, msg_id=?, sent_at=saas.now_local() WHERE id=?", r.jid, r.msg, r.id);
          else await q.run("UPDATE wa_reminders SET status='falhou', error=? WHERE id=?", String(r.error).slice(0, 300), r.id);
        }
      });
    }
    if (diag) diag.erros = results.filter((r) => !r.ok).map((r) => r.error).slice(0, 3);
    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }
  async function sweep({ maxMessages = 80, deadlineMs = 20000 } = {}) {
    const out = { clinicas: 0, enviados: 0, falhas: 0 };
    if (!evo.enabled()) return out;
    const start = Date.now();
    const rows = await sql.unsafe("SELECT * FROM saas.clinic_whatsapp WHERE state='open' ORDER BY clinic_id");
    for (const w of rows) {
      const left = maxMessages - out.enviados - out.falhas;
      if (left <= 0 || Date.now() - start > deadlineMs) break;
      const clinic = await getClinic(w.clinic_id);
      if (!clinic || clinicAccess(clinic).mode !== 'full') continue;
      out.clinicas++;
      try { const r = await sweepClinic(clinic, w, left); out.enviados += r.sent; out.falhas += r.failed; }
      catch (e) { out.falhas++; console.error('WhatsApp: lembretes da clínica', w.clinic_id, e.message); }
    }
    return out;
  }

  // botão "Enviar lembretes agora": roda só para esta clínica e explica o resultado
  route('POST', '/api/whatsapp/run', async (ctx) => {
    requireRole(ctx.user, ['admin']);
    const a = await account(ctx.clinic.id);
    if (a?.state !== 'open') throw new HttpError(400, 'Conecte o WhatsApp da clínica primeiro.');
    await checkRate(`warun|${ctx.clinic.id}`); await failRate(`warun|${ctx.clinic.id}`, 20, 60);
    const diag = {};
    const r = await sweepClinic(ctx.clinic, a, 40, diag);
    return { enviados: r.sent, falhas: r.failed, ...diag };
  });

  return { sweep };
};
module.exports.intent = intent;
module.exports.waNumber = waNumber;
module.exports.phoneKey = phoneKey;

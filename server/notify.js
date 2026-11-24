'use strict';
// Envio de e-mails a partir dos modelos, com histórico (saas.email_log).
// "ref" identifica um envio único (ex.: "trial3:2026-11-27|ana@x.com"): o mesmo e-mail nunca sai duas vezes.
const mailer = require('./mailer');
const templates = require('./emailTemplates');
const { currentSql } = require('./core');

// sendTemplate('esqueci_senha', { to, vars, url, clinicId, ref }) → { sent } | { skipped }
// Lança erro se o envio falhar (quem chama decide o que fazer); o erro fica registrado no histórico.
async function sendTemplate(key, { to, vars = {}, url = null, clinicId = null, ref = null }) {
  if (!(await templates.isEnabled(key))) return { skipped: 'desativado' };
  const db = currentSql();
  const ins = await db.unsafe(`INSERT INTO saas.email_log(clinic_id, template, recipient, ref, status)
    VALUES ($1,$2,$3,$4,'enviando') ON CONFLICT DO NOTHING RETURNING id`, [clinicId, key, String(to).slice(0, 200), ref]);
  if (!ins.length) return { skipped: 'já enviado' };
  const id = ins[0].id;
  try {
    const msg = await templates.render(key, vars, url);
    const r = await mailer.send({ to, subject: msg.subject, text: msg.text, html: msg.html });
    await db.unsafe("UPDATE saas.email_log SET status='enviado', provider=$2 WHERE id=$1", [id, r.provider]);
    return { sent: true, ...r };
  } catch (e) {
    // libera a "ref" para tentar de novo numa próxima vez e guarda o motivo
    await db.unsafe("UPDATE saas.email_log SET status='falhou', error=$2, ref=NULL WHERE id=$1", [id, String(e.message).slice(0, 300)]);
    throw e;
  }
}

async function recent(limit = 100) {
  return currentSql().unsafe(`SELECT l.id, l.created_at, l.template, l.recipient, l.status, l.provider, l.error, c.name clinic
    FROM saas.email_log l LEFT JOIN saas.clinics c ON c.id = l.clinic_id ORDER BY l.id DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 100, 1), 500)]);
}

module.exports = { sendTemplate, recent };

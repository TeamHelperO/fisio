'use strict';
// E-mails automáticos do ciclo do cliente: boas-vindas, fim do teste grátis e eventos de pagamento.
// daily() roda no cron diário; onStatusChange() é chamado quando um webhook muda a assinatura.
// Cada e-mail tem uma "ref" única por clínica + destinatário, então nunca é enviado duas vezes.
const { sql, q, als, withClinic, getClinic } = require('./core');
const { sendTemplate } = require('./notify');

module.exports = function lifecycle({ clinicAccess, APP_URL }) {
  const day = 86400e3;
  const fmtDate = (d, tz) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: tz || 'America/Sao_Paulo' }) : '—');
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const PAID = ['active', 'trialing', 'past_due'];

  // administradores ativos da clínica (recebem os e-mails de conta e cobrança)
  async function admins(clinic) {
    const read = () => q.all("SELECT name, email FROM users WHERE role='admin' AND active=1 ORDER BY id");
    const st = als.getStore();
    return st?.clinic?.id === clinic.id ? read() : withClinic(clinic, read);
  }
  async function notify(clinic, key, ref, vars, path) {
    let sent = 0; let failed = 0;
    for (const a of await admins(clinic)) {
      try {
        const r = await sendTemplate(key, { to: a.email, clinicId: clinic.id, ref: `${ref}|${a.email}`, url: `${APP_URL}/#/${path}`,
          vars: { nome: a.name, clinica: clinic.name, ...vars } });
        if (r.sent) sent++;
      } catch (e) { failed++; console.error(`E-mail "${key}" para a clínica ${clinic.id} falhou:`, e.message); }
    }
    return { sent, failed };
  }

  // ---------- Rotina diária ----------
  async function daily(now = Date.now()) {
    const out = { clinicas: 0, enviados: 0, falhas: 0, por_modelo: {} };
    const count = (key, r) => { out.enviados += r.sent; out.falhas += r.failed; if (r.sent) out.por_modelo[key] = (out.por_modelo[key] || 0) + r.sent; };
    for (const c of await sql.unsafe('SELECT * FROM saas.clinics ORDER BY id')) {
      out.clinicas++;
      if (c.manual_access) continue; // acesso definido à mão pela plataforma: sem e-mails automáticos de teste/cobrança
      const created = new Date(c.created_at).getTime();
      const trialEnd = new Date(c.trial_ends_at).getTime();
      const a = clinicAccess(c, now);
      const paying = PAID.includes(c.subscription_status);
      const tz = c.timezone;
      // boas-vindas: 1 hora depois do cadastro (dá tempo do e-mail de confirmação chegar antes), só para cadastros recentes
      if (now - created >= 3600e3 && now - created < 3 * day) {
        count('boas_vindas', await notify(c, 'boas_vindas', 'boas-vindas', { dias: String(a.trial_days_left), data_fim: fmtDate(c.trial_ends_at, tz) }, 'dashboard'));
      }
      if (!paying && !c.subscription_status) {
        if (trialEnd > now) {
          const left = Math.ceil((trialEnd - now) / day);
          if (left === 3) count('trial_3_dias', await notify(c, 'trial_3_dias', `trial3:${ymd(trialEnd)}`, { dias: '3', data_fim: fmtDate(c.trial_ends_at, tz) }, 'configuracoes/assinatura'));
          if (left === 1) count('trial_ultimo_dia', await notify(c, 'trial_ultimo_dia', `trial1:${ymd(trialEnd)}`, { data_fim: fmtDate(c.trial_ends_at, tz) }, 'configuracoes/assinatura'));
        } else if (now - trialEnd < 3 * day) {
          count('trial_terminou', await notify(c, 'trial_terminou', `trialfim:${ymd(trialEnd)}`, { data_fim: fmtDate(c.trial_ends_at, tz) }, 'configuracoes/assinatura'));
        }
      }
      // garantia: se um aviso de pagamento recusado não saiu pelo webhook, sai aqui (uma vez por período)
      if (c.subscription_status === 'past_due') {
        count('pagamento_recusado', await notify(c, 'pagamento_recusado', `past_due:${c.current_period_end ? ymd(c.current_period_end) : '-'}`, {}, 'configuracoes/assinatura'));
      }
    }
    return out;
  }

  // ---------- Mudanças na assinatura (chamado depois dos webhooks do Stripe e do Mercado Pago) ----------
  async function onStatusChange(clinicId, before, after) {
    try {
      if (!before || !after) return;
      const c = await getClinic(clinicId);
      if (!c || c.manual_access) return;
      const tz = c.timezone;
      const subRef = c.stripe_subscription_id || c.mp_preapproval_id || '-';
      if (after.subscription_status === 'active' && !PAID.includes(before.subscription_status)) {
        await notify(c, 'assinatura_confirmada', `ativa:${subRef}`, { proxima_cobranca: fmtDate(after.current_period_end, tz) }, 'dashboard');
      }
      if (after.subscription_status === 'past_due' && before.subscription_status !== 'past_due') {
        await notify(c, 'pagamento_recusado', `past_due:${after.current_period_end ? ymd(after.current_period_end) : '-'}`, {}, 'configuracoes/assinatura');
      }
      const cancelled = (s) => s.subscription_status === 'canceled' || (s.cancel_at_period_end && PAID.includes(s.subscription_status));
      if (cancelled(after) && !cancelled(before)) {
        await notify(c, 'assinatura_cancelada', `cancel:${subRef}:${after.current_period_end ? ymd(after.current_period_end) : '-'}`,
          { acesso_ate: fmtDate(after.current_period_end, tz) }, 'configuracoes/assinatura');
      }
    } catch (e) { console.error('E-mails de assinatura:', e.message); }
  }

  return { daily, onStatusChange };
};

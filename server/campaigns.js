'use strict';
// Campanhas de e-mail marketing escritas e disparadas no painel /admin.
// LGPD: só vão para quem marcou "quero receber novidades" (saas.marketing_contacts.opt_in) e sempre com link de descadastro.
// O envio é feito em lotes (cada chamada trabalha no máximo ~20 s) para caber no limite das funções da Vercel;
// a tela chama "continuar" até terminar, e a rotina diária retoma campanhas interrompidas.
const { sql, getClinic } = require('./core');
const { HttpError } = require('./http');
const mailer = require('./mailer');
const templates = require('./emailTemplates');

const AUDIENCES = {
  todos: 'Todos que aceitam novidades',
  em_teste: 'Clínicas em teste grátis',
  assinantes: 'Clínicas assinantes',
  sem_assinatura: 'Teste terminou ou assinatura inativa',
};
const VARS = { nome: 'Nome da pessoa', clinica: 'Nome da clínica' };
const BUDGET_MS = 20000;

module.exports = function campaignsModule({ adminRoute, log, clinicAccess, unsubscribeUrl, APP_BASE }) {
  const fail = (msg, status = 400) => { throw new HttpError(status, msg); };
  function validate(b) {
    const name = String(b.name ?? '').trim().slice(0, 120);
    const subject = String(b.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
    const body = String(b.body ?? '').replace(/\r\n/g, '\n').trim();
    const button = String(b.button ?? '').replace(/[\r\n]+/g, ' ').trim();
    const buttonUrl = String(b.button_url ?? '').trim();
    const audience = String(b.audience || 'todos');
    if (!name) fail('Dê um nome para a campanha (só você vê)');
    if (!subject || subject.length > 200) fail('Informe o assunto (até 200 caracteres)');
    if (!body || body.length > 10000) fail('Escreva o texto do e-mail (até 10.000 caracteres)');
    if (button.length > 60) fail('Texto do botão muito longo (máx. 60 caracteres)');
    if (buttonUrl && !/^https:\/\/[^\s<>"']{4,500}$/.test(buttonUrl)) fail('O link do botão precisa começar com https://');
    if (!AUDIENCES[audience]) fail('Público inválido');
    const unknown = [...new Set([...`${subject} ${body} ${button}`.matchAll(templates.VAR_RE)].map((m) => m[1]).filter((v) => !(v in VARS)))];
    if (unknown.length) fail(`Variável desconhecida: ${unknown.map((v) => `{{${v}}}`).join(', ')}. Use {{nome}} ou {{clinica}}.`);
    return { name, subject, body, button, button_url: buttonUrl || null, audience };
  }
  // destinatários: contatos com aceite ativo, filtrados pela situação da clínica
  async function recipients(audience) {
    const rows = await sql.unsafe(`SELECT m.email, m.name, m.clinic_id, c.* , m.email AS contact_email, m.name AS contact_name, c.name AS clinic_name
      FROM saas.marketing_contacts m LEFT JOIN saas.clinics c ON c.id = m.clinic_id WHERE m.opt_in ORDER BY m.email`);
    return rows.filter((r) => {
      if (audience === 'todos') return true;
      if (!r.id) return false;
      const a = clinicAccess(r);
      if (audience === 'em_teste') return a.mode === 'full' && a.reason === 'trial';
      if (audience === 'assinantes') return ['subscription', 'past_due'].includes(a.reason);
      if (audience === 'sem_assinatura') return a.mode === 'readonly';
      return false;
    }).map((r) => ({ email: r.contact_email, name: r.contact_name || '', clinic: r.clinic_name || '' }));
  }
  const compose = (c, rcpt) => {
    const url = c.button ? (c.button_url || `${APP_BASE()}/`) : null;
    return templates.compose({ subject: c.subject, body: c.body, button: c.button }, { nome: rcpt.name || 'tudo bem', clinica: rcpt.clinic || 'sua clínica' }, url,
      { footer: { text: 'Você recebe este e-mail porque aceitou receber novidades do FisioGestão. Para não receber mais', url: unsubscribeUrl(rcpt.email) } });
  };
  async function stats(id) {
    const r = (await sql.unsafe(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='enviado')::int sent, COUNT(*) FILTER (WHERE status='falhou')::int failed,
      COUNT(*) FILTER (WHERE status IN ('pendente','enviando'))::int pending, COUNT(*) FILTER (WHERE status='pulado')::int skipped FROM saas.campaign_sends WHERE campaign_id=$1`, [id]))[0];
    return r;
  }
  async function getCampaign(id) {
    const c = (await sql.unsafe('SELECT * FROM saas.campaigns WHERE id=$1', [Number(id) || 0]))[0];
    if (!c) fail('Campanha não encontrada', 404);
    return c;
  }
  // envia o próximo lote; devolve o andamento
  async function work(c, budget = BUDGET_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      // "reserva" um destinatário por vez (evita envio duplo se duas abas chamarem ao mesmo tempo)
      const r = (await sql.unsafe(`UPDATE saas.campaign_sends SET status='enviando' WHERE (campaign_id, email) =
        (SELECT campaign_id, email FROM saas.campaign_sends WHERE campaign_id=$1 AND status='pendente' ORDER BY email LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [c.id]))[0];
      if (!r) break;
      // quem se descadastrou depois do início não recebe
      const still = (await sql.unsafe('SELECT opt_in FROM saas.marketing_contacts WHERE email=$1', [r.email]))[0];
      if (!still?.opt_in) { await sql.unsafe("UPDATE saas.campaign_sends SET status='pulado', error='descadastrado' WHERE campaign_id=$1 AND email=$2", [c.id, r.email]); continue; }
      try {
        const msg = compose(c, { email: r.email, name: r.name, clinic: r.clinic_name });
        await mailer.send({ to: r.email, subject: msg.subject, text: msg.text, html: msg.html, listUnsubscribe: unsubscribeUrl(r.email) });
        await sql.unsafe("UPDATE saas.campaign_sends SET status='enviado', sent_at=now(), error=NULL WHERE campaign_id=$1 AND email=$2", [c.id, r.email]);
      } catch (e) {
        await sql.unsafe("UPDATE saas.campaign_sends SET status='falhou', error=$3 WHERE campaign_id=$1 AND email=$2", [c.id, r.email, String(e.message).slice(0, 300)]);
        // problema de configuração/servidor: para o lote em vez de falhar todo mundo
        if (/Nenhum serviço|remetente|autenticação|conectar|Tempo esgotado|STARTTLS|TLS/i.test(e.message)) {
          await sql.unsafe("UPDATE saas.campaign_sends SET status='pendente', error=NULL WHERE campaign_id=$1 AND email=$2", [c.id, r.email]);
          throw new HttpError(502, `Envio interrompido: ${e.message}`);
        }
      }
    }
    const st = await stats(c.id);
    if (!st.pending && c.status === 'enviando') {
      await sql.unsafe("UPDATE saas.campaigns SET status='enviada', finished_at=now() WHERE id=$1 AND status='enviando'", [c.id]);
    }
    return { ...st, done: !st.pending };
  }

  adminRoute('GET', '/api/admin/campaigns/meta', async () => {
    const counts = {};
    for (const k of Object.keys(AUDIENCES)) counts[k] = (await recipients(k)).length;
    return { audiences: Object.entries(AUDIENCES).map(([key, label]) => ({ key, label, count: counts[key] })), vars: VARS };
  });
  adminRoute('GET', '/api/admin/campaigns', async () => {
    const list = await sql.unsafe('SELECT * FROM saas.campaigns ORDER BY id DESC LIMIT 200');
    const out = [];
    for (const c of list) out.push({ ...c, audience_label: AUDIENCES[c.audience] || c.audience, stats: c.status === 'rascunho' ? null : await stats(c.id) });
    return out;
  });
  adminRoute('POST', '/api/admin/campaigns', async (ctx) => {
    const v = validate(ctx.body);
    const [c] = await sql.unsafe('INSERT INTO saas.campaigns(name, audience, subject, body, button, button_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [v.name, v.audience, v.subject, v.body, v.button, v.button_url, ctx.admin.email]);
    await log(ctx, 'criou_campanha', v.name);
    return { id: c.id };
  });
  adminRoute('PUT', '/api/admin/campaigns/:id', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    if (c.status !== 'rascunho') fail('Esta campanha já foi enviada e não pode ser alterada. Duplique para fazer outra.');
    const v = validate(ctx.body);
    await sql.unsafe('UPDATE saas.campaigns SET name=$2, audience=$3, subject=$4, body=$5, button=$6, button_url=$7, updated_at=now() WHERE id=$1',
      [c.id, v.name, v.audience, v.subject, v.body, v.button, v.button_url]);
    return { ok: true };
  });
  adminRoute('DELETE', '/api/admin/campaigns/:id', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    if (c.status === 'enviando') fail('Esta campanha está sendo enviada. Pause antes de excluir.');
    await sql.unsafe('DELETE FROM saas.campaigns WHERE id=$1', [c.id]);
    await log(ctx, 'excluiu_campanha', c.name);
    return { ok: true };
  });
  adminRoute('POST', '/api/admin/campaigns/preview', async (ctx) => {
    const v = validate({ name: 'prévia', ...ctx.body });
    const msg = compose(v, { email: 'contato@exemplo.com.br', name: templates.SAMPLE.nome, clinic: templates.SAMPLE.clinica });
    return { subject: msg.subject, paragraphs: msg.paragraphs, button: msg.button };
  });
  adminRoute('POST', '/api/admin/campaigns/test', async (ctx) => {
    const v = validate({ name: 'teste', ...ctx.body });
    const to = String(ctx.body.to || ctx.admin.email).trim();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) fail('Informe um e-mail válido');
    const msg = compose(v, { email: to, name: templates.SAMPLE.nome, clinic: templates.SAMPLE.clinica });
    try { await mailer.send({ to, subject: `[Teste] ${msg.subject}`, text: msg.text, html: msg.html, listUnsubscribe: unsubscribeUrl(to) }); }
    catch (e) { throw new HttpError(502, e.message); }
    await log(ctx, 'testou_campanha', to);
    return { ok: true };
  });
  // começa o envio: congela a lista de destinatários e manda o primeiro lote
  adminRoute('POST', '/api/admin/campaigns/:id/send', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    if (c.status !== 'rascunho') fail('Esta campanha já foi enviada.');
    const list = await recipients(c.audience);
    if (!list.length) fail('Nenhum contato neste público aceitou receber novidades.');
    const upd = await sql.unsafe("UPDATE saas.campaigns SET status='enviando', started_at=now() WHERE id=$1 AND status='rascunho' RETURNING *", [c.id]);
    if (!upd.length) fail('Esta campanha já está sendo enviada.');
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      await sql.unsafe(`INSERT INTO saas.campaign_sends(campaign_id, email, name, clinic_name)
        SELECT $1, e, n, k FROM unnest($2::text[], $3::text[], $4::text[]) AS x(e, n, k) ON CONFLICT DO NOTHING`,
      [c.id, chunk.map((r) => r.email), chunk.map((r) => r.name), chunk.map((r) => r.clinic)]);
    }
    await log(ctx, 'enviou_campanha', c.name, { publico: c.audience, destinatarios: list.length });
    return work(upd[0], 8000);
  });
  adminRoute('POST', '/api/admin/campaigns/:id/continue', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    if (c.status !== 'enviando') return { ...(await stats(c.id)), done: true };
    return work(c);
  });
  // tenta de novo quem falhou
  adminRoute('POST', '/api/admin/campaigns/:id/retry', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    if (c.status === 'rascunho') fail('Esta campanha ainda não foi enviada.');
    const n = await sql.unsafe("UPDATE saas.campaign_sends SET status='pendente', error=NULL WHERE campaign_id=$1 AND status='falhou' RETURNING email", [c.id]);
    if (n.length) await sql.unsafe("UPDATE saas.campaigns SET status='enviando', finished_at=NULL WHERE id=$1", [c.id]);
    await log(ctx, 'reenviou_falhas_campanha', c.name, { quantidade: n.length });
    return work({ ...c, status: 'enviando' }, 8000);
  });
  adminRoute('POST', '/api/admin/campaigns/:id/duplicate', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    const [n] = await sql.unsafe(`INSERT INTO saas.campaigns(name, audience, subject, body, button, button_url, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [`${c.name} (cópia)`.slice(0, 120), c.audience, c.subject, c.body, c.button, c.button_url, ctx.admin.email]);
    return { id: n.id };
  });
  adminRoute('GET', '/api/admin/campaigns/:id/sends', async (ctx) => {
    const c = await getCampaign(ctx.params.id);
    return sql.unsafe("SELECT email, name, clinic_name, status, error, sent_at FROM saas.campaign_sends WHERE campaign_id=$1 ORDER BY (status='enviado'), email LIMIT 1000", [c.id]);
  });

  // rotina diária: retoma campanhas que ficaram no meio (ex.: a aba foi fechada durante o envio)
  async function continueAll() {
    for (const c of await sql.unsafe("SELECT * FROM saas.campaigns WHERE status='enviando' ORDER BY id")) {
      // destinatário que ficou 'enviando' (função interrompida no meio) volta para a fila
      await sql.unsafe("UPDATE saas.campaign_sends SET status='pendente' WHERE campaign_id=$1 AND status='enviando'", [c.id]);
      try { await work(c, 15000); } catch (e) { console.error('Campanha', c.id, e.message); }
    }
  }
  return { continueAll };
};

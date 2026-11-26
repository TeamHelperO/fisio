'use strict';
// Modelos dos e-mails automáticos da plataforma, editáveis no painel /admin → E-mails.
// Cada modelo tem assunto, texto (parágrafos separados por linha em branco) e, opcionalmente, um botão com link.
// Variáveis entre chaves duplas: {{nome}}, {{clinica}}… — só as listadas em cada modelo são aceitas.
const { sql, currentSql } = require('./core');

const DEFAULTS = {
  confirmar_email: {
    group: 'Conta e acesso', name: 'Confirmação de e-mail (cadastro)', when: 'Enviado quando alguém cria uma conta.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', validade: 'Validade do link (ex.: 48 horas)' }, link: true,
    subject: 'Confirme seu e-mail — FisioGestão',
    body: 'Olá, {{nome}}!\n\nSua conta no FisioGestão ({{clinica}}) foi criada. Falta só confirmar que este e-mail é seu.\n\nO link vale por {{validade}}. Se você não reconhece este cadastro, ignore esta mensagem.',
    button: 'Confirmar meu e-mail',
  },
  convite_usuario: {
    group: 'Conta e acesso', name: 'Novo usuário cadastrado pela clínica', when: 'Enviado quando o administrador da clínica cadastra um usuário ou muda o e-mail dele.',
    vars: { nome: 'Nome do usuário', clinica: 'Nome da clínica', convidado_por: 'Quem fez o cadastro', validade: 'Validade do link' }, link: true,
    subject: 'Você foi cadastrado no FisioGestão — {{clinica}}',
    body: 'Olá, {{nome}}!\n\n{{convidado_por}} cadastrou você no FisioGestão da clínica {{clinica}}. Confirme seu e-mail para começar.\n\nO link vale por {{validade}}. Se você não reconhece este cadastro, ignore esta mensagem.',
    button: 'Confirmar meu e-mail',
  },
  esqueci_senha: {
    group: 'Conta e acesso', name: 'Esqueci minha senha', when: 'Enviado quando alguém pede uma nova senha na tela de login.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', validade: 'Validade do link (ex.: 1 hora)' }, link: true,
    subject: 'Criar nova senha — FisioGestão',
    body: 'Olá, {{nome}}!\n\nRecebemos um pedido para criar uma nova senha da sua conta no FisioGestão ({{clinica}}).\n\nO link vale por {{validade}} e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha atual continua valendo.',
    button: 'Criar nova senha',
  },
  senha_alterada: {
    group: 'Conta e acesso', name: 'Senha alterada', when: 'Enviado logo depois que a senha é trocada pelo link de "Esqueci minha senha".',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica' }, link: true,
    subject: 'Sua senha foi alterada — FisioGestão',
    body: 'Olá, {{nome}}!\n\nA senha da sua conta no FisioGestão foi alterada agora. Por segurança, todas as sessões abertas foram encerradas.\n\nSe não foi você, fale imediatamente com o administrador da sua clínica.',
    button: 'Entrar no FisioGestão',
  },
  teste: {
    group: 'Conta e acesso', name: 'E-mail de teste', when: 'Enviado pelo botão "Enviar e-mail de teste" do painel.',
    vars: { servico: 'Serviço usado (SMTP ou Resend)', admin: 'Administrador que enviou' }, link: false,
    subject: 'Teste de e-mail — FisioGestão',
    body: 'Olá!\n\nEste é um e-mail de teste enviado pelo painel da plataforma FisioGestão.\n\nServiço: {{servico}}\nEnviado por: {{admin}}\n\nSe você recebeu esta mensagem, o envio de e-mails está funcionando.',
    button: '',
  },
  admin_esqueci_senha: {
    group: 'Administradores da plataforma', name: 'Admin: esqueci minha senha', when: 'Enviado quando um administrador do /admin pede uma nova senha.',
    vars: { nome: 'Nome do administrador', validade: 'Validade do link (ex.: 1 hora)' }, link: true,
    subject: 'Nova senha do painel administrativo — FisioGestão',
    body: 'Olá, {{nome}}!\n\nRecebemos um pedido para criar uma nova senha da sua conta de administrador da plataforma FisioGestão.\n\nO link vale por {{validade}} e só pode ser usado uma vez. A verificação em duas etapas continua valendo. Se não foi você, ignore este e-mail e avise os outros administradores.',
    button: 'Criar nova senha',
  },
  admin_senha_alterada: {
    group: 'Administradores da plataforma', name: 'Admin: senha alterada', when: 'Enviado logo depois que a senha de um administrador é trocada pelo link.',
    vars: { nome: 'Nome do administrador' }, link: true,
    subject: 'Sua senha do painel administrativo foi alterada',
    body: 'Olá, {{nome}}!\n\nA senha da sua conta de administrador da plataforma FisioGestão foi alterada agora. Todas as sessões abertas foram encerradas.\n\nSe não foi você, avise imediatamente os outros administradores.',
    button: 'Entrar no painel',
  },
  agendamento_novo_pedido: {
    group: 'Agendamento online', optional: true, name: 'Novo pedido de agendamento (para a clínica)',
    when: 'Enviado aos administradores e ao profissional quando um paciente pede um horário pela página de agendamento.',
    vars: { nome: 'Nome de quem recebe', clinica: 'Nome da clínica', paciente: 'Nome do paciente', telefone: 'Telefone do paciente', data: 'Data', hora: 'Hora', profissional: 'Profissional' }, link: true,
    subject: 'Novo pedido de agendamento: {{paciente}} em {{data}} às {{hora}}',
    body: 'Olá, {{nome}}!\n\n{{paciente}} pediu um horário pela página de agendamento online:\n{{data}} às {{hora}} com {{profissional}}.\nTelefone: {{telefone}}\n\nAbra a Agenda para aceitar ou recusar o pedido.',
    button: 'Ver pedidos na agenda',
  },
  agendamento_recebido: {
    group: 'Agendamento online', optional: true, name: 'Pedido recebido (para o paciente)',
    when: 'Enviado ao paciente logo depois do pedido, quando a clínica confirma cada horário.',
    vars: { nome: 'Nome do paciente', clinica: 'Nome da clínica', data: 'Data', hora: 'Hora', profissional: 'Profissional' }, link: false,
    subject: 'Recebemos seu pedido de horário — {{clinica}}',
    body: 'Olá, {{nome}}!\n\nRecebemos seu pedido de atendimento na {{clinica}} para {{data}} às {{hora}} com {{profissional}}.\n\nA clínica vai confirmar o horário e você receberá outro e-mail.',
    button: '',
  },
  agendamento_confirmado: {
    group: 'Agendamento online', optional: true, name: 'Horário confirmado (para o paciente)',
    when: 'Enviado ao paciente quando o horário é confirmado (na hora, ou quando a clínica aceita o pedido).',
    vars: { nome: 'Nome do paciente', clinica: 'Nome da clínica', data: 'Data', hora: 'Hora', profissional: 'Profissional', endereco: 'Endereço da clínica', telefone_clinica: 'Telefone da clínica' }, link: false,
    subject: 'Horário confirmado: {{data}} às {{hora}} — {{clinica}}',
    body: 'Olá, {{nome}}!\n\nSeu atendimento na {{clinica}} está confirmado para {{data}} às {{hora}} com {{profissional}}.\n\nEndereço: {{endereco}}\nTelefone: {{telefone_clinica}}\n\nSe não puder comparecer, avise a clínica com antecedência.',
    button: '',
  },
  agendamento_recusado: {
    group: 'Agendamento online', optional: true, name: 'Pedido não confirmado (para o paciente)',
    when: 'Enviado ao paciente quando a clínica recusa o pedido.',
    vars: { nome: 'Nome do paciente', clinica: 'Nome da clínica', data: 'Data', hora: 'Hora', motivo: 'Motivo informado pela clínica' }, link: true,
    subject: 'Não foi possível confirmar seu horário — {{clinica}}',
    body: 'Olá, {{nome}}!\n\nInfelizmente a {{clinica}} não pôde confirmar o horário de {{data}} às {{hora}}.\nMotivo: {{motivo}}\n\nVocê pode escolher outro horário pelo link abaixo.',
    button: 'Escolher outro horário',
  },
  assinatura_solicitada: {
    group: 'Assinatura digital', optional: true, name: 'Pedido de assinatura (para o paciente)',
    when: 'Enviado ao paciente quando a clínica gera um link de assinatura e escolhe "enviar por e-mail".',
    vars: { nome: 'Nome do paciente', clinica: 'Nome da clínica', documento: 'Nome do documento', validade: 'Validade do link' }, link: true,
    subject: 'Documento para assinar — {{clinica}}',
    body: 'Olá, {{nome}}!\n\nA {{clinica}} enviou o documento "{{documento}}" para você ler e assinar pelo celular.\n\nO link vale por {{validade}}. Se tiver dúvidas, fale com a clínica antes de assinar.',
    button: 'Ler e assinar',
  },
  assinatura_concluida: {
    group: 'Assinatura digital', optional: true, name: 'Documento assinado (para a clínica)',
    when: 'Enviado ao profissional que pediu a assinatura assim que o paciente assina.',
    vars: { nome: 'Nome do profissional', paciente: 'Nome do paciente', documento: 'Nome do documento', data: 'Data e hora da assinatura' }, link: true,
    subject: '{{paciente}} assinou: {{documento}}',
    body: 'Olá, {{nome}}!\n\n{{paciente}} assinou o documento "{{documento}}" em {{data}}.\n\nO comprovante com a assinatura e os dados de verificação está na ficha do paciente, aba LGPD.',
    button: 'Ver na ficha do paciente',
  },
  pagamento_link: {
    group: 'Pagamentos pelo app', optional: true, name: 'Link de pagamento (para o paciente)',
    when: 'Enviado ao paciente quando a clínica manda o link do Mercado Pago por e-mail.',
    vars: { nome: 'Nome do paciente', clinica: 'Nome da clínica', descricao: 'Descrição da cobrança', valor: 'Valor (ex.: R$ 150,00)', validade: 'Validade do link' }, link: true,
    subject: 'Pagamento — {{clinica}}',
    body: 'Olá, {{nome}}!\n\nSegue o link para pagar "{{descricao}}", no valor de {{valor}}, com Pix ou cartão pelo Mercado Pago.\n\nO link vale por {{validade}}. Assim que o pagamento for aprovado, a clínica recebe a confirmação automaticamente.',
    button: 'Pagar agora',
  },
  pagamento_recebido: {
    group: 'Pagamentos pelo app', optional: true, name: 'Pagamento recebido (para a clínica)',
    when: 'Enviado a quem gerou a cobrança (ou aos administradores da clínica) quando o paciente paga pelo link.',
    vars: { nome: 'Nome de quem recebe o aviso', paciente: 'Nome do paciente', descricao: 'Descrição da cobrança', valor: 'Valor pago', forma: 'Forma de pagamento' }, link: true,
    subject: 'Pagamento recebido: {{paciente}} — {{valor}}',
    body: 'Olá, {{nome}}!\n\n{{paciente}} pagou {{valor}} por {{forma}} referente a "{{descricao}}".\n\nO lançamento já está como pago no Financeiro, com o recibo.',
    button: 'Abrir o Financeiro',
  },
  boas_vindas: {
    group: 'Ciclo do cliente', optional: true, name: 'Boas-vindas com primeiros passos',
    when: 'Enviado uma vez, cerca de 1 hora depois do cadastro da clínica.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', dias: 'Dias de teste grátis restantes', data_fim: 'Data em que o teste termina' }, link: true,
    subject: 'Boas-vindas ao FisioGestão, {{nome}}!',
    body: 'Olá, {{nome}}!\n\nQue bom ter a {{clinica}} no FisioGestão. Você tem {{dias}} dias de teste grátis, até {{data_fim}}.\n\nPara começar com o pé direito:\n1. Cadastre seu primeiro paciente.\n2. Registre a anamnese e a avaliação.\n3. Monte um programa de exercícios e gere a folha para o paciente levar para casa.\n4. Organize a agenda da semana.\n\nQualquer dúvida, é só responder pelo nosso suporte.',
    button: 'Abrir o FisioGestão',
  },
  trial_3_dias: {
    group: 'Ciclo do cliente', optional: true, name: 'Teste grátis: faltam 3 dias',
    when: 'Enviado 3 dias antes do fim do teste grátis, se a clínica ainda não assinou.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', dias: 'Dias restantes', data_fim: 'Data em que o teste termina' }, link: true,
    subject: 'Seu teste grátis termina em {{dias}} dias',
    body: 'Olá, {{nome}}!\n\nO teste grátis da {{clinica}} no FisioGestão termina em {{dias}} dias, no dia {{data_fim}}.\n\nPara continuar registrando atendimentos sem interrupção, assine agora. Seus pacientes, prontuários e agenda continuam exatamente onde estão.',
    button: 'Assinar o FisioGestão',
  },
  trial_ultimo_dia: {
    group: 'Ciclo do cliente', optional: true, name: 'Teste grátis: último dia',
    when: 'Enviado no último dia do teste grátis, se a clínica ainda não assinou.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', data_fim: 'Data em que o teste termina' }, link: true,
    subject: 'Último dia do seu teste grátis',
    body: 'Olá, {{nome}}!\n\nHoje é o último dia do teste grátis da {{clinica}} ({{data_fim}}).\n\nAssine para continuar usando o FisioGestão sem interrupção. Leva menos de 2 minutos.',
    button: 'Assinar agora',
  },
  trial_terminou: {
    group: 'Ciclo do cliente', optional: true, name: 'Teste grátis terminou',
    when: 'Enviado quando o teste grátis termina sem assinatura.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', data_fim: 'Data em que o teste terminou' }, link: true,
    subject: 'Seu teste grátis terminou — seus dados estão guardados',
    body: 'Olá, {{nome}}!\n\nO teste grátis da {{clinica}} terminou em {{data_fim}}.\n\nSeus dados continuam guardados e disponíveis para consulta e exportação. Para voltar a registrar atendimentos, é só assinar.',
    button: 'Assinar o FisioGestão',
  },
  assinatura_confirmada: {
    group: 'Ciclo do cliente', optional: true, name: 'Assinatura confirmada',
    when: 'Enviado quando o primeiro pagamento da assinatura é aprovado.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', proxima_cobranca: 'Data da próxima cobrança' }, link: true,
    subject: 'Assinatura confirmada — obrigado!',
    body: 'Olá, {{nome}}!\n\nA assinatura da {{clinica}} no FisioGestão está ativa. Obrigado pela confiança!\n\nPróxima cobrança: {{proxima_cobranca}}. Você pode acompanhar e gerenciar a assinatura em Configurações → Assinatura.',
    button: 'Abrir o FisioGestão',
  },
  pagamento_recusado: {
    group: 'Ciclo do cliente', optional: true, name: 'Pagamento recusado',
    when: 'Enviado quando a cobrança da assinatura não é aprovada.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica' }, link: true,
    subject: 'Não conseguimos cobrar a assinatura da {{clinica}}',
    body: 'Olá, {{nome}}!\n\nA cobrança da assinatura da {{clinica}} no FisioGestão não foi aprovada. Vamos tentar de novo nos próximos dias, mas para não correr o risco de perder o acesso, confira ou troque a forma de pagamento.\n\nSe já resolveu, pode ignorar esta mensagem.',
    button: 'Atualizar forma de pagamento',
  },
  assinatura_cancelada: {
    group: 'Ciclo do cliente', optional: true, name: 'Assinatura cancelada',
    when: 'Enviado quando a assinatura é cancelada.',
    vars: { nome: 'Nome da pessoa', clinica: 'Nome da clínica', acesso_ate: 'Até quando o acesso completo continua' }, link: true,
    subject: 'Sua assinatura foi cancelada',
    body: 'Olá, {{nome}}!\n\nA assinatura da {{clinica}} no FisioGestão foi cancelada. O acesso completo continua até {{acesso_ate}}; depois disso os dados ficam disponíveis para consulta e exportação.\n\nSe mudar de ideia, é só assinar de novo — nada se perde.',
    button: 'Ver minha assinatura',
  },
};
// valores de exemplo para a prévia e para o envio de teste de um modelo
const SAMPLE = { nome: 'Ana Souza', clinica: 'Clínica Movimento', validade: '48 horas', convidado_por: 'Dra. Helena Prado', servico: 'SMTP', admin: 'Administrador',
  dias: '3', data_fim: '27/11/2026', proxima_cobranca: '24/12/2026', acesso_ate: '24/12/2026',
  paciente: 'João Pereira', telefone: '(11) 98888-7777', data: '02/12/2026', hora: '14:00', profissional: 'Dra. Helena Prado',
  endereco: 'Rua das Flores, 100 — Centro', telefone_clinica: '(11) 3333-4444', motivo: 'O horário não está mais disponível.',
  documento: 'Termo de consentimento — LGPD (v1.0)' };

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function check(key, t) {
  const d = DEFAULTS[key];
  const subject = String(t.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  const body = String(t.body ?? '').replace(/\r\n/g, '\n').trim();
  const button = String(t.button ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw Object.assign(new Error('O assunto não pode ficar vazio'), { status: 400 });
  if (subject.length > 200) throw Object.assign(new Error('Assunto muito longo (máx. 200 caracteres)'), { status: 400 });
  if (!body) throw Object.assign(new Error('O texto não pode ficar vazio'), { status: 400 });
  if (body.length > 5000) throw Object.assign(new Error('Texto muito longo (máx. 5.000 caracteres)'), { status: 400 });
  if (button.length > 60) throw Object.assign(new Error('Texto do botão muito longo (máx. 60 caracteres)'), { status: 400 });
  if (d.link && !button) throw Object.assign(new Error('Este e-mail precisa de um botão com o link — informe o texto do botão'), { status: 400 });
  const unknown = [...new Set([...`${subject} ${body} ${button}`.matchAll(VAR_RE)].map((m) => m[1]).filter((v) => !(v in d.vars)))];
  if (unknown.length) throw Object.assign(new Error(`Variável desconhecida neste modelo: ${unknown.map((v) => `{{${v}}}`).join(', ')}`), { status: 400 });
  return { subject, body, button: d.link ? button : '' };
}

async function load(key) {
  const d = DEFAULTS[key];
  if (!d) throw new Error(`Modelo de e-mail desconhecido: ${key}`);
  const row = (await currentSql().unsafe('SELECT * FROM saas.email_templates WHERE key=$1', [key]))[0];
  return merge(key, row);
}
// junta o texto padrão com o que foi salvo no painel (row pode não existir)
function merge(key, row) {
  const d = DEFAULTS[key];
  return { ...d, key, subject: row?.subject ?? d.subject, body: row?.body ?? d.body, button: row?.button ?? d.button,
    enabled: d.optional ? (row ? row.enabled !== false : true) : true,
    customized: !!row && (row.subject !== d.subject || row.body !== d.body || row.button !== d.button), updated_at: row?.updated_at || null, updated_by: row?.updated_by || null };
}

// Monta o e-mail final (assunto, texto puro e HTML) a partir do modelo e das variáveis
function compose(t, vars, url, { footer = null } = {}) {
  const fill = (s, html) => s.replace(VAR_RE, (_, v) => (html ? esc(vars[v] ?? '') : String(vars[v] ?? '')));
  const subject = fill(t.subject, false).replace(/[\r\n]+/g, ' ').trim();
  const paragraphs = t.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const text = paragraphs.map((p) => fill(p, false)).join('\n\n') + (url ? `\n\n${fill(t.button || 'Abrir', false)}: ${url}` : '')
    + (footer ? `\n\n--\n${footer.text}: ${footer.url}` : '');
  const ps = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#17232d">${fill(esc(p), true).replace(/\n/g, '<br>')}</p>`).join('');
  const btn = url ? `<p style="margin:22px 0"><a href="${esc(url)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(fill(t.button || 'Abrir', false))}</a></p>
<p style="margin:0;font-size:12px;color:#64737f">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all">${esc(url)}</span></p>` : '';
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f6f8;font-family:Segoe UI,Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:28px 16px">
<div style="font-weight:bold;font-size:18px;color:#0f766e;margin-bottom:16px">FisioGestão</div>
<div style="background:#fff;border:1px solid #e3e8ec;border-radius:12px;padding:24px">${ps}${btn}</div>
${footer ? `<p style="font-size:12px;color:#64737f;margin-top:16px">${esc(footer.text)}: <a href="${esc(footer.url)}" style="color:#64737f">descadastrar</a></p>` : '<p style="font-size:12px;color:#64737f;margin-top:16px">Mensagem automática do FisioGestão. Não responda a este e-mail.</p>'}</div></body></html>`;
  return { subject, text, html, paragraphs: paragraphs.map((p) => fill(p, false)), button: url ? fill(t.button || 'Abrir', false) : null };
}

// Usado pelo sistema: render('esqueci_senha', { nome, clinica, validade }, url)
async function render(key, vars, url) {
  return compose(await load(key), vars, url);
}
async function list() {
  // uma consulta só (várias consultas simultâneas na mesma conexão travam o pooler do Supabase)
  const rows = Object.fromEntries((await currentSql().unsafe('SELECT * FROM saas.email_templates')).map((r) => [r.key, r]));
  return Object.keys(DEFAULTS).map((k) => {
    const t = merge(k, rows[k]);
    return { key: k, group: t.group, optional: !!t.optional, enabled: t.enabled, name: t.name, when: t.when, vars: t.vars, link: t.link, subject: t.subject, body: t.body, button: t.button,
      customized: t.customized, updated_at: t.updated_at, updated_by: t.updated_by };
  });
}
async function save(key, t, by) {
  if (!DEFAULTS[key]) throw Object.assign(new Error('Modelo desconhecido'), { status: 404 });
  const v = check(key, t);
  const enabled = DEFAULTS[key].optional ? t.enabled !== false : true;
  await sql.unsafe(`INSERT INTO saas.email_templates(key, subject, body, button, enabled, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (key) DO UPDATE SET subject=excluded.subject, body=excluded.body, button=excluded.button, enabled=excluded.enabled, updated_at=now(), updated_by=excluded.updated_by`,
  [key, v.subject, v.body, v.button, enabled, by]);
}
async function reset(key) {
  if (!DEFAULTS[key]) throw Object.assign(new Error('Modelo desconhecido'), { status: 404 });
  // volta o texto ao padrão, mas mantém a escolha de ligado/desligado
  const row = (await sql.unsafe('SELECT enabled FROM saas.email_templates WHERE key=$1', [key]))[0];
  if (row && row.enabled === false) {
    const d = DEFAULTS[key];
    await sql.unsafe('UPDATE saas.email_templates SET subject=$2, body=$3, button=$4, updated_at=now() WHERE key=$1', [key, d.subject, d.body, d.button]);
  } else await sql.unsafe('DELETE FROM saas.email_templates WHERE key=$1', [key]);
}
// liga/desliga um modelo opcional sem mexer no texto
async function setEnabled(key, enabled, by) {
  const d = DEFAULTS[key];
  if (!d) throw Object.assign(new Error('Modelo desconhecido'), { status: 404 });
  if (!d.optional) throw Object.assign(new Error('Este e-mail é essencial e não pode ser desligado'), { status: 400 });
  const t = await load(key);
  await sql.unsafe(`INSERT INTO saas.email_templates(key, subject, body, button, enabled, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (key) DO UPDATE SET enabled=excluded.enabled, updated_at=now(), updated_by=excluded.updated_by`, [key, t.subject, t.body, t.button, !!enabled, by]);
}
async function isEnabled(key) { return (await load(key)).enabled; }
// prévia de um texto ainda não salvo, com dados de exemplo
function preview(key, t) {
  if (!DEFAULTS[key]) throw Object.assign(new Error('Modelo desconhecido'), { status: 404 });
  const v = check(key, t);
  return compose({ ...DEFAULTS[key], ...v }, SAMPLE, DEFAULTS[key].link ? 'https://app.exemplo.com.br/#/link-de-exemplo' : null);
}

module.exports = { DEFAULTS, SAMPLE, render, list, save, reset, preview, check, setEnabled, isEnabled, compose, VAR_RE };

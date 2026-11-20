import { h, icon, toast, buildForm, badge, fmtDT, empty, LABELS, modal, downloadFile, csvCell } from '../ui.js';
import { get, post, put, qs } from '../api.js';
import { state, isAdmin, reloadSettings } from '../state.js';


const refresh = () => dispatchEvent(new Event('fisio:refresh'));

export async function settingsPage(view, [tab]) {
  const tabs = [['perfil', 'Profissional e clínica', true], ['usuarios', 'Usuários e acesso', true], ['seguranca', 'Minha conta'], ['lgpd', 'LGPD', true], ['backup', 'Backup', true], ['auditoria', 'Registro de alterações', true]]
    .filter((t) => !t[2] || isAdmin());
  tab = tab || tabs[0][0];
  const body = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Configurações'), h('p', null, 'Dados do profissional, usuários, segurança, privacidade e backup.'))),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { href: `#/configuracoes/${k}`, class: k === tab ? 'on' : '' }, l))), body);
  const T = { perfil, usuarios, seguranca, lgpd, backup, auditoria };
  if (!tabs.find((t) => t[0] === tab)) return body.append(h('div', { class: 'notice' }, icon('shield'), 'Acesso restrito ao administrador.'));
  await T[tab](body);
}

async function perfil(body) {
  const form = buildForm([
    { type: 'section', label: 'Identificação nos documentos' },
    { key: 'professional_name', label: 'Nome do profissional responsável', span: true },
    { key: 'crefito', label: 'CREFITO' },
    { key: 'professional_cpf', label: 'CPF do profissional', mask: 'cpf', help: 'Exibido nos recibos (exigido para dedução no IR do paciente).' },
    { key: 'clinic_name', label: 'Nome da clínica / consultório (opcional)', span: true },
    { key: 'phone', label: 'Telefone', mask: 'phone' },
    { key: 'email', label: 'E-mail', type: 'email' },
    { key: 'address', label: 'Endereço', span: true },
    { key: 'city', label: 'Cidade/UF (para local e data nos documentos)' },
  ], state.settings);
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, form,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: async () => {
      try { await put('/settings', form.getValues()); await reloadSettings(); toast('Configurações salvas'); } catch (e) { toast(e.message, 'error'); }
    } }, icon('check', 16), 'Salvar')))));
}

async function usuarios(body) {
  const users = await get('/users');
  const edit = (u = {}) => {
    const form = buildForm([
      { key: 'name', label: 'Nome completo', required: true, span: true },
      { key: 'email', label: 'E-mail (login)', type: 'email', required: true },
      { key: 'role', label: 'Perfil de acesso', type: 'select', options: Object.entries(LABELS.role), empty: false, default: 'fisio' },
      { key: 'crefito', label: 'CREFITO (fisioterapeutas)' },
      { key: 'password', label: u.id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial', type: 'password', required: !u.id, autocomplete: 'new-password', help: 'Mínimo 8 caracteres, com letras e números.' },
    ], { ...u, password: '' });
    const m = modal({ title: u.id ? 'Editar usuário' : 'Novo usuário', body: h('div', { class: 'stack' }, form,
      h('div', { class: 'notice info' }, icon('shield'), h('div', null, h('b', null, 'Perfis: '), 'Administrador — acesso total. Fisioterapeuta — prontuários dos pacientes sob sua responsabilidade, agenda e financeiro. Recepção — cadastro, agenda e financeiro, sem acesso a dados clínicos.'))),
    actions: [
      u.id && u.id !== state.user.id ? h('button', { class: 'btn ghost', style: { marginRight: 'auto' }, onclick: async () => { try { await put(`/users/${u.id}`, { active: !u.active }); m.close(); toast(u.active ? 'Usuário desativado' : 'Usuário reativado'); refresh(); } catch (e) { toast(e.message, 'error'); } } }, u.active ? 'Desativar acesso' : 'Reativar acesso') : null,
      h('button', { class: 'btn primary', onclick: async () => {
        if (!form.validate()) return; const v = form.getValues(); if (!v.password) delete v.password;
        try { u.id ? await put(`/users/${u.id}`, v) : await post('/users', v); m.close(); toast('Usuário salvo'); state.professionals = (await get('/users')).filter((x) => x.role !== 'recepcao' && x.active); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Salvar')] });
  };
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Usuários'), h('button', { class: 'btn primary sm', onclick: () => edit() }, icon('plus', 15), 'Novo usuário')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Nome', 'E-mail', 'Perfil', 'CREFITO', 'Último acesso', 'Situação'].map((t) => h('th', null, t)))),
      h('tbody', null, users.map((u) => h('tr', { class: 'click', onclick: () => edit(u) }, h('td', null, h('b', null, u.name)), h('td', null, u.email), h('td', null, LABELS.role[u.role]), h('td', null, u.crefito || '—'),
        h('td', null, u.last_login ? fmtDT(u.last_login.replace(' ', 'T')) : 'Nunca'), h('td', null, u.active ? badge('ativo') : badge('inativo', 'status')))))))));
}

async function seguranca(body) {
  const form = buildForm([
    { key: 'current', label: 'Senha atual', type: 'password', required: true, autocomplete: 'current-password' },
    { key: 'password', label: 'Nova senha', type: 'password', required: true, autocomplete: 'new-password', help: 'Mínimo 8 caracteres, com letras e números.' },
    { key: 'password2', label: 'Confirmar nova senha', type: 'password', required: true, autocomplete: 'new-password' },
  ], {}, { cols: 1 });
  body.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Alterar senha')), h('div', { class: 'card-body stack' }, form,
      h('button', { class: 'btn primary', onclick: async () => {
        if (!form.validate()) return; const v = form.getValues();
        if (v.password !== v.password2) return toast('As senhas não conferem', 'error');
        try { await post('/me/password', v); toast('Senha alterada. Outras sessões foram encerradas.'); refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Alterar senha'))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Medidas de segurança ativas')), h('div', { class: 'card-body' },
      h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '8px' } },
        ['Login individual com senha protegida por hash (scrypt)', 'Bloqueio temporário após 5 tentativas de login incorretas', 'Sessão expira após 10 horas de inatividade',
          'Registros clínicos criptografados no banco (AES-256-GCM)', 'Controle de acesso por perfil e por profissional responsável',
          'Registro de acessos e alterações (auditoria) com histórico de versões dos registros clínicos', 'Backup automático diário + backup antes de exclusões',
          'Proteções contra XSS, CSRF e clickjacking (cabeçalhos de segurança)'].map((t) => h('li', null, t)))))));
}

async function lgpd(body) {
  const form = buildForm([
    { key: 'consent_version', label: 'Versão do termo', help: 'Ao alterar o texto, a versão é incrementada automaticamente.' },
    { key: 'consent_text', label: 'Texto do Termo de Consentimento (LGPD)', type: 'textarea', rows: 18 },
  ], state.settings, { cols: 1 });
  body.append(h('div', { class: 'stack' },
    h('div', { class: 'notice info' }, icon('shield'), h('div', null, 'Dados de saúde são dados pessoais sensíveis (LGPD, art. 5º, II e art. 11). O sistema registra o consentimento de cada paciente com data, versão do termo e responsável pelo registro, permite revogação, exportação (portabilidade) e mantém trilha de auditoria. ',
      h('b', null, 'Revise o termo com sua assessoria jurídica antes de usar.'))),
    h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, form, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { class: 'btn primary', onclick: async () => { try { await put('/settings', form.getValues()); await reloadSettings(); toast('Termo atualizado'); refresh(); } catch (e) { toast(e.message, 'error'); } } }, icon('check', 16), 'Salvar termo'))))));
}

async function backup(body) {
  const list = await get('/backups');
  const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
  const download = async (name) => {
    const res = await fetch(`/api/backups/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
    if (!res.ok) return toast('Falha ao baixar backup', 'error');
    downloadFile(name, await res.blob());
  };
  body.append(h('div', { class: 'stack' },
    h('div', { class: 'notice info' }, icon('shield'), h('div', null, 'Um backup automático é criado diariamente na pasta ', h('code', null, 'data/backups'), ' do servidor (são mantidos os 30 mais recentes). Guarde cópias também fora do computador (HD externo ou nuvem criptografada). ',
      h('b', null, 'Importante: '), 'os registros clínicos são criptografados com a chave ', h('code', null, 'data/secret.key'), ' — guarde uma cópia dessa chave em local seguro e separado; sem ela os backups não podem ser lidos.')),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Backups disponíveis'),
      h('button', { class: 'btn primary sm', onclick: async () => { try { const r = await post('/backups'); toast(`Backup criado: ${r.name}`); refresh(); } catch (e) { toast(e.message, 'error'); } } }, icon('download', 15), 'Criar backup agora')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Arquivo', 'Data', 'Tamanho', ''].map((t) => h('th', null, t)))),
      h('tbody', null, list.map((b) => h('tr', null, h('td', null, b.name), h('td', null, new Date(b.mtime).toLocaleString('pt-BR')), h('td', null, fmtSize(b.size)),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => download(b.name) }, icon('download', 14), 'Baixar')))))))
      : empty('Nenhum backup ainda.')),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Como restaurar')), h('div', { class: 'card-body' },
      h('ol', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '6px' } },
        h('li', null, 'Pare o servidor.'), h('li', null, 'Copie o arquivo de backup para data/fisio.sqlite (substituindo o atual; apague fisio.sqlite-wal e fisio.sqlite-shm, se existirem).'),
        h('li', null, 'Garanta que data/secret.key é a mesma chave usada quando o backup foi criado.'), h('li', null, 'Inicie o servidor novamente.'))))));
}

async function auditoria(body) {
  const users = await get('/users');
  const userSel = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'Todos os usuários'), users.map((u) => h('option', { value: u.id }, u.name)));
  const from = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  const to = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  const wrap = h('div');
  let rows = [];
  const load = async () => {
    rows = await get('/audit' + qs({ user_id: userSel.value, from: from.value, to: to.value }));
    wrap.replaceChildren(rows.length ? h('div', { class: 'table-wrap', style: { maxHeight: '65vh', overflowY: 'auto' } }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Data/hora', 'Usuário', 'Ação', 'Item', 'Paciente', 'Detalhes', 'IP'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((l) => h('tr', null, h('td', { class: 'nowrap' }, fmtDT(l.ts.replace(' ', 'T'))), h('td', null, l.user_name || '—'), h('td', null, l.action.replace(/_/g, ' ')),
        h('td', null, `${LABELS.record[l.entity] || l.entity || ''}${l.entity_id ? ' #' + l.entity_id : ''}`), h('td', null, l.patient_id ? h('a', { href: `#/pacientes/${l.patient_id}` }, `#${l.patient_id}`) : '—'),
        h('td', { style: { maxWidth: '280px', fontSize: '12px', color: 'var(--muted)', wordBreak: 'break-all' } }, l.details || ''), h('td', { style: { fontSize: '12px' } }, l.ip || '')))))) : empty('Nenhum evento no período.'));
  };
  [userSel, from, to].forEach((el) => (el.onchange = load));
  const exportCsv = () => {
    const esc = csvCell;
    downloadFile('auditoria.csv', '﻿' + [['Data/hora', 'Usuário', 'Ação', 'Entidade', 'ID', 'Paciente', 'Detalhes', 'IP'].map(esc).join(';'),
      ...rows.map((l) => [l.ts, l.user_name, l.action, l.entity, l.entity_id, l.patient_id, l.details, l.ip].map(esc).join(';'))].join('\r\n'), 'text/csv;charset=utf-8');
  };
  body.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'row' }, userSel, from, h('span', null, 'a'), to), h('button', { class: 'btn sm', onclick: exportCsv }, icon('download', 14), 'Exportar CSV')), wrap));
  await load();
}

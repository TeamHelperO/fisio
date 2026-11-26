// Portal do paciente. /paciente (entrar com e-mail e senha), /paciente/<código> (link pessoal),
// /paciente/cadastro/<código da clínica> (cadastro) e /paciente/senha/<código> (criar senha).
// Consultas, pagamentos, documentos, exercícios e diário de dor.
import { h, icon, toast, modal } from './ui.js';

const root = document.getElementById('root');
const show = (...els) => root.replaceChildren(...els.flat().filter(Boolean));
let parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
let token = parts[1] || '';
const pub = async (path, body) => {
  const res = await fetch(`/api/public/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fisio' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Não foi possível concluir. Tente novamente.'), { status: res.status });
  return data;
};
const api = async (path = '', body) => {
  const res = await fetch(`/api/portal/${encodeURIComponent(token)}${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fisio' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Não foi possível carregar. Tente novamente.'), { status: res.status });
  return data;
};
const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dayLabel = (d) => { const x = new Date(`${d.slice(0, 10)}T12:00`); return `${WD[x.getDay()]}, ${x.getDate()} de ${MO[x.getMonth()]}`; };
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const section = (title, ic, ...body) => h('section', { class: 'bk-card' }, h('h2', null, icon(ic, 17), title), ...body);
const PAIN_COLOR = (n) => (n <= 3 ? '#16a34a' : n <= 6 ? '#d97706' : '#dc2626');
const isImage = (u) => /\.(gif|png|jpe?g|webp)(\?|$)/i.test(u || '');

// Pix dentro do portal: QR Code + "copia e cola"; a tela confere sozinha até o pagamento ser aprovado
async function pixModal(c, onPaid) {
  let pix;
  try { pix = await api(`/pix/${c.id}`, {}); } catch (e) { return toast(e.message, 'error'); }
  const status = h('div', { class: 'pt-pix-status' }, h('span', { class: 'pt-dot' }), 'Aguardando o pagamento…');
  const left = h('small', { class: 'pt-sub' });
  const code = h('textarea', { class: 'input pt-pix-code', readOnly: true, rows: 3, onfocus: (e) => e.target.select() }); code.value = pix.code;
  const copy = h('button', { class: 'btn primary', style: { width: '100%' }, onclick: async () => {
    try { await navigator.clipboard.writeText(pix.code); copy.textContent = 'Código copiado!'; setTimeout(() => { copy.textContent = 'Copiar código Pix'; }, 2500); }
    catch { code.focus(); code.select(); toast('Selecione e copie o código acima', 'error'); }
  } }, 'Copiar código Pix');
  const body = h('div', { class: 'stack pt-pix' },
    h('div', { class: 'pt-sub', style: { textAlign: 'center' } }, pix.description),
    h('div', { style: { fontSize: '26px', fontWeight: 700, textAlign: 'center' } }, brl(pix.amount)),
    pix.qr ? h('img', { class: 'pt-pix-qr', src: pix.qr, alt: 'QR Code Pix' }) : null,
    h('ol', { class: 'pt-steps' }, h('li', null, 'Abra o app do seu banco e escolha Pix.'), h('li', null, pix.qr ? 'Leia o QR Code ou use o "Pix copia e cola" com o código abaixo.' : 'Use o "Pix copia e cola" com o código abaixo.'), h('li', null, 'Confirme o pagamento. Esta tela atualiza sozinha.')),
    code, copy, status, left);
  let stop = false; let timer = null;
  const m = modal({ title: 'Pagar com Pix', body, onClose: () => { stop = true; clearTimeout(timer); } });
  const exp = new Date(pix.expires_at).getTime();
  const tick = async () => {
    if (stop) return;
    const ms = exp - Date.now();
    if (ms <= 0) { status.replaceChildren('Este código Pix venceu. Feche e gere um novo.'); status.classList.add('off'); return; }
    left.textContent = `O código vale por mais ${Math.floor(ms / 60000)} min ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} s.`;
    try {
      const r = await api(`/pix/${c.id}`);
      if (r.status === 'pago') {
        stop = true;
        body.replaceChildren(h('div', { class: 'bk-done', style: { padding: '10px 0' } }, h('div', { class: 'bk-logo' }, icon('check', 26)),
          h('h2', { style: { justifyContent: 'center' } }, 'Pagamento aprovado!'), h('p', { class: 'bk-empty' }, `Obrigado. ${r.receipt_number ? `Recibo nº ${r.receipt_number}.` : ''} A clínica já recebeu a confirmação.`),
          h('button', { class: 'btn primary', onclick: () => { m.close(); onPaid(); } }, 'Fechar')));
        return;
      }
    } catch { /* sem conexão: tenta de novo */ }
    timer = setTimeout(tick, 4000);
  };
  tick();
}

function fail(msg) {
  show(h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon('alert', 26)),
    h('h1', { style: { fontSize: '20px', margin: '0 0 8px' } }, 'Link indisponível'), h('p', { class: 'bk-empty' }, msg)));
}

const field = (label, input, help) => h('label', { class: 'field' }, h('span', null, label), input, help ? h('small', { class: 'help' }, help) : null);
const card = (...c) => h('section', { class: 'bk-card' }, ...c);
const headBox = (title, sub) => h('div', { class: 'bk-head' }, h('div', { class: 'bk-logo' }, icon('activity', 24)), h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null));
const done = (title, text) => show(h('div', { class: 'bk-card bk-done' }, h('div', { class: 'bk-logo' }, icon('check', 26)),
  h('h1', { style: { fontSize: '20px', margin: '0 0 8px' } }, title), h('p', { class: 'bk-empty' }, text)));

function loginScreen(msg) {
  history.replaceState(null, '', '/paciente'); parts = ['paciente'];
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '12px' } }, 'Entrar');
  const choose = h('div');
  const submit = async (accountId) => {
    btn.disabled = true;
    try {
      const r = await pub('portal-login', { email: email.value, password: pass.value, account_id: accountId });
      if (r.choose) {
        choose.replaceChildren(h('p', { class: 'pt-sub' }, 'Você tem cadastro em mais de uma clínica. Qual quer abrir?'),
          h('div', { class: 'pt-list' }, r.choose.map((c) => h('button', { type: 'button', class: 'btn', onclick: () => submit(c.id) }, c.clinic))));
        btn.disabled = false; return;
      }
      token = 'eu'; main();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  show(headBox('Portal do paciente', 'Entre para ver suas consultas, exercícios e pagamentos'),
    msg ? h('div', { class: 'notice info', style: { marginBottom: '12px' } }, icon('check'), h('span', null, msg)) : null,
    card(h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); submit(); } },
      field('E-mail', email), field('Senha', pass), btn, choose,
      h('a', { href: '#', style: { textAlign: 'center', fontSize: '14px' }, onclick: (e) => { e.preventDefault(); forgotScreen(email.value); } }, 'Esqueci minha senha / primeiro acesso'))),
    h('p', { class: 'bk-foot' }, 'Ainda não tem cadastro? Peça à sua clínica o link de cadastro.'));
}
function forgotScreen(prefill = '') {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true, value: prefill });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '12px' } }, 'Enviar link');
  show(headBox('Criar ou trocar a senha', 'Enviamos um link para o e-mail cadastrado na clínica'),
    card(h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      try { const r = await pub('portal-forgot', { email: email.value }); done('Confira seu e-mail', r.message); } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    } }, field('E-mail', email), btn,
    h('a', { href: '#', style: { textAlign: 'center', fontSize: '14px' }, onclick: (e) => { e.preventDefault(); loginScreen(); } }, '← Voltar para entrar'))));
}
async function passwordScreen(code) {
  let info;
  try { info = await pub(`portal-password/${encodeURIComponent(code)}`); } catch (e) { return fail(e.message); }
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minLength: 8, required: true });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minLength: 8, required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '12px' } }, 'Salvar senha e entrar');
  show(headBox(`Olá, ${info.first_name}!`, `Crie sua senha do portal da ${info.clinic}`),
    card(h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) return toast('As senhas não são iguais', 'error');
      btn.disabled = true;
      try { await pub(`portal-password/${encodeURIComponent(code)}`, { password: p1.value }); history.replaceState(null, '', '/paciente'); parts = ['paciente']; token = 'eu'; main(); }
      catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    } }, h('div', { class: 'bk-summary' }, 'Seu e-mail de acesso: ', h('b', null, info.email)),
    field('Nova senha', p1, 'Pelo menos 8 caracteres, com letras e números.'), field('Repita a senha', p2), btn)));
}
async function signupScreen(code) {
  let info;
  try { info = await pub(`portal-signup/${encodeURIComponent(code)}`); } catch (e) { return fail(e.message); }
  document.title = `Cadastro — ${info.clinic}`;
  const inp = (attrs) => h('input', { class: 'input', ...attrs });
  const f = { name: inp({ autocomplete: 'name', required: true, maxLength: 160 }), birth_date: inp({ type: 'date' }), cpf: inp({ inputmode: 'numeric', maxLength: 14, placeholder: 'opcional' }),
    phone: inp({ type: 'tel', autocomplete: 'tel', required: true, placeholder: '(11) 99999-9999' }), email: inp({ type: 'email', autocomplete: 'email', required: true }) };
  const hp = h('input', { name: 'website', tabIndex: -1, autocomplete: 'off' });
  const agree = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '12px' } }, 'Cadastrar');
  show(headBox(info.clinic, 'Cadastro de paciente'),
    card(h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      if (!agree.checked) return toast('Leia e aceite o termo de consentimento', 'error');
      btn.disabled = true;
      try {
        const r = await pub(`portal-signup/${encodeURIComponent(code)}`, { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])), consent: true, website: hp.value });
        done('Cadastro recebido!', `Enviamos um e-mail para ${r.email} com o link para criar sua senha do portal. Confira também a caixa de spam.`);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    } },
    field('Nome completo', f.name), field('Data de nascimento', f.birth_date), field('CPF', f.cpf), field('Telefone / WhatsApp', f.phone), field('E-mail', f.email, 'Você vai receber neste e-mail o link para criar sua senha.'),
    h('div', { class: 'bk-hp', 'aria-hidden': 'true' }, hp),
    h('details', { class: 'pt-details' }, h('summary', null, `Ler o termo de consentimento (LGPD, v${info.consent_version})`),
      h('div', { style: { whiteSpace: 'pre-line', fontSize: '13px', maxHeight: '260px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px' } }, info.consent_text)),
    h('label', { class: 'bk-consent' }, agree, h('span', null, 'Li e aceito o termo de consentimento para o tratamento dos meus dados pessoais e de saúde pela clínica.')),
    btn)));
}

async function main() {
  if (parts[1] === 'cadastro') return signupScreen(parts[2] || '');
  if (parts[1] === 'senha') return passwordScreen(parts[2] || '');
  if (!token || token === 'entrar') token = 'eu';
  let d;
  try { d = await api(); } catch (e) { return token === 'eu' && e.status === 401 ? loginScreen() : fail(e.message); }
  document.title = `${d.clinic.name} — Meu acompanhamento`;
  const reload = () => main();
  const phone = onlyDigits(d.clinic.phone);
  const wa = (msg) => (phone.length >= 10 ? `https://wa.me/${phone.length <= 11 ? '55' + phone : phone}?text=${encodeURIComponent(msg)}` : null);

  // ---- Como você está hoje? ----
  const todayEntry = d.diary.find((x) => x.day === d.today);
  let pick = todayEntry ? todayEntry.pain : null;
  const note = h('textarea', { class: 'input', rows: 2, maxLength: 500, placeholder: 'Quer contar algo? (opcional) Ex.: dor ao subir escada, dormi melhor…' });
  note.value = todayEntry?.note || '';
  const scale = h('div', { class: 'pt-scale' });
  const drawScale = () => scale.replaceChildren(...Array.from({ length: 11 }, (_, n) => h('button', {
    type: 'button', class: `pt-n ${pick === n ? 'on' : ''}`, style: pick === n ? { background: PAIN_COLOR(n), borderColor: PAIN_COLOR(n) } : null,
    'aria-label': `Dor ${n}`, onclick: () => { pick = n; drawScale(); },
  }, String(n))));
  drawScale();
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (pick === null) return toast('Toque em um número de 0 a 10', 'error');
    saveBtn.disabled = true;
    try { await api('/diary', { pain: pick, note: note.value }); toast('Registrado. Obrigado!'); reload(); } catch (e) { toast(e.message, 'error'); saveBtn.disabled = false; }
  } }, todayEntry ? 'Atualizar' : 'Registrar');
  const recent = d.diary.slice(0, 14).reverse();
  const chart = recent.length > 1 ? h('div', { class: 'pt-bars', 'aria-label': 'Sua dor nos últimos dias' },
    recent.map((x) => h('div', { class: 'pt-bar', title: `${dm(x.day)}: ${x.pain}` },
      h('i', { style: { height: `${Math.max(4, x.pain * 10)}%`, background: PAIN_COLOR(x.pain) } }), h('small', null, dm(x.day))))) : null;

  // ---- Consultas ----
  const appts = d.appointments.length ? h('div', { class: 'pt-list' }, d.appointments.map((a) => h('div', { class: 'pt-item' },
    h('div', { class: 'grow' }, h('b', null, `${dayLabel(a.start)} às ${a.start.slice(11, 16)}`),
      h('div', { class: 'pt-sub' }, [a.kind, a.professional].filter(Boolean).join(' · ')),
      a.status === 'confirmado' ? h('span', { class: 'badge green', style: { marginTop: '4px' } }, 'Presença confirmada') : null),
    h('div', { class: 'pt-actions' },
      a.can_confirm ? h('button', { class: 'btn sm primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api(`/appointments/${a.id}/confirm`, {}); toast('Presença confirmada'); reload(); } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
      } }, icon('check', 14), 'Confirmar') : null,
      wa(`Olá! Sou ${d.patient.first_name} e preciso remarcar minha consulta de ${dayLabel(a.start)} às ${a.start.slice(11, 16)}.`)
        ? h('a', { class: 'btn sm', href: wa(`Olá! Sou ${d.patient.first_name} e preciso remarcar minha consulta de ${dayLabel(a.start)} às ${a.start.slice(11, 16)}.`), target: '_blank', rel: 'noopener noreferrer' }, 'Remarcar') : null))))
    : h('p', { class: 'bk-empty' }, 'Nenhuma consulta marcada.');

  // ---- Pagamentos ----
  const pay = d.pending.length || d.paid.length ? h('div', { class: 'stack' },
    d.pending.length ? h('div', { class: 'pt-list' }, d.pending.map((c) => h('div', { class: 'pt-item' },
      h('div', { class: 'grow' }, h('b', null, brl(c.amount)), h('div', { class: 'pt-sub' }, c.description)),
      h('div', { class: 'pt-actions' },
        h('button', { class: 'btn sm primary', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          await pixModal(c, reload); b.disabled = false;
        } }, 'Pagar com Pix'),
        h('button', { class: 'btn sm', title: 'Pagamento com cartão pelo Mercado Pago', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { location.href = (await api(`/pay/${c.id}`, {})).url; } catch (err) { toast(err.message, 'error'); b.disabled = false; }
        } }, 'Cartão'))))) : null,
    d.paid.length ? h('details', { class: 'pt-details' }, h('summary', null, `Pagamentos feitos (${d.paid.length})`),
      h('div', { class: 'pt-list' }, d.paid.map((c) => h('div', { class: 'pt-item' },
        h('div', { class: 'grow' }, h('span', null, c.description), h('div', { class: 'pt-sub' }, `Pago em ${dm(c.paid_at)}${c.receipt_number ? ` · recibo nº ${c.receipt_number}` : ''}`)),
        h('b', null, brl(c.amount)))))) : null) : null;

  // ---- Documentos ----
  const docs = d.signatures.length ? h('div', { class: 'pt-list' }, d.signatures.map((s) => h('div', { class: 'pt-item' },
    h('div', { class: 'grow' }, h('b', null, s.title), h('div', { class: 'pt-sub' }, `Assinar até ${dm(s.expires_at)}`)),
    h('button', { class: 'btn sm primary', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { location.href = (await api(`/sign/${s.id}`, {})).url; } catch (err) { toast(err.message, 'error'); b.disabled = false; }
    } }, 'Ler e assinar')))) : null;

  // ---- Exercícios ----
  const dose = (it) => [it.sets ? `${it.sets} série(s)` : '', it.reps ? `${it.reps} repetições` : '', it.hold_s ? `segurar ${it.hold_s} s` : '', it.rest_s ? `descanso ${it.rest_s} s` : '', it.side || '', it.load ? `carga: ${it.load}` : ''].filter(Boolean).join(' · ');
  const programs = d.programs.map((x) => section(x.title, 'activity',
    x.frequency || x.duration ? h('p', { class: 'pt-sub', style: { marginTop: '-6px' } }, [x.frequency, x.duration].filter(Boolean).join(' · ')) : null,
    x.notes ? h('div', { class: 'bk-summary' }, x.notes) : null,
    h('div', { class: 'stack' }, x.items.map((it, i) => h('details', { class: 'pt-ex' },
      h('summary', null, h('span', { class: 'pt-exn' }, i + 1), h('div', { class: 'grow' }, h('b', null, it.name), dose(it) ? h('div', { class: 'pt-sub' }, dose(it)) : null)),
      h('div', { class: 'pt-exbody' },
        it.media_url && isImage(it.media_url) ? h('img', { src: it.media_url, alt: it.name, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        it.steps?.length ? h('ol', null, it.steps.map((st) => h('li', null, st))) : null,
        it.notes ? h('div', { class: 'pt-warn' }, h('b', null, 'Atenção: '), it.notes) : null,
        it.media_url && !isImage(it.media_url) ? h('a', { class: 'btn sm', href: it.media_url, target: '_blank', rel: 'noopener noreferrer' }, 'Ver vídeo') : null)))),
    h('p', { class: 'pt-sub', style: { marginTop: '10px' } }, 'Faça com calma. Se sentir dor forte, tontura, falta de ar ou formigamento, pare e avise seu fisioterapeuta.')));

  show(
    h('div', { class: 'bk-head' }, h('div', { class: 'bk-logo' }, icon('activity', 24)), h('div', null, h('h1', null, `Olá, ${d.patient.first_name}!`), h('p', null, d.clinic.name))),
    section('Como está sua dor hoje?', 'trending',
      h('p', { class: 'pt-sub', style: { marginTop: '-6px' } }, '0 = sem dor · 10 = pior dor imaginável'),
      scale, note, h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
        todayEntry ? h('small', { class: 'pt-sub' }, `Hoje você marcou ${todayEntry.pain}.`) : h('span'), saveBtn),
      chart ? h('div', null, h('small', { class: 'pt-sub' }, 'Últimos dias'), chart) : null),
    section('Próximas consultas', 'calendar', appts),
    docs ? section('Documentos para assinar', 'file', docs) : null,
    pay ? section('Pagamentos', 'wallet', pay) : null,
    ...programs,
    h('div', { class: 'bk-foot' },
      h('div', null, h('b', null, d.clinic.name)),
      d.clinic.phone ? h('div', null, wa('Olá!') ? h('a', { href: wa('Olá!'), target: '_blank', rel: 'noopener noreferrer' }, `WhatsApp ${d.clinic.phone}`) : d.clinic.phone) : null,
      d.clinic.address ? h('div', null, d.clinic.address) : null,
      d.logged_in ? h('p', { style: { marginTop: '10px' } }, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await pub('portal-logout', {}); token = 'eu'; loginScreen('Você saiu do portal.'); } }, 'Sair do portal'))
        : h('p', { style: { marginTop: '10px' } }, 'Este link é pessoal: não compartilhe. Para desativá-lo, fale com a clínica.')));
}
main();

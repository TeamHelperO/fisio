// Tutorial guiado do primeiro acesso: destaca cada item do menu e explica para que serve.
// O usuário pode avançar, voltar, clicar no item destacado (abre a tela e segue o tour) ou pular tudo.
import { h, icon } from './ui.js';
import { post } from './api.js';
import { state, isClinical, isAdmin, go } from './state.js';

const STEPS = [
  { nav: 'dashboard', title: 'Dashboard', text: 'Sua visão do dia: próximas consultas, pacientes em tratamento, recebimentos e avisos importantes.' },
  { nav: 'pacientes', title: 'Pacientes', text: 'Cadastre cada paciente com o termo LGPD. Na ficha ficam o histórico, os documentos, o portal do paciente e o diário de dor.', tip: 'Comece por aqui: cadastre o primeiro paciente.' },
  { nav: 'anamnese', clinical: true, title: 'Prontuário', text: 'Anamnese, Avaliações, Planos de tratamento e Evoluções formam o prontuário eletrônico. Tudo fica cifrado e com registro de quem alterou.' },
  { nav: 'exercicios', clinical: true, title: 'Exercícios', text: 'Monte programas de exercícios para casa. O paciente acompanha pelo portal, com fotos ou vídeos e a frequência combinada.' },
  { nav: 'agenda', title: 'Agenda', text: 'Marque consultas, veja os horários de cada profissional e registre o pagamento: já pago, sinal ou a pagar depois. Dá para gerar link de pagamento.', tip: 'Clique em um horário livre da agenda para marcar.' },
  { nav: 'financeiro', title: 'Financeiro', text: 'Cobranças, recebimentos, recibos e pacotes de sessões. O que fica pendente depois do atendimento aparece aqui.' },
  { nav: 'relatorios', title: 'Relatórios', text: 'Números da clínica por período: atendimentos, faltas, faturamento e evolução dos pacientes.' },
  { nav: 'configuracoes', title: 'Configurações', text: 'Dados da clínica e dos documentos, usuários da equipe, agendamento online, recebimentos pelo Mercado Pago, portal do paciente e lembretes pelo WhatsApp.', adminTip: 'Dica: em Configurações → WhatsApp, conecte o número da clínica para enviar lembretes automáticos.' },
];

let active = null;

// done(): registra no servidor que este usuário já viu (ou pulou) o tutorial
async function markDone() {
  if (state.user) state.user.tour_done = true;
  try { await post('/me/tour'); } catch { /* sem conexão: volta a aparecer no próximo acesso */ }
}

export function startTour() {
  if (active) return;
  const steps = STEPS.filter((s) => (!s.clinical || isClinical()) && document.querySelector(`.nav a[data-path="${s.nav}"]`));
  const app = document.querySelector('.app');
  const mobile = () => window.matchMedia('(max-width: 900px)').matches;
  const layer = h('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tutorial do FisioGestão' });
  const blockers = [0, 1, 2, 3].map(() => h('div', { class: 'tour-block' }));
  const hole = h('div', { class: 'tour-hole' });
  const card = h('div', { class: 'tour-card' });
  layer.append(...blockers, hole, card);
  document.body.append(layer);
  let i = -1; // -1 = boas-vindas
  const fill = (...xs) => card.replaceChildren(...xs.filter(Boolean));

  const close = () => {
    window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', onKey, true);
    document.querySelector('.nav')?.removeEventListener('click', onNav);
    layer.remove(); if (mobile()) app?.classList.remove('menu-open');
    active = null;
    markDone();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(i + 1); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); show(i - 1); }
  };
  const target = () => (i >= 0 && i < steps.length ? document.querySelector(`.nav a[data-path="${steps[i].nav}"]`) : null);

  function place() {
    const el = target();
    const W = window.innerWidth; const H = window.innerHeight;
    if (!el) {
      // passo sem destaque (boas-vindas e final): fundo escuro inteiro e cartão no centro
      Object.assign(blockers[0].style, { left: '0', top: '0', width: `${W}px`, height: `${H}px` });
      blockers.slice(1).forEach((b) => Object.assign(b.style, { width: '0', height: '0' }));
      hole.style.display = 'none';
      card.className = 'tour-card center';
      Object.assign(card.style, { left: '', top: '' });
      return;
    }
    const r = el.getBoundingClientRect(); const pad = 4;
    const x = Math.max(0, r.left - pad); const y = Math.max(0, r.top - pad); const w = r.width + pad * 2; const hh = r.height + pad * 2;
    // quatro faixas escuras ao redor do item: o item continua clicável
    Object.assign(blockers[0].style, { left: '0', top: '0', width: `${W}px`, height: `${y}px` });
    Object.assign(blockers[1].style, { left: '0', top: `${y + hh}px`, width: `${W}px`, height: `${Math.max(0, H - y - hh)}px` });
    Object.assign(blockers[2].style, { left: '0', top: `${y}px`, width: `${x}px`, height: `${hh}px` });
    Object.assign(blockers[3].style, { left: `${x + w}px`, top: `${y}px`, width: `${Math.max(0, W - x - w)}px`, height: `${hh}px` });
    Object.assign(hole.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
    card.className = 'tour-card';
    const cw = card.offsetWidth; const ch = card.offsetHeight;
    let left = x + w + 14; let top = y + hh / 2 - ch / 2;
    if (left + cw > W - 12) { left = Math.min(Math.max(12, x), W - cw - 12); top = y + hh + 12; if (top + ch > H - 12) top = y - ch - 12; }
    Object.assign(card.style, { left: `${left}px`, top: `${Math.min(Math.max(12, top), H - ch - 12)}px` });
  }

  function show(n) {
    if (n > steps.length) return close();
    i = n;
    const el = target();
    if (el) { if (mobile()) app?.classList.add('menu-open'); el.scrollIntoView({ block: 'nearest' }); }
    const skip = h('button', { class: 'btn ghost sm', onclick: () => close() }, 'Pular tutorial');
    if (i === -1) {
      fill(
        h('div', { class: 'tour-icon' }, icon('activity', 22)),
        h('h3', null, `Bem-vindo(a) ao FisioGestão${state.user?.name ? `, ${state.user.name.split(' ')[0]}` : ''}!`),
        h('p', null, 'Quer um tour rápido de 1 minuto pelas principais telas? Você pode pular a qualquer momento.'),
        h('div', { class: 'tour-actions' }, skip, h('button', { class: 'btn primary', onclick: () => show(0) }, 'Começar tour')));
    } else if (i === steps.length) {
      fill(
        h('div', { class: 'tour-icon' }, icon('check', 22)),
        h('h3', null, 'Tudo pronto!'),
        h('p', null, 'Esse foi o tour. Que tal começar cadastrando o primeiro paciente?'),
        h('div', { class: 'tour-actions' },
          h('button', { class: 'btn ghost sm', onclick: () => close() }, 'Fechar'),
          h('button', { class: 'btn primary', onclick: () => { close(); go('#/pacientes/novo'); } }, 'Cadastrar paciente')));
    } else {
      const s = steps[i];
      const tip = s.adminTip && isAdmin() ? s.adminTip : s.tip;
      fill(
        h('div', { class: 'tour-step' }, `${i + 1} de ${steps.length}`),
        h('h3', null, s.title),
        h('p', null, s.text),
        tip ? h('p', { class: 'tour-tip' }, tip) : null,
        h('small', { class: 'help' }, 'Clique no item destacado para abrir a tela.'),
        h('div', { class: 'tour-dots' }, steps.map((_, k) => h('span', { class: k === i ? 'on' : '' }))),
        h('div', { class: 'tour-actions' }, skip,
          h('span', { class: 'grow' }),
          i > 0 ? h('button', { class: 'btn sm', onclick: () => show(i - 1) }, 'Voltar') : null,
          h('button', { class: 'btn primary sm', onclick: () => show(i + 1) }, i === steps.length - 1 ? 'Concluir' : 'Próximo')));
    }
    requestAnimationFrame(place);
    card.querySelector('.btn.primary')?.focus();
  }

  // clicar no item destacado: abre a tela e segue para o próximo passo
  function onNav(e) {
    const a = e.target.closest('a[data-path]');
    if (a && target() === a) setTimeout(() => { if (active) show(i + 1); }, 350);
  }
  document.querySelector('.nav')?.addEventListener('click', onNav);
  window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
  document.addEventListener('keydown', onKey, true);
  active = { close };
  show(-1);
}

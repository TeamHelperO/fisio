# FisioGestão — Sistema de Gestão Fisioterapêutica

Prontuário eletrônico completo para fisioterapeutas autônomos e clínicas: cadastro de pacientes, anamnese, avaliação, plano de tratamento, evolução das sessões, agenda, financeiro (com organização para o Carnê-Leão), documentos em PDF e adequação à LGPD.

## Como funciona (SaaS)

Cada clínica cria a própria conta em **/#/criar-conta**, ganha **7 dias grátis sem cartão** e depois assina pelo **Stripe**. Sem assinatura ativa, a conta fica em **somente leitura**: dá para consultar e exportar tudo, mas não criar ou alterar registros.

- **Isolamento:** cada clínica tem um *schema* próprio no Postgres (`c_<id>`), com as mesmas tabelas. Toda requisição roda numa transação apontada para o schema da clínica do usuário logado — uma consulta nunca enxerga outra clínica.
- **Criptografia:** cada clínica tem a própria chave AES-256-GCM para os registros clínicos, guardada cifrada pela `MASTER_KEY`.
- **Plataforma:** o schema `saas` guarda clínicas, assinaturas, sessões, índice de e-mails (um e-mail = uma clínica) e tentativas de login.

## Publicar (Supabase + Vercel + Stripe)

1. **Supabase** — crie um projeto (região *South America — São Paulo*). Em *Connect → Transaction pooler*, copie a string de conexão (porta 6543). As tabelas são criadas sozinhas no primeiro acesso.
2. **Stripe** — crie um produto com preço **recorrente** (ex.: mensal) e copie o `price_...`. Em *Developers → Webhooks*, crie um endpoint `https://SEU-DOMINIO/api/stripe/webhook` com os eventos `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` e `customer.subscription.deleted`, e copie o segredo `whsec_...`. Ative o *Customer portal* em *Settings → Billing*.
3. **Vercel** — importe o repositório (sem framework, sem build). Conecte o banco pela integração **Supabase** do Marketplace da Vercel (ela cria `POSTGRES_URL` sozinha) ou cadastre `DATABASE_URL` à mão. Em *Settings → Environment Variables*, cadastre também: `MASTER_KEY`, `APP_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`. A função roda em São Paulo (`gru1`), e um cron diário limpa sessões vencidas.

> ⚠️ **Guarde a `MASTER_KEY` em local seguro e separado.** Sem ela, os prontuários de todas as clínicas ficam ilegíveis — nem os backups do Supabase resolvem.

### Desenvolvimento local
Requisito: **Node.js 22.13+**. Copie `.env.example` para `.env`, preencha `DATABASE_URL` (um projeto Supabase de desenvolvimento ou qualquer Postgres) e `MASTER_KEY`, rode `npm install` e `npm run dev`. Acesse http://localhost:3000.

### Administração da plataforma (`/admin`)
Área do dono do SaaS, separada do sistema das clínicas, com login próprio:

- **Dashboard:** clínicas, testes grátis (e quais terminam em 3 dias), assinantes, conversão, MRR, cadastros dos últimos 30 dias.
- **Clínicas:** situação de cada conta, contagens agregadas (usuários, pacientes, atendimentos em 30 dias); estender teste grátis, liberar, deixar em somente leitura ou suspender.
- **Financeiro:** MRR, assinaturas e faturas pagas, lidos do Stripe.
- **Usuários e marketing:** todos os usuários das clínicas e quem aceitou receber marketing; exporta CSV **só com quem consentiu**, com link de descadastro de cada contato.
- **APIs e integrações:** chaves do Stripe e do Resend, e-mail de suporte e dias de teste — guardadas cifradas no banco (têm prioridade sobre as variáveis de ambiente).
- **Administradores** e **registro de ações**.

O painel **não dá acesso** a prontuários, cadastros de pacientes ou dados financeiros dos pacientes.

**Primeiro acesso:** cadastre na Vercel a variável `ADMIN_SETUP_TOKEN` (um código longo e aleatório), faça um novo deploy e abra `/admin`. Informe esse código para criar o primeiro administrador (senha com 12+ caracteres). Depois disso o código não é mais aceito e pode ser removido.

## Módulos

| Módulo | O que faz |
|---|---|
| Dashboard | Pacientes (total, em tratamento, finalizados), consultas agendadas, atendimentos e faturamento do mês, pendências, próximos atendimentos, receita de 6 meses |
| Pacientes | Cadastro completo, busca, prontuário individual com abas (resumo, anamnese, avaliações, plano, evoluções, agenda, financeiro, documentos, LGPD) |
| Anamnese | Ficha completa: diagnóstico médico, queixa, HDA, histórico de saúde, doenças associadas, medicamentos, cirurgias, histórico familiar, alergias, hábitos |
| Avaliações | Dor (localização, EVA 0–10, características), ADM, força, mobilidade, equilíbrio, marcha, limitações, testes específicos, escalas — avaliação inicial, reavaliação e alta |
| Planos de tratamento | Diagnóstico fisioterapêutico, objetivos, condutas, técnicas, exercícios, frequência, duração, critérios de reavaliação; histórico de versões e plano ativo/substituído |
| Evoluções | Registro por sessão (numeração automática), EVA início/fim, gráfico de dor, comparação lado a lado de até 4 sessões, copiar conduta da sessão anterior |
| Agenda | Visões dia/semana/mês, agendamento recorrente, detecção de conflito, situações (agendado, confirmado, realizado, falta, cancelado) |
| Financeiro | Valores por atendimento, pacotes mensais, cobranças automáticas ao marcar "realizado", registro de pagamentos (PIX, dinheiro, cartão, transferência), pendências, recibos numerados, relatório de receitas |
| Carnê-Leão | Consolidação anual/mensal das receitas recebidas com paciente, pagador, CPFs, datas e formas — exporta CSV/PDF. **Não calcula imposto.** |
| Relatórios | PDFs: anamnese, avaliação, plano, evoluções, relatório de acompanhamento, prontuário completo, termo LGPD, recibos, receitas, atendimentos, Carnê-Leão |
| Configurações | Dados do profissional, usuários e perfis, troca de senha, termo LGPD, backup, registro de alterações |

Os documentos abrem em uma nova aba já formatados em A4, com identificação do profissional e do paciente, data e espaço para assinatura; escolha **"Salvar como PDF"** na janela de impressão.

## Segurança e LGPD

- Login individual; senhas com hash **scrypt**; bloqueio após 5 tentativas; sessão expira após 10 h de inatividade.
- Perfis: **Administrador** (tudo), **Fisioterapeuta** (prontuários dos pacientes sob sua responsabilidade), **Recepção** (cadastro, agenda e financeiro — sem dados clínicos).
- Registros clínicos **criptografados** no banco (AES-256-GCM), com chave própria por clínica.
- **Registro de alterações** (quem, quando, o quê) incluindo visualizações de prontuário; cada edição de registro clínico preserva a versão anterior; exclusões de registros clínicos são lógicas (guarda legal).
- **Cópias de segurança** diárias pelo Supabase; cópia criptografada do cadastro antes de excluir um paciente; exportação completa da clínica em JSON a qualquer momento (Configurações → Assinatura e dados).
- **Consentimento** do titular registrado por paciente (versão do termo, data, forma, responsável), revogação, exportação de dados (portabilidade) e exclusão pelo administrador.
- **Guarda legal:** pacientes com prontuário clínico não podem ser excluídos antes de 5 anos do último registro (marque-os como "Inativo"); cadastros sem prontuário podem ser excluídos a qualquer momento.
- Cabeçalhos de segurança (CSP, anti-clickjacking), proteção CSRF, cookies HttpOnly/SameSite.

> Revise o texto do termo de consentimento com sua assessoria jurídica e confirme com um contador as regras do Carnê-Leão.

## Estrutura

```
api/          função serverless da Vercel (encaminha para server/app.js)
server/       API (app.js), banco multi-clínica (core.js), Stripe (stripe.js), servidor local (server.js)
public/       interface web (HTML/CSS/JS modular, responsiva), termos e privacidade
```

Para incluir novos profissionais, use **Configurações → Usuários**. A estrutura de formulários clínicos fica em `public/js/schemas.js` — novos campos podem ser adicionados ali sem alterar o banco.

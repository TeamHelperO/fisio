# FisioGestão — Sistema de Gestão Fisioterapêutica

Prontuário eletrônico completo para fisioterapeutas autônomos e clínicas: cadastro de pacientes, anamnese, avaliação, plano de tratamento, evolução das sessões, agenda, financeiro (com organização para o Carnê-Leão), documentos em PDF e adequação à LGPD.

## Como iniciar

Requisito: **Node.js 22.13 ou superior** (https://nodejs.org). Não há dependências para instalar — o banco de dados (SQLite) é nativo do Node.

- **Windows:** dê dois cliques em `Iniciar FisioGestao.bat` (abre o navegador automaticamente).
- **Terminal:** `npm start` e acesse http://localhost:3000

No primeiro acesso, crie a conta do **administrador** (profissional responsável). Depois, em **Configurações**, preencha os dados do profissional/clínica (aparecem nos documentos e recibos) e cadastre outros usuários.

### Acesso pelo celular/tablet na mesma rede
Por segurança o servidor escuta apenas no próprio computador. Para liberar na rede local:
`npm run start:rede` e acesse `http://IP-DO-COMPUTADOR:3000` pelo outro aparelho.
Para acesso pela internet, publique atrás de HTTPS (proxy reverso como Caddy/Nginx) e defina `COOKIE_SECURE=1`.

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
- Registros clínicos **criptografados** no banco (AES-256-GCM). A chave fica em `data/secret.key` (ou na variável `FISIO_KEY`).
- **Registro de alterações** (quem, quando, o quê) incluindo visualizações de prontuário; cada edição de registro clínico preserva a versão anterior; exclusões de registros clínicos são lógicas (guarda legal).
- **Backup** automático diário em `data/backups` (30 mais recentes), backup manual e download pelo sistema, backup automático antes de excluir paciente.
- **Consentimento** do titular registrado por paciente (versão do termo, data, forma, responsável), revogação, exportação de dados (portabilidade) e exclusão pelo administrador.
- **Guarda legal:** pacientes com prontuário clínico não podem ser excluídos antes de 5 anos do último registro (marque-os como "Inativo"); cadastros sem prontuário podem ser excluídos a qualquer momento.
- Cabeçalhos de segurança (CSP, anti-clickjacking), proteção CSRF, cookies HttpOnly/SameSite.

> ⚠️ **Guarde uma cópia de `data/secret.key` em local seguro e separado dos backups.** Sem ela, os registros clínicos não podem ser lidos.
> Revise o texto do termo de consentimento com sua assessoria jurídica e confirme com um contador as regras do Carnê-Leão.

## Estrutura

```
server/       servidor HTTP (Node, sem dependências), banco SQLite, API REST
public/       interface web (HTML/CSS/JS modular, responsiva)
data/         banco de dados, chave de criptografia e backups (criada no 1º uso)
```

Para incluir novos profissionais, use **Configurações → Usuários**. A estrutura de formulários clínicos fica em `public/js/schemas.js` — novos campos podem ser adicionados ali sem alterar o banco.

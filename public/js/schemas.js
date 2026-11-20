// Estrutura dos formulários clínicos. Cada campo vira entrada no formulário, na visualização e no PDF.

export const ANAMNESE = [
  { type: 'section', label: 'Informações clínicas' },
  { key: 'diagnostico_medico', label: 'Diagnóstico médico', type: 'text', span: true },
  { key: 'cid', label: 'CID (se houver)', type: 'text' },
  { key: 'medico_solicitante', label: 'Médico solicitante / encaminhamento', type: 'text' },
  { key: 'queixa_principal', label: 'Queixa principal', type: 'textarea' },
  { key: 'hda', label: 'História da doença atual (HDA)', type: 'textarea', rows: 4 },
  { key: 'inicio_sintomas', label: 'Data de início dos sintomas', type: 'date' },
  { key: 'mecanismo_lesao', label: 'Mecanismo de lesão / fator desencadeante', type: 'text' },
  { type: 'section', label: 'Histórico de saúde' },
  { key: 'historico_saude', label: 'Histórico de saúde (HPP)', type: 'textarea' },
  { key: 'doencas_associadas', label: 'Doenças associadas', type: 'checks', options: ['Diabetes', 'Hipertensão', 'Cardiopatia', 'Osteoporose', 'Artrite / Artrose', 'Doença respiratória', 'Doença renal', 'Doença neurológica', 'Câncer', 'Depressão / Ansiedade', 'Obesidade', 'Tireoide'] },
  { key: 'outras_doencas', label: 'Outras doenças associadas', type: 'text', span: true },
  { key: 'medicamentos', label: 'Medicamentos em uso', type: 'textarea' },
  { key: 'cirurgias', label: 'Histórico de cirurgias', type: 'textarea' },
  { key: 'historico_familiar', label: 'Histórico familiar', type: 'textarea' },
  { key: 'alergias', label: 'Alergias', type: 'text', span: true },
  { key: 'exames', label: 'Exames complementares', type: 'textarea' },
  { type: 'section', label: 'Hábitos de vida' },
  { key: 'atividade_fisica', label: 'Atividade física', type: 'select', options: ['Sedentário', 'Irregular', '1–2x por semana', '3–4x por semana', '5x ou mais por semana'] },
  { key: 'tabagismo', label: 'Tabagismo', type: 'select', options: ['Não', 'Sim', 'Ex-fumante'] },
  { key: 'etilismo', label: 'Etilismo', type: 'select', options: ['Não', 'Social', 'Frequente'] },
  { key: 'sono', label: 'Qualidade do sono', type: 'select', options: ['Boa', 'Regular', 'Ruim'] },
  { key: 'habitos', label: 'Outros hábitos de vida (alimentação, trabalho, postura, lazer)', type: 'textarea' },
  { key: 'observacoes', label: 'Observações complementares', type: 'textarea' },
];

export const AVALIACAO = [
  { key: 'tipo', label: 'Tipo de avaliação', type: 'select', options: ['Avaliação inicial', 'Reavaliação', 'Alta'], default: 'Avaliação inicial' },
  { type: 'section', label: 'Avaliação da dor' },
  { key: 'dor_presente', label: 'Dor presente?', type: 'select', options: ['Sim', 'Não'] },
  { key: 'dor_localizacao', label: 'Localização da dor', type: 'text' },
  { key: 'dor_intensidade', label: 'Intensidade da dor (EVA 0–10)', type: 'scale', span: true },
  { key: 'dor_tipo', label: 'Característica da dor', type: 'checks', options: ['Pontada', 'Queimação', 'Latejante', 'Formigamento', 'Peso', 'Choque', 'Irradiada', 'Contínua', 'Intermitente', 'Noturna'] },
  { key: 'dor_fatores', label: 'Fatores de piora / melhora', type: 'textarea' },
  { type: 'section', label: 'Exame físico' },
  { key: 'inspecao', label: 'Inspeção / postura / palpação', type: 'textarea' },
  { key: 'adm', label: 'Amplitude de movimento (ADM)', type: 'textarea', placeholder: 'Ex.: Flexão de ombro D 120° / E 170°…' },
  { key: 'forca', label: 'Força muscular', type: 'textarea', placeholder: 'Ex.: Quadríceps D grau 4 / E grau 5 (Escala Oxford)…' },
  { key: 'mobilidade', label: 'Mobilidade', type: 'textarea' },
  { key: 'equilibrio', label: 'Equilíbrio', type: 'textarea' },
  { key: 'marcha', label: 'Marcha', type: 'textarea' },
  { key: 'limitacoes', label: 'Limitações funcionais', type: 'textarea' },
  { key: 'testes', label: 'Testes específicos (nome e resultado)', type: 'textarea', rows: 4 },
  { key: 'escalas', label: 'Escalas / questionários funcionais', type: 'textarea', placeholder: 'Ex.: Oswestry 32%, Lysholm 70, Berg 48…' },
  { key: 'observacoes', label: 'Observações do profissional', type: 'textarea', rows: 4 },
];

export const PLANO = [
  { key: 'diagnostico_fisio', label: 'Diagnóstico fisioterapêutico (cinético-funcional)', type: 'textarea' },
  { key: 'objetivo_geral', label: 'Objetivo geral', type: 'textarea' },
  { key: 'objetivos_especificos', label: 'Objetivos específicos', type: 'textarea', rows: 4, placeholder: 'Um objetivo por linha' },
  { key: 'condutas', label: 'Condutas terapêuticas', type: 'textarea', rows: 4 },
  { key: 'tecnicas', label: 'Técnicas que serão utilizadas', type: 'checks', options: ['Cinesioterapia', 'Terapia manual', 'Mobilização articular', 'Liberação miofascial', 'Eletroterapia (TENS/FES)', 'Ultrassom', 'Laser', 'Crioterapia', 'Termoterapia', 'Bandagem', 'Dry needling', 'Pilates', 'RPG', 'Treino funcional', 'Hidroterapia', 'Fisioterapia respiratória', 'Treino de marcha', 'Propriocepção'] },
  { key: 'outras_tecnicas', label: 'Outras técnicas', type: 'text', span: true },
  { key: 'exercicios', label: 'Exercícios planejados', type: 'textarea', rows: 4 },
  { key: 'frequencia', label: 'Frequência semanal', type: 'select', options: ['1x por semana', '2x por semana', '3x por semana', '4x por semana', '5x por semana', 'Diária'] },
  { key: 'duracao', label: 'Previsão de duração do tratamento', type: 'text', placeholder: 'Ex.: 8 semanas / 20 sessões' },
  { key: 'criterios_reavaliacao', label: 'Critérios para reavaliação', type: 'textarea' },
  { key: 'orientacoes', label: 'Orientações domiciliares', type: 'textarea' },
];

export const EVOLUCAO = [
  { key: 'queixa', label: 'Queixa relatada pelo paciente', type: 'textarea' },
  { key: 'dor_inicio', label: 'Dor no início da sessão (EVA)', type: 'scale', span: true },
  { key: 'condicao_inicial', label: 'Condição apresentada no início do atendimento', type: 'textarea' },
  { key: 'exercicios', label: 'Exercícios realizados', type: 'textarea', rows: 4 },
  { key: 'tecnicas', label: 'Técnicas aplicadas', type: 'textarea' },
  { key: 'series_repeticoes', label: 'Séries e repetições', type: 'text' },
  { key: 'tempo', label: 'Tempo de execução', type: 'text', placeholder: 'Ex.: 50 min' },
  { key: 'resposta', label: 'Resposta do paciente ao tratamento', type: 'textarea' },
  { key: 'dor_fim', label: 'Dor ao final da sessão (EVA)', type: 'scale', span: true },
  { key: 'evolucao', label: 'Evolução observada', type: 'textarea' },
  { key: 'intercorrencias', label: 'Intercorrências', type: 'textarea' },
  { key: 'orientacoes', label: 'Orientações para o paciente', type: 'textarea' },
  { key: 'observacoes', label: 'Observações adicionais', type: 'textarea' },
];

export const SCHEMAS = { anamnese: ANAMNESE, avaliacao: AVALIACAO, plano: PLANO, evolucao: EVOLUCAO };

// ======================= Fichas por área de atuação =======================
// Cada área acrescenta campos próprios à avaliação e à evolução.
const t = (key, label, placeholder) => ({ key, label, type: 'text', placeholder });
const ta = (key, label, placeholder, rows) => ({ key, label, type: 'textarea', placeholder, rows });
const s = (key, label, options) => ({ key, label, type: 'select', options });
const c = (key, label, options) => ({ key, label, type: 'checks', options });
const sec = (label) => ({ type: 'section', label });
const BORG = ['0 — nenhuma', '0,5 — muito, muito leve', '1 — muito leve', '2 — leve', '3 — moderada', '4 — pouco intensa', '5 — intensa', '6', '7 — muito intensa', '8', '9', '10 — máxima'];
const OXFORD = ['0 — sem contração', '1 — esboço', '2 — fraca', '3 — moderada', '4 — boa', '5 — forte'];

export const AREAS = {
  ortopedica: {
    label: 'Traumato-ortopédica',
    avaliacao: [
      t('o_segmento', 'Segmento / articulação acometida', 'Ex.: joelho D, coluna lombar'),
      s('o_lado', 'Lado', ['Direito', 'Esquerdo', 'Bilateral', 'Não se aplica']),
      s('o_fase', 'Fase', ['Aguda (até 72 h)', 'Subaguda', 'Crônica', 'Pós-operatório imediato', 'Pós-operatório tardio']),
      t('o_cirurgia', 'Cirurgia / data / restrições médicas', 'Ex.: artroplastia em 10/10; carga parcial 4 sem.'),
      t('o_perimetria', 'Perimetria (cm) — D / E', 'Ex.: 10 cm acima da patela: 42 / 40'),
      ta('o_palpacao', 'Palpação (pontos dolorosos, temperatura, edema)'),
      ta('o_goniometria', 'Goniometria detalhada (ativa / passiva)', 'Movimento — D / E', 4),
      ta('o_forca_mmt', 'Teste muscular manual por grupo (0–5)', 'Grupo — D / E', 3),
      ta('o_testes_ortopedicos', 'Testes ortopédicos especiais', 'Ex.: Lachman (+), McMurray (−), Neer (+)…', 3),
      s('o_carga', 'Descarga de peso', ['Total', 'Parcial', 'Toque', 'Sem carga', 'Não se aplica']),
      t('o_dispositivo', 'Órtese / dispositivo auxiliar'),
    ],
    evolucao: [t('o_adm', 'ADM alcançada (graus)', 'Ex.: flexão 110°'), t('o_edema', 'Edema / perimetria'), s('o_carga', 'Descarga de peso', ['Total', 'Parcial', 'Toque', 'Sem carga'])],
  },
  respiratoria: {
    label: 'Respiratória',
    avaliacao: [
      sec('Sinais vitais e oxigenação'),
      t('r_fr', 'Frequência respiratória (irpm)'), t('r_spo2', 'SpO₂ (%)', 'Ex.: 94% em ar ambiente'), t('r_fc', 'Frequência cardíaca (bpm)'), t('r_pa', 'Pressão arterial (mmHg)'),
      s('r_o2', 'Oxigenoterapia', ['Ar ambiente', 'Cateter nasal', 'Máscara de Venturi', 'Máscara com reservatório', 'Alto fluxo', 'VNI', 'Ventilação mecânica']),
      t('r_o2_fluxo', 'Fluxo / FiO₂', 'Ex.: 2 L/min'),
      sec('Inspeção e padrão respiratório'),
      s('r_torax', 'Tipo de tórax', ['Normal', 'Tonel', 'Pectus excavatum', 'Pectus carinatum', 'Cifoescoliótico']),
      s('r_padrao', 'Padrão respiratório', ['Diafragmático', 'Costal superior', 'Misto', 'Paradoxal']),
      s('r_ritmo', 'Ritmo', ['Regular', 'Taquipneia', 'Bradipneia', 'Cheyne-Stokes', 'Kussmaul', 'Biot']),
      s('r_expansibilidade', 'Expansibilidade torácica', ['Simétrica', 'Assimétrica', 'Diminuída bilateralmente']),
      c('r_sinais', 'Sinais de desconforto respiratório', ['Uso de musculatura acessória', 'Tiragem intercostal', 'Batimento de asa nasal', 'Respiração com lábios franzidos', 'Cianose', 'Baqueteamento digital', 'Ortopneia']),
      t('r_cirtometria', 'Cirtometria (cm) — axilar / xifoide / basal', 'Insp. / exp.'),
      sec('Ausculta pulmonar'),
      s('r_mv', 'Murmúrio vesicular', ['Presente bilateralmente', 'Diminuído', 'Abolido']),
      c('r_ruidos', 'Ruídos adventícios', ['Sibilos', 'Roncos', 'Estertores crepitantes', 'Estertores subcrepitantes', 'Estridor', 'Atrito pleural']),
      t('r_ausculta_local', 'Localização dos achados', 'Ex.: bases bilaterais, terço médio D'),
      sec('Tosse e secreção'),
      s('r_tosse', 'Tosse', ['Ausente', 'Presente — eficaz', 'Presente — ineficaz']),
      s('r_tosse_tipo', 'Tipo de tosse', ['Produtiva', 'Seca', 'Espontânea', 'Somente sob estímulo']),
      s('r_secrecao_qtd', 'Quantidade de secreção', ['Ausente', 'Pequena', 'Moderada', 'Grande']),
      s('r_secrecao_aspecto', 'Aspecto da secreção', ['Mucoide', 'Mucopurulenta', 'Purulenta', 'Hemoptoica', 'Sanguinolenta', 'Espumosa']),
      s('r_secrecao_cor', 'Coloração', ['Clara / hialina', 'Branca', 'Amarelada', 'Esverdeada', 'Acastanhada', 'Rósea']),
      s('r_secrecao_viscosidade', 'Viscosidade', ['Fluida', 'Espessa', 'Muito espessa']),
      sec('Dispneia e capacidade funcional'),
      s('r_mrc', 'Dispneia — escala mMRC', ['0 — só em exercício intenso', '1 — ao apressar o passo ou subir ladeira', '2 — anda mais devagar que pessoas da mesma idade', '3 — para após ~100 m no plano', '4 — dispneia ao se vestir / não sai de casa']),
      s('r_borg', 'Borg (dispneia) em repouso', BORG),
      t('r_pimax', 'PImáx / PEmáx (cmH₂O)', 'Ex.: −60 / +70'),
      t('r_peakflow', 'Pico de fluxo expiratório (L/min)'),
      t('r_tc6', 'TC6 — distância (m), SpO₂ mínima, Borg final'),
      ta('r_exames', 'Exames (RX, TC, espirometria, gasometria)'),
    ],
    evolucao: [
      t('r_fr', 'FR (irpm) pré / pós'), t('r_spo2', 'SpO₂ (%) pré / pós'), t('r_fc', 'FC (bpm) pré / pós'),
      s('r_o2', 'Oxigenoterapia', ['Ar ambiente', 'Cateter nasal', 'Máscara de Venturi', 'Alto fluxo', 'VNI', 'Ventilação mecânica']),
      c('r_ruidos', 'Ausculta — ruídos adventícios', ['Sem ruídos', 'Sibilos', 'Roncos', 'Estertores crepitantes', 'Estertores subcrepitantes']),
      s('r_tosse', 'Tosse', ['Ausente', 'Presente — eficaz', 'Presente — ineficaz']),
      s('r_secrecao_qtd', 'Secreção — quantidade', ['Ausente', 'Pequena', 'Moderada', 'Grande']),
      s('r_secrecao_aspecto', 'Secreção — aspecto', ['Mucoide', 'Mucopurulenta', 'Purulenta', 'Hemoptoica']),
      s('r_borg', 'Borg ao final', BORG),
    ],
  },
  cardiovascular: {
    label: 'Cardiovascular',
    avaliacao: [
      t('cv_pa', 'PA em repouso (mmHg)'), t('cv_fc', 'FC em repouso (bpm)'), t('cv_spo2', 'SpO₂ (%)'),
      s('cv_nyha', 'Classe funcional (NYHA)', ['I — sem limitação', 'II — limitação leve', 'III — limitação acentuada', 'IV — sintomas em repouso']),
      t('cv_fe', 'Fração de ejeção (%) / laudo do ecocardiograma'),
      c('cv_fatores', 'Fatores de risco', ['Hipertensão', 'Diabetes', 'Dislipidemia', 'Tabagismo', 'Obesidade', 'Sedentarismo', 'Histórico familiar', 'Estresse']),
      t('cv_evento', 'Evento / procedimento', 'Ex.: IAM, angioplastia, revascularização em 10/10'),
      s('cv_edema', 'Edema de MMII (cacifo)', ['Ausente', '1+', '2+', '3+', '4+']),
      t('cv_pulsos', 'Pulsos periféricos / perfusão'),
      t('cv_ergometria', 'Teste ergométrico / ergoespirometria (FC máx, VO₂)'),
      t('cv_tc6', 'TC6 — distância (m), FC e PA finais'),
      t('cv_zona', 'Zona de treino prescrita (FC / Borg)', 'Ex.: 105–120 bpm, Borg 11–13'),
      t('cv_medicamentos', 'Betabloqueador / medicações que alteram a FC'),
    ],
    evolucao: [t('cv_pa', 'PA (mmHg) pré / pico / pós'), t('cv_fc', 'FC (bpm) pré / pico / pós'), t('cv_spo2', 'SpO₂ (%)'), s('cv_borg', 'Borg (esforço) no pico', BORG), t('cv_carga', 'Carga / tempo do treino aeróbico'), c('cv_sinais', 'Sinais / sintomas', ['Sem sintomas', 'Dor torácica', 'Palpitação', 'Tontura', 'Dispneia desproporcional', 'Arritmia'])],
  },
  neurologica: {
    label: 'Neurofuncional',
    avaliacao: [
      s('n_lado', 'Lado acometido', ['Direito', 'Esquerdo', 'Bilateral', 'Não se aplica']),
      s('n_consciencia', 'Nível de consciência', ['Alerta', 'Sonolento', 'Torporoso', 'Comatoso']),
      t('n_cognicao', 'Cognição (MEEM / MoCA)', 'Ex.: MEEM 24/30'),
      s('n_comunicacao', 'Comunicação', ['Preservada', 'Disartria', 'Afasia de expressão', 'Afasia de compreensão', 'Afasia mista']),
      ta('n_tonus', 'Tônus — Ashworth modificada', 'Ex.: flexores de cotovelo E 1+; flexores plantares E 2'),
      t('n_reflexos', 'Reflexos (profundos, Babinski, clônus)'),
      ta('n_sensibilidade', 'Sensibilidade (tátil, dolorosa, térmica, proprioceptiva)'),
      t('n_coordenacao', 'Coordenação (índex-nariz, calcanhar-joelho, diadococinesia)'),
      s('n_controle_tronco', 'Controle de tronco', ['Adequado', 'Parcial', 'Ausente']),
      c('n_transferencias', 'Transferências com independência', ['Rolar', 'Deitado para sentado', 'Sentado para de pé', 'Cama para cadeira', 'Ao vaso sanitário']),
      s('n_dispositivo', 'Dispositivo para marcha', ['Nenhum', 'Bengala', 'Bengala de 4 pontos', 'Andador', 'Cadeira de rodas', 'Não deambula']),
      ta('n_escalas', 'Escalas (Berg, TUG, Fugl-Meyer, MIF, Barthel, Rankin)', 'Ex.: Berg 38/56; TUG 21 s; Barthel 70', 3),
      t('n_disfagia', 'Deglutição / alimentação'),
    ],
    evolucao: [t('n_tonus', 'Tônus (Ashworth)'), s('n_controle_tronco', 'Controle de tronco', ['Adequado', 'Parcial', 'Ausente']), t('n_marcha', 'Marcha / distância / dispositivo'), t('n_escala', 'Escala reavaliada (se houver)')],
  },
  pediatrica: {
    label: 'Pediátrica / neonatal',
    avaliacao: [
      t('p_responsavel', 'Responsável que acompanha'),
      t('p_ig', 'Idade gestacional ao nascer (semanas)'), t('p_peso', 'Peso ao nascer (g)'), t('p_apgar', 'Apgar (1º / 5º min)'),
      s('p_parto', 'Tipo de parto', ['Vaginal', 'Cesárea', 'Fórceps']),
      ta('p_neonatal', 'Intercorrências neonatais (UTI, icterícia, hipóxia, ventilação)'),
      t('p_idade_corrigida', 'Idade corrigida (prematuros)'),
      c('p_marcos', 'Marcos motores já adquiridos', ['Controle cervical', 'Rolar', 'Sentar sem apoio', 'Arrastar', 'Engatinhar', 'Ficar de pé com apoio', 'Marcha independente', 'Correr', 'Pular']),
      s('p_tonus', 'Tônus', ['Normal', 'Hipotonia', 'Hipertonia', 'Flutuante']),
      t('p_reflexos', 'Reflexos primitivos / reações posturais'),
      ta('p_escalas', 'Escalas (AIMS, GMFM, GMFCS, Denver)', 'Ex.: AIMS percentil 10; GMFCS nível II'),
      ta('p_comportamento', 'Comportamento, interação e brincar'),
      t('p_escola', 'Escola / terapias associadas (TO, fono)'),
    ],
    evolucao: [t('p_habilidade', 'Habilidade motora trabalhada'), s('p_participacao', 'Participação na sessão', ['Colaborativa', 'Parcial', 'Pouco colaborativa', 'Chorosa / irritada']), t('p_orientacao_familia', 'Orientação à família')],
  },
  geriatrica: {
    label: 'Gerontológica',
    avaliacao: [
      t('g_quedas', 'Quedas nos últimos 12 meses (nº e circunstâncias)'),
      s('g_medo', 'Medo de cair (FES-I)', ['Baixo (16–19)', 'Moderado (20–27)', 'Alto (28–64)']),
      t('g_medicamentos', 'Nº de medicamentos em uso (polifarmácia ≥ 5)'),
      t('g_cognicao', 'Cognição (MEEM / Mini-Cog)'),
      t('g_katz', 'AVDs — Katz', 'Ex.: independente em 5/6'),
      t('g_lawton', 'AIVDs — Lawton', 'Ex.: 18/27'),
      t('g_tug', 'Timed Up and Go (s)'), t('g_berg', 'Berg (0–56)'), t('g_velocidade', 'Velocidade de marcha (m/s)'),
      t('g_sentar_levantar', 'Sentar e levantar 5x (s) ou 30 s (repetições)'), t('g_preensao', 'Força de preensão palmar (kgf)'),
      s('g_sarcf', 'SARC-F (rastreio de sarcopenia)', ['< 4 — baixo risco', '≥ 4 — sugestivo de sarcopenia']),
      c('g_ambiente', 'Riscos no ambiente domiciliar', ['Tapetes soltos', 'Pouca iluminação', 'Escadas sem corrimão', 'Banheiro sem barra de apoio', 'Piso escorregadio', 'Animais domésticos']),
      s('g_dispositivo', 'Dispositivo auxiliar', ['Nenhum', 'Bengala', 'Andador', 'Cadeira de rodas']),
    ],
    evolucao: [t('g_pa', 'PA (mmHg) pré / pós'), t('g_teste', 'Teste funcional realizado (TUG, SL5x…)'), s('g_queda', 'Queda desde a última sessão?', ['Não', 'Sim'])],
  },
  esportiva: {
    label: 'Esportiva',
    avaliacao: [
      t('e_modalidade', 'Modalidade / posição'), s('e_nivel', 'Nível', ['Recreativo', 'Amador competitivo', 'Profissional']),
      t('e_volume', 'Volume de treino (h/semana)'), s('e_temporada', 'Fase da temporada', ['Pré-temporada', 'Competitiva', 'Transição', 'Afastado']),
      t('e_lesoes_previas', 'Lesões prévias'),
      ta('e_testes', 'Testes funcionais (hop tests, Y-Balance, agachamento unipodal)', 'Ex.: single hop D 145 cm / E 170 cm', 3),
      t('e_lsi', 'Índice de simetria entre membros (LSI %)'),
      t('e_dinamometria', 'Dinamometria / força isocinética'),
      t('e_retorno', 'Objetivo / data prevista de retorno ao esporte'),
      ta('e_criterios', 'Critérios de retorno ao esporte'),
    ],
    evolucao: [t('e_carga', 'Carga de treino / PSE da sessão (0–10)'), t('e_teste', 'Teste funcional / LSI (%)'), s('e_fase', 'Fase da reabilitação', ['Proteção', 'Controle motor', 'Fortalecimento', 'Pliometria / agilidade', 'Retorno ao treino', 'Retorno ao jogo'])],
  },
  pelvica: {
    label: 'Saúde da mulher / pélvica',
    avaliacao: [
      c('u_queixa', 'Queixas', ['Incontinência urinária de esforço', 'Incontinência de urgência', 'Incontinência mista', 'Urgência / polaciúria', 'Noctúria', 'Incontinência fecal / de flatos', 'Constipação', 'Dor pélvica', 'Dispareunia', 'Prolapso (sensação de "bola")']),
      t('u_frequencia', 'Frequência miccional (dia / noite)'), t('u_protetor', 'Uso de protetor / absorvente (nº/dia)'),
      t('u_obstetrico', 'Histórico obstétrico (G P A / tipos de parto / episiotomia)'),
      s('u_gestante', 'Gestante / puérpera', ['Não', 'Gestante', 'Puérpera']), t('u_ig', 'Idade gestacional / tempo de pós-parto'),
      s('u_oxford', 'Força dos MAP — Oxford modificada', OXFORD),
      t('u_perfect', 'Esquema PERFECT (P / E / R / F / ECT)'),
      t('u_prolapso', 'Prolapso (POP-Q / grau)'),
      t('u_iciq', 'ICIQ-SF (pontuação)'),
      t('u_diario', 'Diário miccional (resumo)'),
      t('u_diastase', 'Diástase dos retos abdominais (cm)'),
    ],
    evolucao: [s('u_oxford', 'Força dos MAP (Oxford)', OXFORD), t('u_perdas', 'Perdas desde a última sessão'), t('u_recursos', 'Recursos utilizados (biofeedback, eletroestimulação, cones)')],
  },
  dermatofuncional: {
    label: 'Dermatofuncional',
    avaliacao: [
      s('d_tipo', 'Condição', ['Pós-operatório de cirurgia plástica', 'Linfedema', 'Cicatriz / queloide', 'Queimadura', 'Fibro edema geloide', 'Lipodistrofia', 'Envelhecimento cutâneo', 'Outra']),
      t('d_cirurgia', 'Procedimento / data / tempo de pós-operatório'),
      t('d_fototipo', 'Fototipo (Fitzpatrick)'),
      ta('d_perimetria', 'Perimetria (cm) por pontos de referência'),
      c('d_achados', 'Achados', ['Edema', 'Fibrose', 'Aderência', 'Seroma', 'Equimose', 'Hipoestesia', 'Hiperestesia', 'Discromia']),
      t('d_cicatriz', 'Cicatriz — escala de Vancouver / aspecto'),
      t('d_malha', 'Uso de malha compressiva / drenos'),
      t('d_registro', 'Registro fotográfico (consentido)', 'Ex.: sim, 3 ângulos'),
    ],
    evolucao: [t('d_perimetria', 'Perimetria (cm)'), c('d_achados', 'Achados', ['Edema', 'Fibrose', 'Aderência', 'Seroma']), t('d_recursos', 'Recursos (DLM, radiofrequência, ultrassom, bandagem)')],
  },
  reumatologica: {
    label: 'Reumatológica',
    avaliacao: [
      t('rm_doenca', 'Doença / tempo de diagnóstico'),
      ta('rm_articulacoes', 'Articulações acometidas (dor / edema / deformidade)'),
      t('rm_rigidez', 'Rigidez matinal (minutos)'),
      t('rm_fadiga', 'Fadiga (0–10)'),
      t('rm_escalas', 'Escalas (HAQ, DAS28, BASFI, FIQ)'),
      s('rm_atividade', 'Atividade da doença', ['Remissão', 'Baixa', 'Moderada', 'Alta / crise']),
      t('rm_protecao', 'Órteses / proteção articular'),
    ],
    evolucao: [t('rm_rigidez', 'Rigidez matinal (min)'), s('rm_atividade', 'Atividade da doença', ['Remissão', 'Baixa', 'Moderada', 'Alta / crise']), t('rm_fadiga', 'Fadiga (0–10)')],
  },
  oncologica: {
    label: 'Oncológica',
    avaliacao: [
      t('on_diagnostico', 'Diagnóstico / estadiamento'),
      c('on_tratamentos', 'Tratamentos', ['Cirurgia', 'Quimioterapia', 'Radioterapia', 'Hormonioterapia', 'Imunoterapia', 'Cuidados paliativos']),
      t('on_fase', 'Fase atual do tratamento'),
      s('on_ecog', 'Capacidade funcional (ECOG)', ['0 — ativo', '1 — restrição a esforço intenso', '2 — autocuidado, sem trabalho', '3 — autocuidado limitado', '4 — acamado']),
      t('on_linfedema', 'Linfedema — perimetria / volume'),
      t('on_neuropatia', 'Neuropatia periférica'),
      t('on_fadiga', 'Fadiga relacionada ao câncer (0–10)'),
      t('on_contraindicacoes', 'Plaquetas / hemoglobina / contraindicações do dia'),
    ],
    evolucao: [t('on_hemograma', 'Exames do dia (plaquetas, Hb)'), t('on_fadiga', 'Fadiga (0–10)'), t('on_linfedema', 'Perimetria do membro')],
  },
  intensiva: {
    label: 'Terapia intensiva / hospitalar',
    avaliacao: [
      t('ti_glasgow', 'Glasgow / RASS'),
      s('ti_suporte', 'Suporte ventilatório', ['Ar ambiente', 'Oxigenoterapia', 'VNI', 'VM invasiva — TOT', 'VM invasiva — TQT']),
      t('ti_parametros', 'Parâmetros (modo, FiO₂, PEEP, VC, FR)'),
      t('ti_gasometria', 'Gasometria (pH, PaO₂, PaCO₂, HCO₃, P/F)'),
      t('ti_mrc', 'Força — escore MRC (0–60)'),
      s('ti_mobilizacao', 'Nível de mobilização', ['0 — passiva no leito', '1 — ativa no leito', '2 — sentado à beira-leito', '3 — ortostatismo', '4 — transferência para poltrona', '5 — deambulação']),
      t('ti_dispositivos', 'Dispositivos (drenos, cateteres, DVA)'),
      s('ti_secrecao', 'Secreção traqueal', ['Ausente', 'Pequena', 'Moderada', 'Grande']),
    ],
    evolucao: [t('ti_parametros', 'Parâmetros ventilatórios'), t('ti_desmame', 'Desmame / TRE'), s('ti_mobilizacao', 'Mobilização alcançada', ['0 — passiva no leito', '1 — ativa no leito', '2 — sentado à beira-leito', '3 — ortostatismo', '4 — poltrona', '5 — deambulação'])],
  },
};
export const AREA_OPTIONS = Object.entries(AREAS).map(([k, a]) => [k, a.label]);
export const areaLabel = (k) => AREAS[k]?.label || '';

// Esquema completo de um registro: campos gerais + ficha da área (avaliação e evolução)
export function schemaFor(type, data = {}) {
  const base = SCHEMAS[type];
  const a = AREAS[data.area];
  if (!a || !a[type]) return base;
  const extra = a[type][0]?.type === 'section'
    ? [{ ...a[type][0], label: `${a.label} — ${a[type][0].label}` }, ...a[type].slice(1)]
    : [sec(`Ficha específica — ${a.label}`), ...a[type]];
  return type === 'avaliacao' ? [...base.slice(0, -1), ...extra, sec('Considerações finais'), base[base.length - 1]] : [...base, ...extra];
}

export function fieldValue(f, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return null;
  if (Array.isArray(v)) return v.join(', ');
  if (f.type === 'scale') return `${v}/10`;
  if (f.type === 'date') return v.split('-').reverse().join('/');
  return String(v);
}

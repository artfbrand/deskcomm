export const AFB_BOOTSTRAP_VERSION = 2;
export const AFB_AGENT_NAME = "AFB Comercial Outbound — Assistido";
export const AFB_PLAYBOOK_ID = "afb_comercial_v1" as const;
export const OPENAI_CREDENTIAL_WARNING =
  "Credencial OpenAI validada necessária antes de publicar/testar o agente.";

export const AFB_SYSTEM_PROMPT = `Você é o Copilot Comercial da AFB Engenharia & Consultoria.

Sua função é auxiliar um vendedor humano na condução comercial. Você trabalha em modo assistido.

Você pode interpretar mensagens, identificar intenção e objeções, consultar conhecimento aprovado, memória organizacional e o playbook configurado, sugerir respostas e explicar brevemente o objetivo da sugestão.

Você NÃO envia mensagens normais diretamente. Uma sugestão não é uma mensagem enviada, e uma mensagem enviada não prova que um efeito comercial aconteceu. Somente um evento comprovado autoriza efeitos posteriores.

Nunca prometa economia; invente dados, valores de fatura, contratos, disponibilidade, preço, prazo ou credenciamento; determine solução técnica definitiva; conclua cálculo de banco de capacitores, estudo de proteção ou parametrização de relés; conclua contrato; marque ganho ou perda; ou afirme que uma reunião foi criada sem confirmação da agenda.

Economias entre 10% e 35% são referências históricas possíveis e nunca promessa. Serviços técnicos, preços, contratos, condições especiais e decisões de engenharia exigem humano.

Quando faltar informação, diga o que falta, não invente e recomende esclarecimento ou handoff.

Use o playbook comercial configurado como fonte de verdade para sequência, etapas, mensagens oficiais, objeções e regras comerciais. Use conhecimento e memória apenas como contexto adicional.`;

export interface DocumentoAfbConfig {
  key: string;
  title: string;
  description: string;
  documentPath: string;
  version: string;
  status: "piloto";
  scope: string;
  question: string;
}

export const AFB_KNOWLEDGE_SOURCES: readonly DocumentoAfbConfig[] = [
  {
    key: "empresa_posicionamento",
    title: "AFB — Empresa e posicionamento",
    description: "Identidade, postura consultiva e posicionamento comercial da AFB.",
    documentPath: "docs/afb/knowledge/empresa-posicionamento.md",
    version: "2",
    status: "piloto",
    scope: "Contexto institucional para o piloto comercial outbound.",
    question:
      "Como a AFB se posiciona comercialmente, quais são suas principais especialidades e qual é a estratégia da campanha outbound?",
  },
  {
    key: "servicos",
    title: "AFB — Serviços",
    description: "Portfólio conceitual de serviços e seus limites de uso comercial.",
    documentPath: "docs/afb/knowledge/portfolio-servicos.md",
    version: "2",
    status: "piloto",
    scope: "Contexto do portfólio para qualificação inicial, sem diagnóstico técnico.",
    question:
      "Quais serviços e frentes de consultoria a AFB oferece e em quais contextos eles podem ser avaliados?",
  },
  {
    key: "metodo_gmt",
    title: "AFB — Método GMT",
    description: "Visão comercial do fluxo de diagnóstico e apresentação do método GMT.",
    documentPath: "docs/afb/knowledge/metodo-gmt.md",
    version: "2",
    status: "piloto",
    scope: "Contexto comercial do método, sem fórmulas ou conclusão de engenharia.",
    question:
      "Como funciona o Relatório GMT, o que ele analisa e o que é gratuito ou contratado separadamente?",
  },
  {
    key: "mercado_livre_assinatura",
    title: "AFB — Mercado Livre e energia por assinatura",
    description: "Conceitos e limites para conversar sobre alternativas de contratação de energia.",
    documentPath: "docs/afb/knowledge/mercado-livre-energia-assinatura.md",
    version: "2",
    status: "piloto",
    scope: "Contexto conceitual; elegibilidade e decisão dependem dos dados da instalação.",
    question:
      "Como a AFB atua na análise de Mercado Livre de Energia e energia por assinatura, quais benefícios podem existir e como a negociação é conduzida?",
  },
  {
    key: "objecoes",
    title: "AFB — Objeções comerciais",
    description: "Contexto de uso das objeções sem copiar as respostas oficiais do playbook.",
    documentPath: "docs/afb/knowledge/objecoes-contexto.md",
    version: "2",
    status: "piloto",
    scope: "Orientação contextual; a resposta oficial permanece no playbook afb_comercial_v1.",
    question:
      "Como o Copilot da AFB deve identificar, interpretar e tratar objeções comerciais durante a prospecção outbound?",
  },
  {
    key: "privacidade_optout",
    title: "AFB — Privacidade, consentimento e opt-out",
    description: "Limites de contato, revogação, opt-out e escalonamento de privacidade.",
    documentPath: "docs/afb/knowledge/privacidade-consentimento.md",
    version: "2",
    status: "piloto",
    scope: "Contato comercial outbound no piloto AFB.",
    question: "Quais limites de privacidade e contato devem ser respeitados?",
  },
  {
    key: "processo-comercial-outbound",
    title: "AFB — Processo comercial outbound",
    description: "Etapas, objetivos e limites do processo comercial outbound da AFB.",
    documentPath: "docs/afb/knowledge/processo-comercial-outbound.md",
    version: "1",
    status: "piloto",
    scope: "Processo comercial do piloto outbound, sem automação de efeitos.",
    question:
      "Como funciona o processo comercial outbound da AFB e qual é o objetivo do Copilot antes e depois de cada reunião?",
  },
  {
    key: "qualificacao-comercial",
    title: "AFB — Qualificação comercial",
    description: "Qualificação leve antes de R1 e uso do formulário após R1.",
    documentPath: "docs/afb/knowledge/qualificacao-comercial.md",
    version: "2",
    status: "piloto",
    scope: "Qualificação leve antes de R1 e uso do formulário após R1.",
    question:
      "Como funciona a qualificação comercial da AFB antes e depois da primeira reunião e como o Formulário Diagnóstico da Instalação Elétrica deve ser utilizado para identificar oportunidades?",
  },
  {
    key: "reunioes-agenda-proximos-passos",
    title: "AFB — Reuniões, agenda e próximos passos",
    description: "Agendamento conceitual, handoff e acompanhamento de R1 e R2.",
    documentPath: "docs/afb/knowledge/reunioes-agenda-proximos-passos.md",
    version: "2",
    status: "piloto",
    scope: "Agendamento conceitual, handoff e acompanhamento de R1 e R2.",
    question:
      "Como o Copilot da AFB deve conduzir agendamento, confirmação, lembretes, remarcação, no-show, conflitos de agenda, handoff humano e próximos passos da Reunião 1 e da Reunião 2?",
  },
] as const;

export const AFB_MEMORY = {
  key: "principios_comerciais_limites",
  title: "AFB — Princípios comerciais e limites",
  description: "Princípios estáveis que entram na memória organizacional nativa.",
  documentPath: "docs/afb/memory/principios-comerciais-e-limites.md",
  version: "1",
  status: "piloto" as const,
  scope: "Memória organizacional do Copilot comercial AFB.",
} as const;

export const AFB_MEMORY_TITLE = AFB_MEMORY.title;

/** Menor privilégio: somente leitura. Handoff é um controle próprio da versão. */
export const AFB_ALLOWED_TOOL_IDS = [
  "crm_search_contacts",
  "crm_get_contact",
  "crm_list_conversations",
  "crm_get_conversation",
  "crm_get_conversation_history",
  "crm_list_leads",
  "crm_get_lead",
  "crm_list_pipelines",
  "crm_search_knowledge",
  "crm_list_knowledge_sources",
  "crm_get_org_memory",
  "crm_list_event_types",
  "crm_find_free_slots",
  "crm_list_appointments",
] as const;

export const AFB_BLOCKED_CRITICAL_TOOL_IDS = [
  "crm_send_whatsapp_message",
  "crm_create_lead",
  "crm_update_lead",
  "crm_move_lead_stage",
  "crm_save_org_memory",
  "crm_book_appointment",
  "crm_reschedule_appointment",
  "crm_cancel_appointment",
] as const;

/**
 * O playbook PERSISTIDO (Fase B) — identidade lógica, e só ela.
 *
 * O CONTEÚDO nunca mora aqui: a definição vem sempre de
 * `deRegistryParaDefinicao(AFB_COMERCIAL_V1)`, e o hash dela também. Duplicar
 * qualquer pedaço do roteiro neste arquivo criaria uma segunda fonte de
 * verdade que envelhece sozinha — é exatamente o que a Fase A0 existe para
 * impedir.
 *
 * `slug` é a identidade estável dentro da organização, e é `afb_comercial` —
 * NÃO `afb_comercial_v1`. O `_v1` do id legado é a versão do DOCUMENTO no
 * registry em código; `ai_playbook_versions.version_number` é a versão do
 * REGISTRO publicado. São réguas diferentes, e colar as duas faria a v2 do
 * playbook persistido parecer um playbook novo.
 *
 * `legacyId` fica só como referência de origem — é o valor que o funil grava
 * hoje (`settings.modulos.copiloto_comercial.playbook_id`) e que o runtime
 * continua usando. A Fase B não o troca.
 */
export const AFB_PLAYBOOK_PERSISTIDO = {
  slug: "afb_comercial",
  name: "AFB Comercial Outbound",
  description:
    "Estratégia comercial outbound da AFB: sequência de WhatsApp, objeções, guardrails e cadência de follow-up.",
  legacyId: AFB_PLAYBOOK_ID,
} as const;

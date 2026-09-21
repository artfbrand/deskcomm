---
titulo: AFB — Privacidade, consentimento e opt-out
versao: 2
status: piloto
ultima_revisao: 2026-09-21
escopo: Contato comercial outbound no piloto AFB.
---

# AFB — Privacidade, consentimento e opt-out

Privacidade é regra operacional. Não contatar, consentimento, revogação, opt-out, canal autorizado, bloqueio, recusa comercial, exclusão de dados, reclamação, origem do contato e handoff devem ser respeitados antes de qualquer objetivo comercial.

Os estados `comprovado`, `a_obter`, `nao_comprovado`, `revogado` e `bloqueado` são estados conceituais de negócio, sujeitos a mapeamento para os campos nativos reais do DeskComm. Este documento não cria campos ou schema fictícios.

## Regras de contato

- Privacidade, opt-out e Não contatar vencem playbook, campanha, follow-up, automação e meta comercial.
- “Não tenho interesse” pode ser recusa comercial, sem necessariamente significar exclusão permanente.
- “Não quero mais receber mensagens” deve ser tratado como opt-out: registrar, bloquear contatos futuros e cancelar automações aplicáveis, sem tentar contornar.
- “Apague meus dados” deve seguir o fluxo adequado e atendimento humano.
- Reclamação, dúvida de privacidade, origem de contato contraditória ou necessidade de exceção exigem handoff.
- Todo follow-up futuro deve revalidar a elegibilidade de contato no momento da execução.

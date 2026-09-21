---
impacto: capacidade_nova
secao: adicionado
titulo: O piloto comercial AFB ganha um bootstrap seguro e repetível
---

Um comando administrativo agora prepara o Copilot comercial assistido da AFB sem duplicar dados: ele
configura o playbook no funil escolhido, seis materiais de conhecimento, a memória organizacional e,
quando credencial OpenAI validada, modelo e WhatsApp estão inequívocos, publica o agente nativo em modo
assistido.

Os conhecimentos e os princípios de memória do piloto agora vêm de documentos Markdown auditáveis
em `docs/afb/`. O bootstrap associa cada fonte por chave estável, registra versão e SHA-256, atualiza a
mesma fonte quando o conteúdo muda e solicita nova indexação sem copiar o playbook para o RAG.

O comando começa sempre em dry-run. Aplicar exige `--apply`, organização explícita e referências sem
ambiguidade. Ele não recebe nem mostra chaves, não cria follow-up, agenda ou skills e não habilita
ferramentas de envio ou alteração do CRM. A cadência vigente também registra D12 como WhatsApp; e-mail
fica para uma fase futura.

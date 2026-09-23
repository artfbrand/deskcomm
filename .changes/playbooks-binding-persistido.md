---
impacto: nada_mudou
secao: adicionado
titulo: Cada funil passa a guardar, no banco, qual playbook é o seu
---

Até agora a ligação entre um funil e o seu playbook comercial existia apenas como
um nome escrito na configuração do funil. Passa a existir também como um vínculo
de verdade no banco: o funil aponta para o registro do playbook, e o próprio banco
recusa apontar para o playbook de outra organização.

Quem cria esse vínculo é o provisionamento comercial, quando ele roda. O vínculo
antigo continua gravado e continua válido — os dois convivem, e nenhuma instalação
precisa ser convertida.

Nada muda no atendimento. As sugestões do copiloto continuam vindo exatamente da
mesma fonte de sempre; o vínculo novo serve, por enquanto, só para a conferência
que já roda em segundo plano — que agora sabe dizer, no registro técnico, se
conferiu pelo vínculo novo ou pelo antigo. Se o vínculo faltar, estiver
incompleto ou a conferência falhar, o copiloto segue funcionando igual.

Também não muda nada em modo de autonomia, cadastro de clientes, funis, envio de
mensagens ou em qualquer tela.

Nada a fazer pelo fluxo padrão: o `update.sh` aplica a mudança de banco antes de
subir a versão nova, nessa ordem.

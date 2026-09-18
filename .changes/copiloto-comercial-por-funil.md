---
impacto: capacidade_nova
secao: adicionado
titulo: Cada funil ganha o interruptor "Copiloto comercial"
---

Em **Configurações › Funis**, quem administra a organização passa a ver, ao lado do
vocabulário e dos campos de cada funil, o interruptor **Copiloto comercial**. Ele fica
gravado no próprio funil (`settings.modulos.copiloto_comercial.enabled`), então uma
organização pode ligá-lo num funil e deixar os outros como estão. Nesta versão o interruptor
só grava a preferência — o painel do copiloto na caixa de entrada chega numa versão
seguinte, e vai ler exatamente esta chave.

Salvar a configuração do funil continua preservando tudo o que já estava lá: campos, motivos
de perda, tags canônicas e qualquer outro módulo que venha a existir. A mudança fica
registrada na auditoria com o nome do módulo alterado, sem o valor.

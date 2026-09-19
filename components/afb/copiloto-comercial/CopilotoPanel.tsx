"use client";
/**
 * O painel do Copiloto Comercial — o SHELL: mostra em que ponto a conversa
 * está e o que falta para o copiloto agir. Nesta versão não há copy, botão de
 * inserir, objeção nem próxima ação: só contexto e estado, um por vez.
 *
 * Recebe o resultado do hook (`useCopilotoContexto`) por props — quem busca é
 * o `InboxLayout`, uma vez, e passa para a coluna do desktop e para a ficha
 * do celular. Buscar aqui dentro faria duas instâncias pedirem o mesmo
 * contexto.
 *
 * ─── Um estado por vez, e nenhum inventado ──────────────────────────────────
 *
 * Cada `status` da rota tem a sua tela. Onde o copiloto não pode agir, o
 * painel diz POR QUÊ e QUEM resolve (o atendente no CRM, o administrador na
 * configuração do funil) — nunca escolhe um lead, um playbook ou uma etapa
 * por conta própria. Ganho e perdido são finais: sem próxima etapa.
 *
 * Ids técnicos ficam em `data-*`, não em texto: quem lê a tela é quem atende.
 * Texto de dado (nome do lead, da coluna, perfil gravado) sai como está;
 * texto de interface passa por `t()`.
 */
import type { UseQueryResult } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { contextoNaoEncontrado } from "@/hooks/afb/useCopilotoContexto";
import type { ContextoDoCopiloto } from "@/lib/afb/copiloto/contrato";
import { papel } from "@/lib/afb/playbook/papeis";
import { metadadosDoPlaybook } from "@/lib/afb/playbooks/catalogo";
import { cn } from "@/lib/utils";

export type ResultadoDoContexto = Pick<UseQueryResult<ContextoDoCopiloto, unknown>, "data" | "error" | "isLoading" | "isError">;

interface Props {
  contexto: ResultadoDoContexto;
}

/** Bloco rótulo + valor — a unidade do painel. */
function Linha({ rotulo, children, testid }: { rotulo: string; children: React.ReactNode; testid?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{rotulo}</dt>
      <dd className="text-sm text-text" data-testid={testid}>
        {children}
      </dd>
    </div>
  );
}

/** Aviso com título e explicação; a forma (borda + título) carrega o sentido, não só a cor. */
function Aviso({ titulo, children, tom = "neutro" }: { titulo: string; children: React.ReactNode; tom?: "neutro" | "atencao" | "final" }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border p-3 text-sm",
        tom === "atencao" && "border-warning-border bg-warning-bg/40",
        tom === "final" && "border-border bg-muted/40",
        tom === "neutro" && "border-border",
      )}
    >
      <p className="font-medium text-text">{titulo}</p>
      <p className="mt-1 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

export function CopilotoPanel({ contexto }: Props) {
  const t = useT();
  const { data, error, isLoading, isError } = contexto;

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="copiloto-estado" data-estado="loading" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t("Carregando o contexto do copiloto…")}</span>
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    );
  }

  if (isError) {
    if (contextoNaoEncontrado(error)) {
      return (
        <div data-testid="copiloto-estado" data-estado="nao_encontrada">
          <Aviso titulo={t("Conversa não encontrada ou fora do seu acesso.")} tom="atencao">
            {t("O copiloto só funciona em conversas que você pode ver.")}
          </Aviso>
        </div>
      );
    }
    return (
      <div data-testid="copiloto-estado" data-estado="indisponivel">
        <Aviso titulo={t("Não foi possível carregar o copiloto agora.")} tom="atencao">
          {t("Tente de novo em instantes. Se continuar, avise quem administra o sistema.")}
        </Aviso>
      </div>
    );
  }

  if (!data) return null;

  const raiz = { "data-testid": "copiloto-estado", "data-estado": data.status } as const;

  switch (data.status) {
    case "no_contact":
      return (
        <div {...raiz}>
          <Aviso titulo={t("Esta conversa não tem contato vinculado.")}>
            {t("Sem contato não há oportunidade para o copiloto acompanhar.")}
          </Aviso>
        </div>
      );

    case "no_lead":
      return (
        <div {...raiz}>
          <Aviso titulo={t("Este contato ainda não tem uma oportunidade aberta.")}>
            {t("Crie a oportunidade no funil pela aba Contato para o copiloto acompanhar a conversa.")}
          </Aviso>
        </div>
      );

    case "ambiguous_lead":
      return (
        <div {...raiz} data-candidatos={data.candidate_lead_ids.length}>
          <Aviso titulo={t("Há mais de uma oportunidade ativa vinculada a este contato.")} tom="atencao">
            {t("Selecione ou organize a oportunidade correta no CRM antes de usar o copiloto. Ele não escolhe sozinho.")}
          </Aviso>
        </div>
      );

    case "inconsistent":
      return (
        <div {...raiz} data-motivo={data.reason}>
          <Aviso titulo={t("A oportunidade aponta para um funil ou uma etapa que não está disponível.")} tom="atencao">
            {t("Abra a oportunidade no CRM e confira o funil e a etapa dela.")}
          </Aviso>
        </div>
      );

    case "copilot_disabled":
      return (
        <div {...raiz}>
          <Aviso titulo={t("O copiloto comercial está desligado neste funil.")}>
            {t("Quem administra a organização liga o copiloto em Configurações › Funis.")}
          </Aviso>
        </div>
      );

    case "no_playbook":
      return (
        <div {...raiz}>
          <Aviso titulo={t("Este funil ainda não tem um playbook escolhido.")} tom="atencao">
            {t("Quem administra a organização escolhe o playbook do copiloto em Configurações › Funis.")}
          </Aviso>
        </div>
      );

    case "unknown_playbook":
      return (
        <div {...raiz} data-playbook-id={data.pipeline.playbook_id}>
          <Aviso titulo={t("O playbook configurado neste funil não está disponível nesta versão.")} tom="atencao">
            {t("Quem administra a organização precisa escolher outro playbook em Configurações › Funis.")}
          </Aviso>
        </div>
      );

    case "unmapped_stage":
      return (
        <div {...raiz} data-stage-id={data.stage.id}>
          <Aviso titulo={t("A etapa atual do funil ainda não foi mapeada para o copiloto.")} tom="atencao">
            {`${t("Etapa do funil")}: ${data.stage.name}. ${t("Quem administra a organização faz o mapeamento em Configurações › Funis.")}`}
          </Aviso>
        </div>
      );

    case "terminal_won":
      return (
        <div {...raiz}>
          <Aviso titulo={t("Oportunidade ganha.")} tom="final">
            {t("O copiloto comercial não sugere próxima etapa para uma oportunidade fechada.")}
          </Aviso>
          <dl className="mt-3 space-y-3">
            <Linha rotulo={t("Oportunidade")}>{data.lead.title}</Linha>
          </dl>
        </div>
      );

    case "terminal_lost":
      return (
        <div {...raiz}>
          <Aviso titulo={t("Oportunidade perdida.")} tom="final">
            {t("O copiloto comercial não sugere próxima etapa para uma oportunidade encerrada.")}
          </Aviso>
          <dl className="mt-3 space-y-3">
            <Linha rotulo={t("Oportunidade")}>{data.lead.title}</Linha>
          </dl>
        </div>
      );

    case "out_of_playbook": {
      const papelDaColuna = papel(data.stage.role);
      return (
        <div {...raiz} data-papel={data.stage.role}>
          <Aviso titulo={t("Esta etapa acontece fora do WhatsApp.")} tom="final">
            {t("Reunião, apresentação e fechamento não têm mensagem do playbook. O copiloto volta a sugerir quando a conversa retomar.")}
          </Aviso>
          <dl className="mt-3 space-y-3">
            <Linha rotulo={t("Oportunidade")}>{data.lead.title}</Linha>
            <Linha rotulo={t("Etapa do funil")}>{data.stage.name}</Linha>
            <Linha rotulo={t("Momento comercial")} testid="copiloto-papel">{t(papelDaColuna.titulo)}</Linha>
          </dl>
        </div>
      );
    }

    case "active": {
      const papelDaColuna = papel(data.stage.role);
      const meta = metadadosDoPlaybook(data.playbook.id);
      return (
        <div {...raiz} data-etapa-playbook={data.playbook.stage_id} data-origem={data.playbook.position_origin}>
          <dl className="space-y-3">
            <Linha rotulo={t("Etapa atual")} testid="copiloto-etapa">{data.playbook.title}</Linha>
            <Linha rotulo={t("Objetivo")} testid="copiloto-objetivo">{data.playbook.objective}</Linha>
            <Linha rotulo={t("Momento comercial")} testid="copiloto-papel">{t(papelDaColuna.titulo)}</Linha>
            {data.fields.perfil_interlocutor && (
              <Linha rotulo={t("Perfil do interlocutor")} testid="copiloto-perfil">{data.fields.perfil_interlocutor}</Linha>
            )}
            <Linha rotulo={t("Oportunidade")} testid="copiloto-lead">{data.lead.title}</Linha>
            <Linha rotulo={t("Etapa do funil")}>{data.stage.name}</Linha>
            <Linha rotulo={t("Playbook")} testid="copiloto-playbook">{meta?.nome ?? data.playbook.id}</Linha>
          </dl>
          {data.playbook.position_origin === "ajustada" && (
            <p className="mt-3 text-xs text-muted-foreground" role="status" data-testid="copiloto-aviso-ajuste">
              {t("A posição no playbook foi ajustada à etapa atual do funil.")}
            </p>
          )}
        </div>
      );
    }
  }
}

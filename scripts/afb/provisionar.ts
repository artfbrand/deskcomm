import { SupabaseAfbProvisioningRepository } from "@/lib/afb/provisionamento/repositorio-supabase";
import {
  ProvisioningInputError,
  provisionAfbCommercialOutbound,
  type ProvisioningOptions,
} from "@/lib/afb/provisionamento/provisionador";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ProvisioningInputError(`A opção ${flag} exige um valor.`);
  }
  return value;
}

export function parseProvisioningArgs(args: readonly string[]): ProvisioningOptions {
  const effectiveArgs = args[0] === "--" ? args.slice(1) : args;
  const known = new Set([
    "--organization",
    "--pipeline",
    "--credential",
    "--channel-session",
    "--model",
    "--apply",
  ]);
  for (const arg of effectiveArgs) {
    if (arg.startsWith("--") && !known.has(arg)) {
      throw new ProvisioningInputError(`Opção desconhecida: ${arg}.`);
    }
  }
  const organization = valueAfter(effectiveArgs, "--organization");
  if (!organization) {
    throw new ProvisioningInputError(
      "Informe --organization <uuid-ou-slug>. A organização é obrigatória.",
    );
  }
  return {
    organization,
    pipelineId: valueAfter(effectiveArgs, "--pipeline"),
    credentialId: valueAfter(effectiveArgs, "--credential"),
    channelSessionId: valueAfter(effectiveArgs, "--channel-session"),
    model: valueAfter(effectiveArgs, "--model"),
    apply: effectiveArgs.includes("--apply"),
  };
}

function formatReport(report: Awaited<ReturnType<typeof provisionAfbCommercialOutbound>>): string {
  const lines = [
    `Modo: ${report.mode}`,
    `Organização: ${report.organization.displayName} (${report.organization.slug}; ${report.organization.id})`,
    `Playbook: ${report.playbook}`,
    `Funil: ${report.pipeline ? `${report.pipeline.name} (${report.pipeline.id})` : "não resolvido"}`,
    `Funil \"Prospecção Outbound AFB\" encontrado: ${report.outboundPipelineFoundByName ? "sim" : "não"}`,
    `Credencial OpenAI validada: ${report.credential ? `${report.credential.label ?? "sem rótulo"} (${report.credential.id})` : "ausente"}`,
    `Sessão WhatsApp: ${report.channelSession ? `${report.channelSession.displayName ?? "sem nome"} (${report.channelSession.id})` : "não resolvida"}`,
    `Modelo: ${report.model ?? "não resolvido"}`,
    `Agente: ${report.agent.name} — ${report.agent.action}`,
    "Conhecimento:",
    ...report.knowledge.map(
      (item) =>
        `  - ${item.action}: ${item.name} ← ${item.documentPath} (sha256:${item.sha256.slice(0, 12)}…)`,
    ),
    `Memória: ${report.memory.action}: ${report.memory.title} ← ${report.memory.documentPath} (sha256:${report.memory.sha256.slice(0, 12)}…)`,
    "Alterações planejadas:",
    ...report.changes.map((change) => `  - ${change}`),
  ];
  if (report.warnings.length > 0) {
    lines.push("Avisos:", ...report.warnings.map((warning) => `  - ${warning}`));
  }
  lines.push(
    report.applied ? "Resumo: alterações aplicadas." : "Resumo: nenhuma alteração aplicada.",
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  try {
    const options = parseProvisioningArgs(process.argv.slice(2));
    const report = await provisionAfbCommercialOutbound(
      new SupabaseAfbProvisioningRepository(),
      options,
    );
    process.stdout.write(formatReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no bootstrap AFB.";
    process.stderr.write(`Erro: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();

import { describe, expect, it } from "vitest";
import { formatReport } from "@/scripts/afb/provisionar";
import type { ProvisioningReport } from "@/lib/afb/provisionamento/provisionador";
const base = (action: ProvisioningReport["persistedPlaybook"]["action"], reason: string): ProvisioningReport => ({
  mode: "dry-run", organization: { id: "o", slug: "afb", displayName: "AFB" }, playbook: "afb_comercial_v1",
  pipeline: null, outboundPipelineFoundByName: false, credential: null, channelSession: null, model: null,
  agent: { name: "A", readyToPublish: false, action: "pending_dependencies" }, knowledge: [],
  memory: { title: "M", documentPath: "p", sha256: "s", action: "unchanged" },
  persistedPlaybook: { slug: "afb_comercial", name: "AFB Comercial Outbound", sha256: "4f05ee7f80e0bee5", action, reason },
  changes: [], warnings: [], applied: false,
});
describe("dry-run mostra o playbook persistido", () => {
  it.each(["create", "unchanged", "conflict"] as const)("%s aparece com nome e slug", (acao) => {
    const texto = formatReport(base(acao, "motivo"));
    expect(texto).toContain("Playbook persistido:");
    expect(texto).toContain(`  - ${acao}: AFB Comercial Outbound (afb_comercial; sha256:4f05ee7f80e0…)`);
    expect(texto).toContain("Resumo: nenhuma alteração aplicada.");
  });
});

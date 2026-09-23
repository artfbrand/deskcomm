import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { AFB_KNOWLEDGE_SOURCES, AFB_MEMORY, type DocumentoAfbConfig } from "./configuracao";

export interface DocumentoAfbCarregado extends DocumentoAfbConfig {
  content: string;
  sha256: string;
}

export interface MemoriaAfbCarregada {
  key: string;
  title: string;
  description: string;
  documentPath: string;
  version: string;
  status: "piloto";
  scope: string;
  content: string;
  sha256: string;
}

export interface DocumentosAfbCarregados {
  knowledge: readonly DocumentoAfbCarregado[];
  memory: MemoriaAfbCarregada;
}

function conteudoCanonico(raw: string): string {
  return `${raw.replace(/\r\n/g, "\n").trim()}\n`;
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function caminhoSeguro(repositoryRoot: string, documentPath: string): string {
  const docsRoot = path.resolve(repositoryRoot, "docs", "afb");
  const resolved = path.resolve(repositoryRoot, documentPath);
  const relative = path.relative(docsRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved) !== ".md") {
    throw new Error(`Documento AFB fora de docs/afb ou sem extensão .md: ${documentPath}.`);
  }
  return resolved;
}

function validarMetadados(config: DocumentoAfbConfig, content: string): void {
  const required = [
    `titulo: ${config.title}`,
    `versao: ${config.version}`,
    `status: ${config.status}`,
    `escopo: ${config.scope}`,
  ];
  const missing = required.filter((line) => !content.includes(line));
  if (missing.length > 0) {
    throw new Error(`Metadados divergentes em ${config.documentPath}: ${missing.join(", ")}.`);
  }
}

async function carregar(
  repositoryRoot: string,
  config: DocumentoAfbConfig,
): Promise<DocumentoAfbCarregado> {
  const content = conteudoCanonico(
    await readFile(caminhoSeguro(repositoryRoot, config.documentPath), "utf8"),
  );
  validarMetadados(config, content);
  return { ...config, content, sha256: hash(content) };
}

export async function carregarDocumentosAfb(
  repositoryRoot: string = process.cwd(),
): Promise<DocumentosAfbCarregados> {
  const knowledge = await Promise.all(
    AFB_KNOWLEDGE_SOURCES.map((config) => carregar(repositoryRoot, config)),
  );
  const memoryConfig: DocumentoAfbConfig = {
    ...AFB_MEMORY,
    question: "Quais princípios comerciais e limites devem orientar o Copilot AFB?",
  };
  const memory = await carregar(repositoryRoot, memoryConfig);
  return { knowledge, memory };
}

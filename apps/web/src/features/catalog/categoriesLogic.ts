// Lógica PURA da tela administrativa de Categorias: tipos, validações que espelham o banco (só
// para dar retorno imediato; a autoridade é o backend) e tradução dos erros do banco para
// mensagens amigáveis. Sem React e sem Supabase, de propósito, para ser testada à parte. Mesmo
// padrão de sectorsLogic.ts / features/operations/adminLogic.ts.
import type { AdminSector } from "./sectorsLogic";

export interface AdminCategory {
  id: string;
  name: string;
  code: string;
  default_production_sector_id: string | null;
  sort_order: number;
  is_active: boolean;
  // Join do Supabase (default_sector:production_sectors(...)); null = sem setor padrão.
  default_sector: { id: string; name: string; code: string; is_active: boolean } | null;
}

export const CODE_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 60;

// Mesmo formato da CHECK product_categories_code_format: [A-Z0-9][A-Z0-9_-] até 32.
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

export const normalizeCode = (value: string): string => value.trim().toUpperCase();

export function validateCode(code: string): string | null {
  if (!code) return "Informe o código.";
  if (code.length > CODE_MAX_LENGTH) return `Use no máximo ${CODE_MAX_LENGTH} caracteres.`;
  if (!CODE_RE.test(code)) {
    return "Use letras maiúsculas, números, - e _, começando por letra ou número (ex.: BEBIDAS).";
  }
  return null;
}

export function validateName(name: string): string | null {
  if (!name) return "Informe o nome.";
  if (name.length > NAME_MAX_LENGTH) return `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  return null;
}

// Vazio vira 0 (o padrão do banco). Só inteiro; sem CHECK de faixa no banco, então nenhuma aqui.
export function parseSortOrder(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: 0, error: null };
  if (!/^-?\d+$/.test(trimmed)) return { value: null, error: "A ordem precisa ser um número inteiro." };
  return { value: Number(trimmed), error: null };
}

// As regras do banco levantam PT4xx com mensagem pronta em português: passam como vieram. As
// constraints mais comuns viram frase curta; o resto vira a mensagem genérica (o texto técnico
// não vai para a tela).
export function describeCategoryError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  if (code === "23505" && message.includes("product_categories_company_code_key")) {
    return "Já existe uma categoria com este código.";
  }
  if (code === "23503" && message.includes("product_categories_default_sector_fkey")) {
    return "Setor de produção inválido.";
  }
  if (code === "23514") {
    if (message.includes("product_categories_code_format")) {
      return "Código inválido. Use letras maiúsculas, números, - e _ (até 32 caracteres).";
    }
    if (message.includes("product_categories_name_length")) return "O nome deve ter de 1 a 60 caracteres.";
  }
  if (code === "42501") return "Você não tem permissão para alterar categorias.";
  return fallback;
}

export type CategoryFilter = "all" | "active" | "inactive";

// Minúsculas e sem acento.
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Busca por nome, código ou nome do setor padrão; o filtro escolhe ativos, inativos ou todos.
// Ordenada por sort_order e, em empate, por nome (mesma regra da migration 040000).
export function filterCategories(
  categories: AdminCategory[],
  { query, filter }: { query: string; filter: CategoryFilter },
): AdminCategory[] {
  const q = normalize(query.trim());
  return categories
    .filter((category) => {
      if (filter === "active" && !category.is_active) return false;
      if (filter === "inactive" && category.is_active) return false;
      if (!q) return true;
      const fields = [category.name, category.code, category.default_sector?.name ?? ""];
      return fields.some((field) => normalize(field).includes(q));
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "pt-BR"));
}

// "Bar" / "Bar (inativo)" — mesmo texto na lista e na edição, para nunca esconder um vínculo com
// setor desativado.
export function formatSectorLabel(sector: { name: string; is_active: boolean } | null): string {
  if (!sector) return "Sem setor padrão";
  return sector.is_active ? sector.name : `${sector.name} (inativo)`;
}

export interface SectorOption {
  id: string | null;
  label: string;
}

// Opções do <select> de setor padrão: sempre "Sem setor padrão" + setores ATIVOS. Para NOVA
// seleção só ativos entram (currentSectorId null). Na edição, se o setor hoje vinculado estiver
// INATIVO, ele entra também (identificado como "(inativo)") — assim o vínculo nunca fica
// escondido, mesmo que não possa ser escolhido de novo depois de trocado.
export function buildSectorOptions(sectors: AdminSector[], currentSectorId: string | null): SectorOption[] {
  const options: SectorOption[] = [{ id: null, label: "Sem setor padrão" }];
  for (const sector of sectors) {
    if (sector.is_active) options.push({ id: sector.id, label: sector.name });
  }
  const current = currentSectorId ? sectors.find((s) => s.id === currentSectorId) : null;
  if (current && !current.is_active) {
    options.push({ id: current.id, label: `${current.name} (inativo)` });
  }
  return options;
}

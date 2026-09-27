// Lógica PURA da tela administrativa de Setores de produção: tipos, validações que espelham o
// banco (só para dar retorno imediato; a autoridade é o backend) e tradução dos erros do banco
// para mensagens amigáveis. Sem React e sem Supabase, de propósito, para ser testada à parte.
// Mesmo padrão de features/operations/adminLogic.ts.

export interface AdminSector {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
}

export const CODE_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 60;

// Mesmo formato da CHECK production_sectors_code_format: [A-Z0-9][A-Z0-9_-] até 32.
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

export const normalizeCode = (value: string): string => value.trim().toUpperCase();

export function validateCode(code: string): string | null {
  if (!code) return "Informe o código.";
  if (code.length > CODE_MAX_LENGTH) return `Use no máximo ${CODE_MAX_LENGTH} caracteres.`;
  if (!CODE_RE.test(code)) {
    return "Use letras maiúsculas, números, - e _, começando por letra ou número (ex.: CHURRASQUEIRA).";
  }
  return null;
}

export function validateName(name: string): string | null {
  if (!name) return "Informe o nome.";
  if (name.length > NAME_MAX_LENGTH) return `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  return null;
}

// As regras do banco levantam PT4xx com mensagem pronta em português (ex.: a recusa de
// desativar setor em uso, vinda do trigger de 040000): passam como vieram. As constraints mais
// comuns viram frase curta; o resto vira a mensagem genérica (o texto técnico não vai para a tela).
export function describeSectorError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  if (code === "23505" && message.includes("production_sectors_company_code_key")) {
    return "Já existe um setor com este código.";
  }
  if (code === "23514") {
    if (message.includes("production_sectors_code_format")) {
      return "Código inválido. Use letras maiúsculas, números, - e _ (até 32 caracteres).";
    }
    if (message.includes("production_sectors_name_length")) return "O nome deve ter de 1 a 60 caracteres.";
  }
  if (code === "42501") return "Você não tem permissão para alterar setores de produção.";
  return fallback;
}

export type SectorFilter = "all" | "active" | "inactive";

// Minúsculas e sem acento.
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Busca por nome ou código; o filtro escolhe ativos, inativos ou todos. Ordenada por nome.
export function filterSectors(
  sectors: AdminSector[],
  { query, filter }: { query: string; filter: SectorFilter },
): AdminSector[] {
  const q = normalize(query.trim());
  return sectors
    .filter((sector) => {
      if (filter === "active" && !sector.is_active) return false;
      if (filter === "inactive" && sector.is_active) return false;
      if (!q) return true;
      return [sector.name, sector.code].some((field) => normalize(field).includes(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

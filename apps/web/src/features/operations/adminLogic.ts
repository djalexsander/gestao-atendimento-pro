// Lógica PURA da tela administrativa de Comandas / Mesas: tipos, validações que espelham o
// banco (só para dar retorno imediato; a autoridade é o backend), plano da geração em lote e
// tradução dos erros do banco para mensagens amigáveis. Sem React e sem Supabase, de propósito,
// para ser testada à parte.
import { EAN13_INTERNAL_RE, ean13CheckDigit, validateEan13AwareBarcode } from "../../lib/ean13";
import type { ServicePointType } from "./panel";

// Reexportadas por compatibilidade (o cálculo/formato em si agora mora em lib/ean13.ts,
// compartilhado com Produtos e futuros cadastros com barcode — ver migration 20260928010000).
export { EAN13_INTERNAL_RE, ean13CheckDigit };

export interface AdminServicePoint {
  id: string;
  type: ServicePointType;
  code: string;
  display_name: string;
  barcode: string | null;
  is_active: boolean;
}

export const TYPE_SINGULAR: Record<ServicePointType, string> = { command: "Comanda", table: "Mesa" };
export const TYPE_PLURAL_LOWER: Record<ServicePointType, string> = { command: "comandas", table: "mesas" };
export const DEFAULT_PREFIX: Record<ServicePointType, string> = { command: "CMD", table: "MESA" };

export const CODE_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 60;
export const BARCODE_MAX_LENGTH = 64;
export const BATCH_MAX = 200;

// Mesmo formato da CHECK service_points_code_format: [A-Z0-9][A-Z0-9_-] até 32.
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

export const normalizeCode = (value: string): string => value.trim().toUpperCase();

export function validateCode(code: string): string | null {
  if (!code) return "Informe o código.";
  if (code.length > CODE_MAX_LENGTH) return `Use no máximo ${CODE_MAX_LENGTH} caracteres.`;
  if (!CODE_RE.test(code)) {
    return "Use letras maiúsculas, números, - e _, começando por letra ou número (ex.: CMD001).";
  }
  return null;
}

export function validateDisplayName(name: string): string | null {
  if (!name) return "Informe o nome de exibição.";
  if (name.length > NAME_MAX_LENGTH) return `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  return null;
}

// Opcional: vazio é válido. Barcodes legados/próprios (fora do formato 200+13 dígitos) continuam
// liberados como já eram; só o formato interno tem o dígito verificador exigido (lib/ean13.ts).
export function validateBarcode(barcode: string): string | null {
  return validateEan13AwareBarcode(barcode, BARCODE_MAX_LENGTH);
}

// --- Geração em lote -----------------------------------------------------------------------

export interface BatchRow {
  type: ServicePointType;
  code: string;
  display_name: string;
}

export interface BatchPlan {
  rows: BatchRow[]; // o que será criado
  skipped: string[]; // códigos do intervalo que já existem (ficam de fora)
  error: string | null;
}

function toInt(value: string | number): number | null {
  const text = String(value).trim();
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

// Monta o lote: prefixo + número com zeros à esquerda (CMD001 ... CMD050), nome "Comanda 001".
// Comanda usa ao menos 3 dígitos e mesa ao menos 2 (CMD001 / MESA01); passa disso só se o número
// final pedir. Nada de código de barras. Códigos que já existem são pulados, não recusados.
export function planBatch(input: {
  type: ServicePointType;
  prefix: string;
  from: string | number;
  to: string | number;
  existingCodes: Iterable<string>;
}): BatchPlan {
  const fail = (error: string): BatchPlan => ({ rows: [], skipped: [], error });

  const prefix = normalizeCode(input.prefix);
  if (!prefix) return fail("Informe o prefixo.");
  if (!CODE_RE.test(prefix)) return fail("Prefixo inválido: use letras maiúsculas, números, - e _.");

  const from = toInt(input.from);
  const to = toInt(input.to);
  if (from === null || to === null || from < 1) return fail("Informe números inteiros, a partir de 1.");
  if (to < from) return fail("O número final deve ser maior ou igual ao inicial.");
  if (to - from + 1 > BATCH_MAX) return fail(`Gere no máximo ${BATCH_MAX} por vez.`);

  const width = Math.max(input.type === "command" ? 3 : 2, String(to).length);
  if (prefix.length + width > CODE_MAX_LENGTH) {
    return fail(`Prefixo longo demais: o código passaria de ${CODE_MAX_LENGTH} caracteres.`);
  }

  const existing = new Set([...input.existingCodes].map((code) => code.toUpperCase()));
  const rows: BatchRow[] = [];
  const skipped: string[] = [];
  for (let n = from; n <= to; n += 1) {
    const digits = String(n).padStart(width, "0");
    const code = `${prefix}${digits}`;
    if (existing.has(code)) skipped.push(code);
    else rows.push({ type: input.type, code, display_name: `${TYPE_SINGULAR[input.type]} ${digits}` });
  }
  if (rows.length === 0) return { rows, skipped, error: "Todos os códigos deste intervalo já existem." };
  return { rows, skipped, error: null };
}

const SKIPPED_LISTED = 6;

// Aviso da prévia sobre o que fica de fora: "1 já existe e será ignorada: CMD001." /
// "3 já existem e serão ignoradas: CMD001, CMD002, CMD003." Lista só os primeiros; o resto vira "e mais N".
export function describeSkipped(skipped: string[]): string {
  if (skipped.length === 0) return "";
  const many = skipped.length > 1;
  const listed = skipped.slice(0, SKIPPED_LISTED).join(", ");
  const rest = skipped.length - SKIPPED_LISTED;
  return `${skipped.length} ${many ? "já existem e serão ignoradas" : "já existe e será ignorada"}: ${listed}${rest > 0 ? ` e mais ${rest}` : ""}.`;
}

// --- Erros do banco -> mensagem amigável ------------------------------------------------------

// As regras do banco levantam PT4xx com mensagem pronta em português (ex.: "Há um atendimento
// aberto neste ponto. Feche-o antes de desativar."): passam como vieram. As constraints mais
// comuns viram frase curta; o resto vira a mensagem genérica (o texto técnico não vai para a tela).
export function describeServiceError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  if (code === "23505") {
    if (message.includes("service_points_company_barcode_key")) {
      return "Este código de barras já está em uso por outra comanda ou mesa.";
    }
    if (message.includes("service_points_company_code_key")) return "Já existe uma comanda ou mesa com este código.";
  }
  if (code === "23514") {
    if (message.includes("service_points_code_format")) {
      return "Código inválido. Use letras maiúsculas, números, - e _ (até 32 caracteres).";
    }
    if (message.includes("service_points_barcode_format")) {
      return "Código de barras inválido: sem espaços, até 64 caracteres.";
    }
    if (message.includes("service_points_display_name_length")) return "O nome de exibição deve ter de 1 a 60 caracteres.";
  }
  if (code === "42501") return "Você não tem permissão para alterar comandas e mesas.";
  return fallback;
}

// --- Lista ----------------------------------------------------------------------------------

export type ListFilter = "all" | "command" | "table" | "inactive";

// Minúsculas e sem acento.
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Busca por código, nome ou código de barras; o filtro escolhe o tipo ou só os inativos.
export function filterAdminPoints(
  points: AdminServicePoint[],
  { query, filter }: { query: string; filter: ListFilter },
): AdminServicePoint[] {
  const q = normalize(query.trim());
  return points.filter((point) => {
    if (filter === "command" || filter === "table") {
      if (point.type !== filter) return false;
    } else if (filter === "inactive" && point.is_active) {
      return false;
    }
    if (!q) return true;
    return [point.code, point.display_name, point.barcode ?? ""].some((field) => normalize(field).includes(q));
  });
}

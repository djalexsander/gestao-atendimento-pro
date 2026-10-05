// Regras PURAS do cadastro de Clientes (sem React, sem Supabase). O servidor é a autoridade (normalização,
// duplicidade, papéis); aqui há rótulos, máscaras, validação amigável de formulário e filtros.

export type CustomerType = "person" | "company";
export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = { person: "Pessoa física", company: "Empresa" };

export interface CustomerRow {
  id: string;
  type: CustomerType;
  name: string;
  document: string | null; // só dígitos
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  isActive: boolean;
  createdAt: string;
  visits: number;
  lastVisitAt: string | null;
  totalSpentCents: number;
}

export interface CustomerDetail {
  id: string;
  type: CustomerType;
  name: string;
  document: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  birthDate: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  visits: number;
  lastVisitAt: string | null;
  closedVisits: number;
  totalSpentCents: number;
  averageTicketCents: number;
  openReceivableCents: number;
  openReceivableCount: number;
}

export interface CustomersSummary {
  active: number;
  inactive: number;
  newThisMonth: number;
  recentVisits: number;
}

export interface CustomerOption {
  id: string;
  name: string;
  phoneLast4: string | null;
}

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
export const when = (iso: string): string => dateTime.format(new Date(iso));

// --- Máscaras (exibição) -------------------------------------------------------------------------

export const digitsOnly = (s: string): string => s.replace(/\D/g, "");

export function formatDocument(digits: string | null): string {
  if (!digits) return "";
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return digits;
}

export function formatPhone(digits: string | null): string {
  if (!digits) return "";
  const d = digits.length >= 12 && digits.startsWith("55") ? digits.slice(2) : digits; // +55 some da exibição
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
  if (d.length === 9) return d.replace(/^(\d{5})(\d{4})$/, "$1-$2");
  if (d.length === 8) return d.replace(/^(\d{4})(\d{4})$/, "$1-$2");
  return digits;
}

// Máscara enquanto digita (campo de documento: CPF até 11 dígitos, CNPJ até 14).
export function maskDocumentInput(value: string): string {
  return formatDocument(digitsOnly(value).slice(0, 14)) || digitsOnly(value).slice(0, 14);
}
export function maskPhoneInput(value: string): string {
  // +55 colado/digitado (mais de 11 dígitos começando por 55): o código do país sai, não vira DDD.
  let d = digitsOnly(value);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return d.replace(/^(\d{2})(\d+)$/, "($1) $2");
  if (d.length <= 10) return d.replace(/^(\d{2})(\d{4})(\d+)$/, "($1) $2-$3");
  return d.replace(/^(\d{2})(\d{5})(\d+)$/, "($1) $2-$3");
}

// --- Validação de CPF/CNPJ (mesmo algoritmo do servidor) ------------------------------------------

export function isValidDocument(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return false;
  const nums = digits.split("").map(Number);
  if (digits.length === 11) {
    const check = (len: number) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += nums[i] * (len + 1 - i);
      const r = (sum * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return check(9) === nums[9] && check(10) === nums[10];
  }
  if (digits.length === 14) {
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const check = (w: number[]) => {
      const sum = w.reduce((acc, weight, i) => acc + nums[i] * weight, 0) % 11;
      return sum < 2 ? 0 : 11 - sum;
    };
    return check(w1) === nums[12] && check(w2) === nums[13];
  }
  return false;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// --- Formulário ------------------------------------------------------------------------------------

export interface CustomerDraft {
  name: string;
  type: CustomerType;
  document: string;
  phone: string;
  whatsapp: string;
  sameWhatsapp: boolean; // "Usar o mesmo número no WhatsApp"
  email: string;
  birthDate: string; // yyyy-mm-dd ou ""
  notes: string;
}

export const EMPTY_DRAFT: CustomerDraft = {
  name: "",
  type: "person",
  document: "",
  phone: "",
  whatsapp: "",
  sameWhatsapp: false,
  email: "",
  birthDate: "",
  notes: "",
};

export function draftFromDetail(c: CustomerDetail): CustomerDraft {
  return {
    name: c.name,
    type: c.type,
    document: formatDocument(c.document),
    phone: formatPhone(c.phone),
    whatsapp: formatPhone(c.whatsapp),
    sameWhatsapp: !!c.phone && c.phone === c.whatsapp,
    email: c.email ?? "",
    birthDate: c.birthDate ?? "",
    notes: c.notes ?? "",
  };
}

export interface CustomerPayload {
  name: string;
  type: CustomerType;
  document: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  birthDate: string | null;
  notes: string | null;
}

function phoneProblem(label: string, digits: string): string | null {
  if (digits === "") return null;
  if (digits.length < 8 || digits.length > 13) return `${label} inválido. Informe o DDD e o número.`;
  return null;
}

export function validateDraft(draft: CustomerDraft, today: string): { error: string } | { payload: CustomerPayload } {
  const name = draft.name.trim().replace(/\s+/g, " ");
  if (name === "") return { error: "Informe o nome do cliente." };
  if (name.length > 80) return { error: "O nome pode ter no máximo 80 caracteres." };

  const document = digitsOnly(draft.document);
  if (document !== "" && !isValidDocument(document)) return { error: "CPF/CNPJ inválido. Confira os números." };

  const phone = digitsOnly(draft.phone);
  const whatsapp = draft.sameWhatsapp ? phone : digitsOnly(draft.whatsapp);
  const phoneError = phoneProblem("Telefone", phone) ?? phoneProblem("WhatsApp", whatsapp);
  if (phoneError) return { error: phoneError };

  const email = draft.email.trim().toLowerCase();
  if (email !== "" && (email.length > 254 || !EMAIL_RE.test(email))) return { error: "E-mail inválido." };

  if (draft.birthDate !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.birthDate) || draft.birthDate < "1900-01-01" || draft.birthDate > today) {
      return { error: "Data de nascimento inválida." };
    }
  }
  const notes = draft.notes.trim();
  if (notes.length > 1000) return { error: "As observações podem ter no máximo 1000 caracteres." };

  return {
    payload: {
      name,
      type: draft.type,
      document: document === "" ? null : document,
      phone: phone === "" ? null : phone,
      whatsapp: whatsapp === "" ? null : whatsapp,
      email: email === "" ? null : email,
      birthDate: draft.birthDate === "" ? null : draft.birthDate,
      notes: notes === "" ? null : notes,
    },
  };
}

// --- Filtros ---------------------------------------------------------------------------------------

export type StatusFilter = "all" | "active" | "inactive";
export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
];

export type TypeFilter = "all" | CustomerType;
export const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "Todos os tipos" },
  { value: "person", label: "Pessoa física" },
  { value: "company", label: "Empresa" },
];

export type SortKey = "name" | "recent" | "last_visit" | "spent";
export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "name", label: "Nome A-Z" },
  { value: "recent", label: "Mais recentes" },
  { value: "last_visit", label: "Último atendimento" },
  { value: "spent", label: "Maior gasto" },
];

export interface CustomerFilters {
  status: StatusFilter;
  type: TypeFilter;
  search: string;
  sort: SortKey;
}

export const DEFAULT_FILTERS: CustomerFilters = { status: "all", type: "all", search: "", sort: "name" };

export function hasActiveFilters(f: CustomerFilters): boolean {
  return f.status !== "all" || f.type !== "all" || f.search.trim() !== "";
}

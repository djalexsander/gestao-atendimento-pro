import { digitsOnly, formatDocument, formatPhone, isValidDocument, maskDocumentInput, maskPhoneInput } from "../customers/customersLogic";

// Regras PURAS de Configurações → Sistema / Preferências (sem React, sem Supabase). O servidor é a autoridade
// (papéis, validação, gravação atômica); aqui há rótulos, rascunho, detecção de alterações e validação amigável.

export type DefaultPointType = "ask" | "command" | "table";
export const DEFAULT_TYPE_OPTIONS: Array<{ value: DefaultPointType; label: string }> = [
  { value: "ask", label: "Perguntar / mostrar tudo (como hoje)" },
  { value: "command", label: "Priorizar comandas" },
  { value: "table", label: "Priorizar mesas" },
];

export type ServiceModeKey = "command" | "table" | "both";
export const SERVICE_MODE_LABEL: Record<ServiceModeKey, string> = {
  command: "Somente comandas",
  table: "Somente mesas",
  both: "Comandas e mesas",
};

// Preferências que as telas operacionais consomem (cards, abertura de atendimento).
export interface OperationalPreferences {
  defaultType: DefaultPointType;
  allowQuickCustomerCreate: boolean;
  showCustomerOnCard: boolean;
  compactCards: boolean;
}

// Empresa sem linha ou ainda sem resposta do servidor: o comportamento de sempre.
export const DEFAULT_OPERATIONAL_PREFERENCES: OperationalPreferences = {
  defaultType: "ask",
  allowQuickCustomerCreate: true,
  showCustomerOnCard: true,
  compactCards: true,
};

export interface SystemSettings {
  company: {
    name: string;
    slug: string;
    document: string | null; // só dígitos (ou texto livre antigo, preservado)
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
  };
  serviceMode: ServiceModeKey;
  preferences: OperationalPreferences;
  updatedAt: string | null;
  updatedByName: string | null;
  timezone: string;
  currency: string;
}

export interface SettingsDraft {
  name: string;
  document: string;
  phone: string;
  whatsapp: string;
  email: string;
  defaultType: DefaultPointType;
  allowQuickCustomerCreate: boolean;
  showCustomerOnCard: boolean;
  compactCards: boolean;
}

const isPlainDigits = (s: string) => /^\d+$/.test(s);

export function draftFromSettings(s: SystemSettings): SettingsDraft {
  const doc = s.company.document ?? "";
  return {
    name: s.company.name,
    document: isPlainDigits(doc) ? formatDocument(doc) : doc,
    phone: formatPhone(s.company.phone),
    whatsapp: formatPhone(s.company.whatsapp),
    email: s.company.email ?? "",
    defaultType: s.preferences.defaultType,
    allowQuickCustomerCreate: s.preferences.allowQuickCustomerCreate,
    showCustomerOnCard: s.preferences.showCustomerOnCard,
    compactCards: s.preferences.compactCards,
  };
}

// Máscara ao digitar: só enquanto o texto for de número/pontuação (texto livre antigo fica como está).
export const maskDocument = (v: string): string => (/[A-Za-z]/.test(v) ? v : maskDocumentInput(v));
export const maskPhone = maskPhoneInput;

const normalized = (d: SettingsDraft) => ({
  ...d,
  name: d.name.trim().replace(/\s+/g, " "),
  document: d.document.trim(),
  phone: digitsOnly(d.phone),
  whatsapp: digitsOnly(d.whatsapp),
  email: d.email.trim().toLowerCase(),
});

// "Alterações não salvas": compara o rascunho com o estado salvo já normalizado (formatar não conta como mudar).
export function isDirty(draft: SettingsDraft, saved: SettingsDraft): boolean {
  return JSON.stringify(normalized(draft)) !== JSON.stringify(normalized(saved));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface SettingsPayload {
  name: string;
  document: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  defaultType: DefaultPointType;
  allowQuickCustomerCreate: boolean;
  showCustomerOnCard: boolean;
  compactCards: boolean;
}

// `savedDocument`: o que já está salvo (pode ser texto livre antigo). Se não mudou, não revalida.
export function validateDraft(draft: SettingsDraft, savedDocument: string | null): { error: string } | { payload: SettingsPayload } {
  const n = normalized(draft);
  if (n.name === "") return { error: "Informe o nome da empresa." };
  if (n.name.length > 120) return { error: "O nome da empresa pode ter no máximo 120 caracteres." };

  const docDigits = digitsOnly(n.document);
  const savedDigits = digitsOnly(savedDocument ?? "");
  if (n.document !== "" && !(docDigits !== "" && docDigits === savedDigits) && !isValidDocument(docDigits)) {
    return { error: "CNPJ/CPF inválido. Confira os números." };
  }
  for (const [label, v] of [["Telefone", n.phone], ["WhatsApp", n.whatsapp]] as const) {
    if (v !== "" && (v.length < 8 || v.length > 13)) return { error: `${label} inválido. Informe o DDD e o número.` };
  }
  if (n.email !== "" && (n.email.length > 254 || !EMAIL_RE.test(n.email))) return { error: "E-mail inválido." };

  return {
    payload: {
      name: n.name,
      document: n.document === "" ? null : n.document,
      phone: n.phone === "" ? null : n.phone,
      whatsapp: n.whatsapp === "" ? null : n.whatsapp,
      email: n.email === "" ? null : n.email,
      defaultType: n.defaultType,
      allowQuickCustomerCreate: n.allowQuickCustomerCreate,
      showCustomerOnCard: n.showCustomerOnCard,
      compactCards: n.compactCards,
    },
  };
}

// Papéis que cadastram cliente sem depender da preferência de cadastro rápido.
export const CAN_ALWAYS_CREATE_CUSTOMER = ["owner", "admin"];

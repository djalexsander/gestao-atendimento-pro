// Apresentação dos Contatos do WhatsApp (Etapa 7.4): constantes, rótulos e pequenas regras de TELA. Sem React, sem Supabase.
// (A lógica de dados, busca e paginação está em whatsappContactsLogic.ts / whatsappContactsApi.ts, Etapa 7.3.)
import { formatWaPhone, listTime } from "./whatsappLogic";
import type { ContactRow } from "./whatsappContactsLogic";

/** Espera depois da última tecla antes de buscar. */
export const CONTACTS_DEBOUNCE_MS = 350;
export const CONTACTS_PAGE_SIZE = 30;
export const CONTACTS_BASE_PATH = "/operacional/whatsapp";
export const CONTACTS_PATH = `${CONTACTS_BASE_PATH}/contatos`;

/** Destino do botão "Abrir conversa". O parâmetro ?conversation= só passa a ser lido pela caixa de entrada na Etapa 7.5. */
export const conversationPath = (conversationId: string): string => `${CONTACTS_BASE_PATH}?conversation=${encodeURIComponent(conversationId)}`;

export const SOURCE_LABEL: Record<ContactRow["source"], string> = {
  conversation: "Conversa",
  customer: "Cliente cadastrado",
  both: "Conversa + cliente",
  manual: "Contato manual",
};

export const NAME_SOURCE_LABEL: Record<ContactRow["nameSource"], string> = {
  manual: "Nome cadastrado manualmente",
  customer: "Nome do cadastro do cliente",
  profile: "Nome do perfil do WhatsApp",
  phone: "Sem nome: só o telefone",
};

export const SEARCH_EXAMPLES: ReadonlyArray<{ label: string; example: string }> = [
  { label: "Nome", example: "Maria" },
  { label: "DDD", example: "44" },
  { label: "Final do telefone", example: "8888" },
  { label: "Telefone completo", example: "(44) 99999-8888" },
];

export const EMPTY_LIST_TEXT =
  "Ainda não há contatos. Eles aparecem quando alguém conversa com a empresa pelo WhatsApp ou quando um cliente é cadastrado com telefone.";
export const EMPTY_ARCHIVED_TEXT = "Nenhum contato arquivado. Contatos arquivados ficam aqui e podem ser restaurados por donos e administradores.";
export type ContactsFilter = "active" | "archived";
export const FILTER_LABEL: Record<ContactsFilter, string> = { active: "Ativos", archived: "Arquivados" };
const archivedFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" });
/** "Arquivado em 14/11/2026" (ou null sem data válida). */
export function archivedOnText(archivedAt: string | null): string | null {
  if (!archivedAt) return null;
  const d = new Date(archivedAt);
  return Number.isNaN(d.getTime()) ? null : `Arquivado em ${archivedFmt.format(d)}`;
}
export const NO_RESULTS_TEXT = "Nenhum contato encontrado para esta busca.";

/** Horário curto da última interação ("14:32" hoje, "05/11" antes), ou null quando não há mensagem. */
export function lastInteraction(c: Pick<ContactRow, "lastMessageAt" | "lastInboundAt">, now: Date = new Date()): string | null {
  const when = c.lastMessageAt ?? c.lastInboundAt;
  const t = when ? listTime(when, now) : "";
  return t === "" ? null : t;
}

/** Rótulo de cada fonte presente na linha (a ordem é a de ContactRow.sources). */
export const SOURCE_KIND_LABEL: Record<ContactRow["sources"][number], string> = {
  manual: "Contato manual",
  customer: "Cliente cadastrado",
  conversation: "Conversa",
};

/** Selos do cartão: um por fonte presente (um contato manual com conversa mostra os dois). */
export function sourceBadges(c: Pick<ContactRow, "sources">): string[] {
  return c.sources.map((k) => SOURCE_KIND_LABEL[k]);
}

/** Texto do vínculo com cliente mostrado no cartão (null = nada a mostrar). */
export function customerLinkText(c: Pick<ContactRow, "customerId" | "customerMatches" | "nameSource" | "source">): string | null {
  if (c.customerId !== null) {
    if (c.customerMatches > 1) return `${c.customerMatches} clientes com este número`;
    // cliente sem conversa: o selo "Cliente cadastrado" já diz tudo; "vinculado" só faz sentido quando há conversa
    return c.source === "customer" ? null : "Cliente vinculado";
  }
  return c.nameSource === "profile" ? "Sem cliente cadastrado" : null;
}

/**
 * Telefone como aparece no cartão. Telefone de CONVERSA vem em E.164 (com código do país) e segue formatWaPhone. Telefone de
 * CLIENTE cadastrado (source = "customer") vem SEM código do país: 10/11 dígitos são DDD + número do Brasil e aparecem como
 * "(11) 98888-7777" (nunca como "+11…", que pareceria número internacional); 8/9 dígitos (sem DDD) só ganham o hífen.
 * Mais de 11 dígitos (já com 55) e qualquer outro tamanho seguem formatWaPhone.
 */
export function formatContactPhone(c: Pick<ContactRow, "phone" | "source">): string {
  const d = c.phone.replace(/\D/g, "");
  if (c.source === "customer") {
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
    if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4)}`;
  }
  return formatWaPhone(c.phone);
}

// Abrir uma conversa pedida de fora da caixa de entrada (Etapa 7.5: tela Contatos → ?conversation=<id>). Lógica PURA, sem React nem Supabase.
// Regras: o id só vale se for um UUID; só se abre uma conversa que o servidor entregou para a EMPRESA ATIVA (a lista da empresa ou a
// consulta por id, ambas filtradas por empresa e pelo RLS: papel, módulo e conversa não excluída); qualquer outra coisa vira aviso e a
// seleção atual NÃO muda. Cada pedido (empresa + id) é tratado uma única vez.
import { applyFilter, type ConversationFilter, type ConversationRow } from "./whatsappLogic";

export const OPEN_REQUEST_NOT_FOUND_TEXT = "Não foi possível abrir essa conversa. Ela pode ter sido excluída ou não está disponível para você.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Id de conversa válido (UUID). Qualquer outro texto nunca chega ao servidor. */
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Identidade de um pedido: o mesmo id em outra empresa é outro pedido. */
export const openRequestKey = (companyId: string, conversationId: string): string => `${companyId}:${conversationId}`;

export type OpenPlan =
  | { kind: "invalid" } // não é UUID
  | { kind: "found"; row: ConversationRow } // já está na lista DESTA empresa
  | { kind: "fetch" }; // pode estar além do limite da lista: confirmar no servidor

/**
 * Decide como resolver o pedido. A lista só vale se foi carregada para a empresa ativa (durante a troca de empresa ela ainda pode
 * ser a da empresa anterior: nesse caso vai ao servidor, que filtra pela empresa certa).
 */
export function planOpenRequest(input: {
  requestedId: string;
  companyId: string;
  listCompanyId: string | null;
  conversations: readonly ConversationRow[] | null;
}): OpenPlan {
  if (!isConversationId(input.requestedId)) return { kind: "invalid" };
  if (input.listCompanyId === input.companyId && input.conversations) {
    const row = input.conversations.find((c) => c.id === input.requestedId);
    if (row) return { kind: "found", row };
  }
  return { kind: "fetch" };
}

/** Garante que a conversa aberta apareça na lista: limpa a busca e, se ainda assim o filtro a esconder, usa "Todas". */
export function revealConversation(
  row: ConversationRow,
  filter: ConversationFilter,
  search: string,
  userId: string | null,
): { filter: ConversationFilter; search: string } {
  if (applyFilter([row], filter, search, userId).length > 0) return { filter, search };
  if (applyFilter([row], filter, "", userId).length > 0) return { filter, search: "" };
  return { filter: "all", search: "" };
}

/** Acrescenta a conversa "fixada" (pedida de fora e além do limite da lista) sem duplicar. */
export function withPinned(list: readonly ConversationRow[], pinned: ConversationRow | null): ConversationRow[] {
  if (!pinned || list.some((c) => c.id === pinned.id)) return [...list];
  return [...list, pinned];
}

/** Consulta por id (a da fonte de dados): `data` nulo sem erro = não existe, foi excluída, é de outra empresa ou sem permissão. */
export type FetchConversationById = (companyId: string, conversationId: string) => Promise<{ data: ConversationRow | null; error: string | null }>;

/**
 * Resolve o pedido até uma conversa que o servidor entregou para a empresa, ou null (nunca lança). Id inválido não chega ao servidor.
 * Falha de rede/erro do servidor também vira null: a tela avisa e NÃO seleciona outra conversa no lugar.
 */
export async function resolveOpenRequest(input: {
  requestedId: string;
  companyId: string;
  listCompanyId: string | null;
  conversations: readonly ConversationRow[] | null;
  fetchById?: FetchConversationById;
}): Promise<ConversationRow | null> {
  const plan = planOpenRequest(input);
  if (plan.kind === "invalid") return null;
  if (plan.kind === "found") return plan.row;
  if (!input.fetchById) return null;
  try {
    const r = await input.fetchById(input.companyId, input.requestedId);
    return r.error ? null : r.data;
  } catch {
    return null;
  }
}

export type OpenOutcome =
  | { action: "notice" } // não foi possível abrir: aviso discreto, seleção intacta
  | { action: "skip" } // a pessoa escolheu outra conversa enquanto isso: a escolha dela vence
  | { action: "open"; pin: boolean }; // abrir; pin = fixar (está além do limite da lista)

/** Decide o que fazer quando a resolução termina. */
export function decideOpenOutcome(input: {
  row: ConversationRow | null;
  selectionAtStart: string | null;
  selectionNow: string | null;
  inList: boolean;
}): OpenOutcome {
  if (!input.row) return { action: "notice" };
  if (input.selectionNow !== input.selectionAtStart) return { action: "skip" };
  return { action: "open", pin: !input.inList };
}

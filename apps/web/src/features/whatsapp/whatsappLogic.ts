// Regras PURAS do inbox de WhatsApp (sem React/Supabase): formatação, filtros, ordenação e mensagens. Fase 2A-1: SOMENTE
// leitura. O telefone no banco é E.164 só com dígitos (ex.: 5544999990001); a máscara é só de exibição.
import type { CompanyRole } from "../../lib/types";

export type ConversationStatus = "open" | "waiting" | "closed";
export type MessageType = "text" | "image" | "audio" | "document" | "location" | "interactive" | "template" | "unknown";
export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
export type Direction = "inbound" | "outbound";
export type ConversationFilter = "open" | "mine" | "unassigned" | "waiting" | "closed" | "unread" | "all";

export interface RawConversation {
  id: string;
  contact_phone: string;
  contact_display_name: string | null;
  customer_id: string | null;
  status: ConversationStatus;
  assigned_user_id: string | null;
  unread_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
}
export interface ConversationRow {
  id: string;
  phone: string;
  name: string | null;
  customerId: string | null;
  status: ConversationStatus;
  assignedUserId: string | null;
  unread: number;
  preview: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
}
export interface RawMessage {
  id: string;
  conversation_id: string;
  direction: Direction;
  type: MessageType;
  body: string | null;
  status: MessageStatus;
  provider_timestamp: string | null;
  created_at: string;
}
export interface MessageRow {
  id: string;
  conversationId: string;
  direction: Direction;
  type: MessageType;
  body: string | null;
  status: MessageStatus;
  at: string;
}
export interface CustomerHint {
  id: string;
  name: string;
  phoneLast4: string;
}
export interface Suggestions {
  linked: CustomerHint | null;
  suggestions: CustomerHint[];
}
export interface ConnectionSummary {
  configured: boolean;
  status: string | null;
  mode: "test" | "live" | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
}

export const FILTER_LABEL: Record<ConversationFilter, string> = {
  open: "Abertas",
  mine: "Minhas",
  unassigned: "Não atribuídas",
  waiting: "Aguardando",
  closed: "Fechadas",
  unread: "Não lidas",
  all: "Todas",
};
export const FILTER_ORDER: readonly ConversationFilter[] = ["open", "mine", "unassigned", "unread", "waiting", "closed", "all"];
export const STATUS_LABEL: Record<ConversationStatus, string> = { open: "Aberta", waiting: "Aguardando", closed: "Fechada" };

/** Papéis que enxergam o WhatsApp (espelha o banco: production e courier ficam de fora). */
export const WHATSAPP_ROLES: readonly CompanyRole[] = ["owner", "admin", "attendant", "cashier"];
export const canUseWhatsapp = (role: CompanyRole | null | undefined): boolean => !!role && WHATSAPP_ROLES.includes(role);

export function toConversation(r: RawConversation): ConversationRow {
  return {
    id: r.id,
    phone: r.contact_phone,
    name: r.contact_display_name,
    customerId: r.customer_id,
    status: r.status,
    assignedUserId: r.assigned_user_id ?? null,
    unread: Number(r.unread_count) || 0,
    preview: r.last_message_preview,
    lastMessageAt: r.last_message_at,
    lastInboundAt: r.last_inbound_at ?? null,
  };
}

export function toMessage(r: RawMessage): MessageRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    type: r.type,
    body: r.body,
    status: r.status,
    at: r.provider_timestamp ?? r.created_at,
  };
}

/** E.164 só dígitos => "+55 (44) 99999-0001". Fora do padrão brasileiro devolve "+dígitos". */
export function formatWaPhone(digits: string | null | undefined): string {
  const d = String(digits ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const cut = rest.length - 4;
    return `+55 (${ddd}) ${rest.slice(0, cut)}-${rest.slice(cut)}`;
  }
  return `+${d}`;
}

export function conversationTitle(c: Pick<ConversationRow, "name" | "phone">): string {
  return c.name?.trim() || formatWaPhone(c.phone);
}

export function matchesFilter(c: ConversationRow, filter: ConversationFilter, currentUserId: string | null): boolean {
  switch (filter) {
    case "open":
      return c.status !== "closed"; // "abertas" = tudo que ainda não foi fechado (inclui aguardando)
    case "waiting":
      return c.status === "waiting";
    case "closed":
      return c.status === "closed";
    case "unread":
      return c.unread > 0;
    case "mine":
      return currentUserId !== null && c.assignedUserId === currentUserId && c.status !== "closed";
    case "unassigned":
      return c.assignedUserId === null && c.status !== "closed";
    default:
      return true;
  }
}

export function applyFilter(rows: readonly ConversationRow[], filter: ConversationFilter, search = "", currentUserId: string | null = null): ConversationRow[] {
  const q = search.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return rows
    .filter((c) => matchesFilter(c, filter, currentUserId))
    .filter((c) => {
      if (!q) return true;
      return (c.name ?? "").toLowerCase().includes(q) || (digits !== "" && c.phone.includes(digits));
    })
    .sort((a, b) => {
      const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return tb - ta || a.id.localeCompare(b.id);
    });
}

export function totalUnread(rows: readonly ConversationRow[]): number {
  return rows.reduce((n, c) => n + c.unread, 0);
}

/** Texto da bolha: o conteúdo textual, ou o rótulo do tipo (mídia ainda não é baixada nesta fase). */
export function messageText(m: Pick<MessageRow, "type" | "body">): string {
  const label: Record<MessageType, string> = {
    text: "Mensagem recebida",
    image: "Imagem recebida",
    audio: "Áudio recebido",
    document: "Documento recebido",
    location: "Localização recebida",
    interactive: "Resposta recebida",
    template: "Mensagem modelo",
    unknown: "Mensagem recebida",
  };
  if (m.type === "text" || m.type === "interactive") return m.body ?? label[m.type];
  return m.body ? `${label[m.type]} — ${m.body}` : label[m.type];
}

export const isMediaType = (t: MessageType): boolean => t === "image" || t === "audio" || t === "document" || t === "location";

const STATUS_TEXT: Partial<Record<MessageStatus, string>> = {
  queued: "Na fila",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};
/** Só mensagens enviadas pela empresa têm status a mostrar. */
export function statusText(m: Pick<MessageRow, "direction" | "status">): string | null {
  return m.direction === "outbound" ? (STATUS_TEXT[m.status] ?? null) : null;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Hoje: hora; mais antigo: dia/mês. */
export function listTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? formatClock(iso) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function toSuggestions(raw: unknown): Suggestions {
  const o = (raw && typeof raw === "object" ? raw : {}) as { linked?: unknown; suggestions?: unknown };
  const hint = (v: unknown): CustomerHint | null => {
    if (!v || typeof v !== "object") return null;
    const x = v as { id?: unknown; name?: unknown; phone_last4?: unknown };
    return typeof x.id === "string" && typeof x.name === "string"
      ? { id: x.id, name: x.name, phoneLast4: typeof x.phone_last4 === "string" ? x.phone_last4 : "" }
      : null;
  };
  return {
    linked: hint(o.linked),
    suggestions: Array.isArray(o.suggestions) ? o.suggestions.map(hint).filter((h): h is CustomerHint => h !== null) : [],
  };
}

export function toConnectionSummary(raw: unknown): ConnectionSummary {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    configured: o.configured === true,
    status: typeof o.status === "string" ? o.status : null,
    mode: o.mode === "live" ? "live" : o.mode === "test" ? "test" : null,
    displayPhoneNumber: typeof o.display_phone_number === "string" ? o.display_phone_number : null,
    businessName: typeof o.business_name === "string" ? o.business_name : null,
  };
}

// ---- Janela de atendimento (espelha whatsapp_can_send_freeform; o servidor é quem decide de verdade) ----
export const WINDOW_HOURS = 24;
export interface WindowState {
  open: boolean;
  expiresAt: string | null;
  reason: "no_inbound" | "window_closed" | null;
}
export function windowState(lastInboundAt: string | null | undefined, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { open: false, expiresAt: null, reason: "no_inbound" };
  const t = Date.parse(lastInboundAt);
  if (Number.isNaN(t)) return { open: false, expiresAt: null, reason: "no_inbound" };
  const end = t + WINDOW_HOURS * 3600 * 1000;
  const expiresAt = new Date(end).toISOString();
  return now.getTime() <= end ? { open: true, expiresAt, reason: null } : { open: false, expiresAt, reason: "window_closed" };
}

export const OUTSIDE_WINDOW_TEXT = "Fora da janela de atendimento. Será necessário usar um template aprovado.";
export const MAX_BODY_LENGTH = 4096;

export type ComposerBlock = "closed" | "window" | "empty" | "too_long" | null;
/** Por que o composer não pode enviar agora (null = pode). */
export function composerBlock(c: Pick<ConversationRow, "status" | "lastInboundAt">, body: string, now: Date = new Date()): ComposerBlock {
  if (c.status === "closed") return "closed";
  if (!windowState(c.lastInboundAt, now).open) return "window";
  const text = body.trim();
  if (text.length === 0) return "empty";
  if (text.length > MAX_BODY_LENGTH) return "too_long";
  return null;
}

export function windowLabel(w: WindowState): string {
  return w.open && w.expiresAt ? `Janela aberta até ${formatClock(w.expiresAt)}` : "Janela de atendimento encerrada";
}

// ---- Ações da conversa ----
export interface AgentOption {
  userId: string;
  name: string;
  role: string;
}
const ROLE_LABEL: Record<string, string> = { owner: "Proprietário", admin: "Administrador", attendant: "Atendente", cashier: "Caixa" };
export const agentLabel = (a: AgentOption): string => `${a.name} (${ROLE_LABEL[a.role] ?? a.role})`;

export function toAgents(raw: unknown): AgentOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentOption[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as { user_id?: unknown; name?: unknown; role?: unknown };
    if (typeof o.user_id === "string" && typeof o.name === "string" && typeof o.role === "string") out.push({ userId: o.user_id, name: o.name, role: o.role });
  }
  return out;
}

export interface StatusAction {
  to: ConversationStatus;
  label: string;
}
/** Ações de situação permitidas a partir do estado atual (espelha as transições do banco). */
export function statusActions(status: ConversationStatus): StatusAction[] {
  switch (status) {
    case "open":
      return [{ to: "waiting", label: "Aguardar" }, { to: "closed", label: "Fechar" }];
    case "waiting":
      return [{ to: "open", label: "Retomar" }, { to: "closed", label: "Fechar" }];
    default:
      return [{ to: "open", label: "Reabrir" }];
  }
}

/** Mensagem do erro do envio sem expor nada técnico. */
export function friendlySendError(message: string | null | undefined): string {
  const m = (message ?? "").trim();
  if (m && !/^(Edge Function|FunctionsHttpError|FunctionsFetchError|Failed to|TypeError|AuthApiError)/i.test(m) && m.length <= 200) return m;
  return "Não foi possível enviar a mensagem agora. Tente novamente.";
}

import { supabase } from "../../lib/supabaseClient";
import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { subscribeToOpenAttendanceChanges } from "../operations/openSessionsRealtime";
import {
  friendlyAiError,
  friendlySendError,
  toAiMode,
  type AiMode,
  toAgents,
  toConnectionSummary,
  toConversation,
  toMessage,
  toSuggestions,
  type AgentOption,
  type ConnectionSummary,
  type ConversationRow,
  type ConversationStatus,
  type MessageRow,
  type RawConversation,
  type RawMessage,
  type Suggestions,
} from "./whatsappLogic";

export type Result<T> = { data: T; error: null } | { data: null; error: string };

export interface SendOutcome {
  messageId: string | null;
  status: string;
}

// Fase 2A-2: leitura + operação da conversa (RPCs) + envio manual de texto (Edge whatsapp-send).
export interface WhatsappSource {
  summary(companyId: string): Promise<Result<ConnectionSummary>>;
  conversations(companyId: string): Promise<Result<ConversationRow[]>>;
  messages(companyId: string, conversationId: string): Promise<Result<MessageRow[]>>;
  suggestions(conversationId: string): Promise<Result<Suggestions>>;
  markRead(conversationId: string): Promise<Result<null>>;
  agents(companyId: string): Promise<Result<AgentOption[]>>;
  assign(conversationId: string, userId: string | null): Promise<Result<null>>;
  setStatus(conversationId: string, status: ConversationStatus): Promise<Result<null>>;
  linkCustomer(conversationId: string, customerId: string | null): Promise<Result<null>>;
  send(conversationId: string, body: string, clientRequestId: string): Promise<Result<SendOutcome>>;
  /** IA (Fase 1): modo efetivo da empresa e SUGESTÃO de texto. Opcionais: fontes simuladas antigas continuam válidas. */
  aiMode?(companyId: string): Promise<Result<AiMode>>;
  aiSuggest?(conversationId: string): Promise<Result<string>>;
  /** IA automática (Fase 2): 'human' = Assumir atendimento (pausa a IA); 'inherit' = Devolver para IA (também desatribui). */
  setAiControl?(conversationId: string, control: "human" | "inherit"): Promise<Result<null>>;
  /** Excluir conversa (soft delete; só owner/admin; o banco deriva a empresa da conversa). Opcional: fontes simuladas antigas seguem válidas. */
  deleteConversation?(conversationId: string): Promise<Result<null>>;
  subscribe(companyId: string, onChange: () => void): () => void;
}

const GENERIC = "Não foi possível carregar o WhatsApp agora. Tente novamente.";
const NOT_AVAILABLE = "O WhatsApp não está disponível para a sua empresa.";

function fail<T>(error: { code?: string | null; message?: string | null }): Result<T> {
  console.error("Falha no WhatsApp:", error.code ?? "sem código"); // nunca registra telefone nem conteúdo
  if (error.code === "PT403" || /não está contratado|permissão/i.test(error.message ?? "")) return { data: null, error: NOT_AVAILABLE };
  return { data: null, error: GENERIC };
}

// Ações do atendente: as mensagens PT400/403/404/409 do banco são amigáveis e seguem para a tela.
function failAction<T>(error: { code?: string | null; message?: string | null }): Result<T> {
  console.error("Falha na ação do WhatsApp:", error.code ?? "sem código");
  if (error.code && /^PT40\d$/.test(error.code) && error.message) return { data: null, error: error.message };
  return { data: null, error: "Não foi possível concluir a ação agora. Tente novamente." };
}

// Corpo de erro da Edge (FunctionsHttpError.context é a Response): { error, message_id?, status? }.
async function edgeError(error: unknown): Promise<{ message: string | null; messageId: string | null }> {
  try {
    const ctx = (error as { context?: { json?: () => Promise<unknown> } }).context;
    if (ctx?.json) {
      const body = (await ctx.json()) as { error?: unknown; message_id?: unknown } | null;
      return {
        message: typeof body?.error === "string" ? body.error : null,
        messageId: typeof body?.message_id === "string" ? body.message_id : null,
      };
    }
  } catch {
    // corpo ilegível: cai no genérico
  }
  return { message: null, messageId: null };
}

const CONVERSATION_COLUMNS =
  "id, contact_phone, contact_display_name, customer_id, status, assigned_user_id, unread_count, last_message_preview, last_message_at, last_inbound_at, ai_control, ai_handoff_reason";
const MESSAGE_COLUMNS = "id, conversation_id, direction, type, body, status, provider_timestamp, created_at, origin";
const MESSAGE_LIMIT = 200;

export const supabaseWhatsappSource: WhatsappSource = {
  async summary(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_get_connection_summary", { p_company_id: companyId });
    if (error) return fail(error);
    return { data: toConnectionSummary(data), error: null };
  },
  async conversations(companyId) {
    const { data, error } = await supabase
      .from("whatsapp_conversations")
      .select(CONVERSATION_COLUMNS)
      .eq("company_id", companyId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) return fail(error);
    return { data: ((data ?? []) as unknown as RawConversation[]).map(toConversation), error: null };
  },
  async messages(companyId, conversationId) {
    // as MAIS RECENTES (limite), exibidas em ordem cronológica
    const { data, error } = await supabase
      .from("whatsapp_messages")
      .select(MESSAGE_COLUMNS)
      .eq("company_id", companyId)
      .eq("conversation_id", conversationId)
      .order("provider_timestamp", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(MESSAGE_LIMIT);
    if (error) return fail(error);
    const rows = ((data ?? []) as unknown as RawMessage[]).map(toMessage).reverse();
    return { data: rows, error: null };
  },
  async suggestions(conversationId) {
    const { data, error } = await supabase.rpc("whatsapp_suggest_customers", { p_conversation_id: conversationId });
    if (error) return fail(error);
    return { data: toSuggestions(data), error: null };
  },
  async markRead(conversationId) {
    const { error } = await supabase.rpc("mark_whatsapp_conversation_read", { p_conversation_id: conversationId });
    if (error) return fail(error);
    return { data: null, error: null };
  },
  async agents(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_list_agents", { p_company_id: companyId });
    if (error) return fail(error);
    return { data: toAgents(data), error: null };
  },
  async assign(conversationId, userId) {
    const { error } = await supabase.rpc("assign_whatsapp_conversation", { p_conversation_id: conversationId, p_user_id: userId });
    if (error) return failAction(error);
    return { data: null, error: null };
  },
  async setStatus(conversationId, status) {
    const { error } = await supabase.rpc("set_whatsapp_conversation_status", { p_conversation_id: conversationId, p_status: status });
    if (error) return failAction(error);
    return { data: null, error: null };
  },
  async linkCustomer(conversationId, customerId) {
    const { error } = await supabase.rpc("link_whatsapp_conversation_customer", { p_conversation_id: conversationId, p_customer_id: customerId });
    if (error) return failAction(error);
    return { data: null, error: null };
  },
  async send(conversationId, body, clientRequestId) {
    const { data, error } = await supabase.functions.invoke("whatsapp-send", {
      body: { conversation_id: conversationId, client_request_id: clientRequestId, body },
    });
    if (error) {
      const e = await edgeError(error);
      console.error("Falha no envio do WhatsApp");
      return { data: null, error: friendlySendError(e.message) };
    }
    const o = (data ?? {}) as { message_id?: unknown; status?: unknown };
    return { data: { messageId: typeof o.message_id === "string" ? o.message_id : null, status: typeof o.status === "string" ? o.status : "queued" }, error: null };
  },
  async aiMode(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_ai_get_settings", { p_company_id: companyId });
    if (error) return { data: "off", error: null }; // sem acesso/indisponível: o recurso simplesmente não aparece
    return { data: toAiMode(data), error: null };
  },
  async aiSuggest(conversationId) {
    // Só TEXTO volta: a Edge nunca envia, nunca grava mensagem e nunca altera a conversa.
    const { data, error } = await supabase.functions.invoke("whatsapp-ai-suggest", { body: { conversation_id: conversationId } });
    if (error) {
      const e = await edgeError(error);
      console.error("Falha na sugestão de IA do WhatsApp");
      return { data: null, error: friendlyAiError(e.message) };
    }
    const s = (data as { suggestion?: unknown } | null)?.suggestion;
    if (typeof s !== "string" || s.trim() === "") return { data: null, error: friendlyAiError(null) };
    return { data: s, error: null };
  },
  async setAiControl(conversationId, control) {
    const { error } = await supabase.rpc("whatsapp_set_conversation_ai_control", { p_conversation_id: conversationId, p_control: control });
    if (error) return failAction(error);
    return { data: null, error: null };
  },
  async deleteConversation(conversationId) {
    const { error } = await supabase.rpc("whatsapp_delete_conversation", { p_conversation_id: conversationId });
    if (error) return failAction(error);
    return { data: null, error: null };
  },
  subscribe(companyId, onChange) {
    return subscribeToOpenAttendanceChanges(supabase as unknown as RealtimeClientLike, companyId, onChange, "whatsapp-inbox", [
      "whatsapp_conversations",
      "whatsapp_messages",
    ]);
  },
};

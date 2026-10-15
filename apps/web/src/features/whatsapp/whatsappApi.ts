import { supabase } from "../../lib/supabaseClient";
import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { subscribeToOpenAttendanceChanges } from "../operations/openSessionsRealtime";
import {
  toConnectionSummary,
  toConversation,
  toMessage,
  toSuggestions,
  type ConnectionSummary,
  type ConversationRow,
  type MessageRow,
  type RawConversation,
  type RawMessage,
  type Suggestions,
} from "./whatsappLogic";

export type Result<T> = { data: T; error: null } | { data: null; error: string };

// Fase 2A-1: SOMENTE leitura (+ marcar como lida). Nenhum envio.
export interface WhatsappSource {
  summary(companyId: string): Promise<Result<ConnectionSummary>>;
  conversations(companyId: string): Promise<Result<ConversationRow[]>>;
  messages(companyId: string, conversationId: string): Promise<Result<MessageRow[]>>;
  suggestions(conversationId: string): Promise<Result<Suggestions>>;
  markRead(conversationId: string): Promise<Result<null>>;
  subscribe(companyId: string, onChange: () => void): () => void;
}

const GENERIC = "Não foi possível carregar o WhatsApp agora. Tente novamente.";
const NOT_AVAILABLE = "O WhatsApp não está disponível para a sua empresa.";

function fail<T>(error: { code?: string | null; message?: string | null }): Result<T> {
  console.error("Falha no WhatsApp:", error.code ?? "sem código"); // nunca registra telefone nem conteúdo
  if (error.code === "PT403" || /não está contratado|permissão/i.test(error.message ?? "")) return { data: null, error: NOT_AVAILABLE };
  return { data: null, error: GENERIC };
}

const CONVERSATION_COLUMNS =
  "id, contact_phone, contact_display_name, customer_id, status, unread_count, last_message_preview, last_message_at";
const MESSAGE_COLUMNS = "id, conversation_id, direction, type, body, status, provider_timestamp, created_at";
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
  subscribe(companyId, onChange) {
    return subscribeToOpenAttendanceChanges(supabase as unknown as RealtimeClientLike, companyId, onChange, "whatsapp-inbox", [
      "whatsapp_conversations",
      "whatsapp_messages",
    ]);
  },
};

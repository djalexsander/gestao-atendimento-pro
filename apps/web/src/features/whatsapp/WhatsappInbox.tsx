import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseWhatsappSource, type WhatsappSource } from "./whatsappApi";
import {
  FILTER_LABEL,
  STATUS_LABEL,
  applyFilter,
  canUseWhatsapp,
  conversationTitle,
  formatClock,
  formatWaPhone,
  isMediaType,
  listTime,
  messageText,
  statusText,
  totalUnread,
  type ConnectionSummary,
  type ConversationFilter,
  type ConversationRow,
  type MessageRow,
  type Suggestions,
} from "./whatsappLogic";

const FILTERS: ConversationFilter[] = ["open", "unread", "all"];

// Inbox do WhatsApp (Fase 2A-1: SOMENTE leitura). Desktop: conversas | histórico | cliente. Celular: uma tela por vez
// (lista -> conversa -> voltar). Sem campo de envio: o envio entra na próxima etapa.
export function WhatsappInbox({ source = supabaseWhatsappSource }: { source?: WhatsappSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;

  const [summary, setSummary] = useState<ConnectionSummary | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>("open");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    if (!companyId) return;
    const r = await source.conversations(companyId);
    if (r.data) {
      setConversations(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [companyId, source]);

  const loadMessages = useCallback(async () => {
    const id = selectedRef.current;
    if (!companyId || !id) return;
    const r = await source.messages(companyId, id);
    if (selectedRef.current !== id) return; // trocou de conversa no meio da busca
    if (r.data) setMessages(r.data);
  }, [companyId, source]);

  const requestConversations = useMemo(() => createCoalescedRunner(loadConversations), [loadConversations]);
  const requestMessages = useMemo(() => createCoalescedRunner(loadMessages), [loadMessages]);

  useEffect(() => {
    if (!companyId) return;
    void source.summary(companyId).then((r) => setSummary(r.data));
    void requestConversations();
  }, [companyId, source, requestConversations]);

  // Realtime (sem polling): conversas e mensagens da empresa.
  useEffect(() => {
    if (!companyId) return;
    return source.subscribe(companyId, () => {
      requestConversations();
      requestMessages();
    });
  }, [companyId, source, requestConversations, requestMessages]);

  // Fallback barato ao voltar o foco.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") {
        requestConversations();
        requestMessages();
      }
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [requestConversations, requestMessages]);

  // Abrir uma conversa: histórico, sugestões e zera as não lidas.
  useEffect(() => {
    setMessages(null);
    setSuggestions(null);
    if (!companyId || !selectedId) return;
    void requestMessages();
    void source.suggestions(selectedId).then((r) => {
      if (selectedRef.current === selectedId) setSuggestions(r.data);
    });
    void source.markRead(selectedId).then(() => requestConversations());
  }, [companyId, selectedId, source, requestMessages, requestConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  const visible = useMemo(() => applyFilter(conversations ?? [], filter, search), [conversations, filter, search]);
  const unread = useMemo(() => totalUnread(conversations ?? []), [conversations]);
  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  if (!companyId) return <p className="op-state">Selecione uma empresa.</p>;
  if (!canUseWhatsapp(role)) return <p className="op-state">Você não tem acesso ao WhatsApp.</p>;

  return (
    <div className={`wa-inbox${selected ? " wa-has-selected" : ""}`}>
      <div className="wa-header">
        <div>
          <strong>WhatsApp</strong>
          {summary?.configured && (
            <span className="muted">
              {" "}
              · {summary.displayPhoneNumber ?? "Número conectado"}
              {summary.mode === "test" ? " · modo de teste" : ""}
            </span>
          )}
        </div>
        {unread > 0 && <span className="wa-badge">{unread} não lida{unread === 1 ? "" : "s"}</span>}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}
      {summary && !summary.configured && (
        <div className="form-notice" role="status">
          Nenhum número de WhatsApp está conectado a esta empresa.
        </div>
      )}

      <div className="wa-panes">
        <section className="wa-list" aria-label="Conversas">
          <input
            className="wa-search"
            type="search"
            placeholder="Buscar nome ou telefone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar conversas"
          />
          <div className="dl-chips" role="group" aria-label="Filtro de conversas">
            {FILTERS.map((f) => (
              <button key={f} type="button" className="op-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
          {conversations === null && !error && <p className="op-state">Carregando…</p>}
          {conversations !== null && visible.length === 0 && (
            <p className="op-state">{conversations.length === 0 ? "Nenhuma conversa ainda." : "Nenhuma conversa neste filtro."}</p>
          )}
          <ul className="wa-conv-list">
            {visible.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`wa-conv${c.id === selectedId ? " wa-conv-on" : ""}${c.unread > 0 ? " wa-conv-unread" : ""}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <span className="wa-conv-top">
                    <span className="wa-conv-name">{conversationTitle(c)}</span>
                    <span className="wa-conv-time">{listTime(c.lastMessageAt)}</span>
                  </span>
                  <span className="wa-conv-phone">{c.name ? formatWaPhone(c.phone) : ""}</span>
                  <span className="wa-conv-bottom">
                    <span className="wa-conv-preview">{c.preview ?? "—"}</span>
                    {c.unread > 0 && <span className="wa-count" aria-label={`${c.unread} não lidas`}>{c.unread}</span>}
                  </span>
                  {c.status !== "open" && <span className="wa-conv-status">{STATUS_LABEL[c.status]}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="wa-chat" aria-label="Conversa">
          {!selected ? (
            <p className="op-state wa-empty">Selecione uma conversa para ver as mensagens.</p>
          ) : (
            <>
              <div className="wa-chat-head">
                <button type="button" className="btn-secondary btn-small wa-back" onClick={() => setSelectedId(null)}>
                  ← Conversas
                </button>
                <div>
                  <strong>{conversationTitle(selected)}</strong>
                  <div className="muted">{formatWaPhone(selected.phone)}</div>
                </div>
              </div>
              <div className="wa-messages" role="log" aria-live="polite">
                {messages === null && <p className="op-state">Carregando…</p>}
                {messages?.length === 0 && <p className="op-state">Sem mensagens.</p>}
                {messages?.map((m) => (
                  <div key={m.id} className={`wa-msg wa-msg-${m.direction}${isMediaType(m.type) ? " wa-msg-media" : ""}`}>
                    <span className="wa-msg-body">{messageText(m)}</span>
                    <span className="wa-msg-meta">
                      {formatClock(m.at)}
                      {statusText(m) ? ` · ${statusText(m)}` : ""}
                    </span>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              <p className="wa-readonly">O envio de mensagens será habilitado na próxima etapa.</p>
            </>
          )}
        </section>

        <aside className="wa-side" aria-label="Cliente">
          {!selected ? (
            <p className="muted">Os dados do cliente aparecem aqui.</p>
          ) : (
            <>
              <h3 className="wa-side-title">Cliente</h3>
              {suggestions === null && <p className="muted">Carregando…</p>}
              {suggestions?.linked && (
                <div className="wa-customer">
                  <strong>{suggestions.linked.name}</strong>
                  {suggestions.linked.phoneLast4 && <div className="muted">Telefone final {suggestions.linked.phoneLast4}</div>}
                </div>
              )}
              {suggestions && !suggestions.linked && suggestions.suggestions.length === 0 && (
                <p className="muted">Nenhum cliente cadastrado com este telefone.</p>
              )}
              {suggestions && !suggestions.linked && suggestions.suggestions.length > 0 && (
                <>
                  <p className="muted">
                    {suggestions.suggestions.length === 1 ? "Possível cliente:" : "Possíveis clientes:"}
                  </p>
                  <ul className="wa-suggest">
                    {suggestions.suggestions.map((s) => (
                      <li key={s.id}>
                        <strong>{s.name}</strong>
                        {s.phoneLast4 && <span className="muted"> · final {s.phoneLast4}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="field-hint">A associação do cliente à conversa chega na próxima etapa.</p>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

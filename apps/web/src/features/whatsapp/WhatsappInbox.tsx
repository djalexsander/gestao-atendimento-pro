import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAuth } from "../../app/useAuth";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseWhatsappSource, type WhatsappSource } from "./whatsappApi";
import {
  FILTER_LABEL,
  FILTER_ORDER,
  MAX_BODY_LENGTH,
  OUTSIDE_WINDOW_TEXT,
  STATUS_LABEL,
  agentLabel,
  applyFilter,
  canUseWhatsapp,
  composerBlock,
  conversationTitle,
  formatClock,
  formatWaPhone,
  isMediaType,
  listTime,
  messageText,
  statusActions,
  statusText,
  totalUnread,
  windowLabel,
  windowState,
  type AgentOption,
  type ConnectionSummary,
  type ConversationFilter,
  type ConversationRow,
  type ConversationStatus,
  type MessageRow,
  type Suggestions,
} from "./whatsappLogic";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

// Inbox do WhatsApp (Fase 2A-2). Desktop: conversas | histórico + composer | cliente. Celular: uma tela por vez
// (lista -> conversa -> voltar). Texto livre só dentro da janela de 24 h (o servidor confere de novo).
export function WhatsappInbox({ source = supabaseWhatsappSource }: { source?: WhatsappSource }) {
  const { activeMembership, user } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const userId = user?.id ?? null;

  const [summary, setSummary] = useState<ConnectionSummary | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>("open");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Mesmo texto reenviado depois de falha de REDE (sem resposta) reutiliza o mesmo pedido: nunca duplica a mensagem.
  const pendingRequest = useRef<{ text: string; id: string } | null>(null);

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

  const loadSuggestions = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    const r = await source.suggestions(id);
    if (selectedRef.current === id) setSuggestions(r.data);
  }, [source]);

  const requestConversations = useMemo(() => createCoalescedRunner(loadConversations), [loadConversations]);
  const requestMessages = useMemo(() => createCoalescedRunner(loadMessages), [loadMessages]);
  const requestSuggestions = useMemo(() => createCoalescedRunner(loadSuggestions), [loadSuggestions]);

  useEffect(() => {
    if (!companyId) return;
    void source.summary(companyId).then((r) => setSummary(r.data));
    void source.agents(companyId).then((r) => setAgents(r.data ?? []));
    void requestConversations();
  }, [companyId, source, requestConversations]);

  // Realtime (sem polling): conversas (atribuição, situação, cliente) e mensagens (novas e status de envio).
  useEffect(() => {
    if (!companyId) return;
    return source.subscribe(companyId, () => {
      requestConversations();
      requestMessages();
      requestSuggestions();
    });
  }, [companyId, source, requestConversations, requestMessages, requestSuggestions]);

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
    setDraft("");
    setSendError(null);
    setActionError(null);
    pendingRequest.current = null;
    if (!companyId || !selectedId) return;
    void requestMessages();
    void requestSuggestions();
    void source.markRead(selectedId).then(() => requestConversations());
  }, [companyId, selectedId, source, requestMessages, requestSuggestions, requestConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  const visible = useMemo(() => applyFilter(conversations ?? [], filter, search, userId), [conversations, filter, search, userId]);
  const unread = useMemo(() => totalUnread(conversations ?? []), [conversations]);
  const selected = conversations?.find((c) => c.id === selectedId) ?? null;
  const win = selected ? windowState(selected.lastInboundAt) : null;
  const block = selected ? composerBlock(selected, draft) : null;

  async function runAction(fn: () => Promise<{ error: string | null }>) {
    setActionError(null);
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.error) setActionError(r.error);
    requestConversations();
  }

  async function doSend(text: string) {
    if (!selected || sending) return;
    const trimmed = text.trim();
    const pend = pendingRequest.current;
    const requestId = pend && pend.text === trimmed ? pend.id : newRequestId();
    pendingRequest.current = { text: trimmed, id: requestId };
    setSending(true);
    setSendError(null);
    const r = await source.send(selected.id, trimmed, requestId);
    setSending(false);
    if (r.error) {
      // resposta do servidor (inclusive recusas): a mensagem pode existir como 'failed'; novo pedido na próxima tentativa
      pendingRequest.current = null;
      setSendError(r.error);
    } else {
      pendingRequest.current = null;
      setDraft("");
    }
    requestMessages();
    requestConversations();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (block === null) void doSend(draft);
    }
  }

  if (!companyId) return <p className="op-state">Selecione uma empresa.</p>;
  if (!canUseWhatsapp(role)) return <p className="op-state">Você não tem acesso ao WhatsApp.</p>;

  const assignee = selected?.assignedUserId ?? "";
  const known = agents.some((a) => a.userId === assignee);

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
            {FILTER_ORDER.map((f) => (
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
            {visible.map((c) => {
              const owner = agents.find((a) => a.userId === c.assignedUserId);
              return (
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
                    <span className="wa-conv-status">
                      {c.status !== "open" ? STATUS_LABEL[c.status] : ""}
                      {c.status !== "open" && c.assignedUserId ? " · " : ""}
                      {c.assignedUserId ? (owner?.name ?? "Atribuída") : ""}
                    </span>
                  </button>
                </li>
              );
            })}
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
                <div className="wa-chat-title">
                  <strong>{conversationTitle(selected)}</strong>
                  <div className="muted">
                    {formatWaPhone(selected.phone)} · {STATUS_LABEL[selected.status]}
                  </div>
                </div>
              </div>

              <div className="wa-actions">
                <label className="wa-assign">
                  <span className="muted">Atendente</span>
                  <select
                    value={assignee}
                    disabled={busy}
                    aria-label="Atendente"
                    onChange={(e) => void runAction(() => source.assign(selected.id, e.target.value === "" ? null : e.target.value))}
                  >
                    <option value="">Não atribuído</option>
                    {!known && assignee && <option value={assignee}>Atribuída</option>}
                    {agents.map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {agentLabel(a)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="wa-status-actions">
                  {statusActions(selected.status).map((a) => (
                    <button
                      key={a.to}
                      type="button"
                      className="btn-secondary btn-small"
                      disabled={busy}
                      onClick={() => void runAction(() => source.setStatus(selected.id, a.to as ConversationStatus))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              {actionError && <div className="form-error" role="alert">{actionError}</div>}

              <div className="wa-messages" role="log" aria-live="polite">
                {messages === null && <p className="op-state">Carregando…</p>}
                {messages?.length === 0 && <p className="op-state">Sem mensagens.</p>}
                {messages?.map((m) => (
                  <div key={m.id} className={`wa-msg wa-msg-${m.direction}${isMediaType(m.type) ? " wa-msg-media" : ""}${m.status === "failed" ? " wa-msg-failed" : ""}`}>
                    <span className="wa-msg-body">{messageText(m)}</span>
                    <span className="wa-msg-meta">
                      {formatClock(m.at)}
                      {statusText(m) ? ` · ${statusText(m)}` : ""}
                    </span>
                    {m.direction === "outbound" && m.status === "failed" && m.body && (
                      <button type="button" className="btn-secondary btn-small wa-retry" disabled={sending || block === "window" || block === "closed"} onClick={() => void doSend(m.body ?? "")}>
                        Reenviar
                      </button>
                    )}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              <div className="wa-composer">
                <div className={`wa-window${win?.open ? "" : " wa-window-closed"}`} role="status">
                  {win ? windowLabel(win) : ""}
                </div>
                {block === "window" && <p className="wa-readonly">{OUTSIDE_WINDOW_TEXT}</p>}
                {block === "closed" && <p className="wa-readonly">Reabra a conversa para responder.</p>}
                {sendError && <div className="form-error" role="alert">{sendError}</div>}
                <div className="wa-composer-row">
                  <textarea
                    className="wa-input"
                    aria-label="Mensagem"
                    placeholder="Digite uma mensagem..."
                    rows={2}
                    value={draft}
                    maxLength={MAX_BODY_LENGTH}
                    disabled={sending || block === "window" || block === "closed"}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                  />
                  <button type="button" className="btn-primary btn-auto" disabled={block !== null || sending} onClick={() => void doSend(draft)}>
                    {sending ? "Enviando…" : "Enviar"}
                  </button>
                </div>
              </div>
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
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    disabled={busy}
                    onClick={() => void runAction(async () => { const r = await source.linkCustomer(selected.id, null); requestSuggestions(); return r; })}
                  >
                    Desvincular
                  </button>
                </div>
              )}
              {suggestions && !suggestions.linked && suggestions.suggestions.length === 0 && (
                <p className="muted">Nenhum cliente cadastrado com este telefone.</p>
              )}
              {suggestions && suggestions.suggestions.length > 0 && (
                <>
                  <p className="muted">{suggestions.linked ? "Outros clientes com este telefone:" : suggestions.suggestions.length === 1 ? "Possível cliente:" : "Possíveis clientes:"}</p>
                  <ul className="wa-suggest">
                    {suggestions.suggestions.map((s) => (
                      <li key={s.id}>
                        <span>
                          <strong>{s.name}</strong>
                          {s.phoneLast4 && <span className="muted"> · final {s.phoneLast4}</span>}
                        </span>
                        <button
                          type="button"
                          className="btn-secondary btn-small"
                          disabled={busy}
                          onClick={() => void runAction(async () => { const r = await source.linkCustomer(selected.id, s.id); requestSuggestions(); return r; })}
                        >
                          Vincular
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

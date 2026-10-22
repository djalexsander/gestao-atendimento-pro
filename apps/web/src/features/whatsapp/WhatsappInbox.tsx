import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAuth } from "../../app/useAuth";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseWhatsappSource, type WhatsappSource } from "./whatsappApi";
import { Modal } from "../employees/Modal";
import { useChatScroll, useFillViewport } from "./useChatScroll";
import {
  AI_BADGE_EDITED_TEXT,
  AI_BADGE_TEXT,
  AI_IDLE,
  AI_SUGGEST_ERROR,
  aiBadge,
  aiConversationState,
  aiFailed,
  aiLoading,
  aiReady,
  aiSuggestAvailable,
  aiTakeoverAction,
  FILTER_LABEL,
  FILTER_ORDER,
  MAX_BODY_LENGTH,
  OUTSIDE_WINDOW_TEXT,
  STATUS_LABEL,
  agentLabel,
  applyFilter,
  DELETE_CONVERSATION_OK,
  DELETE_CONVERSATION_TEXT,
  DELETE_CONVERSATION_TITLE,
  canDeleteConversation,
  canUseWhatsapp,
  friendlyDeleteError,
  composerBlock,
  READONLY_MODULE_TEXT,
  conversationTitle,
  formatClock,
  formatWaPhone,
  isMediaType,
  newMessagesLabel,
  listTime,
  messageText,
  statusActions,
  statusText,
  enterSends,
  makeSendError,
  totalUnread,
  visibleSendError,
  withoutConversation,
  windowLabel,
  windowState,
  type AgentOption,
  type AiDraftState,
  type AiMode,
  type ConnectionSummary,
  type ConversationFilter,
  type ConversationRow,
  type ConversationStatus,
  type MessageRow,
  type SendErrorState,
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
  // Excluir conversa: menu ⋮ (só owner/admin), confirmação e aviso de sucesso
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>("open");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Recusa do ÚLTIMO envio, presa à conversa onde ocorreu (ver visibleSendError). Não se mistura com aiError (sugestão) nem actionError.
  const [sendError, setSendError] = useState<SendErrorState | null>(null);
  const [busy, setBusy] = useState(false);
  // IA (Fase 1): só sugere texto; o envio de uma sugestão é exclusivamente pelo botão Enviar (Enter nela só quebra a linha).
  const [aiMode, setAiMode] = useState<AiMode>("off");
  const [aiState, setAiState] = useState<AiDraftState>(AI_IDLE);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiRunning = useRef(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  // celular: atendente/status ficam recolhidos (o chat usa a altura) e o painel do cliente vira uma tela própria
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const inboxRef = useRef<HTMLDivElement | null>(null);
  // Chat com rolagem própria: só mensagem NOVA (id novo) rola/conta; status (sent/delivered/read) não
  const chat = useChatScroll(selectedId, messages);
  useFillViewport(inboxRef);
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
    void source.aiMode?.(companyId).then((r) => setAiMode(r.data ?? "off"));
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
    setMenuOpen(false);
    setConfirmDelete(false);
    setDeleteError(null);
    setDetailsOpen(false);
    setSideOpen(false);
    setAiState(AI_IDLE);
    setAiError(null);
    aiRunning.current = false;
    pendingRequest.current = null;
    if (!companyId || !selectedId) return;
    void requestMessages();
    void requestSuggestions();
    void source.markRead(selectedId).then(() => requestConversations());
  }, [companyId, selectedId, source, requestMessages, requestSuggestions, requestConversations]);

  // A conversa aberta sumiu da caixa (excluída por outra pessoa/aparelho): limpa o painel, o contador e o composer
  useEffect(() => {
    if (selectedId && conversations !== null && !conversations.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [conversations, selectedId]);

  const visible = useMemo(() => applyFilter(conversations ?? [], filter, search, userId), [conversations, filter, search, userId]);
  const unread = useMemo(() => totalUnread(conversations ?? []), [conversations]);
  const selected = conversations?.find((c) => c.id === selectedId) ?? null;
  const win = selected ? windowState(selected.lastInboundAt) : null;
  const readOnly = summary?.moduleActive === false;
  const block = selected ? composerBlock(selected, draft, new Date(), !readOnly) : null;
  // IA automática (Fase 2): estado por conversa (só aparece com a empresa em 'auto') e a ação Assumir/Devolver
  const shownSendError = visibleSendError(sendError, selectedId, messages);
  const aiState2 = selected ? aiConversationState(aiMode, selected) : null;
  const takeover = aiState2 ? aiTakeoverAction(aiState2) : null;

  async function runAction(fn: () => Promise<{ error: string | null }>) {
    setActionError(null);
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.error) setActionError(r.error);
    requestConversations();
  }

  async function doDelete() {
    if (!selected || deleting || !source.deleteConversation) return;
    const id = selected.id;
    setDeleting(true);
    setDeleteError(null);
    const r = await source.deleteConversation(id);
    setDeleting(false);
    if (r.error) {
      setDeleteError(friendlyDeleteError(r.error));
      return;
    }
    // some NA HORA da lista; o painel central e o do cliente voltam ao estado vazio (sem F5)
    setConversations((list) => withoutConversation(list, id));
    setConfirmDelete(false);
    setMenuOpen(false);
    setSelectedId(null);
    setNotice(DELETE_CONVERSATION_OK);
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
    const forId = selected.id;
    const r = await source.send(forId, trimmed, requestId);
    setSending(false);
    if (r.error) {
      // resposta do servidor (inclusive recusas): a mensagem pode existir como 'failed'; novo pedido na próxima tentativa
      pendingRequest.current = null;
      if (selectedRef.current === forId) setSendError(makeSendError(forId, r.error, messages));
    } else {
      pendingRequest.current = null;
      setDraft("");
      setAiState(AI_IDLE);
      setAiError(null);
      chat.notifyOwnSend(); // a mensagem enviada leva ao fim, mesmo lendo o histórico
    }
    requestMessages();
    requestConversations();
  }

  async function doSuggest() {
    if (!selected || aiRunning.current || sending || !source.aiSuggest) return;
    const forId = selected.id;
    aiRunning.current = true;
    setAiError(null);
    setSendError(null); // nova ação de IA: um erro de envio anterior não pertence a esta tentativa
    const before = aiState;
    setAiState(aiLoading(before, draft));
    const r = await source.aiSuggest(forId);
    if (selectedRef.current !== forId) return; // trocou de conversa: o efeito de abertura já limpou tudo
    aiRunning.current = false;
    if (r.data) {
      setDraft(r.data);
      setAiState((s) => aiReady(s, r.data as string));
    } else {
      // falha: o rascunho NÃO é apagado e o envio manual segue normal
      setAiState(aiFailed(before));
      setAiError(r.error || AI_SUGGEST_ERROR);
    }
  }

  function discardSuggestion() {
    setDraft(aiState.previousDraft);
    setAiState(AI_IDLE);
    setAiError(null);
    setSendError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Texto digitado: Enter envia. Sugestão da IA (sugerida/editada): só o botão Enviar; Enter vira quebra de linha.
      if (!enterSends(aiState)) return;
      e.preventDefault();
      if (block === null) void doSend(draft);
    }
  }

  if (!companyId) return <p className="op-state">Selecione uma empresa.</p>;
  if (!canUseWhatsapp(role)) return <p className="op-state">Você não tem acesso ao WhatsApp.</p>;

  const assignee = selected?.assignedUserId ?? "";
  const known = agents.some((a) => a.userId === assignee);

  return (
    <div ref={inboxRef} className={`wa-inbox${selected ? " wa-has-selected" : ""}${sideOpen ? " wa-side-open" : ""}`}>
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
      {notice && (
        <div className="form-notice" role="status">
          {notice}{" "}
          <button type="button" className="btn-secondary btn-small" onClick={() => setNotice(null)}>
            Ok
          </button>
        </div>
      )}
      {readOnly && (
        <div className="form-notice" role="status">
          {READONLY_MODULE_TEXT}
        </div>
      )}
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
                    {aiMode === "auto" && (() => {
                      const st = aiConversationState(aiMode, c);
                      return st.kind === "none" ? null : <span className={`wa-ai-tag wa-ai-tag-${st.kind}`}>{st.kind === "active" ? "IA ativa" : st.kind === "handoff" ? "Para humano" : "IA pausada"}</span>;
                    })()}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className={`wa-chat${detailsOpen ? " wa-details-open" : ""}`} aria-label="Conversa">
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
                <div className="wa-head-toggles">
                  <button type="button" className="btn-secondary btn-small wa-detail-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((o) => !o)}>
                    Atendimento
                  </button>
                  <button type="button" className="btn-secondary btn-small wa-side-toggle" onClick={() => setSideOpen(true)}>
                    Cliente
                  </button>
                </div>
              </div>

              <div className="wa-actions">
                <label className="wa-assign">
                  <span className="muted">Atendente</span>
                  <select
                    value={assignee}
                    disabled={busy || readOnly}
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
                {canDeleteConversation(role) && source.deleteConversation && (
                  <div className="wa-menu">
                    <button
                      type="button"
                      className="btn-secondary btn-small wa-menu-button"
                      aria-label="Mais ações da conversa"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={() => setMenuOpen((o) => !o)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setMenuOpen(false);
                      }}
                    >
                      ⋮
                    </button>
                    {menuOpen && (
                      <div className="wa-menu-list" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="wa-menu-item wa-menu-danger"
                          onClick={() => {
                            setMenuOpen(false);
                            setDeleteError(null);
                            setConfirmDelete(true);
                          }}
                        >
                          Excluir conversa
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div className="wa-status-actions">
                  {statusActions(selected.status).map((a) => (
                    <button
                      key={a.to}
                      type="button"
                      className="btn-secondary btn-small"
                      disabled={busy || readOnly}
                      onClick={() => void runAction(() => source.setStatus(selected.id, a.to as ConversationStatus))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              {aiState2 && aiState2.kind !== "none" && (
                <div className={`wa-ai-state wa-ai-state-${aiState2.kind}`} role="status" data-testid="wa-ai-state">
                  <span>{aiState2.label}</span>
                  {takeover && source.setAiControl && (
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      disabled={busy || readOnly}
                      onClick={() => void runAction(() => source.setAiControl!(selected.id, takeover.to))}
                    >
                      {takeover.label}
                    </button>
                  )}
                </div>
              )}
              {actionError && <div className="form-error" role="alert">{actionError}</div>}

              <div className="wa-messages-wrap">
              <div className="wa-messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="Mensagens da conversa" ref={chat.scrollerRef} onScroll={chat.onScroll}>
                {messages === null && <p className="op-state">Carregando…</p>}
                {messages?.length === 0 && <p className="op-state">Sem mensagens.</p>}
                {messages?.map((m) => (
                  <div key={m.id} className={`wa-msg wa-msg-${m.direction}${isMediaType(m.type) ? " wa-msg-media" : ""}${m.status === "failed" ? " wa-msg-failed" : ""}`}>
                    <span className="wa-msg-body">{messageText(m)}</span>
                    <span className="wa-msg-meta">
                      {m.origin === "ai_auto" ? "IA · " : ""}
                      {formatClock(m.at)}
                      {statusText(m) ? ` · ${statusText(m)}` : ""}
                    </span>
                    {m.direction === "outbound" && m.status === "failed" && m.body && (
                      <button type="button" className="btn-secondary btn-small wa-retry" disabled={sending || aiState.status === "loading" || block === "module" || block === "window" || block === "closed"} onClick={() => void doSend(m.body ?? "")}>
                        Reenviar
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {chat.unread > 0 && (
                <button type="button" className="wa-new-messages" onClick={chat.jumpToEnd} data-testid="wa-new-messages">
                  {newMessagesLabel(chat.unread)}
                </button>
              )}
              </div>

              <div className="wa-composer">
                <div className={`wa-window${win?.open ? "" : " wa-window-closed"}`} role="status">
                  {win ? windowLabel(win) : ""}
                </div>
                {block === "module" && <p className="wa-readonly">{READONLY_MODULE_TEXT}</p>}
                {block === "window" && <p className="wa-readonly">{OUTSIDE_WINDOW_TEXT}</p>}
                {block === "closed" && <p className="wa-readonly">Reabra a conversa para responder.</p>}
                {shownSendError && <div className="form-error" role="alert">{shownSendError}</div>}
                {aiError && <div className="form-error" role="alert">{aiError}</div>}
                {aiBadge(aiState, draft) !== "none" && (
                  <div className="wa-ai-badge" role="status">
                    <span>{aiBadge(aiState, draft) === "edited" ? AI_BADGE_EDITED_TEXT : AI_BADGE_TEXT}</span>
                    <button type="button" className="btn-secondary btn-auto" onClick={discardSuggestion} disabled={aiState.status === "loading" || sending}>
                      Descartar
                    </button>
                    <button type="button" className="btn-secondary btn-auto" onClick={() => void doSuggest()} disabled={aiState.status === "loading" || sending}>
                      Gerar outra
                    </button>
                  </div>
                )}
                <div className="wa-composer-row">
                  <textarea
                    className="wa-input"
                    aria-label="Mensagem"
                    placeholder="Digite uma mensagem..."
                    rows={2}
                    value={draft}
                    maxLength={MAX_BODY_LENGTH}
                    disabled={sending || block === "module" || block === "window" || block === "closed"}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setSendError(null); // texto novo = nova tentativa: o aviso da anterior não vale mais
                      // composer esvaziado: a sugestão foi abandonada; o que for digitado depois é texto manual (Enter volta a enviar)
                      if (e.target.value.trim() === "" && aiState.suggestion !== null && aiState.status !== "loading") {
                        setAiState(AI_IDLE);
                        setAiError(null);
                      }
                    }}
                    onKeyDown={onKeyDown}
                  />
                  {aiSuggestAvailable(aiMode, block) && source.aiSuggest && (
                    <button
                      type="button"
                      className="btn-secondary btn-auto wa-ai-button"
                      disabled={sending || aiState.status === "loading"}
                      onClick={() => void doSuggest()}
                    >
                      {aiState.status === "loading" ? "Gerando sugestão..." : "Sugerir resposta com IA"}
                    </button>
                  )}
                  <button type="button" className="btn-primary btn-auto" disabled={block !== null || sending || aiState.status === "loading"} onClick={() => void doSend(draft)}>
                    {sending ? "Enviando…" : "Enviar"}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {confirmDelete && selected && (
          <Modal title={DELETE_CONVERSATION_TITLE} onClose={() => (deleting ? undefined : setConfirmDelete(false))}>
            <p>{DELETE_CONVERSATION_TEXT}</p>
            <p className="field-hint">
              {conversationTitle(selected)} · {formatWaPhone(selected.phone)}
            </p>
            {deleteError && <div className="form-error" role="alert">{deleteError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" disabled={deleting} onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
              <button type="button" className="btn-danger" disabled={deleting} onClick={() => void doDelete()}>
                {deleting ? "Excluindo…" : "Excluir conversa"}
              </button>
            </div>
          </Modal>
        )}

        <aside className="wa-side" aria-label="Cliente">
          {!selected ? (
            <p className="muted">Os dados do cliente aparecem aqui.</p>
          ) : (
            <>
              <div className="wa-side-head">
                <button type="button" className="btn-secondary btn-small wa-side-back" onClick={() => setSideOpen(false)}>
                  ← Conversa
                </button>
                <h3 className="wa-side-title">Cliente</h3>
              </div>
              {suggestions === null && <p className="muted">Carregando…</p>}
              {suggestions?.linked && (
                <div className="wa-customer">
                  <strong>{suggestions.linked.name}</strong>
                  {suggestions.linked.phoneLast4 && <div className="muted">Telefone final {suggestions.linked.phoneLast4}</div>}
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    disabled={busy || readOnly}
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
                          disabled={busy || readOnly}
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

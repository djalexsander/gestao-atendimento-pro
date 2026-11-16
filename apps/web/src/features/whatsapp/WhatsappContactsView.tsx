import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ambiguityNotice, canOpenConversation, canRetry, describeContactQuery, classifyContactQuery, type ContactRow, type ContactsState } from "./whatsappContactsLogic";
import {
  CONTACTS_BASE_PATH,
  EMPTY_LIST_TEXT,
  NAME_SOURCE_LABEL,
  NO_RESULTS_TEXT,
  SEARCH_EXAMPLES,
  SOURCE_LABEL,
  conversationPath,
  customerLinkText,
  formatContactPhone,
  lastInteraction,
} from "./whatsappContactsPresentation";

function ContactCard({ contact }: { contact: ContactRow }) {
  const notice = ambiguityNotice(contact);
  const last = lastInteraction(contact);
  const link = customerLinkText(contact);
  const showProfile = contact.profileName !== null && contact.profileName !== contact.displayName;
  return (
    <li className="wc-card" data-testid="wc-contact">
      <div className="wc-main">
        <div className="wc-top">
          <strong className="wc-name">{contact.displayName}</strong>
          <span className="wc-badge" title={NAME_SOURCE_LABEL[contact.nameSource]}>
            {SOURCE_LABEL[contact.source]}
          </span>
        </div>
        {contact.nameSource !== "phone" && <div className="wc-phone">{formatContactPhone(contact)}</div>}
        <div className="wc-meta">
          {link !== null && <span className={contact.customerId !== null ? "wc-chip wc-chip-customer" : "wc-chip"}>{link}</span>}
          {showProfile && <span className="wc-chip">Perfil: {contact.profileName}</span>}
          {contact.conversationCount > 1 && <span className="wc-chip">{contact.conversationCount} conversas</span>}
          <span className="wc-chip wc-chip-time">{last ? `Última mensagem: ${last}` : "Sem mensagens"}</span>
        </div>
        {notice && (
          <p className="wc-warning" role="note">
            <span aria-hidden="true">⚠ </span>
            {notice}
          </p>
        )}
      </div>
      <div className="wc-actions">
        {canOpenConversation(contact) && contact.conversationId !== null ? (
          <Link className="btn-primary btn-small" to={conversationPath(contact.conversationId)}>
            Abrir conversa
          </Link>
        ) : (
          <span className="wc-no-conv">Sem conversa</span>
        )}
      </div>
    </li>
  );
}

/**
 * Apresentação pura da tela de Contatos (sem hooks de dados): recebe o estado do carregador e devolve a marcação. Existe separada
 * do contêiner para que TODOS os estados (carregando, erro, vazio, resultados, ambíguo, sem conversa, "carregar mais") sejam
 * testáveis sem navegador.
 */
export function ContactsView({
  text,
  state,
  onTextChange,
  onSubmit,
  onRetry,
  onLoadMore,
}: {
  text: string;
  state: ContactsState;
  onTextChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const live = classifyContactQuery(text);
  const loading = state.status === "loading";
  const loadingMore = state.status === "loading_more";
  const failed = state.status === "error" && state.error !== null;
  const noResults = state.loaded && !loading && !failed && state.contacts.length === 0;
  const hint = text.trim() === "" ? null : describeContactQuery(live);

  return (
    <div className="wc-page">
      <div className="wc-header">
        {/* o título da página vem do cabeçalho operacional (OperationalShell): aqui só a descrição */}
        <p className="muted wc-sub">Pessoas que já conversaram com a empresa e clientes cadastrados com telefone.</p>
        <Link className="btn-secondary btn-small" to={CONTACTS_BASE_PATH}>
          ← Conversas
        </Link>
      </div>

      <form className="wc-search" role="search" onSubmit={onSubmit}>
        <input
          className="wc-input"
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder="Buscar por nome, DDD, final ou telefone"
          value={text}
          maxLength={120}
          onChange={(e) => onTextChange(e.target.value)}
          aria-label="Buscar contatos"
          aria-describedby="wc-hint"
        />
        <div id="wc-hint" className="wc-hint" aria-live="polite">
          {hint ?? (
            <span>
              Exemplos:{" "}
              {SEARCH_EXAMPLES.map((x, i) => (
                <span key={x.label}>
                  {i > 0 ? " · " : ""}
                  <span className="wc-example">{x.label}</span> <code>{x.example}</code>
                </span>
              ))}
            </span>
          )}
        </div>
      </form>

      {failed && state.error && (
        <div className="form-error wc-error" role="alert">
          <span>{state.error.message}</span>
          {canRetry(state) && (
            <button type="button" className="btn-secondary btn-small" onClick={onRetry}>
              Tentar de novo
            </button>
          )}
        </div>
      )}

      {loading && (
        <p className="op-state" role="status">
          Carregando contatos…
        </p>
      )}

      {noResults && (
        <p className="op-state" role="status">
          {state.query.kind === "empty" ? EMPTY_LIST_TEXT : state.query.skipRequest ? describeContactQuery(state.query) : NO_RESULTS_TEXT}
        </p>
      )}

      {state.contacts.length > 0 && (
        <>
          <p className="muted wc-count" aria-live="polite">
            {state.contacts.length} contato{state.contacts.length === 1 ? "" : "s"} carregado{state.contacts.length === 1 ? "" : "s"}
            {state.hasMore ? " · há mais" : ""}
          </p>
          <ul className="wc-list" aria-label="Contatos">
            {state.contacts.map((c) => (
              <ContactCard key={c.contactKey} contact={c} />
            ))}
          </ul>
        </>
      )}

      {state.hasMore && (
        <div className="wc-more">
          <button type="button" className="btn-secondary" disabled={loadingMore || loading} onClick={onLoadMore}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}

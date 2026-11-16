import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useAuth } from "../../app/useAuth";
import type { CustomersSource } from "../customers/customersApi";
import { createContactsLoader, supabaseArchivedContactsSource, supabaseContactsSource, type ContactsSource } from "./whatsappContactsApi";
import { classifyContactQuery, type ContactRow } from "./whatsappContactsLogic";
import { CONTACTS_DEBOUNCE_MS, CONTACTS_PAGE_SIZE, type ContactsFilter } from "./whatsappContactsPresentation";
import { ContactsView } from "./WhatsappContactsView";
import { canUseWhatsapp } from "./whatsappLogic";
import { createManualContactsController, supabaseManualContactsSource, type ManualContactsSource, type ManualResult } from "./whatsappManualContactsApi";
import { manualContactPermissions, type ManualContactError } from "./whatsappManualContactsLogic";
import { ManualContactDetailView, ManualContactForm, ManualContactLinkView } from "./WhatsappManualContactsUi";
import { CLOSED_PANEL, NOTICES, panelContactId, panelReducer, type DetailState } from "./whatsappManualContactsUiLogic";

/**
 * Contatos do WhatsApp: contêiner da tela. Liga a empresa ativa e o papel ao carregador (Etapa 7.3) e ao controlador de contatos
 * manuais (Etapa 7.10E), faz a busca com debounce e entrega o estado à apresentação (WhatsappContactsView).
 *
 * Contatos manuais (Etapa 7.10F): cadastrar, ver, editar, vincular/desvincular cliente EXISTENTE, arquivar e restaurar. O servidor decide
 * as permissões (o detalhe devolve o que o usuário pode fazer); aqui só se escondem botões. Nada cria cliente, conversa, mensagem nem
 * resposta de IA, e nada mexe em ?conversation=. `source`/`manualSource`/`customerSource` existem para exercitar a tela com dados simulados.
 */
export function WhatsappContacts({
  source = supabaseContactsSource,
  archivedSource = supabaseArchivedContactsSource,
  manualSource = supabaseManualContactsSource,
  customerSource,
  debounceMs = CONTACTS_DEBOUNCE_MS,
  pageSize = CONTACTS_PAGE_SIZE,
}: {
  source?: ContactsSource;
  /** Fonte da aba Arquivados (por padrão a RPC real). */
  archivedSource?: ContactsSource;
  manualSource?: ManualContactsSource;
  customerSource?: CustomersSource;
  debounceMs?: number;
  pageSize?: number;
}) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  if (!companyId) return <p className="op-state">Selecione uma empresa.</p>;
  if (!canUseWhatsapp(role)) return <p className="op-state">Você não tem acesso ao WhatsApp.</p>;
  // key: trocar de empresa ou de papel recomeça TUDO (lista, painéis abertos, avisos), sem restos da empresa anterior
  return (
    <ContactsScreen
      key={`${companyId}|${role}`}
      companyId={companyId}
      role={role}
      source={source}
      archivedSource={archivedSource}
      manualSource={manualSource}
      customerSource={customerSource}
      debounceMs={debounceMs}
      pageSize={pageSize}
    />
  );
}

function ContactsScreen({
  companyId,
  role,
  source,
  archivedSource,
  manualSource,
  customerSource,
  debounceMs,
  pageSize,
}: {
  companyId: string;
  role: string | null;
  source: ContactsSource;
  archivedSource: ContactsSource;
  manualSource: ManualContactsSource;
  customerSource?: CustomersSource;
  debounceMs: number;
  pageSize: number;
}) {
  const perms = manualContactPermissions(role);
  const [text, setText] = useState("");
  const textRef = useRef("");
  const lastSearched = useRef<string | null>(null);

  // aba Ativos/Arquivados: cada aba tem o SEU carregador (busca, cursor e respostas atrasadas separados); trocar de aba recarrega com o texto atual
  const [filter, setFilter] = useState<ContactsFilter>("active");
  const loader = useMemo(
    () => createContactsLoader({ source: filter === "archived" ? archivedSource : source, companyId, pageSize }),
    [source, archivedSource, filter, companyId, pageSize],
  );
  const subscribe = useCallback((notify: () => void) => loader.subscribe(() => notify()), [loader]);
  const state = useSyncExternalStore(subscribe, loader.getState, loader.getState);

  // primeira carga com o texto que já estiver no campo
  useEffect(() => {
    lastSearched.current = classifyContactQuery(textRef.current).text;
    void loader.search(textRef.current);
  }, [loader]);

  // busca com debounce: só dispara quando o texto (normalizado) mudou de verdade
  useEffect(() => {
    const normalized = classifyContactQuery(text).text;
    if (lastSearched.current === normalized) return;
    const timer = setTimeout(() => {
      lastSearched.current = normalized;
      void loader.search(text);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [text, debounceMs, loader]);

  // ---- contatos manuais ----
  // depois de cada escrita bem-sucedida a lista é atualizada NO LUGAR (mesma busca, mesma lista na tela até a resposta chegar)
  const controller = useMemo(
    () => createManualContactsController({ source: manualSource, companyId, role, onChanged: () => loader.refresh() }),
    [manualSource, companyId, role, loader],
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.invalidate(); // operações em andamento passam a valer "stale": nada é atualizado depois de sair (empresa e papel não mudam: o StrictMode remonta com o mesmo controlador)
    };
  }, [controller]);

  const [panel, dispatch] = useReducer(panelReducer, CLOSED_PANEL);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [opError, setOpError] = useState<ManualContactError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailToken = useRef(0);

  const loadDetail = useCallback(
    async (contactId: string) => {
      const token = ++detailToken.current;
      setDetail({ id: contactId, status: "loading" });
      const r = await controller.get(contactId);
      if (!alive.current || token !== detailToken.current) return; // resposta de outro contato/pedido antigo
      if (r.ok) {
        setDetail({ id: contactId, status: "ready", data: r.data });
        setSelectedKey(r.data.contact.contactKey); // só destaca a linha; nunca abre conversa
        setSelectedId(r.data.contact.id);
      } else if (r.error.kind !== "stale") {
        setDetail({ id: contactId, status: "error", error: r.error });
        if (r.error.kind === "not_found") void loader.refresh(); // o contato não existe mais: a lista precisa refletir isso
      }
    },
    [controller, loader],
  );

  function openView(contactId: string) {
    setOpError(null);
    setNotice(null);
    dispatch({ type: "view", contactId });
    void loadDetail(contactId);
  }

  function closePanel() {
    detailToken.current++;
    setOpError(null);
    setDetail(null);
    dispatch({ type: "close" });
  }

  /** Executa uma operação: uma por vez (clique duplo não repete), erro vira mensagem no painel, "stale" é ignorado. */
  async function act<T>(run: () => Promise<ManualResult<T>>, onOk: (data: T) => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOpError(null);
    setNotice(null);
    const r = await run();
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) onOk(r.data);
    else if (r.error.kind !== "stale") setOpError(r.error);
  }

  const id = panelContactId(panel);
  const ready = detail && detail.id === id && detail.status === "ready" ? detail.data : null;

  function afterWrite(contactId: string, contactKey: string, message: string, back: boolean) {
    setSelectedKey(contactKey);
    setNotice(message);
    if (back) dispatch({ type: "back" });
    else dispatch({ type: "view", contactId });
    void loadDetail(contactId);
  }

  function onOpenContact(c: ContactRow) {
    if (c.manualContactId) openView(c.manualContactId);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    lastSearched.current = classifyContactQuery(text).text;
    void loader.search(text);
  }

  return (
    <>
      <ContactsView
        text={text}
        state={state}
        canCreate={perms.canCreate}
        notice={notice}
        selectedKey={filter === "archived" ? selectedId : selectedKey}
        filter={filter}
        onFilterChange={(f) => {
          closePanel();
          setNotice(null);
          setFilter(f);
        }}
        onNewContact={() => {
          setOpError(null);
          setNotice(null);
          dispatch({ type: "create" });
        }}
        onOpenContact={onOpenContact}
        onTextChange={(value) => {
          textRef.current = value;
          setText(value);
        }}
        onSubmit={onSubmit}
        onRetry={() => void loader.retry()}
        onLoadMore={() => void loader.loadMore()}
      />

      {panel.mode === "create" && (
        <ManualContactForm
          key="create"
          mode="create"
          busy={busy}
          error={opError}
          onCancel={closePanel}
          onOpenExisting={openView}
          onSubmit={(input) => void act(() => controller.create(input), (m) => afterWrite(m.contact.id, m.contact.contactKey, NOTICES.created, false))}
        />
      )}

      {panel.mode === "view" && detail && detail.id === panel.contactId && (
        <ManualContactDetailView
          detail={detail}
          busy={busy}
          error={opError}
          confirm={panel.confirm}
          onClose={closePanel}
          onEdit={() => {
            setOpError(null);
            dispatch({ type: "edit" });
          }}
          onLink={() => {
            setOpError(null);
            dispatch({ type: "link" });
          }}
          onUnlink={() => void act(() => controller.setCustomer(panel.contactId, null), (m) => afterWrite(panel.contactId, m.contact.contactKey, m.changed ? NOTICES.unlinked : NOTICES.unchanged, false))}
          onAskConfirm={(what) => {
            setOpError(null);
            dispatch({ type: "confirm", what });
          }}
          onConfirm={() =>
            panel.confirm === "archive"
              ? void act(() => controller.archive(panel.contactId), (m) => afterWrite(panel.contactId, m.contact.contactKey, NOTICES.archived, false))
              : void act(() => controller.restore(panel.contactId), (m) => afterWrite(panel.contactId, m.contact.contactKey, NOTICES.restored, false))
          }
          onRetry={() => void loadDetail(panel.contactId)}
          onOpenExisting={openView}
        />
      )}

      {panel.mode === "edit" && ready && (
        <ManualContactForm
          key={`edit-${panel.contactId}`}
          mode="edit"
          initial={ready.contact}
          busy={busy}
          error={opError}
          onCancel={() => {
            setOpError(null);
            dispatch({ type: "back" });
          }}
          onOpenExisting={openView}
          onSubmit={(input) =>
            void act(() => controller.update(panel.contactId, input), (m) => afterWrite(panel.contactId, m.contact.contactKey, m.changed ? NOTICES.updated : NOTICES.unchanged, true))
          }
        />
      )}

      {panel.mode === "link" && ready && (
        <ManualContactLinkView
          key={`link-${panel.contactId}`}
          companyId={companyId}
          currentName={ready.contact.customerName}
          busy={busy}
          error={opError}
          customerSource={customerSource}
          onCancel={() => {
            setOpError(null);
            dispatch({ type: "back" });
          }}
          onOpenExisting={openView}
          onSubmit={(customerId) =>
            void act(() => controller.setCustomer(panel.contactId, customerId), (m) => afterWrite(panel.contactId, m.contact.contactKey, m.changed ? NOTICES.linked : NOTICES.unchanged, true))
          }
        />
      )}
    </>
  );
}

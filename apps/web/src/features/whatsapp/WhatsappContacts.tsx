import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useAuth } from "../../app/useAuth";
import { createContactsLoader, supabaseContactsSource, type ContactsSource } from "./whatsappContactsApi";
import { classifyContactQuery } from "./whatsappContactsLogic";
import { CONTACTS_DEBOUNCE_MS, CONTACTS_PAGE_SIZE } from "./whatsappContactsPresentation";
import { ContactsView } from "./WhatsappContactsView";
import { canUseWhatsapp } from "./whatsappLogic";

/**
 * Contatos do WhatsApp (Etapa 7.4): contêiner da tela. Liga a empresa ativa e o papel ao carregador (whatsappContactsApi, Etapa 7.3),
 * faz a busca com debounce e entrega o estado à apresentação (WhatsappContactsView). Somente leitura: não cria nem edita contatos e
 * nunca vincula cliente sozinho. `source` só existe para exercitar a tela com dados simulados.
 */
export function WhatsappContacts({
  source = supabaseContactsSource,
  debounceMs = CONTACTS_DEBOUNCE_MS,
  pageSize = CONTACTS_PAGE_SIZE,
}: {
  source?: ContactsSource;
  debounceMs?: number;
  pageSize?: number;
}) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const allowed = canUseWhatsapp(activeMembership?.role ?? null);

  const [text, setText] = useState("");
  const textRef = useRef("");
  const lastSearched = useRef<string | null>(null);

  // um carregador por (fonte, empresa, papel): trocar de empresa começa uma lista nova, sem restos da anterior
  const loader = useMemo(
    () => createContactsLoader({ source, companyId: allowed ? companyId : null, pageSize }),
    [source, companyId, allowed, pageSize],
  );
  const subscribe = useCallback((notify: () => void) => loader.subscribe(() => notify()), [loader]);
  const state = useSyncExternalStore(subscribe, loader.getState, loader.getState);

  // primeira carga (e recarga ao trocar de empresa) com o texto que já estiver no campo
  useEffect(() => {
    if (!allowed || !companyId) return;
    lastSearched.current = classifyContactQuery(textRef.current).text;
    void loader.search(textRef.current);
  }, [loader, allowed, companyId]);

  // busca com debounce: só dispara quando o texto (normalizado) mudou de verdade
  useEffect(() => {
    if (!allowed || !companyId) return;
    const normalized = classifyContactQuery(text).text;
    if (lastSearched.current === normalized) return;
    const timer = setTimeout(() => {
      lastSearched.current = normalized;
      void loader.search(text);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [text, debounceMs, loader, allowed, companyId]);

  if (!companyId) return <p className="op-state">Selecione uma empresa.</p>;
  if (!allowed) return <p className="op-state">Você não tem acesso ao WhatsApp.</p>;

  function onTextChange(value: string) {
    textRef.current = value;
    setText(value);
  }

  // Enter busca já, sem esperar o debounce
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    lastSearched.current = classifyContactQuery(text).text;
    void loader.search(text);
  }

  return (
    <ContactsView
      text={text}
      state={state}
      onTextChange={onTextChange}
      onSubmit={onSubmit}
      onRetry={() => void loader.retry()}
      onLoadMore={() => void loader.loadMore()}
    />
  );
}

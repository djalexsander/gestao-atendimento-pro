import { supabase } from "../../lib/supabaseClient";
import {
  applyError,
  applyPage,
  beginLoadMore,
  beginRefresh,
  beginRetry,
  beginSearch,
  clampContactsLimit,
  initialContactsState,
  refreshLimit,
  mapContactsError,
  toArchivedContactsPage,
  toContactsPage,
  type ContactsCursor,
  type ContactsError,
  type ContactsPage,
  type ContactsState,
  type RpcErrorLike,
} from "./whatsappContactsLogic";

// Contatos do WhatsApp (Etapa 7.3): SOMENTE leitura, SOMENTE pelas RPCs list_whatsapp_contacts / search_whatsapp_contacts
// (migration 20261126010000). Nenhum acesso direto a tabelas e nenhuma escrita. O servidor valida sessão, empresa, papel e módulo
// (whatsapp_assert_reader); o navegador nunca decide permissão. Esta camada não cria telas, rotas nem componentes.

export type ContactsResult<T> = { data: T; error: null } | { data: null; error: ContactsError };

/** Fonte de dados. Recebida por parâmetro para exercitar a lógica com RPCs simuladas. */
export interface ContactsSource {
  list(companyId: string, cursor: ContactsCursor | null, limit: number): Promise<ContactsResult<ContactsPage>>;
  search(companyId: string, query: string, cursor: ContactsCursor | null, limit: number): Promise<ContactsResult<ContactsPage>>;
}

function fail(error: RpcErrorLike): ContactsResult<never> {
  // nunca registra telefone, nome nem o texto da busca
  console.error("Falha nos contatos do WhatsApp:", error.code ?? "sem código");
  return { data: null, error: mapContactsError(error) };
}

export const supabaseContactsSource: ContactsSource = {
  async list(companyId, cursor, limit) {
    const { data, error } = await supabase.rpc("list_whatsapp_contacts", {
      p_company_id: companyId,
      p_limit: clampContactsLimit(limit),
      p_after_sort: cursor?.sort ?? null,
      p_after_key: cursor?.key ?? null,
    });
    if (error) return fail(error);
    return { data: toContactsPage(data), error: null };
  },
  async search(companyId, query, cursor, limit) {
    const { data, error } = await supabase.rpc("search_whatsapp_contacts", {
      p_company_id: companyId,
      p_query: query,
      p_limit: clampContactsLimit(limit),
      p_after_sort: cursor?.sort ?? null,
      p_after_key: cursor?.key ?? null,
    });
    if (error) return fail(error);
    return { data: toContactsPage(data), error: null };
  },
};

/** Aba Arquivados (Etapa 7.10F.1): mesma interface da lista, pela RPC list_archived_whatsapp_contacts (só leitura; owner, admin, attendant e cashier). */
export const supabaseArchivedContactsSource: ContactsSource = {
  async list(companyId, cursor, limit) {
    return supabaseArchivedContactsSource.search(companyId, "", cursor, limit);
  },
  async search(companyId, query, cursor, limit) {
    const { data, error } = await supabase.rpc("list_archived_whatsapp_contacts", {
      p_company_id: companyId,
      p_query: query === "" ? null : query,
      p_limit: clampContactsLimit(limit),
      p_after_sort: cursor?.sort ?? null,
      p_after_key: cursor?.key ?? null,
    });
    if (error) return fail(error);
    return { data: toArchivedContactsPage(data), error: null };
  },
};

const NO_COMPANY: ContactsError = { kind: "forbidden", message: "Selecione uma empresa para ver os contatos." };
const GENERIC: ContactsError = { kind: "generic", message: "Não foi possível carregar os contatos agora. Tente novamente." };

/**
 * Carrega UMA página: lista completa quando não há texto, busca quando há. Nunca lança. Sem empresa ativa não chama o servidor.
 * O texto vai como foi classificado (aparado, espaços únicos); a decisão de 'nome / DDD / final / número completo' é do servidor.
 */
export async function fetchContactsPage(
  source: ContactsSource,
  companyId: string | null | undefined,
  queryText: string,
  cursor: ContactsCursor | null,
  limit?: number,
): Promise<ContactsResult<ContactsPage>> {
  if (!companyId) return { data: null, error: NO_COMPANY };
  const size = clampContactsLimit(limit);
  try {
    return queryText === "" ? await source.list(companyId, cursor, size) : await source.search(companyId, queryText, cursor, size);
  } catch {
    // falha de rede/exceção da fonte: mensagem genérica, sem detalhes
    return { data: null, error: GENERIC };
  }
}

// ---------------------------------------------------------------------------
// Carregador com estado (busca + carregamento incremental), sem React: uma tela futura apenas se inscreve.
// ---------------------------------------------------------------------------
export interface ContactsLoader {
  getState(): ContactsState;
  /** Inscreve-se nas mudanças de estado. Devolve a função de cancelar a inscrição. */
  subscribe(listener: (state: ContactsState) => void): () => void;
  /** Nova busca (texto vazio = lista completa). Cancela, na prática, qualquer pedido anterior em andamento. */
  search(rawQuery: string): Promise<void>;
  /** Próxima página da busca atual (nada acontece sem cursor, ou com pedido em andamento). */
  loadMore(): Promise<void>;
  /** Depois de uma falha: repete a página que falhou. Erros de permissão/texto inválido não repetem. */
  retry(): Promise<void>;
  /** Atualiza a lista depois de uma operação (ex.: contato criado/editado), mantendo busca e lista até a resposta chegar. */
  refresh(): Promise<void>;
  /** Troca a empresa ativa: zera tudo e descarta respostas pendentes da empresa anterior. */
  setCompany(companyId: string | null): void;
}

export function createContactsLoader(options: { source: ContactsSource; companyId: string | null; pageSize?: number }): ContactsLoader {
  const { source, pageSize } = options;
  let companyId = options.companyId;
  let state = initialContactsState();
  const listeners = new Set<(s: ContactsState) => void>();

  const set = (next: ContactsState) => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l(state);
  };

  // Executa o pedido do estado atual; a resposta só vale se o requestId ainda for o do pedido (descarta atrasadas e troca de empresa).
  async function run(cursor: ContactsCursor | null, size: number | undefined = pageSize): Promise<void> {
    const requestId = state.requestId;
    const companyAtStart = companyId;
    const res = await fetchContactsPage(source, companyAtStart, state.query.text, cursor, size);
    if (companyAtStart !== companyId) return;
    set(res.error ? applyError(state, requestId, res.error) : applyPage(state, requestId, res.data));
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async search(rawQuery) {
      set(beginSearch(state, rawQuery));
      if (state.status !== "loading") return; // texto sem sentido: lista vazia local, nenhum pedido
      await run(null);
    },
    async loadMore() {
      const before = state;
      const cursor = state.nextCursor;
      set(beginLoadMore(state));
      if (state === before) return;
      await run(cursor);
    },
    async retry() {
      const before = state;
      const cursor = state.contacts.length > 0 ? state.nextCursor : null;
      set(beginRetry(state));
      if (state === before) return;
      await run(state.status === "loading_more" ? cursor : null);
    },
    async refresh() {
      const loaded = state.contacts.length;
      const before = state;
      set(beginRefresh(state));
      if (state === before) return;
      await run(null, state.status === "loading" ? pageSize : refreshLimit(loaded, pageSize));
    },
    setCompany(next) {
      if (next === companyId) return;
      companyId = next;
      // novo requestId (maior que qualquer pedido pendente) para invalidar respostas da empresa anterior
      const reset = initialContactsState();
      set({ ...reset, requestId: state.requestId + 1 });
    },
  };
}

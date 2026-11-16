// Lógica PURA dos Contatos do WhatsApp (Etapa 7.3): sem React, sem Supabase, sem relógio. Consome o formato devolvido pelas RPCs
// list_whatsapp_contacts / search_whatsapp_contacts (migration 20261126010000, Etapa 7.2).
//
// REGRA DE OURO: o servidor decide TUDO (empresa, papel, módulo, quem é contato, deduplicação, nome, busca). Este arquivo só
//   (1) interpreta a resposta com defesa (nada quebra se o formato vier diferente),
//   (2) classifica o texto digitado do MESMO jeito que o servidor (para não chamar a RPC à toa e para a tela explicar a busca),
//   (3) guarda o estado da lista com paginação por cursor e proteção contra respostas atrasadas.
// A normalização de telefone/nome abaixo é a MESMA de whatsapp_contact_key / whatsapp_contact_fold (a paridade com o banco é
// testada em .claude/db-tests/whatsapp-contacts-integration.mjs). Qualquer mudança aqui exige mudar a migration, e vice-versa.

export type ContactSource = "conversation" | "customer" | "both";
export type ContactNameSource = "customer" | "profile" | "phone";

export interface ContactsCursor {
  sort: string;
  key: string;
}

export interface ContactRow {
  /** Identidade do contato na empresa (telefone normalizado). Única na lista inteira. */
  contactKey: string;
  displayName: string;
  nameSource: ContactNameSource;
  /** Só dígitos, como veio da conversa (ou do cadastro do cliente). */
  phone: string;
  customerId: string | null;
  /** Quantos clientes ATIVOS coincidem com este número. Maior que 1 = contato ambíguo (ver isAmbiguousContact). */
  customerMatches: number;
  profileName: string | null;
  /** Conversa mais recente (para abrir). Nula para cliente sem conversa. */
  conversationId: string | null;
  connectionId: string | null;
  conversationCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  source: ContactSource;
  sortName: string;
}

export interface ContactsPage {
  contacts: ContactRow[];
  hasMore: boolean;
  nextCursor: ContactsCursor | null;
}

// ---------------------------------------------------------------------------
// 1) Normalização (espelho de whatsapp_contact_fold / whatsapp_contact_key)
// ---------------------------------------------------------------------------
const ACCENTS_FROM = "ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ";
const ACCENTS_TO = "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy";

/**
 * Minúsculas e sem acentos (tabela fixa, igual à do banco). Não colapsa espaços internos (o banco também não). A paridade com o banco é
 * garantida para ASCII e para as letras latinas da tabela; outros alfabetos dependem do idioma do banco. É só um auxiliar: quem filtra é o servidor.
 */
export function foldContactText(text: string | null | undefined): string {
  let out = "";
  for (const ch of text ?? "") {
    const i = ACCENTS_FROM.indexOf(ch);
    out += i >= 0 ? ACCENTS_TO[i] : ch;
  }
  // toLowerCase do JS transforma "İ" em "i" + ponto combinante; o lower() do banco devolve só "i"
  return out.toLowerCase().replace(/̇/g, "").trim();
}

/**
 * Chave de contato. brLocal = true quando o número pode vir SEM código do país (cadastro de cliente e texto digitado na busca):
 * 10 ou 11 dígitos são DDD + número do Brasil. Telefone de conversa (E.164) usa brLocal = false.
 * O 9 do celular só é removido quando vem seguido de 6..9 (equivalência real) e só em números brasileiros (55).
 */
export function contactKey(text: string | null | undefined, brLocal = false): string | null {
  const d = (text ?? "").replace(/[^0-9]/g, "");
  const l = d.length;
  if (l === 0) return null;
  if (l === 13 && d.startsWith("55") && d[4] === "9" && d[5] >= "6" && d[5] <= "9") return d.slice(0, 4) + d.slice(5);
  if (brLocal && l === 11 && d[2] === "9" && d[3] >= "6" && d[3] <= "9") return "55" + d.slice(0, 2) + d.slice(3);
  if (brLocal && (l === 10 || l === 11)) return "55" + d;
  return d;
}

// ---------------------------------------------------------------------------
// 2) Classificação do texto digitado (espelho do início de whatsapp_contacts_query)
// ---------------------------------------------------------------------------
export const CONTACTS_QUERY_MAX = 100;
export const CONTACTS_PAGE_DEFAULT = 30;
export const CONTACTS_PAGE_MAX = 100;

export type ContactQueryKind =
  | "empty" // sem texto: lista completa
  | "name" // texto com letras: nome (todos os termos, sem acento nem caixa)
  | "ddd" // 2 dígitos
  | "suffix" // 3 a 9 dígitos: finais do número
  | "phone" // 10 a 13 dígitos: número completo (com/sem 55, com/sem o nono dígito)
  | "too_short" // 1 dígito: largo demais, o servidor devolve vazio
  | "too_many_digits" // mais de 13 dígitos: não é telefone, o servidor devolve vazio
  | "too_long"; // texto acima de 100 caracteres: o servidor recusa (PT400)

export interface ContactQuery {
  kind: ContactQueryKind;
  /** Texto a enviar ao servidor (aparado, espaços internos únicos). Vazio para 'empty'. */
  text: string;
  /** Dígitos do texto numérico ('' para nome/empty). */
  digits: string;
  /** true quando a RPC não precisa (nem deve) ser chamada: o resultado é vazio por definição. */
  skipRequest: boolean;
}

const NUMERIC_QUERY = /^[0-9\s()+.-]+$/;

export function classifyContactQuery(raw: string | null | undefined): ContactQuery {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return { kind: "empty", text: "", digits: "", skipRequest: false };
  if (text.length > CONTACTS_QUERY_MAX) return { kind: "too_long", text: "", digits: "", skipRequest: true };
  if (NUMERIC_QUERY.test(text) && /[0-9]/.test(text)) {
    const digits = text.replace(/[^0-9]/g, "");
    const n = digits.length;
    if (n < 2) return { kind: "too_short", text, digits, skipRequest: true };
    if (n > 13) return { kind: "too_many_digits", text, digits, skipRequest: true };
    return { kind: n === 2 ? "ddd" : n <= 9 ? "suffix" : "phone", text, digits, skipRequest: false };
  }
  return { kind: "name", text, digits: "", skipRequest: false };
}

/** Texto curto que a tela pode mostrar sob o campo de busca. */
export function describeContactQuery(q: ContactQuery): string {
  switch (q.kind) {
    case "empty":
      return "Todos os contatos";
    case "name":
      return "Buscando por nome";
    case "ddd":
      return `Contatos com DDD ${q.digits}`;
    case "suffix":
      return `Números terminados em ${q.digits}`;
    case "phone":
      return "Buscando pelo número completo";
    case "too_short":
      return "Digite ao menos 2 números (DDD ou final do telefone).";
    case "too_many_digits":
      return "Esse número tem dígitos demais.";
    case "too_long":
      return `A busca aceita até ${CONTACTS_QUERY_MAX} caracteres.`;
  }
}

/** Tamanho de página aceito pelo servidor (1 a 100; padrão 30). */
export function clampContactsLimit(limit: number | null | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : CONTACTS_PAGE_DEFAULT;
  return Math.min(Math.max(n, 1), CONTACTS_PAGE_MAX);
}

// ---------------------------------------------------------------------------
// 3) Interpretação defensiva da resposta
// ---------------------------------------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const nonNegInt = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

export function toContact(raw: unknown): ContactRow | null {
  if (!isObj(raw)) return null;
  const contactKeyValue = str(raw.contact_key);
  const phone = str(raw.phone);
  const displayName = str(raw.display_name) ?? phone;
  if (!contactKeyValue || !displayName) return null;
  const nameSource: ContactNameSource = raw.name_source === "customer" || raw.name_source === "profile" ? raw.name_source : "phone";
  const source: ContactSource = raw.source === "customer" || raw.source === "both" ? raw.source : "conversation";
  return {
    contactKey: contactKeyValue,
    displayName,
    nameSource,
    phone: phone ?? contactKeyValue,
    customerId: str(raw.customer_id),
    customerMatches: nonNegInt(raw.customer_matches),
    profileName: str(raw.profile_name),
    conversationId: str(raw.conversation_id),
    connectionId: str(raw.connection_id),
    conversationCount: nonNegInt(raw.conversation_count),
    lastMessageAt: str(raw.last_message_at),
    lastInboundAt: str(raw.last_inbound_at),
    source,
    sortName: str(raw.sort_name) ?? "",
  };
}

export function toCursor(raw: unknown): ContactsCursor | null {
  if (!isObj(raw)) return null;
  const sort = typeof raw.sort === "string" ? raw.sort : null;
  const key = str(raw.key);
  return sort !== null && key ? { sort, key } : null;
}

/** Resposta da RPC → página. Linhas inválidas são descartadas; nunca lança. Sem cursor válido, não há próxima página. */
export function toContactsPage(raw: unknown): ContactsPage {
  if (!isObj(raw)) return { contacts: [], hasMore: false, nextCursor: null };
  const list = Array.isArray(raw.contacts) ? raw.contacts : [];
  const seen = new Set<string>();
  const contacts: ContactRow[] = [];
  for (const item of list) {
    const c = toContact(item);
    if (c && !seen.has(c.contactKey)) {
      seen.add(c.contactKey);
      contacts.push(c);
    }
  }
  const nextCursor = toCursor(raw.next_cursor);
  return { contacts, hasMore: raw.has_more === true && nextCursor !== null, nextCursor };
}

// ---------------------------------------------------------------------------
// 4) Regras de apresentação
// ---------------------------------------------------------------------------
/** Mais de um cliente ATIVO com o mesmo número: o nome mostrado foi escolhido por critério fixo, não por certeza. */
export function isAmbiguousContact(c: Pick<ContactRow, "customerMatches">): boolean {
  return c.customerMatches > 1;
}

/** Só quem tem conversa pode ser aberto no atendimento. Cliente sem conversa não tem para onde ir. */
export function canOpenConversation(c: Pick<ContactRow, "conversationId">): boolean {
  return c.conversationId !== null;
}

/**
 * Cliente confiável para vincular/mostrar: o contato tem um cliente E não é ambíguo. Ambíguo nunca deve ser vinculado
 * automaticamente por tela nenhuma (o operador escolhe).
 */
export function trustedCustomerId(c: Pick<ContactRow, "customerId" | "customerMatches">): string | null {
  return c.customerId !== null && !isAmbiguousContact(c) ? c.customerId : null;
}

export function ambiguityNotice(c: Pick<ContactRow, "customerMatches">): string | null {
  return isAmbiguousContact(c) ? `${c.customerMatches} clientes cadastrados com este número. Confira antes de usar o nome.` : null;
}

// ---------------------------------------------------------------------------
// 5) Estado da lista (busca + carregamento incremental)
// ---------------------------------------------------------------------------
export type ContactsStatus = "idle" | "loading" | "loading_more" | "error";
export type ContactsErrorKind = "auth" | "forbidden" | "invalid" | "generic";

export interface ContactsError {
  kind: ContactsErrorKind;
  message: string;
}

export interface ContactsState {
  query: ContactQuery;
  contacts: ContactRow[];
  nextCursor: ContactsCursor | null;
  hasMore: boolean;
  status: ContactsStatus;
  error: ContactsError | null;
  /** Número do pedido em andamento; respostas com outro número (atrasadas) são descartadas. */
  requestId: number;
  /** true depois da primeira resposta (para a tela diferenciar "carregando" de "nenhum contato"). */
  loaded: boolean;
}

export function initialContactsState(): ContactsState {
  return { query: classifyContactQuery(""), contacts: [], nextCursor: null, hasMore: false, status: "idle", error: null, requestId: 0, loaded: false };
}

/** Nova busca (ou recarga): zera a lista e o cursor. Texto sem sentido (1 dígito etc.) vira lista vazia SEM pedido ao servidor. */
export function beginSearch(state: ContactsState, rawQuery: string): ContactsState {
  const query = classifyContactQuery(rawQuery);
  const requestId = state.requestId + 1;
  if (query.skipRequest) {
    return { ...initialContactsState(), query, requestId, status: "idle", loaded: true };
  }
  return { query, contacts: [], nextCursor: null, hasMore: false, status: "loading", error: null, requestId, loaded: false };
}

/** Próxima página. Só quando há cursor, nada em andamento e sem erro pendente; senão devolve o MESMO estado (sem pedido). */
export function beginLoadMore(state: ContactsState): ContactsState {
  if (!state.hasMore || !state.nextCursor || state.status === "loading" || state.status === "loading_more") return state;
  return { ...state, status: "loading_more", error: null, requestId: state.requestId + 1 };
}

/** Aplica uma página. Resposta de pedido antigo é ignorada. Em "mais", acrescenta sem repetir contatos. */
export function applyPage(state: ContactsState, requestId: number, page: ContactsPage): ContactsState {
  if (requestId !== state.requestId) return state;
  const append = state.status === "loading_more";
  const known = new Set(append ? state.contacts.map((c) => c.contactKey) : []);
  const fresh = page.contacts.filter((c) => !known.has(c.contactKey));
  return {
    ...state,
    contacts: append ? [...state.contacts, ...fresh] : fresh,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    status: "idle",
    error: null,
    loaded: true,
  };
}

/** Falha. A lista já carregada é MANTIDA (a tela pode oferecer "tentar de novo" sem perder o que o operador via). */
export function applyError(state: ContactsState, requestId: number, error: ContactsError): ContactsState {
  if (requestId !== state.requestId) return state;
  return { ...state, status: "error", error, loaded: true };
}

/** Tentar de novo depois de uma falha: refaz a busca do zero (primeira página) ou a página que falhou (tinha cursor). */
export function canRetry(state: ContactsState): boolean {
  return state.status === "error" && state.error?.kind !== "forbidden" && state.error?.kind !== "invalid";
}

export function beginRetry(state: ContactsState): ContactsState {
  if (!canRetry(state)) return state;
  if (state.contacts.length > 0 && state.hasMore && state.nextCursor) {
    return { ...state, status: "loading_more", error: null, requestId: state.requestId + 1 };
  }
  return beginSearch(state, state.query.text);
}

// ---------------------------------------------------------------------------
// 6) Erros do servidor → mensagem amigável + tipo (nada de telefone, nome ou texto da busca)
// ---------------------------------------------------------------------------
export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

export function mapContactsError(error: RpcErrorLike): ContactsError {
  const code = error.code ?? "";
  const msg = error.message ?? "";
  if (code === "PT401" || code === "42501" || code === "401" || /sess[ãa]o inv[aá]lida|jwt|not authenticated/i.test(msg)) {
    return { kind: "auth", message: "Sua sessão expirou. Entre novamente para ver os contatos." };
  }
  if (code === "PT403" || code === "PT404" || code === "PT402" || /n[ãa]o est[áa] contratado|permiss[ãa]o|empresa n[ãa]o encontrada/i.test(msg)) {
    return { kind: "forbidden", message: "Os contatos do WhatsApp não estão disponíveis para o seu usuário ou para esta empresa." };
  }
  if (code === "PT400") {
    return { kind: "invalid", message: /muito longa/i.test(msg) ? `A busca aceita até ${CONTACTS_QUERY_MAX} caracteres.` : "Não foi possível fazer essa busca. Ajuste o texto e tente de novo." };
  }
  return { kind: "generic", message: "Não foi possível carregar os contatos agora. Tente novamente." };
}

// INTERAÇÃO DETERMINÍSTICA da IA do WhatsApp (sem chamada à IA, sem custo, sem cota): textos fixos de transferência para o humano e de mesa/reserva, leitura de pedidos com
// QUANTIDADE ("quero 2 haineken", "2 haineken e 3 coca zero"), continuação de uma pergunta de esclarecimento ("a zero") e a mensagem que confirma o item, pergunta qual o
// cliente prefere ou oferece alternativas REAIS. Tudo sobre os fatos que o banco já devolveu (whatsapp_ai_lookup_knowledge_job): nome e preço vêm SEMPRE do cadastro da empresa
// do job, nada é inventado e nada é trocado sem o cliente confirmar. Este módulo não conhece prompt, banco nem rede.
import { norm } from "./ai-auto.ts";
import { isOrderIntent, type KnowledgeFacts, type KnowledgeProduct } from "./ai-knowledge.ts";

export const HUMAN_CONFIRM_TEXT = "Claro! Vou encaminhar você para um atendente. 😊";
export const RESERVATION_HANDOFF_TEXT = "Não consigo confirmar mesas ou reservas por aqui. Vou encaminhar você para um atendente que poderá ajudar. 😊";
export const RESERVATION_INFO_TEXT = "Não consigo confirmar mesas ou reservas por aqui.";
export const EMPTY_CATALOG_TEXT = "Ainda não tenho o cardápio disponível por aqui. Vou encaminhar você para um atendente. 😊";

/** Pergunta sobre mesa/lugar/reserva: informação que a IA não consegue verificar (nunca inventa disponibilidade). */
const NUMW = "(?:\\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)";
const RESERVATION_RE = new RegExp(
  "(\\breserv(?:ar|a|as|ei|o)\\b|\\b(?:tem|ha|existe|sobrou|tinha|temos)\\s+(?:uma?\\s+)?(?:mesa|mesas|lugar|lugares)\\b|\\b(?:mesa|mesas|lugar|lugares)\\s+(?:pra|para|p/)\\s+" + NUMW + "\\b|\\b(?:pra|para)\\s+" + NUMW + "\\s+pessoas\\b|\\bmesa\\s+(?:disponivel|livre)\\b)",
);
export function isReservationQuestion(text: string): boolean {
  return RESERVATION_RE.test(norm(text));
}

// ---------------------------------------------------------------------------
// Quantidade e itens
// ---------------------------------------------------------------------------
export interface OrderItemRequest {
  /** Quantidade que o cliente disse (null = não disse). */
  qty: number | null;
  /** O que ele pediu, sem verbo nem quantidade ("haineken", "coca zero"). */
  term: string;
  /** Texto alternativo para uma segunda tentativa (continuação: pedido anterior + resposta). */
  fallbackTerm?: string;
}

const WORD_QTY: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
const MAX_ITEMS = 4;
const MAX_QTY = 999;

const VERBS = /\b(?:oi|ola|bom dia|boa tarde|boa noite|por favor|pfv|pf|porfavor|obrigad[oa]|vou querer|vou pedir|quero pedir|queria|quero|gostaria de|gostaria|pode(?:ria)? (?:me )?(?:anotar|colocar|mandar|trazer|separar|ver)|me (?:ve|manda|traz|anota|separa)|anota|manda|separa|traz|fazer (?:um |o )?pedido(?: de)?|(?:um )?pedido de)\b/g;

function splitQty(seg: string): { qty: number | null; rest: string } {
  let m = seg.match(/^(\d{1,3})\s*(?:x|un|unid\w*|unidades?)?\s+(.*)$/);
  if (m) {
    const q = Number(m[1]);
    return { qty: q >= 1 && q <= MAX_QTY ? q : null, rest: m[2] };
  }
  m = seg.match(/^(um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(.*)$/);
  if (m) return { qty: WORD_QTY[m[1]], rest: m[2] };
  m = seg.match(/^(.*?)\s+(\d{1,3})\s*x$/);
  if (m) return { qty: Number(m[2]), rest: m[1] };
  return { qty: null, rest: seg };
}

/** "quero 2 haineken" -> [{qty:2, term:"haineken"}]; "2 haineken e 3 coca zero" -> dois itens. Sem quantidade em cada pedaço, é UM item só (não quebra nomes com "e"). */
export function parseOrderItems(raw: string): OrderItemRequest[] {
  const t = norm(raw).replace(/[!?.]+/g, " ").replace(VERBS, " ").replace(/\s+/g, " ").replace(/^[\s,;+]+|[\s,;+]+$/g, "").trim();
  if (!t) return [];
  const pieces = t.split(/\s*(?:,|;|\+|\s+e\s+|\s+mais\s+)\s*/).map((s) => s.trim()).filter(Boolean);
  const parsed = pieces.map((p) => ({ ...splitQty(p), raw: p }));
  const withQty = parsed.filter((p) => p.qty !== null).length;
  const groups: { qty: number | null; rest: string }[] = [];
  if (withQty >= 2) {
    for (const p of parsed) {
      if (p.qty !== null || groups.length === 0) groups.push({ qty: p.qty, rest: p.rest });
      else groups[groups.length - 1].rest += ` e ${p.raw}`; // pedaço sem quantidade pertence ao item anterior
    }
  } else {
    const first = splitQty(t);
    groups.push(first);
  }
  const items: OrderItemRequest[] = [];
  let prevHead = "";
  for (const g of groups.slice(0, MAX_ITEMS)) {
    let rest = g.rest.replace(/^(?:unidades?|un|unid)\s+/, "").trim();
    const de = rest.match(/^(?:de|da|do)\s+(.*)$/);
    if (de && prevHead) rest = `${prevHead} de ${de[1]}`; // "2 espetos de carne e 1 de frango" -> espetos de frango
    rest = rest.replace(/^(?:de|da|do|dos|das|o|a|os|as)\s+/, "").trim();
    if (rest.length < 2) continue;
    prevHead = rest.split(" ")[0];
    items.push({ qty: g.qty, term: rest });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Continuação: "quero 2 coca" -> (pergunta de esclarecimento) -> "a zero"
// ---------------------------------------------------------------------------
interface Msg {
  direction: "inbound" | "outbound";
  text: string;
  type?: string;
}
const lastIndexWhere = (a: Msg[], f: (m: Msg) => boolean): number => {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
};

/** Pedidos que a IA consegue ler SEM IA: pedido novo (com quantidade) ou resposta curta à pergunta de esclarecimento que ela mesma fez. null = não é o caso. */
export function orderRequestFrom(messages: Msg[]): { items: OrderItemRequest[]; followUp: boolean } | null {
  const li = lastIndexWhere(messages, (m) => m.direction === "inbound" && (m.type === undefined || m.type === "text"));
  if (li < 0) return null;
  const last = messages[li].text;
  if (isOrderIntent(last)) {
    const items = parseOrderItems(last);
    return items.length ? { items, followUp: false } : null;
  }
  const words = norm(last).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  const oi = lastIndexWhere(messages.slice(0, li), (m) => m.direction === "outbound");
  if (oi < 0 || !/\?\s*$/.test(messages[oi].text.trim())) return null; // a resposta tem de seguir uma pergunta nossa
  const pi = lastIndexWhere(messages.slice(0, oi), (m) => m.direction === "inbound" && (m.type === undefined || m.type === "text"));
  if (pi < 0 || !isOrderIntent(messages[pi].text)) return null;
  const prev = parseOrderItems(messages[pi].text);
  if (prev.length === 0) return null;
  const reply = norm(last).replace(/^(?:a|o|as|os|pode ser|pode|quero|esse|essa|ai|entao)\s+/g, "").replace(/^(?:a|o|as|os)\s+/, "").trim() || norm(last);
  return { items: [{ qty: prev[0].qty, term: reply, fallbackTerm: `${prev[0].term} ${reply}` }], followUp: true };
}

// ---------------------------------------------------------------------------
// Resposta ao pedido (fatos do banco -> texto). Sem total, sem estoque, sem promessa.
// ---------------------------------------------------------------------------
const brl = (n: number): string => `R$ ${n.toFixed(2).replace(".", ",")}`;
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const list = (ps: KnowledgeProduct[]): string => {
  const t = ps.map((p) => `${p.name} (${brl(p.price)})`);
  return t.length <= 1 ? (t[0] ?? "") : `${t.slice(0, -1).join(", ")} e ${t[t.length - 1]}`;
};
const forQty = (q: number | null): string => (q && q > 1 ? ` para as ${q} unidades` : "");

export type ItemState =
  | { kind: "resolved"; product: KnowledgeProduct; qty: number | null }
  | { kind: "ask"; text: string; term: string };

/** Uma única correspondência clara = resolvido; senão pergunta objetiva (opções parecidas, alternativas reais da mesma família ou "não encontrei"). */
export function classifyItem(req: OrderItemRequest, f: KnowledgeFacts): ItemState {
  const exact = f.exact_match !== false;
  if (exact && f.products.length === 1 && !f.ambiguous) return { kind: "resolved", product: f.products[0], qty: req.qty };
  if (exact && f.products.length > 1) {
    const opts = f.products.slice(0, 3);
    return { kind: "ask", term: req.term, text: `Temos ${list(opts)}${f.products.length > 3 ? " e outras opções" : ""}. Qual você prefere${forQty(req.qty)}?` };
  }
  const alts = f.alternatives ?? [];
  if (alts.length > 0) {
    const what = f.missing?.brands[0] ? cap(f.missing.brands[0]) : "esse item";
    return { kind: "ask", term: req.term, text: `Não temos ${what} no cardápio, mas temos ${list(alts.slice(0, 3))}. Algum deles serve${forQty(req.qty)}?` };
  }
  if (f.products.length > 0) {
    const attrs = f.missing?.attrs.length ? ` (${f.missing.attrs.join(", ")})` : "";
    return { kind: "ask", term: req.term, text: `Não temos exatamente isso${attrs}, mas temos ${list(f.products.slice(0, 3))}. Qual você prefere${forQty(req.qty)}?` };
  }
  return { kind: "ask", term: req.term, text: "Não encontrei esse item no cardápio. Pode me dizer de outro jeito ou prefere que eu chame um atendente?" };
}

const itemText = (s: Extract<ItemState, { kind: "resolved" }>): string =>
  s.qty ? `${s.qty} × ${s.product.name} (${brl(s.product.price)} cada)` : `${s.product.name} (${brl(s.product.price)})`;

export interface OrderReply {
  text: string;
  /** true = tudo confirmado: a conversa segue para um atendente finalizar o pedido (a IA não cria pedido). */
  handoff: boolean;
  reason: "order_assist" | "clarification" | "missing_info";
}

export function composeOrderReply(states: ItemState[], opts: { catalogEmpty?: boolean } = {}): OrderReply {
  if (opts.catalogEmpty) return { text: EMPTY_CATALOG_TEXT, handoff: true, reason: "missing_info" };
  const resolved = states.filter((s): s is Extract<ItemState, { kind: "resolved" }> => s.kind === "resolved");
  const asks = states.filter((s): s is Extract<ItemState, { kind: "ask" }> => s.kind === "ask");
  const noted = resolved.length ? `Anotei: ${resolved.map(itemText).join(" e ")}.` : "";
  if (asks.length === 0) return { text: `${noted} Vou encaminhar você para um atendente finalizar o pedido. 😊`, handoff: true, reason: "order_assist" };
  const rest = asks.length > 1 ? ` Depois me diga sobre: ${asks.slice(1).map((a) => a.term).join(", ")}.` : "";
  return { text: `${noted ? noted + " " : ""}${asks[0].text}${rest}`, handoff: false, reason: "clarification" };
}

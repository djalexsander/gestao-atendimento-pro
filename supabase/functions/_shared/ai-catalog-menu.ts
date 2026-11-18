// LISTAGEM DO CATÁLOGO no WhatsApp ("manda o cardápio", "quero ver o catálogo", "o que vocês vendem?", "quais bebidas têm?"). Determinístico: sem IA,
// sem cota. "Cardápio" e "catálogo" são sinônimos. O texto sai SOMENTE dos dados que o banco devolveu (whatsapp_ai_catalog_menu_job: categorias e produtos
// ativos e à venda da empresa do job, nome e preço do cadastro). Nada é inventado, nenhum link é criado e nenhum total/estoque é prometido.
import { norm } from "./ai-auto.ts";
import { isOrderIntent } from "./ai-knowledge.ts";

/** Marca da pergunta de categoria (quando o cardápio completo não cabe numa mensagem): a resposta curta do cliente seguinte é lida como a categoria. */
export const CATALOG_ASK_MARKER = "Qual categoria você quer ver?";
export const CATALOG_TAIL = "Me diga o que você quer e a quantidade (ex.: \"2 coca zero\") que eu anoto. 😊";
const MAX_BODY = 3600;          // abaixo do limite do WhatsApp (4096) com folga para o cabeçalho e o rodapé
const MAX_REQUEST_WORDS = 14;

const words = (s: string): string[] => norm(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const NEGATION_RE = /\b(?:nao|sem|nunca|dispenso)\b/;
// perguntas específicas (preço, horário, entrega, disponibilidade de um item) NÃO são pedido de listagem
const SPECIFIC_RE = /\b(?:preco|precos|quanto|custa|custam|horario|horarios|abre|abrem|fecha|fecham|aberto|aberta|entrega|entregam|taxa|frete|pagamento|pix|cartao|promocao|desconto|estoque|acabou)\b/;
const MENU_WORD_RE = /\b(?:cardapio|cardapios|catalogo|catalogos|menu)\b/;
// "o que vocês vendem/têm/servem/oferecem", "quais produtos/opções/categorias vocês têm"
const WHAT_RE = /\b(?:o que|oq|que que)\s+(?:voces|vcs|vc)?\s*(?:tem|temos|vendem|vende|servem|oferecem|ha|trabalham)\b|\bquais?\s+(?:sao\s+)?(?:os\s+|as\s+)?(?:produtos|opcoes|itens|categorias)\b|\b(?:ver|conhecer|saber)\s+(?:os\s+|as\s+)?(?:produtos|opcoes|itens|categorias)\b/;
// "quais bebidas têm?", "quais as bebidas", "que bebidas vocês têm" (a categoria é decidida pelo banco: só vale se existir uma categoria com esse nome)
const WHICH_CAT_RE = /\b(?:quais|que)\s+(?:sao\s+)?(?:as\s+|os\s+)?([a-z]{4,20})\s+(?:voces\s+|vcs\s+)?(?:tem|temos|vendem|servem|oferecem|ha)\b|\bquais?\s+(?:sao\s+)?(?:as\s+|os\s+)([a-z]{4,20})\b/;

// "quero ver os espetos", "me mostra as bebidas", "manda as sobremesas": verbo de mostrar + artigo + palavra (só vale se for categoria: o banco decide)
const SHOW_CAT_RE = /\b(?:ver|veja|mostra|mostre|mostrar|manda|mande|envia|envie)\s+(?:me\s+)?(?:todos?\s+|todas?\s+)?(?:os\s+|as\s+)([a-z]{4,20})\s*$/;

/** O cliente pediu para VER o cardápio/catálogo (completo ou de uma categoria)? Não vale para pedido de item, pergunta de preço/horário ou frase longa. */
export function isCatalogListRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const w = words(text);
  if (w.length === 0 || w.length > MAX_REQUEST_WORDS) return false;
  const t = w.join(" ");
  if (NEGATION_RE.test(t) || SPECIFIC_RE.test(t) || /\d/.test(t)) return false;
  if (isOrderIntent(text)) return false;
  return MENU_WORD_RE.test(t) || WHAT_RE.test(t) || WHICH_CAT_RE.test(t) || SHOW_CAT_RE.test(t);
}

/** Resposta curta à nossa pergunta de categoria ("bebidas", "as bebidas", "quero ver lanches"). */
export function isCategoryReply(text: string | null | undefined, lastBot: string | null | undefined): boolean {
  if (!text || !lastBot || !lastBot.includes(CATALOG_ASK_MARKER)) return false;
  const w = words(text);
  return w.length >= 1 && w.length <= 5 && !isOrderIntent(text) && !/\d/.test(w.join(" "));
}

export interface MenuProduct { name: string; price: number }
/** count = total de itens à venda da categoria no cadastro (pode ser maior que a lista enviada). */
export interface MenuCategory { name: string; products: MenuProduct[]; count: number }
export interface CatalogMenu { scope: "all" | "category"; total: number; categories: MenuCategory[]; businessName: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** RPC -> dados saneados. null = nada utilizável (desligado, sem categoria correspondente, vazio ou resposta inválida): o fluxo normal segue. */
export function parseCatalogMenu(raw: unknown): CatalogMenu | null {
  if (!isObj(raw) || raw.result !== "ok" || !Array.isArray(raw.categories)) return null;
  const categories: MenuCategory[] = [];
  let total = 0;
  for (const c of raw.categories.slice(0, 20)) {
    if (!isObj(c) || typeof c.name !== "string" || !Array.isArray(c.products)) continue;
    const products: MenuProduct[] = [];
    for (const p of c.products.slice(0, 60)) {
      if (!isObj(p) || typeof p.name !== "string") continue;
      const price = typeof p.price === "number" ? p.price : typeof p.price === "string" ? Number(p.price) : NaN;
      const name = p.name.replace(/[\r\n*_~`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!name || !Number.isFinite(price) || price < 0) continue;
      products.push({ name, price });
    }
    const cname = c.name.replace(/[\r\n*_~`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    const count = typeof c.count === "number" && Number.isFinite(c.count) ? Math.max(Math.trunc(c.count), products.length) : products.length;
    if (cname && products.length) { categories.push({ name: cname, products, count }); total += products.length; }
  }
  if (!categories.length) return null;
  const bn = typeof raw.business_name === "string" ? raw.business_name.replace(/[\r\n*_~`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { scope: raw.scope === "category" ? "category" : "all", total, categories, businessName: bn || null };
}

const brl = (n: number): string => `R$ ${n.toFixed(2).replace(".", ",")}`;
const moreText = (n: number): string => `E mais ${n} ${n === 1 ? "item" : "itens"} nesta categoria — me diga o nome do que procura.`;
const block = (c: MenuCategory, limit = c.products.length): string => {
  const hidden = c.count - Math.min(limit, c.products.length);
  return `*${c.name.toUpperCase()}*\n${c.products.slice(0, limit).map((p) => `• ${p.name} — ${brl(p.price)}`).join("\n")}${hidden > 0 ? `\n_${moreText(hidden)}_` : ""}`;
};

export interface CatalogReply { text: string; askCategory: boolean }

/**
 * Monta a mensagem. Cabe: cardápio organizado por categoria. Não cabe (cardápio completo grande): lista as categorias e pergunta qual ver (a resposta curta
 * seguinte é lida como a categoria). Categoria grande demais: mostra o que cabe e avisa quantos itens faltam (nada é omitido em silêncio).
 */
export function renderCatalogMenu(m: CatalogMenu, nameHint: string | null): CatalogReply {
  const title = m.scope === "all" ? `*Cardápio${nameHint ?? m.businessName ? ` — ${nameHint ?? m.businessName}` : ""}*` : null;
  const full = [title, ...m.categories.map((c) => block(c))].filter(Boolean).join("\n\n");
  if (full.length + CATALOG_TAIL.length + 2 <= MAX_BODY) return { text: `${full}\n\n${CATALOG_TAIL}`, askCategory: false };
  if (m.scope === "all" && m.categories.length > 1) {
    const cats = m.categories.map((c) => `• ${c.name} (${c.count})`).join("\n");
    return { text: `Temos bastante coisa! Estas são as nossas categorias:\n${cats}\n\n${CATALOG_ASK_MARKER}`, askCategory: true };
  }
  const c = m.categories[0];
  let n = c.products.length;
  while (n > 1 && `${block(c, n)}\n\n${CATALOG_TAIL}`.length > MAX_BODY) n--;
  return { text: `${block(c, n)}\n\n${CATALOG_TAIL}`, askCategory: false };
}

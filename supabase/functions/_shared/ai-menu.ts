// Cardápio em PDF pelo WhatsApp: decisão DETERMINÍSTICA (sem IA, sem custo de cota) de quando o cliente pediu ou aceitou receber o
// cardápio. O PDF só sai quando (a) o cliente PEDE ("me manda o cardápio", "quero ver o menu", "o que vocês têm?") ou (b) ACEITA uma
// oferta pendente ("sim", "pode mandar"). "Sim" sozinho NUNCA basta: a oferta pendente é decidida no banco.

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s: string): string[] => fold(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Frase de oferta, anexada à saudação inicial (uma vez por conversa). */
export const MENU_OFFER_TEXT = "Se quiser, posso enviar o nosso cardápio em PDF. É só me dizer!";
/** Legenda do documento enviado. */
export const MENU_CAPTION = "Segue o nosso cardápio em PDF. Quando quiser fazer um pedido, é só me dizer o que deseja!";

// Pedido explícito do cardápio.
const MENU_WORD_RE = /\b(?:cardapio|cardapios|menu)\b/;
// "o que vocês têm/tem/servem/vendem", "quais as opções", "ver as opções"
const WHAT_YOU_HAVE_RE = /\b(?:o que|oq|que que)\s+(?:voces|vcs|vc|tem|temos|voces tem|vcs tem|voces servem|voces vendem|vendem|servem|ha)\b|\bquais?\s+(?:sao\s+)?(?:as\s+)?(?:opcoes|pratos|produtos|lanches)\b|\b(?:ver|conhecer|saber)\s+(?:as\s+)?opcoes\b/;
const NEGATION_RE = /\b(?:nao|sem|nunca|dispenso)\b/;
// mensagem longa com cara de pergunta específica não é pedido de cardápio ("o cardápio de sexta tem feijoada?")
const MAX_REQUEST_WORDS = 14;

export function isMenuRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const w = words(text);
  if (w.length === 0 || w.length > MAX_REQUEST_WORDS) return false;
  const t = w.join(" ");
  if (NEGATION_RE.test(t)) return false;
  return MENU_WORD_RE.test(t) || WHAT_YOU_HAVE_RE.test(t);
}

const ACCEPT_WORDS = new Set([
  "sim", "s", "ss", "sss", "pode", "podemos", "manda", "mande", "mandar", "envia", "envie", "enviar", "quero", "queria", "claro", "ok", "okay", "blz", "beleza",
  "bora", "aceito", "por", "favor", "pf", "pfv", "pfvr", "isso", "uhum", "aham", "mesmo", "gostaria", "com", "certeza", "ja", "pode", "sim", "o", "a", "me", "ai", "ta", "bom", "otimo", "perfeito",
]);
const ACCEPT_CORE = new Set(["sim", "s", "ss", "sss", "pode", "manda", "mande", "mandar", "envia", "envie", "enviar", "quero", "claro", "aceito", "uhum", "aham", "bora", "gostaria"]);

/** "Sim", "Pode mandar", "Quero sim", "Claro, por favor". SÓ vale com oferta pendente (decidido no banco). */
export function isMenuAcceptance(text: string | null | undefined): boolean {
  if (!text) return false;
  const w = words(text);
  if (w.length === 0 || w.length > 6) return false;
  if (NEGATION_RE.test(w.join(" "))) return false;
  return w.every((t) => ACCEPT_WORDS.has(t)) && w.some((t) => ACCEPT_CORE.has(t));
}

export type MenuIntent = "request" | "acceptance" | null;

/** Decide a partir das mensagens do cliente ainda sem resposta (a última manda na aceitação). */
export function menuIntent(inboundTexts: string[]): MenuIntent {
  if (inboundTexts.some((t) => isMenuRequest(t))) return "request";
  if (inboundTexts.length > 0 && isMenuAcceptance(inboundTexts[inboundTexts.length - 1])) return "acceptance";
  return null;
}

/** Nome do arquivo enviado ao cliente: ASCII, sem caminho nem caracteres especiais. */
export function menuFilename(company: string): string {
  const slug = fold(company).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `Cardapio${slug ? `-${slug}` : ""}.pdf`;
}

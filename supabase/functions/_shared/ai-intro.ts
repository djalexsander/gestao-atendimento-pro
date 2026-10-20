// Apresentação determinística da assistente virtual (Fase 2). SEM IA: a frase vem pronta do banco (whatsapp_ai_auto_intro) e aqui só
// se decide (a) se a mensagem do cliente é SÓ uma saudação e (b) como compor "apresentação + resposta" sem ficar estranho.
// O nome da assistente NUNCA entra em prompt: este módulo não conhece nenhum prompt.

const GREETING_WORDS = new Set([
  "oi", "oii", "oiii", "oie", "ola", "olaa", "eae", "opa", "salve", "hey", "hello", "bom", "boa", "dia", "tarde", "noite", "e", "ai", "tudo", "bem", "td", "tdb",
]);
const GREETING_CORE = new Set(["oi", "oii", "oiii", "oie", "ola", "olaa", "eae", "opa", "salve", "hey", "hello", "bom", "boa"]);

const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** "Oi", "Olá!", "Bom dia", "Boa tarde, tudo bem?" ... Qualquer outra coisa (pergunta, pedido, número) NÃO é só saudação. */
export function isGreetingOnly(text: string | null | undefined): boolean {
  if (!text) return false;
  const tokens = fold(text).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  if (tokens.join(" ") === "e ai") return true; // "e aí"
  if (!tokens.every((t) => GREETING_WORDS.has(t))) return false;
  return tokens.some((t) => GREETING_CORE.has(t));
}

export const GREETING_TEMPLATE_TAIL = "Como posso ajudar?";

/** Saudação pura: apresentação completa, 100% template. */
export const greetingReply = (intro: string): string => `${intro} ${GREETING_TEMPLATE_TAIL}`;

// Saudação no começo da resposta normal ("Olá! Temos..."), que ficaria repetida depois da apresentação.
const LEADING_GREETING = /^(?:ol[aá]|oi|bom dia|boa tarde|boa noite)\s*(?:[,!.]+\s*|\s+)/i;

/** Apresentação como prefixo; a resposta normal segue em outro parágrafo, sem repetir a saudação. */
export function composeWithIntro(intro: string | null, body: string): string {
  if (!intro) return body;
  const text = body.trim();
  if (text.startsWith(intro)) return text; // já traz a apresentação (ex.: a saudação-template)
  let rest = text.replace(LEADING_GREETING, "");
  if (rest.length === 0) rest = text;
  else rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  return `${intro}\n\n${rest}`;
}

/** Texto da última mensagem do CLIENTE no contexto (mais recente). */
export function lastInboundText(messages: Array<{ direction?: string; text?: string }> | undefined): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.direction === "inbound" && typeof m.text === "string") return m.text;
  }
  return null;
}

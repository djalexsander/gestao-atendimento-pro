// Nome da assistente virtual (Fase 2): normalização, validação (espelho da regra do banco) e preview da apresentação.
// O nome é SÓ dado de apresentação; nunca vai ao prompt da IA.
export const AI_NAME_MAX = 40;
export const AI_NAME_FALLBACK = "Assistente Virtual";
export const AI_NAME_HINT = "Esse nome será usado para apresentar a assistente virtual aos clientes.";
export const AI_NAME_PLACEHOLDER = "Juliana";

const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 .'-]*$/;
const BLOCKED_RE = /(ignor|instru|prompt|system|sistema|regra|desconsider|esque[cç]a|jailbreak|openai|chatgpt)/i;

/** Aparas e espaços repetidos viram um só. Vazio => null (volta ao padrão). */
export function normalizeDisplayName(raw: string): string | null {
  const v = raw.replace(/\s+/g, " ").trim();
  return v === "" ? null : v;
}

/** null = válido (ou vazio, que significa "usar o padrão"). */
export function displayNameError(raw: string): string | null {
  if (/[\r\n\t]/.test(raw)) return "O nome deve ficar em uma única linha.";
  const v = normalizeDisplayName(raw);
  if (v === null) return null;
  if (v.length > AI_NAME_MAX) return `O nome pode ter no máximo ${AI_NAME_MAX} caracteres.`;
  if (!NAME_RE.test(v)) return "Use apenas letras, números, espaço, ponto, apóstrofo ou hífen.";
  if (v.split(" ").length > 4) return "Use um nome curto, de até 4 palavras.";
  if (BLOCKED_RE.test(v)) return "Esse nome não pode ser usado. Escolha um nome de pessoa ou apelido.";
  return null;
}

/** Mesma frase fixa que o banco monta para a 1ª mensagem da conversa. */
export function assistantIntro(name: string | null | undefined, business: string): string {
  const biz = business.trim() || "nossa empresa";
  const n = name ? normalizeDisplayName(name) : null;
  return n ? `Olá! Eu sou a ${n}, assistente virtual da ${biz}.` : `Olá! Sou a Assistente Virtual da ${biz}.`;
}
export const assistantPreview = (name: string | null | undefined, business: string): string => `${assistantIntro(name, business)} Como posso ajudar?`;

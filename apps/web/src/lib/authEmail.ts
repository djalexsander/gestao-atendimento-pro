// Regras PURAS do cadastro por e-mail (sem React/Supabase): normalização, destino do link de confirmação e reenvio com
// cooldown. A confirmação em si é do Supabase Auth; aqui só se evita o erro humano (e-mail digitado errado) e o destino errado.

/** Domínio oficial do produto: para onde o link de confirmação do e-mail leva (nunca localhost em produção). */
export const OFFICIAL_APP_URL = "https://atendimento.alexproapps.com.br";

/** Só aparar espaços e usar minúsculas: nenhuma outra parte do endereço é alterada. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Formato mínimo (a validação real é do Auth); evita enviar lixo óbvio. */
export function looksLikeEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * emailRedirectTo do cadastro/reenvio. Em desenvolvimento (página aberta em localhost) volta ao próprio localhost; em
 * qualquer outro caso (produção, PWA instalado, app desktop com origem tauri://) volta ao domínio oficial.
 */
export function signupRedirectUrl(hostname: string | null | undefined, origin: string | null | undefined): string {
  if (hostname && LOCAL_HOSTS.has(hostname) && origin && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, "");
  return OFFICIAL_APP_URL;
}

/** O Auth do projeto aceita um e-mail por minuto por destinatário (auth.email.max_frequency = 1m). */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Segundos que ainda faltam para liberar o reenvio (0 = liberado). */
export function cooldownRemaining(lastSentAtMs: number | null, nowMs: number, cooldownSeconds = RESEND_COOLDOWN_SECONDS): number {
  if (lastSentAtMs === null) return 0;
  return Math.max(0, Math.ceil((lastSentAtMs + cooldownSeconds * 1000 - nowMs) / 1000));
}

/** Mensagem amigável para falhas do reenvio (rate limit do Auth e do SMTP, rede e demais). */
export function friendlyResendError(error: { message?: string; status?: number; code?: string } | null | undefined): string {
  if (!error) return "Não foi possível reenviar agora. Tente novamente em instantes.";
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  if (error.status === 429 || /rate.?limit|too many|security purposes|over_email/.test(text)) {
    return "Aguarde cerca de um minuto antes de pedir outro e-mail.";
  }
  if (/already.*(confirmed|registered)|email_exists/.test(text)) return "Este e-mail já está confirmado. Volte para o login.";
  return "Não foi possível reenviar agora. Tente novamente em instantes.";
}

export const RESEND_SUCCESS_MESSAGE = "Reenviamos o e-mail. Confira também a caixa de spam.";

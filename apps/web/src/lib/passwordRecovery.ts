// Regras PURAS da recuperação de senha e das mensagens do login (sem React/Supabase). O fluxo em si é do Supabase Auth
// (resetPasswordForEmail + updateUser); aqui só: destino do link, validação da nova senha e mensagens amigáveis.
import { OFFICIAL_APP_URL, signupRedirectUrl } from "./authEmail";

export const RESET_PASSWORD_PATH = "/redefinir-senha";
/** Mesma regra mínima do cadastro (SignupPage: minLength 6; a política real do projeto é a do Auth). */
export const MIN_PASSWORD_LENGTH = 6;

/** Sempre a mesma mensagem: a tela nunca revela se o e-mail existe. */
export const RESET_REQUEST_MESSAGE = "Se este e-mail estiver cadastrado, você receberá um link para redefinir sua senha.";
export const RESET_SUCCESS_MESSAGE = "Senha alterada com sucesso. Você já pode entrar com a nova senha.";
export const RESET_LINK_EXPIRED_MESSAGE = "Este link de recuperação expirou ou já foi usado. Solicite um novo link.";
export const LOGIN_INVALID_MESSAGE = "E-mail ou senha incorretos.";
export const LOGIN_GENERIC_MESSAGE = "Não foi possível entrar agora. Verifique a conexão e tente novamente.";
export const NETWORK_MESSAGE = "Não foi possível conectar. Verifique sua internet e tente novamente.";

/** redirectTo do e-mail de recuperação: domínio oficial (ou o próprio localhost só em desenvolvimento) + /redefinir-senha. */
export function resetPasswordRedirectUrl(hostname: string | null | undefined, origin: string | null | undefined): string {
  return `${signupRedirectUrl(hostname, origin)}${RESET_PASSWORD_PATH}`;
}

type AuthErrorLike = { message?: string; status?: number; code?: string; name?: string } | null | undefined;

const isNetwork = (e: NonNullable<AuthErrorLike>) =>
  e.status === 0 || /failed to fetch|network|load failed|fetch/i.test(`${e.name ?? ""} ${e.message ?? ""}`) && !e.code;

/** Login de proprietário/admin: nunca repassa o texto técnico do Auth. */
export function friendlyLoginError(error: AuthErrorLike): string | null {
  if (!error) return null;
  const code = error.code ?? "";
  const text = `${code} ${error.message ?? ""}`.toLowerCase();
  if (code === "invalid_credentials" || /invalid login credentials/.test(text)) return LOGIN_INVALID_MESSAGE;
  if (code === "email_not_confirmed" || /email not confirmed/.test(text)) return "Confirme seu e-mail pelo link que enviamos antes de entrar.";
  if (code === "over_request_rate_limit" || error.status === 429) return "Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.";
  if (code === "user_banned") return "Acesso desativado. Procure o administrador da empresa.";
  if (isNetwork(error)) return NETWORK_MESSAGE;
  return LOGIN_GENERIC_MESSAGE;
}

/**
 * Pedido do link: só falhas que NÃO revelam existência de conta viram erro (rede, limite de envio). Qualquer outra
 * resposta é tratada como "enviado" para impedir enumeração de e-mails.
 */
export function friendlyResetRequestError(error: AuthErrorLike): string | null {
  if (!error) return null;
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  if (error.status === 429 || /rate.?limit|too many|security purposes|over_email/.test(text)) {
    return "Aguarde cerca de um minuto antes de pedir outro link.";
  }
  if (isNetwork(error)) return NETWORK_MESSAGE;
  return null;
}

/** Falhas do updateUser na tela de nova senha. */
export function friendlyUpdatePasswordError(error: AuthErrorLike): string | null {
  if (!error) return null;
  const code = error.code ?? "";
  const text = `${code} ${error.message ?? ""}`.toLowerCase();
  if (code === "same_password" || /different from the old|same.*password/.test(text)) return "Escolha uma senha diferente da atual.";
  if (code === "weak_password" || /password (should|must)|weak/.test(text)) return "Senha fraca. Use uma senha mais longa e menos comum.";
  if (/session|jwt|expired|not authenticated|missing/.test(text) || error.status === 401 || error.status === 403) return RESET_LINK_EXPIRED_MESSAGE;
  if (isNetwork(error)) return NETWORK_MESSAGE;
  return "Não foi possível alterar a senha agora. Tente novamente em instantes.";
}

/** Valida nova senha + confirmação; devolve a mensagem de erro ou null. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `A senha precisa ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password !== confirm) return "As senhas não conferem.";
  return null;
}

/**
 * Lê o fragmento/consulta da URL de volta do e-mail. O Auth manda erro como #error=access_denied&error_code=otp_expired
 * (ou na query) e, em caso de sucesso, #access_token=...&type=recovery (consumido pelo supabase-js).
 */
export function parseRecoveryUrl(hash: string, search: string): "error" | "recovery" | "none" {
  const p = new URLSearchParams(`${hash.replace(/^#/, "")}&${search.replace(/^\?/, "")}`);
  if (p.get("error") || p.get("error_code") || p.get("error_description")) return "error";
  if (p.get("type") === "recovery" || p.get("access_token") || p.get("code")) return "recovery";
  return "none";
}

export { OFFICIAL_APP_URL };

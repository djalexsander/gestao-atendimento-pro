// Regras de login, nome e credencial de funcionário aplicadas na tela. Espelham o
// backend (constraints de company_users e a Edge Function employee-admin) só para
// dar retorno imediato enquanto a pessoa digita. A autoridade é o backend: qualquer
// coisa que passar por aqui e não valer lá volta como mensagem amigável.

export const LOGIN_MIN_LENGTH = 3;
export const LOGIN_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 120;

// PIN = só dígitos, EXATAMENTE 6. Qualquer outra coisa é senha, com a política que o
// Auth aceita hoje (mínimo de 6; até 72 bytes, limite do bcrypt).
export const PIN_LENGTH = 6;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_BYTES = 72;

// Devolve a mensagem do primeiro problema encontrado, ou null se está válido.
export function validateLogin(login: string): string | null {
  if (login.length === 0) return "Informe o login.";
  if (login.length < LOGIN_MIN_LENGTH) return `Use no mínimo ${LOGIN_MIN_LENGTH} caracteres.`;
  if (login.length > LOGIN_MAX_LENGTH) return `Use no máximo ${LOGIN_MAX_LENGTH} caracteres.`;
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(login)) {
    return "Use letras minúsculas, números, _ e -. O ponto só pode separar grupos (nunca no início, no fim nem repetido).";
  }
  return null;
}

export function validateEmployeeName(name: string): string | null {
  if (name.length === 0) return "Informe o nome do funcionário.";
  if (name.length > NAME_MAX_LENGTH) return `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  return null;
}

export function validateCredential(value: string): string | null {
  if (value.length === 0) return "Informe o PIN ou a senha.";
  if (value !== value.trim()) return "O PIN ou a senha não pode começar nem terminar com espaço.";
  if (/^[0-9]+$/.test(value)) {
    return value.length === PIN_LENGTH ? null : `O PIN deve ter exatamente ${PIN_LENGTH} números.`;
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) {
    return `A senha pode ter no máximo ${PASSWORD_MAX_BYTES} caracteres.`;
  }
  return null;
}

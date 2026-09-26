// Regras do código da empresa (login dos funcionários) aplicadas na tela. Espelham a
// CHECK companies_access_code_format do banco — 3 a 32 caracteres; minúsculas, dígitos
// e hífen; sem hífen no início, no fim nem repetido — só para dar retorno imediato
// enquanto a pessoa digita. A autoridade continua sendo o banco: a RPC create_company
// devolve a mensagem amigável se algo passar por aqui.
export const ACCESS_CODE_MIN_LENGTH = 3;
export const ACCESS_CODE_MAX_LENGTH = 32;

// Devolve a mensagem do primeiro problema encontrado, ou null se o código é válido.
export function validateAccessCode(code: string): string | null {
  if (code.length === 0) return "Informe o código da empresa.";
  if (code.length < ACCESS_CODE_MIN_LENGTH) {
    return `Use no mínimo ${ACCESS_CODE_MIN_LENGTH} caracteres.`;
  }
  if (code.length > ACCESS_CODE_MAX_LENGTH) {
    return `Use no máximo ${ACCESS_CODE_MAX_LENGTH} caracteres.`;
  }
  if (!/^[a-z0-9-]+$/.test(code)) return "Use apenas letras minúsculas, números e hífen.";
  if (code.startsWith("-") || code.endsWith("-")) {
    return "O código não pode começar nem terminar com hífen.";
  }
  if (code.includes("--")) return "O código não pode ter dois hífens seguidos.";
  return null;
}

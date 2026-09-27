// Regras do código da empresa (login dos funcionários) aplicadas na tela. Espelham a
// CHECK companies_access_code_format do banco — 3 a 32 caracteres; minúsculas, dígitos
// e hífen; sem hífen no início, no fim nem repetido — só para dar retorno imediato
// enquanto a pessoa digita. A autoridade continua sendo o banco: as RPCs create_company e
// update_company_access_code devolvem a mensagem amigável se algo passar por aqui.
export const ACCESS_CODE_MIN_LENGTH = 3;
export const ACCESS_CODE_MAX_LENGTH = 32;

// O código faz parte do e-mail técnico dos funcionários (<login>@<código>.staff...): com
// funcionário cadastrado ele não muda. É a mesma mensagem que o banco devolve.
export const ACCESS_CODE_LOCKED_MESSAGE =
  "Este código não pode ser alterado enquanto houver funcionários cadastrados, pois ele faz parte das credenciais de acesso.";

// Mensagem para o erro de update_company_access_code. As mensagens amigáveis (código em uso,
// inválido, travado, sem permissão) já vêm escritas do banco com SQLSTATE PT###; qualquer outra
// falha vira a mensagem genérica, sem o texto técnico.
export function describeAccessCodeError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  return code.startsWith("PT") && message ? message : fallback;
}

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

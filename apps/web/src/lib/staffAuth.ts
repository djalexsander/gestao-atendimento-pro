// Login operacional do funcionário: ele informa código da empresa + login + PIN ou senha.
// Por baixo, o Supabase Auth recebe um e-mail técnico que o funcionário nunca vê:
//   <login>@<access_code>.staff.alexproapps.com.br
// É o mesmo endereço que a Edge Function employee-admin gera ao cadastrar (no banco:
// company_staff_email); se um mudar, o outro muda junto.
export const STAFF_EMAIL_DOMAIN = "staff.alexproapps.com.br";

export const normalizeAccessCode = (value: string): string => value.trim().toLowerCase();
export const normalizeLogin = (value: string): string => value.trim().toLowerCase();

export function staffEmail(accessCode: string, login: string): string {
  return `${normalizeLogin(login)}@${normalizeAccessCode(accessCode)}.${STAFF_EMAIL_DOMAIN}`;
}

// "Lembrar esta empresa neste aparelho": só o código da empresa (não é segredo) e só se a
// pessoa pedir.
const REMEMBERED_COMPANY_KEY = "orca-facil:employee-company-code";

export function readRememberedCompany(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_COMPANY_KEY);
  } catch {
    return null;
  }
}

export function rememberCompany(accessCode: string): void {
  try {
    localStorage.setItem(REMEMBERED_COMPANY_KEY, accessCode);
  } catch {
    // localStorage indisponível (modo privado, etc.): segue sem lembrar.
  }
}

export function forgetRememberedCompany(): void {
  try {
    localStorage.removeItem(REMEMBERED_COMPANY_KEY);
  } catch {
    // idem
  }
}

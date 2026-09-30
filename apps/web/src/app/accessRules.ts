import type { CompanyRole } from "../lib/types";

// Regras de acesso por papel e de redirecionamento das rotas. Sem React e sem
// dependências de runtime, de propósito: as decisões ficam aqui (testáveis à parte) e os
// guards em routeGuards.tsx só as aplicam. A proteção dos DADOS é do backend (RLS); estas
// regras só decidem para onde a tela vai.

export type OperationalArea = "atendimento" | "caixa" | "producao";

export type GuardedRoute =
  | "guest" // /login, /cadastro, /funcionario: só para quem NÃO tem sessão
  | "root" // "/": só encaminha
  | "onboarding" // /onboarding: só para conta normal que ainda não tem empresa
  | "disabled" // /acesso-desativado
  | "app" // /app/*: Administrativo (owner/admin)
  | OperationalArea; // /operacional/atendimento, /operacional/caixa, /operacional/producao

export const OPERATIONAL_PATH: Record<OperationalArea, string> = {
  atendimento: "/operacional/atendimento",
  caixa: "/operacional/caixa",
  producao: "/operacional/producao",
};
export const DISABLED_ACCESS_PATH = "/acesso-desativado";
export const EMPLOYEE_LOGIN_PATH = "/funcionario";
export const ADMIN_LOGIN_PATH = "/login";
export const ADMIN_HOME_PATH = "/app";
export const ONBOARDING_PATH = "/onboarding";

// Área operacional de cada papel nesta etapa (landing): attendant → Atendimento, cashier → Caixa /
// Balcão. owner e admin pousam no app administrativo; de lá entram no Caixa / Balcão pelo menu
// (ver AREA_ROLES abaixo). Ampliar o acesso (ex.: caixa também em Atendimento) é decisão de produto.
const ROLE_AREA: Partial<Record<CompanyRole, OperationalArea>> = {
  attendant: "atendimento",
  cashier: "caixa",
  production: "producao",
};

export function operationalAreaOf(role: CompanyRole): OperationalArea | null {
  return ROLE_AREA[role] ?? null;
}

// Quem PODE abrir cada rota operacional. O Caixa / Balcão também é aberto por owner e admin
// (menu Operacional → Caixa / Balcão do Administrativo): é a MESMA tela do cashier. Atendimento
// segue só do attendant. A landing de cada papel (operationalAreaOf) não muda.
const AREA_ROLES: Record<OperationalArea, readonly CompanyRole[]> = {
  atendimento: ["attendant"],
  caixa: ["cashier", "owner", "admin"],
  // Produção / Cozinha (KDS): o papel production e, pelo menu Operacional do Administrativo, owner/admin.
  producao: ["production", "owner", "admin"],
};

export function canOpenOperationalArea(role: CompanyRole, area: OperationalArea): boolean {
  return AREA_ROLES[area].includes(role);
}

export function homePathForRole(role: CompanyRole): string {
  const area = operationalAreaOf(role);
  return area ? OPERATIONAL_PATH[area] : ADMIN_HOME_PATH;
}

export interface AuthSnapshot {
  loading: boolean; // sessão inicial ainda sendo resolvida
  hasSession: boolean;
  companiesLoading: boolean;
  role: CompanyRole | null; // papel no vínculo ATIVO da empresa ativa (null = nenhum)
  accessDisabled: boolean; // tem vínculo(s), mas nenhum ativo
  isManaged: boolean; // conta de funcionário (app_metadata.managed)
}

export type Decision =
  | { action: "wait" }
  | { action: "render" }
  | { action: "redirect"; to: string };

const WAIT: Decision = { action: "wait" };
const RENDER: Decision = { action: "render" };
const redirect = (to: string): Decision => ({ action: "redirect", to });

// Para onde uma pessoa logada, com os vínculos já carregados, deve estar.
export function landingPath(s: AuthSnapshot): string {
  if (s.role) return homePathForRole(s.role);
  // Sem vínculo ativo: vínculo desativado, ou conta de funcionário sem vínculo. Nunca
  // onboarding, para que funcionário não crie empresa.
  if (s.accessDisabled || s.isManaged) return DISABLED_ACCESS_PATH;
  return ONBOARDING_PATH;
}

// Quem chega sem sessão numa rota operacional (ou na tela de acesso desativado) volta para
// o login do funcionário; nas demais, para o login de proprietário/administrador.
function signedOutPath(route: GuardedRoute): string {
  return route === "atendimento" || route === "caixa" || route === "producao" || route === "disabled"
    ? EMPLOYEE_LOGIN_PATH
    : ADMIN_LOGIN_PATH;
}

export function decide(route: GuardedRoute, s: AuthSnapshot): Decision {
  if (s.loading) return WAIT;

  if (!s.hasSession) {
    return route === "guest" ? RENDER : redirect(signedOutPath(route));
  }
  if (s.companiesLoading) return WAIT;

  const landing = landingPath(s);
  switch (route) {
    case "guest":
    case "root":
      return redirect(landing);
    case "onboarding":
      return landing === ONBOARDING_PATH ? RENDER : redirect(landing);
    case "disabled":
      return landing === DISABLED_ACCESS_PATH ? RENDER : redirect(landing);
    case "app":
      return s.role === "owner" || s.role === "admin" ? RENDER : redirect(landing);
    case "atendimento":
    case "caixa":
    case "producao":
      return s.role !== null && canOpenOperationalArea(s.role, route) ? RENDER : redirect(landing);
  }
}

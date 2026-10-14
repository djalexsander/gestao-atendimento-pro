import type { CompanyRole } from "../../lib/types";
import type { EmployeeRole } from "./api";

export const ROLE_LABEL: Record<CompanyRole, string> = {
  owner: "Dono(a)",
  admin: "Administrador",
  cashier: "Caixa / Balcão",
  attendant: "Atendente",
  production: "Produção",
  courier: "Entregador",
};

// Funções que cada papel pode cadastrar e gerenciar. É só um espelho para decidir o que a
// tela MOSTRA (botões e opções); a autoridade é o banco (can_manage_company_user), que
// reavalia tudo a cada pedido.
const ASSIGNABLE_ROLES: Record<CompanyRole, EmployeeRole[]> = {
  owner: ["admin", "cashier", "attendant", "production", "courier"],
  admin: ["cashier", "attendant", "production", "courier"],
  cashier: [],
  attendant: [],
  production: [],
  courier: [],
};

export function assignableRoles(viewerRole: CompanyRole | null): EmployeeRole[] {
  return viewerRole ? ASSIGNABLE_ROLES[viewerRole] : [];
}

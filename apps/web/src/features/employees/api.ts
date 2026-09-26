import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabaseClient";
import type { CompanyMember, CompanyRole } from "../../lib/types";

// Funções que o dono/admin pode atribuir. O owner nunca é criado nem atribuído por aqui.
export type EmployeeRole = Exclude<CompanyRole, "owner">;

const FALLBACK_ERROR = "Não foi possível concluir a operação agora. Tente novamente em instantes.";
const ROLE_RANK: Record<CompanyRole, number> = { owner: 0, admin: 1, cashier: 2, attendant: 3 };

// company_users e profiles não têm FK direta entre si (ambas referenciam auth.users),
// então o PostgREST não monta o embed: duas consultas, juntadas no cliente. O e-mail do
// perfil só serve de nome para quem tem e-mail próprio (login nulo); conta gerenciada
// nunca o usa.
export async function fetchCompanyMembers(
  companyId: string,
): Promise<{ data: CompanyMember[]; error: string | null }> {
  const membersResult = await supabase
    .from("company_users")
    .select("id, company_id, user_id, login, role, status, created_at, updated_at")
    .eq("company_id", companyId);

  if (membersResult.error) return { data: [], error: membersResult.error.message };

  const rows = membersResult.data as Array<Omit<CompanyMember, "name">>;
  const userIds = rows.map((r) => r.user_id);

  const profilesResult = userIds.length
    ? await supabase.from("profiles").select("user_id, full_name, email").in("user_id", userIds)
    : { data: [], error: null };

  if (profilesResult.error) return { data: [], error: profilesResult.error.message };

  const profileByUserId = new Map(
    (profilesResult.data as Array<{ user_id: string; full_name: string | null; email: string | null }>).map(
      (p) => [p.user_id, p],
    ),
  );

  const members: CompanyMember[] = rows.map((row) => {
    const profile = profileByUserId.get(row.user_id);
    return { ...row, name: profile?.full_name ?? (row.login === null ? (profile?.email ?? null) : null) };
  });

  members.sort(
    (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || (a.name ?? "").localeCompare(b.name ?? "", "pt-BR"),
  );
  return { data: members, error: null };
}

// A mensagem amigável vem no corpo JSON ({ error }) das respostas de erro da Edge Function.
async function messageFromError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.json();
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
        return body.error;
      }
    } catch {
      // corpo ilegível: cai na mensagem genérica
    }
  }
  return FALLBACK_ERROR;
}

// Único ponto de contato com a Edge Function employee-admin. A Auth Admin API e o
// service_role vivem só lá; o browser só manda o pedido com a sessão de quem está logado.
async function invokeEmployeeAdmin(body: Record<string, unknown>): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke("employee-admin", { body });
  return { error: error ? await messageFromError(error) : null };
}

export function createEmployee(input: {
  companyId: string;
  name: string;
  login: string;
  credential: string;
  role: EmployeeRole;
}) {
  return invokeEmployeeAdmin({
    action: "create",
    company_id: input.companyId,
    name: input.name,
    login: input.login,
    credential: input.credential,
    role: input.role,
  });
}

export function updateEmployee(input: { companyId: string; userId: string; name?: string; role?: EmployeeRole }) {
  return invokeEmployeeAdmin({
    action: "update",
    company_id: input.companyId,
    user_id: input.userId,
    name: input.name,
    role: input.role,
  });
}

export function resetEmployeeCredential(input: { companyId: string; userId: string; credential: string }) {
  return invokeEmployeeAdmin({
    action: "reset_password",
    company_id: input.companyId,
    user_id: input.userId,
    credential: input.credential,
  });
}

export function setEmployeeStatus(input: { companyId: string; userId: string; status: "active" | "inactive" }) {
  return invokeEmployeeAdmin({
    action: "set_status",
    company_id: input.companyId,
    user_id: input.userId,
    status: input.status,
  });
}

export function deleteEmployee(input: { companyId: string; userId: string }) {
  return invokeEmployeeAdmin({ action: "delete", company_id: input.companyId, user_id: input.userId });
}

import { supabase } from "../../lib/supabaseClient";
import type {
  CompanyInviteRow,
  CompanyRole,
  CompanyRow,
  ProfileRow,
  TeamMember,
} from "../../lib/types";

export async function updateCompanyDetails(
  companyId: string,
  fields: { name: string; document: string | null },
): Promise<{ data: CompanyRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("companies")
    .update({ name: fields.name, document: fields.document })
    .eq("id", companyId)
    .select()
    .single();

  return { data: (data as CompanyRow | null) ?? null, error: error?.message ?? null };
}

// company_users e profiles não têm FK direta entre si (ambas referenciam
// auth.users), então o PostgREST não consegue montar o embed automático —
// buscamos em duas consultas e juntamos no cliente.
export async function fetchTeamMembers(
  companyId: string,
): Promise<{ data: TeamMember[]; error: string | null }> {
  const membersResult = await supabase
    .from("company_users")
    .select("id, user_id, role")
    .eq("company_id", companyId);

  if (membersResult.error) {
    return { data: [], error: membersResult.error.message };
  }

  const rows = membersResult.data as Array<{ id: string; user_id: string; role: CompanyRole }>;
  const userIds = rows.map((r) => r.user_id);

  const profilesResult = userIds.length
    ? await supabase.from("profiles").select("user_id, full_name, email").in("user_id", userIds)
    : { data: [] as ProfileRow[], error: null };

  if (profilesResult.error) {
    return { data: [], error: profilesResult.error.message };
  }

  const profileByUserId = new Map(
    (profilesResult.data as ProfileRow[]).map((p) => [p.user_id, p]),
  );

  const members: TeamMember[] = rows.map((r) => ({
    companyUserId: r.id,
    userId: r.user_id,
    role: r.role,
    fullName: profileByUserId.get(r.user_id)?.full_name ?? null,
    email: profileByUserId.get(r.user_id)?.email ?? null,
  }));

  return { data: members, error: null };
}

export async function updateMemberRole(
  companyUserId: string,
  role: CompanyRole,
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("company_users").update({ role }).eq("id", companyUserId);
  return { error: error?.message ?? null };
}

export async function removeMember(companyUserId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("company_users").delete().eq("id", companyUserId);
  return { error: error?.message ?? null };
}

export async function fetchCompanyInvites(
  companyId: string,
): Promise<{ data: CompanyInviteRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("company_invites")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  return { data: (data as CompanyInviteRow[] | null) ?? [], error: error?.message ?? null };
}

export async function createInvite(
  companyId: string,
  email: string,
  role: CompanyRole,
): Promise<{ data: CompanyInviteRow | null; error: string | null }> {
  const { data, error } = await supabase.rpc("create_company_invite", {
    p_company_id: companyId,
    p_email: email,
    p_role: role,
  });
  return { data: (data as CompanyInviteRow | null) ?? null, error: error?.message ?? null };
}

// Disparo/reenvio do e-mail de notificação — operação separada da criação do
// convite (ver Edge Function send-invite-email). Pode ser chamada de novo
// (reenvio) sem criar outro convite.
export async function sendInviteEmail(inviteId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke("send-invite-email", {
    body: { inviteId },
  });
  return { error: error?.message ?? null };
}

export async function revokeInvite(inviteId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("company_invites")
    .update({ status: "revoked" })
    .eq("id", inviteId);
  return { error: error?.message ?? null };
}

export async function fetchMyPendingInvites(
  email: string,
): Promise<{ data: CompanyInviteRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("company_invites")
    .select("*")
    .eq("status", "pending")
    .ilike("email", email);

  return { data: (data as CompanyInviteRow[] | null) ?? [], error: error?.message ?? null };
}

export async function acceptInvite(inviteId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("accept_company_invite", { p_invite_id: inviteId });
  return { error: error?.message ?? null };
}

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createInvite,
  fetchCompanyInvites,
  fetchTeamMembers,
  removeMember,
  revokeInvite,
  sendInviteEmail,
  updateMemberRole,
} from "../features/company/api";
import type { CompanyInviteRow, CompanyRole, TeamMember } from "../lib/types";
import { useAuth } from "../app/useAuth";

const ROLE_LABEL: Record<CompanyRole, string> = {
  owner: "Dono(a)",
  admin: "Administrador(a)",
  agent: "Agente",
};

export function TeamPage() {
  const { activeCompanyId, activeMembership, user } = useAuth();
  const viewerRole = activeMembership?.role ?? null;
  const isOwner = viewerRole === "owner";
  const isAdmin = viewerRole === "admin";

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<CompanyInviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("agent");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteWarning, setInviteWarning] = useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCompanyId) return;
    setLoading(true);
    const [membersResult, invitesResult] = await Promise.all([
      fetchTeamMembers(activeCompanyId),
      isOwner || isAdmin
        ? fetchCompanyInvites(activeCompanyId)
        : Promise.resolve({ data: [], error: null }),
    ]);
    setMembers(membersResult.data);
    setInvites(invitesResult.data);
    setError(membersResult.error ?? invitesResult.error ?? null);
    setLoading(false);
  }, [activeCompanyId, isOwner, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  function canManage(target: TeamMember): boolean {
    if (target.userId === user?.id) return false; // não gerencia a própria linha por aqui
    if (isOwner) return true;
    if (isAdmin) return target.role === "agent";
    return false;
  }

  async function handleRoleChange(member: TeamMember, role: CompanyRole) {
    setError(null);
    const { error } = await updateMemberRole(member.companyUserId, role);
    if (error) {
      setError(error);
      return;
    }
    await load();
  }

  async function handleRemove(member: TeamMember) {
    setError(null);
    const { error } = await removeMember(member.companyUserId);
    if (error) {
      setError(error);
      return;
    }
    await load();
  }

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (!activeCompanyId) return;
    setInviteError(null);
    setInviteWarning(null);
    setInviteSubmitting(true);
    const { data: invite, error } = await createInvite(activeCompanyId, inviteEmail.trim(), inviteRole);
    if (error) {
      setInviteSubmitting(false);
      setInviteError(error);
      return;
    }
    // Criação e envio são operações separadas: o convite já existe mesmo se
    // o e-mail falhar agora — dá para reenviar depois pela lista abaixo.
    if (invite) {
      const { error: emailError } = await sendInviteEmail(invite.id);
      if (emailError) {
        setInviteWarning(
          `Convite criado, mas o e-mail não pôde ser enviado agora (${emailError}). Você pode tentar reenviar na lista abaixo.`,
        );
      }
    }
    setInviteSubmitting(false);
    setInviteEmail("");
    setInviteRole("agent");
    await load();
  }

  async function handleRevoke(inviteId: string) {
    setError(null);
    const { error } = await revokeInvite(inviteId);
    if (error) {
      setError(error);
      return;
    }
    await load();
  }

  async function handleResend(inviteId: string) {
    setInviteWarning(null);
    setResendingId(inviteId);
    const { error } = await sendInviteEmail(inviteId);
    setResendingId(null);
    if (error) {
      setInviteWarning(`Falha ao reenviar o e-mail: ${error}`);
      return;
    }
    await load();
  }

  if (loading) return <p>Carregando equipe…</p>;

  const canInvite = isOwner || isAdmin;
  const pendingInvites = invites.filter((i) => i.status === "pending");

  return (
    <div>
      <h2>Equipe</h2>
      {error && <div className="form-error">{error}</div>}

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "8px 4px" }}>Nome</th>
            <th style={{ padding: "8px 4px" }}>E-mail</th>
            <th style={{ padding: "8px 4px" }}>Papel</th>
            {(isOwner || isAdmin) && <th style={{ padding: "8px 4px" }}>Ações</th>}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const manageable = canManage(member);
            return (
              <tr key={member.companyUserId} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 4px" }}>{member.fullName ?? "—"}</td>
                <td style={{ padding: "8px 4px" }}>{member.email ?? "—"}</td>
                <td style={{ padding: "8px 4px" }}>
                  {isOwner && manageable ? (
                    <select
                      value={member.role}
                      onChange={(e) => void handleRoleChange(member, e.target.value as CompanyRole)}
                    >
                      <option value="owner">Dono(a)</option>
                      <option value="admin">Administrador(a)</option>
                      <option value="agent">Agente</option>
                    </select>
                  ) : (
                    <span className="role-badge">{ROLE_LABEL[member.role]}</span>
                  )}
                </td>
                {(isOwner || isAdmin) && (
                  <td style={{ padding: "8px 4px" }}>
                    {manageable && (
                      <button
                        className="btn-secondary"
                        type="button"
                        onClick={() => void handleRemove(member)}
                      >
                        Remover
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {canInvite && (
        <>
          <h3 style={{ fontSize: 18 }}>Convidar membro</h3>
          {inviteError && <div className="form-error">{inviteError}</div>}
          {inviteWarning && <div className="form-notice">{inviteWarning}</div>}
          <form onSubmit={handleInvite} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ marginBottom: 0, flex: "1 1 220px" }}>
              <label htmlFor="invite-email">E-mail</label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="invite-role">Papel</label>
              {isOwner ? (
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as CompanyRole)}
                >
                  <option value="agent">Agente</option>
                  <option value="admin">Administrador(a)</option>
                  <option value="owner">Dono(a)</option>
                </select>
              ) : (
                <input value="Agente" disabled readOnly />
              )}
            </div>
            <button className="btn-primary" type="submit" disabled={inviteSubmitting} style={{ width: "auto" }}>
              {inviteSubmitting ? "Convidando…" : "Convidar"}
            </button>
          </form>

          {pendingInvites.length > 0 && (
            <>
              <h3 style={{ fontSize: 18, marginTop: 24 }}>Convites pendentes</h3>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {pendingInvites.map((invite) => (
                  <li
                    key={invite.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span>
                      {invite.email} — {ROLE_LABEL[invite.role]}
                      <br />
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {invite.email_last_sent_at
                          ? `e-mail enviado em ${new Date(invite.email_last_sent_at).toLocaleString("pt-BR")}`
                          : "e-mail ainda não enviado"}
                      </span>
                    </span>
                    <span style={{ display: "flex", gap: 8 }}>
                      <button
                        className="btn-secondary"
                        type="button"
                        disabled={resendingId === invite.id}
                        onClick={() => void handleResend(invite.id)}
                      >
                        {resendingId === invite.id ? "Enviando…" : "Reenviar e-mail"}
                      </button>
                      <button className="btn-secondary" type="button" onClick={() => void handleRevoke(invite.id)}>
                        Cancelar
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

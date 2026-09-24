import { useCallback, useEffect, useState } from "react";
import { acceptInvite, fetchMyPendingInvites } from "../features/company/api";
import type { CompanyInviteRow } from "../lib/types";
import { useAuth } from "./useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador(a)",
  agent: "Agente",
};

export function PendingInvitesBanner() {
  const { user, refreshMemberships } = useAuth();
  const [invites, setInvites] = useState<CompanyInviteRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.email) return;
    const { data } = await fetchMyPendingInvites(user.email);
    setInvites(data);
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAccept(inviteId: string) {
    setBusyId(inviteId);
    setError(null);
    const { error } = await acceptInvite(inviteId);
    setBusyId(null);
    if (error) {
      setError(error);
      return;
    }
    await refreshMemberships();
    await load();
  }

  if (invites.length === 0) return null;

  return (
    <div className="invite-banner">
      {error && <div className="form-error">{error}</div>}
      {invites.map((invite) => (
        <div className="invite-banner-item" key={invite.id}>
          <span>
            Você foi convidado(a) para <strong>{invite.company_name}</strong> como{" "}
            <strong>{ROLE_LABEL[invite.role] ?? invite.role}</strong>.
          </span>
          <button
            className="btn-primary"
            type="button"
            disabled={busyId === invite.id}
            onClick={() => void handleAccept(invite.id)}
          >
            {busyId === invite.id ? "Aceitando…" : "Aceitar convite"}
          </button>
        </div>
      ))}
    </div>
  );
}

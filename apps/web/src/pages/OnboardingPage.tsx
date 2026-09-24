import { useCallback, useEffect, useState, type FormEvent } from "react";
import { acceptInvite, fetchMyPendingInvites } from "../features/company/api";
import type { CompanyInviteRow } from "../lib/types";
import { useAuth } from "../app/useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador(a)",
  agent: "Agente",
};

export function OnboardingPage() {
  const { user, createCompany, refreshMemberships } = useAuth();

  const [invites, setInvites] = useState<CompanyInviteRow[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [document, setDocument] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadInvites = useCallback(async () => {
    if (!user?.email) return;
    setInvitesLoading(true);
    const { data } = await fetchMyPendingInvites(user.email);
    setInvites(data);
    setInvitesLoading(false);
  }, [user]);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  async function handleAccept(inviteId: string) {
    setAcceptError(null);
    setAcceptingId(inviteId);
    const { error } = await acceptInvite(inviteId);
    setAcceptingId(null);
    if (error) {
      setAcceptError(error);
      return;
    }
    // sucesso: refreshMemberships atualiza companies e a rota /onboarding
    // redireciona sozinha para /app assim que companies.length > 0.
    await refreshMemberships();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await createCompany(name.trim(), document.trim() || null);
    setSubmitting(false);
    if (error) setError(error);
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 460 }}>
        <div className="brand">OrçaFácil</div>

        {!invitesLoading && invites.length > 0 && (
          <>
            <h1 style={{ fontSize: 22 }}>Você tem convites pendentes</h1>
            {acceptError && <div className="form-error">{acceptError}</div>}
            <ul style={{ listStyle: "none", padding: 0, marginBottom: 24 }}>
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span>
                    <strong>{invite.company_name}</strong> — como{" "}
                    {ROLE_LABEL[invite.role] ?? invite.role}
                  </span>
                  <button
                    className="btn-primary"
                    type="button"
                    style={{ width: "auto" }}
                    disabled={acceptingId === invite.id}
                    onClick={() => void handleAccept(invite.id)}
                  >
                    {acceptingId === invite.id ? "Aceitando…" : "Aceitar"}
                  </button>
                </li>
              ))}
            </ul>
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Ou, se preferir, crie sua própria empresa abaixo.
            </p>
          </>
        )}

        <h1 style={{ fontSize: 22 }}>Crie sua empresa</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Você ainda não faz parte de nenhuma empresa. Crie a primeira para continuar.
        </p>

        {error && <div className="form-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="company-name">Nome da empresa</label>
            <input
              id="company-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="company-document">Documento (CNPJ/CPF) — opcional</label>
            <input
              id="company-document"
              type="text"
              value={document}
              onChange={(e) => setDocument(e.target.value)}
            />
          </div>
          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Criando empresa…" : "Criar empresa"}
          </button>
        </form>
      </div>
    </div>
  );
}

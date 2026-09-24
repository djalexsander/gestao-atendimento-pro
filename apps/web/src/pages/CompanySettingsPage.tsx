import { useState, type FormEvent } from "react";
import { useAuth } from "../app/useAuth";
import { updateCompanyDetails } from "../features/company/api";
import type { CompanyRole, CompanyRow } from "../lib/types";

const ROLE_LABEL: Record<CompanyRole, string> = {
  owner: "Dono(a)",
  admin: "Administrador(a)",
  agent: "Agente",
};

interface CompanyFormProps {
  company: CompanyRow;
  role: CompanyRole;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}

// Chaveado por company.id no componente pai: ao trocar de empresa ativa, o
// React remonta este componente com o estado inicial já correto, sem precisar
// de um efeito para "ressincronizar" os campos do formulário.
function CompanyForm({ company, role, canEdit, onSaved }: CompanyFormProps) {
  const [name, setName] = useState(company.name);
  const [document, setDocument] = useState(company.document ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setSubmitting(true);
    const { error } = await updateCompanyDetails(company.id, {
      name: name.trim(),
      document: document.trim() || null,
    });
    setSubmitting(false);
    if (error) {
      setError(error);
      return;
    }
    setSuccess(true);
    await onSaved();
  }

  return (
    <div>
      <h2>Configurações da empresa</h2>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="form-notice">Dados atualizados com sucesso.</div>}

      <form onSubmit={handleSubmit} style={{ maxWidth: 420 }}>
        <div className="field">
          <label htmlFor="settings-name">Nome</label>
          <input
            id="settings-name"
            type="text"
            required
            disabled={!canEdit}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="settings-slug">Slug</label>
          <input id="settings-slug" type="text" value={company.slug} disabled readOnly />
        </div>
        <div className="field">
          <label htmlFor="settings-document">Documento (CNPJ/CPF)</label>
          <input
            id="settings-document"
            type="text"
            disabled={!canEdit}
            value={document}
            onChange={(e) => setDocument(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Seu papel</label>
          <div>
            <span className="role-badge">{ROLE_LABEL[role]}</span>
          </div>
        </div>

        {canEdit ? (
          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Salvando…" : "Salvar alterações"}
          </button>
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Somente donos(as) e administradores(as) podem editar os dados da empresa.
          </p>
        )}
      </form>
    </div>
  );
}

export function CompanySettingsPage() {
  const { activeMembership, refreshMemberships } = useAuth();
  if (!activeMembership) return null;

  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";

  return (
    <CompanyForm
      key={activeMembership.company.id}
      company={activeMembership.company}
      role={activeMembership.role}
      canEdit={canEdit}
      onSaved={refreshMemberships}
    />
  );
}

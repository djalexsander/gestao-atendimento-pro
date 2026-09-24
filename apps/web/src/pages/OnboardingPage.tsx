import { useState, type FormEvent } from "react";
import { useAuth } from "../app/useAuth";

export function OnboardingPage() {
  const { createCompany } = useAuth();
  const [name, setName] = useState("");
  const [document, setDocument] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await createCompany(name.trim(), document.trim() || null);
    setSubmitting(false);
    if (error) setError(error);
    // sucesso: a lista de empresas é atualizada e a rota /onboarding redireciona
    // sozinha para /app assim que companies.length > 0.
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">OrçaFácil</div>
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

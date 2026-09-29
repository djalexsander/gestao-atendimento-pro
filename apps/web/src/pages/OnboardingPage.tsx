import { useState, type FormEvent } from "react";
import { ACCESS_CODE_MAX_LENGTH, validateAccessCode } from "../lib/accessCode";
import { useAuth } from "../app/useAuth";

export function OnboardingPage() {
  const { createCompany } = useAuth();

  const [name, setName] = useState("");
  const [accessCode, setAccessCode] = useState("");
  // Código vazio só é apontado como erro depois de tentar enviar; código preenchido
  // e inválido é apontado na hora.
  const [accessCodeAttempted, setAccessCodeAttempted] = useState(false);
  const [document, setDocument] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Espaços nas pontas são ignorados (a RPC também os remove); o resto é validado.
  const trimmedAccessCode = accessCode.trim();
  const accessCodeError = validateAccessCode(trimmedAccessCode);
  const showAccessCodeError =
    accessCodeError !== null && (trimmedAccessCode.length > 0 || accessCodeAttempted);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setAccessCodeAttempted(true);
    if (accessCodeError) return;
    setSubmitting(true);
    const { error } = await createCompany(name.trim(), trimmedAccessCode, document.trim() || null);
    setSubmitting(false);
    if (error) setError(error);
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 460 }}>
        <div className="brand">Gestão Atendimento Pro</div>

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
            <label htmlFor="company-access-code">Código da empresa</label>
            <input
              id="company-access-code"
              type="text"
              required
              maxLength={ACCESS_CODE_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.toLowerCase())}
              aria-invalid={showAccessCodeError}
              aria-describedby={
                showAccessCodeError
                  ? "company-access-code-help company-access-code-error"
                  : "company-access-code-help"
              }
            />
            <span
              id="company-access-code-help"
              style={{ color: "var(--text-muted)", fontSize: 13 }}
            >
              Será usado pelos funcionários para entrar no sistema.
            </span>
            {showAccessCodeError && (
              <span
                id="company-access-code-error"
                style={{ color: "var(--danger)", fontSize: 13 }}
              >
                {accessCodeError}
              </span>
            )}
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

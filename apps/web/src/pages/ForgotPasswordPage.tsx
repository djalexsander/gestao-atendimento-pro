import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app/useAuth";
import { looksLikeEmail, normalizeEmail } from "../lib/authEmail";
import { RESET_REQUEST_MESSAGE } from "../lib/passwordRecovery";

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const normalized = normalizeEmail(email);
    if (!looksLikeEmail(normalized)) {
      setError("Informe um e-mail válido.");
      return;
    }
    setSubmitting(true);
    const { error: failure } = await requestPasswordReset(normalized);
    setSubmitting(false);
    if (failure) setError(failure);
    else setSent(true);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Gestão Atendimento Pro</div>
        <h1 style={{ fontSize: 22 }}>Recuperar senha</h1>

        {sent ? (
          <div className="form-notice" role="status">
            {RESET_REQUEST_MESSAGE} Confira também a caixa de spam.
          </div>
        ) : (
          <>
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Informe o e-mail da sua conta para receber o link de recuperação.
            </p>
            {error && <div className="form-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="email">E-mail</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Enviando…" : "Enviar link de recuperação"}
              </button>
            </form>
          </>
        )}

        <div className="auth-footer">
          <Link to="/login">Voltar para o login</Link>
        </div>
      </div>
    </div>
  );
}

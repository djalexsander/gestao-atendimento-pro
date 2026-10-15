import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../app/useAuth";
import {
  RESET_LINK_EXPIRED_MESSAGE,
  RESET_SUCCESS_MESSAGE,
  parseRecoveryUrl,
  validateNewPassword,
} from "../lib/passwordRecovery";

// Quanto esperar o supabase-js trocar o link por uma sessão de recuperação antes de tratar como link inválido.
const SESSION_WAIT_MS = 8000;

export function ResetPasswordPage() {
  const { session, loading, completePasswordReset } = useAuth();
  const navigate = useNavigate();
  // Lido uma única vez: o supabase-js limpa o fragmento da URL depois de processar o link.
  const [linkState] = useState(() => parseRecoveryUrl(window.location.hash, window.location.search));
  const [waitedOut, setWaitedOut] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaitedOut(true), SESSION_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const linkInvalid = linkState === "error" || linkState === "none" || (waitedOut && !session && !loading);
  const ready = linkState === "recovery" && Boolean(session);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const invalid = validateNewPassword(password, confirm);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    const { error: failure } = await completePasswordReset(password);
    setSubmitting(false);
    if (failure) {
      setError(failure);
      return;
    }
    navigate("/login", { replace: true, state: { notice: RESET_SUCCESS_MESSAGE } });
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Gestão Atendimento Pro</div>
        <h1 style={{ fontSize: 22 }}>Redefinir senha</h1>

        {ready ? (
          <>
            {error && <div className="form-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="new-password">Nova senha</label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="confirm-password">Confirmar nova senha</label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Salvando…" : "Salvar nova senha"}
              </button>
            </form>
            <div className="auth-footer">
              <Link to="/login">Voltar para o login</Link>
            </div>
          </>
        ) : linkInvalid ? (
          <>
            <div className="form-error">{RESET_LINK_EXPIRED_MESSAGE}</div>
            <div className="auth-footer">
              <Link to="/esqueci-senha">Solicitar novo link</Link>
            </div>
          </>
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Validando o link de recuperação…</p>
        )}
      </div>
    </div>
  );
}

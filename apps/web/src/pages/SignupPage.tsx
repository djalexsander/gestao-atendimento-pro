import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app/useAuth";
import {
  RESEND_COOLDOWN_SECONDS,
  RESEND_SUCCESS_MESSAGE,
  cooldownRemaining,
  looksLikeEmail,
  normalizeEmail,
} from "../lib/authEmail";

export function SignupPage() {
  const { signUp, resendSignupConfirmation } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // e-mail EXATO que foi enviado ao Auth (normalizado): é o que a confirmação mostra
  const [sentTo, setSentTo] = useState("");
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  const normalized = normalizeEmail(email);
  const wait = cooldownRemaining(lastSentAt, now);

  // contagem regressiva do reenvio
  useEffect(() => {
    if (lastSentAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lastSentAt]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!looksLikeEmail(normalized)) {
      setError("Informe um e-mail válido.");
      return;
    }
    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);
    const { error } = await signUp(normalized, password);
    setSubmitting(false);

    if (error) {
      setError(error);
      return;
    }
    setSentTo(normalized);
    setLastSentAt(Date.now());
    setNow(Date.now());
    setSubmitted(true);
  }

  async function handleResend() {
    if (wait > 0 || resending) return;
    setResending(true);
    setResendNotice(null);
    setResendError(null);
    const { error } = await resendSignupConfirmation(sentTo);
    setResending(false);
    // o cooldown vale também após falha (evita insistir contra o rate limit do Auth)
    setLastSentAt(Date.now());
    setNow(Date.now());
    if (error) setResendError(error);
    else setResendNotice(RESEND_SUCCESS_MESSAGE);
  }

  if (submitted) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="brand">Gestão Atendimento Pro</div>
          <h1 style={{ fontSize: 22 }}>Confirme seu e-mail</h1>
          <div className="form-notice">
            Enviamos um link de confirmação para <strong>{sentTo}</strong>. Clique no link para ativar sua conta e depois
            volte para entrar.
          </div>
          <p className="field-hint">
            Confira se o endereço acima está correto. Se houver erro de digitação,{" "}
            <button type="button" className="link-button" onClick={() => { setSubmitted(false); setResendNotice(null); setResendError(null); }}>
              volte e corrija o e-mail
            </button>
            .
          </p>
          {resendNotice && <div className="form-notice">{resendNotice}</div>}
          {resendError && <div className="form-error">{resendError}</div>}
          <button className="btn-secondary" type="button" onClick={() => void handleResend()} disabled={wait > 0 || resending}>
            {resending ? "Reenviando…" : wait > 0 ? `Reenviar e-mail (${wait}s)` : "Reenviar e-mail"}
          </button>
          <p className="field-hint">Você poderá reenviar a cada {RESEND_COOLDOWN_SECONDS} segundos.</p>
          <div className="auth-footer">
            <Link to="/login">Voltar para o login</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Gestão Atendimento Pro</div>
        <h1 style={{ fontSize: 22 }}>Criar conta</h1>

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
            {normalized && (
              <p className="field-hint" aria-live="polite">
                Enviaremos o link de confirmação para: <strong>{normalized}</strong>
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="confirm-password">Confirmar senha</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Criando conta…" : "Criar conta"}
          </button>
        </form>

        <div className="auth-footer">
          Já tem conta? <Link to="/login">Entrar</Link>
        </div>
      </div>
    </div>
  );
}

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app/useAuth";

export function SignupPage() {
  const { signUp } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);
    const { error } = await signUp(email, password);
    setSubmitting(false);

    if (error) {
      setError(error);
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="brand">Gestão de Atendimento Pro</div>
          <h1 style={{ fontSize: 22 }}>Confirme seu e-mail</h1>
          <div className="form-notice">
            Enviamos um link de confirmação para <strong>{email}</strong>. Clique no
            link para ativar sua conta e depois volte para entrar.
          </div>
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
        <div className="brand">Gestão de Atendimento Pro</div>
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

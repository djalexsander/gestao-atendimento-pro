import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app/useAuth";

export function LoginPage() {
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await signIn(email, password);
    setSubmitting(false);
    if (error) setError(error);
    // sucesso: onAuthStateChange atualiza a sessão e as rotas redirecionam sozinhas.
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Gestão Atendimento Pro</div>
        <h1 style={{ fontSize: 22 }}>Entrar</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Proprietário ou administrador da empresa.</p>

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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <div className="auth-footer">
          Ainda não tem conta?{" "}
          <Link to="/cadastro">Criar conta</Link>
          <br />
          Sou funcionário: <Link to="/funcionario">entrar com o código da empresa</Link>
        </div>
      </div>
    </div>
  );
}

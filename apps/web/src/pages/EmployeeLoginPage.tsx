import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app/useAuth";
import { companyAccessCodeExists } from "../features/employees/api";
import { ACCESS_CODE_MAX_LENGTH, validateAccessCode } from "../lib/accessCode";
import { LOGIN_MAX_LENGTH, validateLogin } from "../lib/employeeRules";
import {
  forgetRememberedCompany,
  normalizeAccessCode,
  normalizeLogin,
  readRememberedCompany,
  rememberCompany,
} from "../lib/staffAuth";

const COMPANY_NOT_FOUND = "Empresa não encontrada. Confira o código com o administrador.";
const COMPANY_CHECK_FAILED = "Não foi possível verificar o código agora. Tente novamente em instantes.";

// Só usa o código lembrado se ele ainda tem o formato de um código de empresa.
function initialCompany(): string | null {
  const remembered = readRememberedCompany();
  return remembered !== null && validateAccessCode(remembered) === null ? remembered : null;
}

function Footer() {
  return (
    <div className="auth-footer">
      Proprietário ou administrador? <Link to="/login">Entrar com e-mail</Link>
    </div>
  );
}

// TELA 1: código da empresa.
function CompanyStep({ onConfirmed }: { onConfirmed: (accessCode: string) => void }) {
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const accessCode = normalizeAccessCode(code);
    const problem = validateAccessCode(accessCode);
    if (problem) {
      setError(problem);
      return;
    }
    setChecking(true);
    const result = await companyAccessCodeExists(accessCode);
    setChecking(false);
    if (result.error) {
      console.error("Falha ao verificar o código da empresa:", result.error);
      setError(COMPANY_CHECK_FAILED);
      return;
    }
    if (!result.exists) {
      setError(COMPANY_NOT_FOUND);
      return;
    }
    if (remember) rememberCompany(accessCode);
    else forgetRememberedCompany();
    onConfirmed(accessCode);
  }

  return (
    <>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Informe o código da sua empresa.</p>
      {error && <div className="form-error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="emp-company-code">Código da empresa</label>
          <input
            id="emp-company-code"
            type="text"
            required
            maxLength={ACCESS_CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
          />
          <span className="field-hint">Se não souber, peça ao administrador da empresa.</span>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Lembrar esta empresa neste aparelho
        </label>
        <button className="btn-primary" type="submit" disabled={checking}>
          {checking ? "Verificando…" : "Continuar"}
        </button>
      </form>
    </>
  );
}

// TELA 2: login + PIN ou senha.
function CredentialsStep({ accessCode, onChangeCompany }: { accessCode: string; onChangeCompany: () => void }) {
  const { signInEmployee } = useAuth();
  const [login, setLogin] = useState("");
  const [credential, setCredential] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const normalizedLogin = normalizeLogin(login);
    const problem = validateLogin(normalizedLogin);
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    const { error: signInError } = await signInEmployee(accessCode, normalizedLogin, credential);
    setSubmitting(false);
    if (signInError) setError(signInError);
    // Sucesso: a sessão muda e as rotas levam o funcionário à área do papel dele.
  }

  return (
    <>
      <div
        className="form-notice"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span>
          Empresa: <strong>{accessCode}</strong>
        </span>
        <button className="btn-secondary btn-small" type="button" onClick={onChangeCompany}>
          Trocar empresa
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="emp-login">Login</label>
          <input
            id="emp-login"
            type="text"
            required
            maxLength={LOGIN_MAX_LENGTH}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={login}
            onChange={(e) => setLogin(e.target.value.toLowerCase())}
          />
        </div>
        <div className="field">
          <label htmlFor="emp-credential">PIN ou senha</label>
          <div className="input-with-action">
            <input
              id="emp-credential"
              type={visible ? "text" : "password"}
              required
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
            <button className="btn-secondary btn-small" type="button" onClick={() => setVisible((v) => !v)}>
              {visible ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        </div>
        <button className="btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </>
  );
}

export function EmployeeLoginPage() {
  // Tela 1 (código da empresa) ou tela 2 (login + PIN/senha). O código só fica no estado
  // desta página; no aparelho, apenas se a pessoa marcar "Lembrar esta empresa" (e aí a
  // próxima visita já abre na tela 2).
  const [accessCode, setAccessCode] = useState<string | null>(initialCompany);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Gestão Atendimento Pro</div>
        <h1 style={{ fontSize: 22 }}>Entrar como funcionário</h1>
        {accessCode === null ? (
          <CompanyStep onConfirmed={setAccessCode} />
        ) : (
          <CredentialsStep
            accessCode={accessCode}
            onChangeCompany={() => {
              forgetRememberedCompany();
              setAccessCode(null);
            }}
          />
        )}
        <Footer />
      </div>
    </div>
  );
}

import { useState, type FormEvent, type ReactNode } from "react";
import {
  LOGIN_MAX_LENGTH,
  NAME_MAX_LENGTH,
  validateCredential,
  validateEmployeeName,
  validateLogin,
} from "../../lib/employeeRules";
import type { CompanyMember } from "../../lib/types";
import {
  createEmployee,
  deleteEmployee,
  resetEmployeeCredential,
  setEmployeeStatus,
  updateEmployee,
  type EmployeeRole,
} from "./api";
import { Modal } from "./Modal";
import { ROLE_LABEL } from "./roles";

const CREDENTIAL_HELP = "PIN: exatamente 6 números. Senha: ao menos 6 caracteres.";

interface DialogProps {
  companyId: string;
  onClose: () => void;
  // Fecha o diálogo e recarrega a lista, com o aviso de sucesso.
  onDone: (notice: string) => void;
}

function Actions({
  submitting,
  submitLabel,
  submittingLabel,
  danger,
  onClose,
}: {
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  danger?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-actions">
      <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
        Cancelar
      </button>
      <button className={danger ? "btn-danger" : "btn-primary btn-auto"} type="submit" disabled={submitting}>
        {submitting ? submittingLabel : submitLabel}
      </button>
    </div>
  );
}

// PIN ou senha: campo oculto, com opção de mostrar (quem cadastra digita para outra pessoa).
function CredentialField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-with-action">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="btn-secondary btn-small" type="button" onClick={() => setVisible((v) => !v)}>
          {visible ? "Ocultar" : "Mostrar"}
        </button>
      </div>
      <span className="field-hint">{CREDENTIAL_HELP}</span>
    </div>
  );
}

function RoleSelect({
  id,
  value,
  roles,
  onChange,
}: {
  id: string;
  value: EmployeeRole;
  roles: EmployeeRole[];
  onChange: (role: EmployeeRole) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Função</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as EmployeeRole)}>
        {roles.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </select>
    </div>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  return message ? <div className="form-error">{message}</div> : null;
}

// Base dos formulários: cuida de enviar, do "enviando…" e da mensagem de erro.
function useSubmit(onDone: (notice: string) => void, notice: string) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function run(validate: () => string | null, request: () => Promise<{ error: string | null }>) {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    const result = await request();
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone(notice);
  }

  return { error, submitting, run };
}

export function CreateEmployeeDialog({
  companyId,
  roles,
  onClose,
  onDone,
}: DialogProps & { roles: EmployeeRole[] }) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [credential, setCredential] = useState("");
  const [role, setRole] = useState<EmployeeRole>(roles[roles.length - 1]);
  const { error, submitting, run } = useSubmit(onDone, "Funcionário cadastrado.");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => validateEmployeeName(name.trim()) ?? validateLogin(login) ?? validateCredential(credential),
      () => createEmployee({ companyId, name: name.trim(), login, credential, role }),
    );
  }

  return (
    <Modal title="Novo funcionário" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="emp-name">Nome</label>
          <input
            id="emp-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="emp-login">Login</label>
          <input
            id="emp-login"
            type="text"
            required
            maxLength={LOGIN_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={login}
            onChange={(e) => setLogin(e.target.value.toLowerCase())}
          />
          <span className="field-hint">Usado para entrar. Não poderá ser alterado depois.</span>
        </div>
        <CredentialField id="emp-credential" label="PIN ou senha" value={credential} onChange={setCredential} />
        <RoleSelect id="emp-role" value={role} roles={roles} onChange={setRole} />
        <Actions submitting={submitting} submitLabel="Cadastrar" submittingLabel="Cadastrando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

export function EditEmployeeDialog({
  companyId,
  member,
  roles,
  onClose,
  onDone,
}: DialogProps & { member: CompanyMember; roles: EmployeeRole[] }) {
  const [name, setName] = useState(member.name ?? "");
  const [role, setRole] = useState<EmployeeRole>(member.role as EmployeeRole);
  const { error, submitting, run } = useSubmit(onDone, "Funcionário atualizado.");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    void run(
      () => validateEmployeeName(trimmed),
      () =>
        updateEmployee({
          companyId,
          userId: member.user_id,
          // só o que mudou
          name: trimmed !== (member.name ?? "") ? trimmed : undefined,
          role: role !== member.role ? role : undefined,
        }),
    );
  }

  return (
    <Modal title="Editar funcionário" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="emp-edit-name">Nome</label>
          <input
            id="emp-edit-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <RoleSelect id="emp-edit-role" value={role} roles={roles} onChange={setRole} />
        <div className="field">
          <label htmlFor="emp-edit-login">Login</label>
          <input id="emp-edit-login" type="text" value={member.login ?? ""} disabled readOnly />
        </div>
        <Actions submitting={submitting} submitLabel="Salvar" submittingLabel="Salvando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

export function CredentialDialog({ companyId, member, onClose, onDone }: DialogProps & { member: CompanyMember }) {
  const [credential, setCredential] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { error, submitting, run } = useSubmit(onDone, "PIN/senha redefinido.");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => validateCredential(credential) ?? (credential !== confirmation ? "O PIN/senha e a confirmação não coincidem." : null),
      () => resetEmployeeCredential({ companyId, userId: member.user_id, credential }),
    );
  }

  return (
    <Modal title="Redefinir PIN/Senha" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          Defina o novo PIN ou senha de <strong>{member.name ?? member.login}</strong>. Informe-o ao funcionário;
          o sistema não envia mensagem nem e-mail.
        </p>
        <ErrorBox message={error} />
        <CredentialField id="emp-new-credential" label="Novo PIN ou senha" value={credential} onChange={setCredential} />
        <div className="field">
          <label htmlFor="emp-confirm-credential">Confirmar PIN ou senha</label>
          <input
            id="emp-confirm-credential"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </div>
        <Actions submitting={submitting} submitLabel="Redefinir" submittingLabel="Redefinindo…" onClose={onClose} />
      </form>
    </Modal>
  );
}

function ConfirmDialog({
  title,
  children,
  submitLabel,
  submittingLabel,
  danger,
  onClose,
  onConfirm,
  onDone,
  notice,
}: {
  title: string;
  children: ReactNode;
  submitLabel: string;
  submittingLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<{ error: string | null }>;
  onDone: (notice: string) => void;
  notice: string;
}) {
  const { error, submitting, run } = useSubmit(onDone, notice);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(() => null, onConfirm);
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="modal-text">{children}</div>
        <ErrorBox message={error} />
        <Actions
          submitting={submitting}
          submitLabel={submitLabel}
          submittingLabel={submittingLabel}
          danger={danger}
          onClose={onClose}
        />
      </form>
    </Modal>
  );
}

export function StatusDialog({ companyId, member, onClose, onDone }: DialogProps & { member: CompanyMember }) {
  const activating = member.status === "inactive";
  const who = member.name ?? member.login;
  return (
    <ConfirmDialog
      title={activating ? "Ativar funcionário" : "Desativar funcionário"}
      submitLabel={activating ? "Ativar" : "Desativar"}
      submittingLabel={activating ? "Ativando…" : "Desativando…"}
      danger={!activating}
      onClose={onClose}
      onDone={onDone}
      notice={activating ? "Funcionário ativado." : "Funcionário desativado."}
      onConfirm={() =>
        setEmployeeStatus({ companyId, userId: member.user_id, status: activating ? "active" : "inactive" })
      }
    >
      {activating ? (
        <p>
          Reativar o acesso de <strong>{who}</strong>? Ele volta a poder entrar no sistema.
        </p>
      ) : (
        <p>
          Desativar o acesso de <strong>{who}</strong>? Ele deixa de acessar o sistema imediatamente. O cadastro e o
          histórico são mantidos e você pode ativar de novo depois.
        </p>
      )}
    </ConfirmDialog>
  );
}

export function DeleteEmployeeDialog({ companyId, member, onClose, onDone }: DialogProps & { member: CompanyMember }) {
  return (
    <ConfirmDialog
      title="Excluir funcionário"
      submitLabel="Excluir definitivamente"
      submittingLabel="Excluindo…"
      danger
      onClose={onClose}
      onDone={onDone}
      notice="Funcionário excluído."
      onConfirm={() => deleteEmployee({ companyId, userId: member.user_id })}
    >
      <p>
        Excluir <strong>{member.name ?? member.login}</strong> definitivamente? O login e o cadastro deixam de existir e
        isso <strong>não pode ser desfeito</strong>. Quem já tem movimentações não pode ser excluído: nesse caso, desative
        o acesso.
      </p>
    </ConfirmDialog>
  );
}

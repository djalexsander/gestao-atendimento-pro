import { useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import type { NewSector } from "./sectorsApi";
import {
  CODE_MAX_LENGTH,
  NAME_MAX_LENGTH,
  normalizeCode,
  validateCode,
  validateName,
  type AdminSector,
} from "./sectorsLogic";

// `onSubmit` devolve a mensagem de erro (ou null quando deu certo); quem fecha o diálogo em caso
// de sucesso é a tela. Mesmo contrato de ServicePointAdminDialogs.tsx.
type Submit<T> = (value: T) => Promise<string | null>;

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function run(validate: () => string | null, request: () => Promise<string | null>) {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    const failure = await request();
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return { error, submitting, run };
}

function Actions({
  submitting,
  submitLabel,
  submittingLabel,
  danger,
  disabled,
  onClose,
}: {
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  danger?: boolean;
  disabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-actions">
      <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
        Cancelar
      </button>
      <button
        className={danger ? "btn-danger" : "btn-primary btn-auto"}
        type="submit"
        disabled={submitting || disabled}
      >
        {submitting ? submittingLabel : submitLabel}
      </button>
    </div>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  return message ? <div className="form-error">{message}</div> : null;
}

// NOVO setor.
export function NewSectorDialog({
  existingCodes,
  onSubmit,
  onClose,
}: {
  existingCodes: Set<string>;
  onSubmit: Submit<NewSector>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [active, setActive] = useState(true);
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    void run(
      () =>
        validateName(name.trim()) ??
        validateCode(normalized) ??
        (existingCodes.has(normalized) ? "Já existe um setor com este código." : null),
      () => onSubmit({ name: name.trim(), code: normalized, is_active: active }),
    );
  }

  return (
    <Modal title="Novo setor" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="sector-name">Nome</label>
          <input
            id="sector-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder="Churrasqueira"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="sector-code">Código</label>
          <input
            id="sector-code"
            type="text"
            required
            maxLength={CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="CHURRASQUEIRA"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <span className="field-hint">Único na empresa. Letras maiúsculas, números, - e _.</span>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Ativo
        </label>
        <Actions submitting={submitting} submitLabel="Cadastrar" submittingLabel="Cadastrando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// EDITAR: nome e código (o banco permite editar os dois; ver sectorsApi.ts).
export function EditSectorDialog({
  sector,
  existingCodes,
  onSubmit,
  onClose,
}: {
  sector: AdminSector;
  existingCodes: Set<string>;
  onSubmit: Submit<{ name: string; code: string }>;
  onClose: () => void;
}) {
  const [name, setName] = useState(sector.name);
  const [code, setCode] = useState(sector.code);
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    void run(
      () =>
        validateName(name.trim()) ??
        validateCode(normalized) ??
        (normalized !== sector.code && existingCodes.has(normalized) ? "Já existe um setor com este código." : null),
      () => onSubmit({ name: name.trim(), code: normalized }),
    );
  }

  return (
    <Modal title="Editar setor" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="sector-edit-name">Nome</label>
          <input
            id="sector-edit-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="sector-edit-code">Código</label>
          <input
            id="sector-edit-code"
            type="text"
            required
            maxLength={CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <span className="field-hint">Único na empresa. Letras maiúsculas, números, - e _.</span>
        </div>
        <Actions submitting={submitting} submitLabel="Salvar" submittingLabel="Salvando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// ATIVAR / DESATIVAR (nunca exclui). Se o setor estiver em uso por categoria ou produto ativo, o
// banco recusa (PT409, trigger de 040000) e a mensagem amigável dele aparece aqui — não repetida
// no frontend.
export function ToggleSectorDialog({
  sector,
  onConfirm,
  onClose,
}: {
  sector: AdminSector;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const activating = !sector.is_active;
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(() => null, onConfirm);
  }

  return (
    <Modal title={activating ? "Ativar" : "Desativar"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          {activating ? (
            <>
              Ativar <strong>{sector.name}</strong> ({sector.code})?
            </>
          ) : (
            <>
              Desativar <strong>{sector.name}</strong> ({sector.code})? Nada é apagado e você pode ativar de novo.
            </>
          )}
        </p>
        <ErrorBox message={error} />
        <Actions
          submitting={submitting}
          submitLabel={activating ? "Ativar" : "Desativar"}
          submittingLabel={activating ? "Ativando…" : "Desativando…"}
          danger={!activating}
          onClose={onClose}
        />
      </form>
    </Modal>
  );
}

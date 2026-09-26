import { useMemo, useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import type { NewServicePoint } from "./adminApi";
import {
  BARCODE_MAX_LENGTH,
  BATCH_MAX,
  CODE_MAX_LENGTH,
  DEFAULT_PREFIX,
  NAME_MAX_LENGTH,
  TYPE_PLURAL_LOWER,
  TYPE_SINGULAR,
  describeSkipped,
  normalizeCode,
  planBatch,
  validateBarcode,
  validateCode,
  validateDisplayName,
  type AdminServicePoint,
  type BatchRow,
} from "./adminLogic";
import type { ServicePointType } from "./panel";

// `onSubmit` devolve a mensagem de erro (ou null quando deu certo); quem fecha o diálogo em caso
// de sucesso é a tela.
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

function TypeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ServicePointType;
  onChange: (type: ServicePointType) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Tipo</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as ServicePointType)}>
        <option value="command">{TYPE_SINGULAR.command}</option>
        <option value="table">{TYPE_SINGULAR.table}</option>
      </select>
    </div>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  return message ? <div className="form-error">{message}</div> : null;
}

// O leitor de código de barras termina com Enter: no campo do código de barras isso NÃO pode
// enviar o formulário inteiro.
function BarcodeField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>Código de barras (opcional)</label>
      <input
        id={id}
        type="text"
        maxLength={BARCODE_MAX_LENGTH}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      />
      <span className="field-hint">Clique aqui e passe o leitor, ou digite. Sem espaços.</span>
    </div>
  );
}

// NOVA comanda / mesa.
export function PointFormDialog({
  initialType,
  existingCodes,
  onSubmit,
  onClose,
}: {
  initialType: ServicePointType;
  existingCodes: Set<string>;
  onSubmit: Submit<NewServicePoint>;
  onClose: () => void;
}) {
  const [type, setType] = useState<ServicePointType>(initialType);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [active, setActive] = useState(true);
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    void run(
      () =>
        validateCode(normalized) ??
        (existingCodes.has(normalized) ? "Já existe uma comanda ou mesa com este código." : null) ??
        validateDisplayName(name.trim()) ??
        validateBarcode(barcode.trim()),
      () =>
        onSubmit({
          type,
          code: normalized,
          display_name: name.trim(),
          barcode: barcode.trim() || null,
          is_active: active,
        }),
    );
  }

  return (
    <Modal title={`Nova ${TYPE_SINGULAR[type].toLowerCase()}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <TypeSelect id="sp-type" value={type} onChange={setType} />
        <div className="field">
          <label htmlFor="sp-code">Código</label>
          <input
            id="sp-code"
            type="text"
            required
            maxLength={CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={type === "command" ? "CMD001" : "MESA01"}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <span className="field-hint">Único na empresa e não muda depois. Letras maiúsculas, números, - e _.</span>
        </div>
        <div className="field">
          <label htmlFor="sp-name">Nome de exibição</label>
          <input
            id="sp-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder={type === "command" ? "Comanda 001" : "Mesa 01"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <BarcodeField id="sp-barcode" value={barcode} onChange={setBarcode} />
        <label className="checkbox-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Ativo
        </label>
        <Actions submitting={submitting} submitLabel="Cadastrar" submittingLabel="Cadastrando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// GERAR VÁRIAS: prefixo + intervalo, com pré-visualização do que será criado. Sem código de barras.
export function BatchDialog({
  existingCodes,
  onSubmit,
  onClose,
}: {
  existingCodes: Set<string>;
  onSubmit: Submit<BatchRow[]>;
  onClose: () => void;
}) {
  const [type, setType] = useState<ServicePointType>("command");
  const [prefix, setPrefix] = useState<string>(DEFAULT_PREFIX.command);
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("50");
  const { error, submitting, run } = useSubmit();

  const plan = useMemo(
    () => planBatch({ type, prefix, from, to, existingCodes }),
    [type, prefix, from, to, existingCodes],
  );

  // Trocar o tipo troca também o prefixo, se ele ainda for o padrão do tipo anterior.
  function changeType(next: ServicePointType) {
    setPrefix((current) => (current === DEFAULT_PREFIX[type] ? DEFAULT_PREFIX[next] : current));
    setType(next);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => plan.error,
      () => onSubmit(plan.rows),
    );
  }

  const first = plan.rows[0];
  const last = plan.rows[plan.rows.length - 1];

  return (
    <Modal title="Gerar várias comandas/mesas" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <TypeSelect id="sp-batch-type" value={type} onChange={changeType} />
        <div className="field">
          <label htmlFor="sp-batch-prefix">Prefixo</label>
          <input
            id="sp-batch-prefix"
            type="text"
            maxLength={CODE_MAX_LENGTH - 2}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          />
        </div>
        <div className="batch-range">
          <div className="field">
            <label htmlFor="sp-batch-from">De</label>
            <input
              id="sp-batch-from"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sp-batch-to">Até</label>
            <input
              id="sp-batch-to"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        {plan.error ? (
          <div className="form-notice" data-testid="batch-preview">
            {plan.error}
          </div>
        ) : (
          <div className="form-notice" data-testid="batch-preview">
            Serão criadas <strong>{plan.rows.length}</strong> {TYPE_PLURAL_LOWER[type]}:{" "}
            <strong>{first.code}</strong>
            {plan.rows.length > 1 && (
              <>
                {" "}
                … <strong>{last.code}</strong>
              </>
            )}
            . Nomes: “{first.display_name}”{plan.rows.length > 1 && <> … “{last.display_name}”</>}. Sem código de
            barras.
            {plan.skipped.length > 0 && <> {describeSkipped(plan.skipped)}</>}
          </div>
        )}
        <span className="field-hint">Até {BATCH_MAX} por vez.</span>
        <Actions
          submitting={submitting}
          submitLabel="Gerar"
          submittingLabel="Gerando…"
          disabled={plan.error !== null}
          onClose={onClose}
        />
      </form>
    </Modal>
  );
}

// EDITAR: só nome de exibição e código de barras (tipo e código não mudam).
export function EditPointDialog({
  point,
  onSubmit,
  onClose,
}: {
  point: AdminServicePoint;
  onSubmit: Submit<{ display_name: string; barcode: string | null }>;
  onClose: () => void;
}) {
  const [name, setName] = useState(point.display_name);
  const [barcode, setBarcode] = useState(point.barcode ?? "");
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => validateDisplayName(name.trim()) ?? validateBarcode(barcode.trim()),
      () => onSubmit({ display_name: name.trim(), barcode: barcode.trim() || null }),
    );
  }

  return (
    <Modal title={`Editar ${TYPE_SINGULAR[point.type].toLowerCase()}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="sp-edit-type">Tipo</label>
          <input id="sp-edit-type" type="text" value={TYPE_SINGULAR[point.type]} disabled readOnly />
        </div>
        <div className="field">
          <label htmlFor="sp-edit-code">Código</label>
          <input id="sp-edit-code" type="text" value={point.code} disabled readOnly />
          <span className="field-hint">Tipo e código não podem ser alterados. Para corrigir, desative e cadastre outro.</span>
        </div>
        <div className="field">
          <label htmlFor="sp-edit-name">Nome de exibição</label>
          <input
            id="sp-edit-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <BarcodeField id="sp-edit-barcode" value={barcode} onChange={setBarcode} />
        <Actions submitting={submitting} submitLabel="Salvar" submittingLabel="Salvando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// ATIVAR / DESATIVAR (nunca exclui). Se houver atendimento aberto, o banco recusa a desativação
// e a mensagem dele aparece aqui.
export function TogglePointDialog({
  point,
  onConfirm,
  onClose,
}: {
  point: AdminServicePoint;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const activating = !point.is_active;
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
              Ativar <strong>{point.display_name}</strong> ({point.code})? Ela volta a aparecer no Atendimento e no
              Caixa.
            </>
          ) : (
            <>
              Desativar <strong>{point.display_name}</strong> ({point.code})? Ela deixa de aparecer para abrir
              atendimento. Nada é apagado e você pode ativar de novo.
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

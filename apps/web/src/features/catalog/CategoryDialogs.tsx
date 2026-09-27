import { useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import { buildSectorOptions, CODE_MAX_LENGTH, NAME_MAX_LENGTH, normalizeCode, validateCode, validateName, parseSortOrder, type AdminCategory } from "./categoriesLogic";
import type { EditCategory, NewCategory } from "./categoriesApi";
import type { AdminSector } from "./sectorsLogic";

// `onSubmit` devolve a mensagem de erro (ou null quando deu certo); quem fecha o diálogo em caso
// de sucesso é a tela. Mesmo contrato de SectorDialogs.tsx.
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

function SectorSelect({
  id,
  sectors,
  currentSectorId,
  value,
  onChange,
}: {
  id: string;
  sectors: AdminSector[];
  currentSectorId: string | null;
  value: string | null;
  onChange: (sectorId: string | null) => void;
}) {
  const options = buildSectorOptions(sectors, currentSectorId);
  return (
    <div className="field">
      <label htmlFor={id}>Setor de produção padrão</label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        {options.map((option) => (
          <option key={option.id ?? "none"} value={option.id ?? ""}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="field-hint">Opcional. Só setores ativos aparecem para escolher (o vínculo atual, se estiver inativo, continua visível).</span>
    </div>
  );
}

// NOVA categoria.
export function NewCategoryDialog({
  existingCodes,
  sectors,
  onSubmit,
  onClose,
}: {
  existingCodes: Set<string>;
  sectors: AdminSector[];
  onSubmit: Submit<NewCategory>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [sectorId, setSectorId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState("0");
  const [active, setActive] = useState(true);
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    const parsedOrder = parseSortOrder(sortOrder);
    void run(
      () =>
        validateName(name.trim()) ??
        validateCode(normalized) ??
        (existingCodes.has(normalized) ? "Já existe uma categoria com este código." : null) ??
        parsedOrder.error,
      () =>
        onSubmit({
          name: name.trim(),
          code: normalized,
          default_production_sector_id: sectorId,
          sort_order: parsedOrder.value ?? 0,
          is_active: active,
        }),
    );
  }

  return (
    <Modal title="Nova categoria" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="category-name">Nome</label>
          <input
            id="category-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder="Bebidas"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="category-code">Código</label>
          <input
            id="category-code"
            type="text"
            required
            maxLength={CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="BEBIDAS"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <span className="field-hint">Único na empresa. Letras maiúsculas, números, - e _.</span>
        </div>
        <SectorSelect id="category-sector" sectors={sectors} currentSectorId={null} value={sectorId} onChange={setSectorId} />
        <div className="field">
          <label htmlFor="category-sort">Ordem de exibição</label>
          <input
            id="category-sort"
            type="number"
            inputMode="numeric"
            step={1}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
          <span className="field-hint">Menor aparece primeiro no catálogo (ex.: 10).</span>
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

// EDITAR: nome, código, setor padrão e ordem (o banco permite editar os quatro; ver
// categoriesApi.ts). Status fica por ação própria (ToggleCategoryDialog).
export function EditCategoryDialog({
  category,
  existingCodes,
  sectors,
  onSubmit,
  onClose,
}: {
  category: AdminCategory;
  existingCodes: Set<string>;
  sectors: AdminSector[];
  onSubmit: Submit<EditCategory>;
  onClose: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [code, setCode] = useState(category.code);
  const [sectorId, setSectorId] = useState<string | null>(category.default_production_sector_id);
  const [sortOrder, setSortOrder] = useState(String(category.sort_order));
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    const parsedOrder = parseSortOrder(sortOrder);
    void run(
      () =>
        validateName(name.trim()) ??
        validateCode(normalized) ??
        (normalized !== category.code && existingCodes.has(normalized) ? "Já existe uma categoria com este código." : null) ??
        parsedOrder.error,
      () =>
        onSubmit({
          name: name.trim(),
          code: normalized,
          default_production_sector_id: sectorId,
          sort_order: parsedOrder.value ?? 0,
        }),
    );
  }

  return (
    <Modal title="Editar categoria" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="category-edit-name">Nome</label>
          <input
            id="category-edit-name"
            type="text"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="category-edit-code">Código</label>
          <input
            id="category-edit-code"
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
        <SectorSelect
          id="category-edit-sector"
          sectors={sectors}
          currentSectorId={category.default_production_sector_id}
          value={sectorId}
          onChange={setSectorId}
        />
        <div className="field">
          <label htmlFor="category-edit-sort">Ordem de exibição</label>
          <input
            id="category-edit-sort"
            type="number"
            inputMode="numeric"
            step={1}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
          <span className="field-hint">Menor aparece primeiro no catálogo.</span>
        </div>
        <Actions submitting={submitting} submitLabel="Salvar" submittingLabel="Salvando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// ATIVAR / DESATIVAR (nunca exclui). Desativar avisa sobre o efeito nos produtos da categoria —
// nada em products é alterado, é só o comportamento já existente da RLS operacional (cashier e
// attendant só veem produto ativo de categoria ativa).
export function ToggleCategoryDialog({
  category,
  onConfirm,
  onClose,
}: {
  category: AdminCategory;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const activating = !category.is_active;
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
              Ativar <strong>{category.name}</strong> ({category.code})? Os produtos ativos dela voltam a aparecer no
              catálogo operacional.
            </>
          ) : (
            <>
              Desativar <strong>{category.name}</strong> ({category.code})? Os produtos desta categoria deixarão de
              aparecer no catálogo operacional enquanto ela estiver inativa. Nada é apagado e você pode ativar de
              novo.
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

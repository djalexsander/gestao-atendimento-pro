import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { supabaseModifiersAdminSource, type AdminModifierGroup, type GroupInput, type ModifiersAdminSource, type OptionInput, type ProductLite } from "./modifiersApi";
import {
  NAME_MAX,
  groupHint,
  groupSummary,
  parseDelta,
  selectionTypeLabel,
  validateModifierName,
  type ModifierOption,
  type ModifierType,
  type SelectionType,
} from "./modifiersLogic";

type Dialog =
  | { kind: "group"; group: AdminModifierGroup | null }
  | { kind: "option"; group: AdminModifierGroup; option: ModifierOption | null }
  | { kind: "products"; group: AdminModifierGroup };

type Result = { error: string | null };

function ErrorBox({ message }: { message: string | null }) {
  return message ? (
    <div className="form-error" role="alert">
      {message}
    </div>
  ) : null;
}

function DialogActions({ submitting, onClose, label = "Salvar" }: { submitting: boolean; onClose: () => void; label?: string }) {
  return (
    <div className="modal-actions">
      <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
        Cancelar
      </button>
      <button className="btn-primary btn-auto" type="submit" disabled={submitting}>
        {submitting ? "Salvando…" : label}
      </button>
    </div>
  );
}

function GroupDialog({ group, nextOrder, onSubmit, onClose }: { group: AdminModifierGroup | null; nextOrder: number; onSubmit: (input: GroupInput) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [type, setType] = useState<SelectionType>(group?.selectionType ?? "multiple");
  const [required, setRequired] = useState((group?.minSelection ?? 0) >= 1);
  const [min, setMin] = useState(String(Math.max(group?.minSelection ?? 0, 1)));
  const [max, setMax] = useState(group?.maxSelection != null ? String(group.maxSelection) : "");
  const [order, setOrder] = useState(String(group?.sortOrder ?? nextOrder));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validateModifierName(name);
    if (problem) return setError(problem);
    const minValue = type === "single" ? (required ? 1 : 0) : required ? Number(min) : 0;
    const maxValue = type === "single" ? 1 : max.trim() === "" ? null : Number(max);
    if (!Number.isInteger(minValue) || minValue < 0 || minValue > 20) return setError("O mínimo precisa ser um número inteiro entre 1 e 20.");
    if (maxValue !== null && (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 20)) return setError("O máximo precisa ser um número inteiro entre 1 e 20.");
    if (maxValue !== null && maxValue < minValue) return setError("O máximo não pode ser menor que o mínimo.");
    const orderValue = Number(order);
    if (!Number.isInteger(orderValue)) return setError("A ordem precisa ser um número inteiro.");
    setSubmitting(true);
    const failure = await onSubmit({ name: name.trim(), selectionType: type, minSelection: minValue, maxSelection: maxValue, sortOrder: orderValue });
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return (
    <Modal title={group ? "Editar grupo" : "Novo grupo"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="mg-name">Nome do grupo</label>
          <input id="mg-name" type="text" maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Como servir, Adicionais" autoFocus />
        </div>
        <div className="field">
          <label htmlFor="mg-type">Seleção</label>
          <select id="mg-type" value={type} onChange={(e) => setType(e.target.value as SelectionType)}>
            <option value="single">Escolher 1 (só uma opção)</option>
            <option value="multiple">Escolher várias</option>
          </select>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          Obrigatório (o garçom precisa escolher)
        </label>
        {type === "multiple" && (
          <>
            {required && (
              <div className="field">
                <label htmlFor="mg-min">Mínimo de opções</label>
                <input id="mg-min" type="number" min={1} max={20} value={min} onChange={(e) => setMin(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label htmlFor="mg-max">Máximo de opções</label>
              <input id="mg-max" type="number" min={1} max={20} value={max} onChange={(e) => setMax(e.target.value)} placeholder="Sem limite" />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="mg-order">Ordem</label>
          <input id="mg-order" type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
          <span className="field-hint">Menor aparece primeiro para o garçom.</span>
        </div>
        <DialogActions submitting={submitting} onClose={onClose} />
      </form>
    </Modal>
  );
}

function OptionDialog({ option, nextOrder, onSubmit, onClose }: { option: ModifierOption | null; nextOrder: number; onSubmit: (input: OptionInput) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(option?.name ?? "");
  const [type, setType] = useState<ModifierType>(option?.type ?? "add");
  const [price, setPrice] = useState(option && option.priceDelta > 0 ? String(option.priceDelta).replace(".", ",") : "");
  const [order, setOrder] = useState(String(option?.sortOrder ?? nextOrder));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validateModifierName(name);
    if (problem) return setError(problem);
    const delta = type === "remove" ? 0 : parseDelta(price);
    if (delta === null) return setError("Informe um valor válido (ex.: 5,00). Não há preço negativo.");
    const orderValue = Number(order);
    if (!Number.isInteger(orderValue)) return setError("A ordem precisa ser um número inteiro.");
    setSubmitting(true);
    const failure = await onSubmit({ name: name.trim(), type, priceDelta: delta, sortOrder: orderValue });
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return (
    <Modal title={option ? "Editar opção" : "Nova opção"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <div className="field">
          <label htmlFor="mo-name">Nome da opção</label>
          <input id="mo-name" type="text" maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Sem cebola, + Bacon" autoFocus />
          <span className="field-hint">O nome aparece exatamente assim na cesta, na produção e no ticket.</span>
        </div>
        <div className="field">
          <label htmlFor="mo-type">Tipo</label>
          <select id="mo-type" value={type} onChange={(e) => setType(e.target.value as ModifierType)}>
            <option value="add">Adicionar / preferência (pode ter acréscimo)</option>
            <option value="remove">Retirar (sempre R$ 0,00)</option>
          </select>
        </div>
        {type === "add" && (
          <div className="field">
            <label htmlFor="mo-price">Acréscimo (R$)</label>
            <input id="mo-price" type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
          </div>
        )}
        <div className="field">
          <label htmlFor="mo-order">Ordem</label>
          <input id="mo-order" type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
        </div>
        <DialogActions submitting={submitting} onClose={onClose} />
      </form>
    </Modal>
  );
}

function ProductsDialog({
  group,
  products,
  onToggle,
  onClose,
}: {
  group: AdminModifierGroup;
  products: ProductLite[];
  onToggle: (productId: string, linked: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const linked = new Set(group.productIds);
  const q = query.trim().toLowerCase();
  const shown = products.filter((p) => !q || p.name.toLowerCase().includes(q));

  async function toggle(productId: string) {
    setError(null);
    setBusy(productId);
    const failure = await onToggle(productId, linked.has(productId));
    setBusy(null);
    if (failure) setError(failure);
  }

  return (
    <Modal title={`Produtos de “${group.name}”`} onClose={onClose}>
      <ErrorBox message={error} />
      <div className="field">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar produto…" aria-label="Buscar produto" />
      </div>
      <div className="mod-link-list">
        {shown.length === 0 && <p className="field-hint">Nenhum produto encontrado.</p>}
        {shown.map((p) => (
          <label key={p.id} className="checkbox-row">
            <input type="checkbox" checked={linked.has(p.id)} disabled={busy === p.id} onChange={() => void toggle(p.id)} />
            {p.name}
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn-primary btn-auto" type="button" onClick={onClose}>
          Concluir
        </button>
      </div>
    </Modal>
  );
}

// Cadastros → Adicionais / opções (owner/admin). Grupos reutilizáveis, opções e vínculo com produtos.
export function ModifiersAdmin({ source = supabaseModifiersAdminSource }: { source?: ModifiersAdminSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const canManage = activeMembership?.role === "owner" || activeMembership?.role === "admin";

  const [groups, setGroups] = useState<AdminModifierGroup[] | null>(null);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.load(companyId);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar os adicionais.");
      return;
    }
    setLoadError(null);
    setGroups(result.data.groups);
    setProducts(result.data.products);
  }, [companyId, source]);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  const productNames = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);

  if (!canManage) return <p className="form-notice">Somente donos(as) e administradores(as) podem configurar adicionais.</p>;

  async function run(request: () => Promise<Result>, successNotice?: string): Promise<string | null> {
    setActionError(null);
    const result = await request();
    if (result.error) return result.error;
    setDialog(null);
    if (successNotice) setNotice(successNotice);
    await reload();
    return null;
  }

  async function action(request: () => Promise<Result>, successNotice?: string) {
    const failure = await run(request, successNotice);
    if (failure) setActionError(failure);
  }

  async function move(group: AdminModifierGroup, option: ModifierOption, direction: -1 | 1) {
    const index = group.options.findIndex((o) => o.id === option.id);
    const swap = group.options[index + direction];
    if (!swap) return;
    // Renumera a lista inteira para a ordem ficar estável mesmo com valores repetidos.
    const reordered = [...group.options];
    reordered[index] = swap;
    reordered[index + direction] = option;
    await action(() => source.setOptionOrder(reordered.map((o, i) => ({ id: o.id, sortOrder: (i + 1) * 10 }))));
  }

  const nextGroupOrder = ((groups ?? []).reduce((m, g) => Math.max(m, g.sortOrder), 0) || 0) + 10;

  return (
    <div className="sp-admin">
      <div className="admin-actions">
        <button className="btn-primary btn-auto" type="button" onClick={() => setDialog({ kind: "group", group: null })}>
          + Novo grupo
        </button>
      </div>
      {loadError && <div className="form-error">{loadError}</div>}
      {actionError && <div className="form-error">{actionError}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {groups === null ? (
        <p className="op-state">{loadError ? "" : "Carregando…"}</p>
      ) : groups.length === 0 ? (
        <div className="print-empty">
          <p>Nenhum grupo de adicionais ainda. Crie um grupo (ex.: “Como servir”) e vincule aos produtos.</p>
        </div>
      ) : (
        <div className="print-cards">
          {groups.map((group) => {
            const linkedNames = group.productIds.map((id) => productNames.get(id)).filter(Boolean) as string[];
            return (
              <section key={group.id} className="mod-admin-card" aria-label={group.name}>
                <div className="mod-admin-head">
                  <h3>{group.name}</h3>
                  <span className={`status-badge ${group.isActive ? "status-active" : "status-inactive"}`}>{group.isActive ? "Ativo" : "Inativo"}</span>
                </div>
                <p className="print-card-meta">
                  {selectionTypeLabel(group.selectionType)} · {groupHint({ ...group, options: group.options })} · {groupSummary(group)}
                </p>
                <p className="field-hint">
                  {linkedNames.length === 0 ? "Não vinculado a nenhum produto." : `Usado em: ${linkedNames.slice(0, 4).join(", ")}${linkedNames.length > 4 ? ` e mais ${linkedNames.length - 4}` : ""}`}
                </p>
                <ul className="mod-admin-options">
                  {group.options.map((option, index) => (
                    <li key={option.id} className="mod-admin-option">
                      <span className="mod-admin-option-name" style={option.isActive ? undefined : { opacity: 0.55 }}>
                        {option.name} <span className="muted">· {option.type === "remove" ? "retirar" : option.priceDelta > 0 ? `+ ${formatReais(option.priceDelta)}` : "sem custo"}</span>
                      </span>
                      <button className="btn-secondary btn-small" type="button" aria-label={`Subir ${option.name}`} disabled={index === 0} onClick={() => void move(group, option, -1)}>
                        ↑
                      </button>
                      <button className="btn-secondary btn-small" type="button" aria-label={`Descer ${option.name}`} disabled={index === group.options.length - 1} onClick={() => void move(group, option, 1)}>
                        ↓
                      </button>
                      <button className="btn-secondary btn-small" type="button" onClick={() => setDialog({ kind: "option", group, option })}>
                        Editar
                      </button>
                      <button className="btn-secondary btn-small" type="button" onClick={() => void action(() => source.setOptionActive(option.id, !option.isActive))}>
                        {option.isActive ? "Desativar" : "Ativar"}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="row-actions">
                  <button className="btn-secondary btn-small" type="button" onClick={() => setDialog({ kind: "option", group, option: null })}>
                    + Opção
                  </button>
                  <button className="btn-secondary btn-small" type="button" onClick={() => setDialog({ kind: "products", group })}>
                    Produtos
                  </button>
                  <button className="btn-secondary btn-small" type="button" onClick={() => setDialog({ kind: "group", group })}>
                    Editar grupo
                  </button>
                  <button className="btn-secondary btn-small" type="button" onClick={() => void action(() => source.setGroupActive(group.id, !group.isActive))}>
                    {group.isActive ? "Desativar" : "Ativar"}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {dialog?.kind === "group" && (
        <GroupDialog
          group={dialog.group}
          nextOrder={nextGroupOrder}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            run(() => (dialog.group ? source.updateGroup(dialog.group.id, input) : source.createGroup(companyId!, input)), dialog.group ? "Grupo atualizado." : "Grupo criado.")
          }
        />
      )}
      {dialog?.kind === "option" && (
        <OptionDialog
          option={dialog.option}
          nextOrder={((dialog.group.options.reduce((m, o) => Math.max(m, o.sortOrder), 0) || 0) as number) + 10}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            run(
              () => (dialog.option ? source.updateOption(dialog.option.id, input) : source.createOption(companyId!, dialog.group.id, input)),
              dialog.option ? "Opção atualizada." : "Opção criada.",
            )
          }
        />
      )}
      {dialog?.kind === "products" && (
        <ProductsDialog
          group={groups?.find((g) => g.id === dialog.group.id) ?? dialog.group}
          products={products}
          onClose={() => setDialog(null)}
          onToggle={async (productId, linked) => {
            const result = linked ? await source.unlinkProduct(dialog.group.id, productId) : await source.linkProduct(companyId!, dialog.group.id, productId);
            if (result.error) return result.error;
            await reload();
            return null;
          }}
        />
      )}
    </div>
  );
}

// Seção "Adicionais e opções" do cadastro do produto: vincula/remove grupos já existentes (escrita imediata,
// independente do "Salvar" do produto). A criação de grupos fica em Cadastros → Adicionais / opções.
export function ProductModifiersSection({ productId, source = supabaseModifiersAdminSource }: { productId: string; source?: ModifiersAdminSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const [groups, setGroups] = useState<AdminModifierGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.load(companyId);
    if (result.error || !result.data) {
      setError(result.error);
      return;
    }
    setError(null);
    setGroups(result.data.groups);
  }, [companyId, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function change(request: () => Promise<Result>) {
    setBusy(true);
    const result = await request();
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setPick("");
    await reload();
  }

  const linked = (groups ?? []).filter((g) => g.productIds.includes(productId));
  const available = (groups ?? []).filter((g) => g.isActive && !g.productIds.includes(productId));

  return (
    <section className="field" aria-label="Adicionais e opções">
      <label>Adicionais e opções</label>
      {error && <div className="form-error">{error}</div>}
      {groups === null ? (
        <span className="field-hint">Carregando…</span>
      ) : (
        <>
          {linked.length === 0 && <span className="field-hint">Nenhum grupo vinculado. O produto entra direto na cesta.</span>}
          <ul className="mod-admin-options">
            {linked.map((g) => (
              <li key={g.id} className="mod-admin-option">
                <span className="mod-admin-option-name">
                  {g.name} <span className="muted">· {groupSummary(g)}{g.isActive ? "" : " · inativo"}</span>
                </span>
                <button className="btn-secondary btn-small" type="button" disabled={busy} onClick={() => void change(() => source.unlinkProduct(g.id, productId))}>
                  Remover vínculo
                </button>
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <div className="mod-admin-option">
              <select aria-label="Vincular grupo" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">+ Vincular grupo…</option>
                {available.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({groupSummary(g)})
                  </option>
                ))}
              </select>
              <button className="btn-secondary btn-small" type="button" disabled={busy || !pick} onClick={() => void change(() => source.linkProduct(companyId!, pick, productId))}>
                Vincular
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { EditCategoryDialog, NewCategoryDialog, ToggleCategoryDialog } from "./CategoryDialogs";
import { supabaseCategoriesAdminSource, type CategoriesAdminSource, type EditCategory, type NewCategory } from "./categoriesApi";
import { filterCategories, formatSectorLabel, type AdminCategory, type CategoryFilter } from "./categoriesLogic";
import type { AdminSector } from "./sectorsLogic";

const FILTER_CHIPS: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
];

type OpenDialog = { kind: "create" } | { kind: "edit" | "toggle"; category: AdminCategory };

// Cadastro de Categorias (Administrativo): criar, editar, buscar/filtrar, ativar e desativar.
// Só owner e admin (o Administrativo já barra os demais; aqui vai uma segunda checagem) e, de
// verdade, o RLS do banco (migration 040000). Nada é excluído. Mesmo padrão de
// features/operations/ServicePointsAdmin.tsx e SectorsAdmin.tsx.
export function CategoriesAdmin({ source = supabaseCategoriesAdminSource }: { source?: CategoriesAdminSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const canManage = role === "owner" || role === "admin";

  const [categories, setCategories] = useState<AdminCategory[] | null>(null);
  const [sectors, setSectors] = useState<AdminSector[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CategoryFilter>("all");

  const reload = useCallback(async () => {
    if (!companyId) return;
    const [categoriesResult, sectorsResult] = await Promise.all([source.load(companyId), source.loadSectors(companyId)]);
    setLoading(false);
    if (categoriesResult.error || !categoriesResult.data) {
      setLoadError(categoriesResult.error ?? "Não foi possível carregar as categorias.");
      return;
    }
    setLoadError(null);
    setCategories(categoriesResult.data);
    setSectors(sectorsResult.data ?? []);
  }, [companyId, source]);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  const list = useMemo(() => categories ?? [], [categories]);
  const existingCodes = useMemo(() => new Set(list.map((c) => c.code)), [list]);
  const shown = useMemo(() => filterCategories(list, { query, filter }), [list, query, filter]);

  if (!canManage) {
    return <p className="form-notice">Somente donos(as) e administradores(as) podem configurar categorias.</p>;
  }

  // Roda a operação; se der certo fecha o diálogo, avisa e recarrega a lista. Erro volta para o
  // diálogo, que o mostra sem fechar.
  async function submit(
    request: () => Promise<{ error: string | null }>,
    successNotice: string,
  ): Promise<string | null> {
    const result = await request();
    if (result.error) return result.error;
    setDialog(null);
    setNotice(successNotice);
    void reload();
    return null;
  }

  function open(next: OpenDialog) {
    setNotice(null);
    setDialog(next);
  }

  let body;
  if (loading && categories === null) {
    body = <p className="op-state">Carregando categorias…</p>;
  } else if (categories === null) {
    body = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (list.length === 0) {
    body = <p className="op-state">Nenhuma categoria cadastrada.</p>;
  } else if (shown.length === 0) {
    body = <p className="op-state">Nada encontrado com esses filtros.</p>;
  } else {
    body = (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Código</th>
              <th>Setor padrão</th>
              <th>Ordem</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((category) => (
              <tr key={category.id} className={category.is_active ? undefined : "row-inactive"}>
                <td>{category.name}</td>
                <td className="mono">{category.code}</td>
                <td>{formatSectorLabel(category.default_sector)}</td>
                <td className="mono">{category.sort_order}</td>
                <td>
                  <span className={`status-badge ${category.is_active ? "status-active" : "status-inactive"}`}>
                    {category.is_active ? "Ativo" : "Inativo"}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "edit", category })}>
                      Editar
                    </button>
                    <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "toggle", category })}>
                      {category.is_active ? "Desativar" : "Ativar"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="sp-admin">
      <div className="admin-actions">
        <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "create" })}>
          Nova categoria
        </button>
      </div>

      {loadError && <div className="form-error">{loadError}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {categories && list.length > 0 && (
        <div className="admin-filters">
          <input
            className="admin-search"
            type="search"
            value={query}
            placeholder="Buscar nome, código ou setor"
            aria-label="Buscar por nome, código ou setor padrão"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="op-filters" role="group" aria-label="Filtrar lista">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                className="op-chip"
                aria-pressed={filter === chip.value}
                onClick={() => setFilter(chip.value)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {body}

      {dialog?.kind === "create" && (
        <NewCategoryDialog
          existingCodes={existingCodes}
          sectors={sectors}
          onSubmit={(input: NewCategory) => submit(() => source.create(companyId!, input), `${input.name} cadastrada.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditCategoryDialog
          key={dialog.category.id}
          category={dialog.category}
          existingCodes={existingCodes}
          sectors={sectors}
          onSubmit={(input: EditCategory) => submit(() => source.update(dialog.category.id, input), `${input.name} atualizada.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "toggle" && (
        <ToggleCategoryDialog
          key={dialog.category.id}
          category={dialog.category}
          onConfirm={() =>
            submit(
              () => source.setActive(dialog.category.id, !dialog.category.is_active),
              dialog.category.is_active ? `${dialog.category.name} desativada.` : `${dialog.category.name} ativada.`,
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

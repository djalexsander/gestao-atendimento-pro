import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { EditSectorDialog, NewSectorDialog, ToggleSectorDialog } from "./SectorDialogs";
import { supabaseSectorsAdminSource, type NewSector, type SectorsAdminSource } from "./sectorsApi";
import { filterSectors, type AdminSector, type SectorFilter } from "./sectorsLogic";

const FILTER_CHIPS: Array<{ value: SectorFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
];

type OpenDialog = { kind: "create" } | { kind: "edit" | "toggle"; sector: AdminSector };

// Cadastro de Setores de produção (Administrativo): criar, editar, buscar/filtrar, ativar e
// desativar. Só owner e admin (o Administrativo já barra os demais; aqui vai uma segunda
// checagem) e, de verdade, o RLS do banco (migration 040000). Nada é excluído. Mesmo padrão de
// features/operations/ServicePointsAdmin.tsx.
export function SectorsAdmin({ source = supabaseSectorsAdminSource }: { source?: SectorsAdminSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const canManage = role === "owner" || role === "admin";

  const [sectors, setSectors] = useState<AdminSector[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SectorFilter>("all");

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.load(companyId);
    setLoading(false);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar os setores de produção.");
      return;
    }
    setLoadError(null);
    setSectors(result.data);
  }, [companyId, source]);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  const list = useMemo(() => sectors ?? [], [sectors]);
  const existingCodes = useMemo(() => new Set(list.map((s) => s.code)), [list]);
  const shown = useMemo(() => filterSectors(list, { query, filter }), [list, query, filter]);

  if (!canManage) {
    return <p className="form-notice">Somente donos(as) e administradores(as) podem configurar setores de produção.</p>;
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
  if (loading && sectors === null) {
    body = <p className="op-state">Carregando setores de produção…</p>;
  } else if (sectors === null) {
    body = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (list.length === 0) {
    body = <p className="op-state">Nenhum setor cadastrado.</p>;
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
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((sector) => (
              <tr key={sector.id} className={sector.is_active ? undefined : "row-inactive"}>
                <td>{sector.name}</td>
                <td className="mono">{sector.code}</td>
                <td>
                  <span className={`status-badge ${sector.is_active ? "status-active" : "status-inactive"}`}>
                    {sector.is_active ? "Ativo" : "Inativo"}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "edit", sector })}>
                      Editar
                    </button>
                    <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "toggle", sector })}>
                      {sector.is_active ? "Desativar" : "Ativar"}
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
          Novo setor
        </button>
      </div>

      {loadError && <div className="form-error">{loadError}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {sectors && list.length > 0 && (
        <div className="admin-filters">
          <input
            className="admin-search"
            type="search"
            value={query}
            placeholder="Buscar nome ou código"
            aria-label="Buscar por nome ou código"
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
        <NewSectorDialog
          existingCodes={existingCodes}
          onSubmit={(input: NewSector) => submit(() => source.create(companyId!, input), `${input.name} cadastrado.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditSectorDialog
          key={dialog.sector.id}
          sector={dialog.sector}
          existingCodes={existingCodes}
          onSubmit={(input) => submit(() => source.update(dialog.sector.id, input), `${input.name} atualizado.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "toggle" && (
        <ToggleSectorDialog
          key={dialog.sector.id}
          sector={dialog.sector}
          onConfirm={() =>
            submit(
              () => source.setActive(dialog.sector.id, !dialog.sector.is_active),
              dialog.sector.is_active ? `${dialog.sector.name} desativado.` : `${dialog.sector.name} ativado.`,
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../app/useAuth";
import {
  supabaseServicePointsAdminSource,
  type ServicePointsAdminData,
  type ServicePointsAdminSource,
} from "./adminApi";
import { TYPE_SINGULAR, filterAdminPoints, type AdminServicePoint, type ListFilter } from "./adminLogic";
import { BatchDialog, EditPointDialog, PointFormDialog, TogglePointDialog } from "./ServicePointAdminDialogs";
import { sortPoints, type ServicePointType } from "./panel";

const FILTER_CHIPS: Array<{ value: ListFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "command", label: "Comandas" },
  { value: "table", label: "Mesas" },
  { value: "inactive", label: "Inativos" },
];

function batchNotice(count: number, type: ServicePointType): string {
  const noun = type === "table" ? (count === 1 ? "mesa cadastrada" : "mesas cadastradas") : count === 1 ? "comanda cadastrada" : "comandas cadastradas";
  return `${count} ${noun}.`;
}

type OpenDialog =
  | { kind: "create"; type: ServicePointType }
  | { kind: "batch" }
  | { kind: "edit" | "toggle"; point: AdminServicePoint };

// Configuração de Comandas / Mesas (Administrativo): cadastro individual e em lote, busca,
// filtros, edição e ativar/desativar. O modo de atendimento tem tela própria em Configurações
// (ServiceModeSection/ServiceModeSettingsPage) e não é mais mostrado aqui. Só owner e admin (o
// Administrativo já barra os demais; aqui vai uma segunda checagem) e, de verdade, o RLS do
// banco. Nada é excluído.
export function ServicePointsAdmin({ source = supabaseServicePointsAdminSource }: { source?: ServicePointsAdminSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const canManage = role === "owner" || role === "admin";

  const [data, setData] = useState<ServicePointsAdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.load(companyId);
    setLoading(false);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar as comandas e mesas.");
      return;
    }
    setLoadError(null);
    setData(result.data);
  }, [companyId, source]);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  const points = useMemo(() => data?.points ?? [], [data]);
  const existingCodes = useMemo(() => new Set(points.map((p) => p.code)), [points]);
  const shown = useMemo(() => sortPoints(filterAdminPoints(points, { query, filter })), [points, query, filter]);

  if (!canManage) {
    return (
      <p className="form-notice">Somente donos(as) e administradores(as) podem configurar comandas e mesas.</p>
    );
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

  const commandCount = points.filter((p) => p.type === "command").length;
  const tableCount = points.length - commandCount;

  let list;
  if (loading && !data) {
    list = <p className="op-state">Carregando comandas e mesas…</p>;
  } else if (!data) {
    list = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (points.length === 0) {
    list = (
      <p className="op-state">
        Nenhuma comanda ou mesa cadastrada ainda. Use “Nova comanda”, “Nova mesa” ou “Gerar várias”.
      </p>
    );
  } else if (shown.length === 0) {
    list = <p className="op-state">Nada encontrado com esses filtros.</p>;
  } else {
    list = (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nome</th>
              <th>Tipo</th>
              <th>Código de barras</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((point) => (
              <tr key={point.id} className={point.is_active ? undefined : "row-inactive"}>
                <td className="mono">{point.code}</td>
                <td>{point.display_name}</td>
                <td>{TYPE_SINGULAR[point.type]}</td>
                <td className="mono">{point.barcode ?? "—"}</td>
                <td>
                  <span className={`status-badge ${point.is_active ? "status-active" : "status-inactive"}`}>
                    {point.is_active ? "Ativo" : "Inativo"}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn-secondary btn-small"
                      type="button"
                      onClick={() => open({ kind: "edit", point })}
                    >
                      Editar
                    </button>
                    <button
                      className="btn-secondary btn-small"
                      type="button"
                      onClick={() => open({ kind: "toggle", point })}
                    >
                      {point.is_active ? "Desativar" : "Ativar"}
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
        <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "create", type: "command" })}>
          Nova comanda
        </button>
        <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "create", type: "table" })}>
          Nova mesa
        </button>
        <button className="btn-secondary" type="button" onClick={() => open({ kind: "batch" })}>
          Gerar várias comandas/mesas
        </button>
      </div>

      {loadError && <div className="form-error">{loadError}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {data && points.length > 0 && (
        <div className="admin-filters">
          <input
            className="admin-search"
            type="search"
            value={query}
            placeholder="Buscar código, nome ou barras"
            aria-label="Buscar por código, nome ou código de barras"
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
          <p className="field-hint">
            {commandCount} {commandCount === 1 ? "comanda" : "comandas"} · {tableCount}{" "}
            {tableCount === 1 ? "mesa" : "mesas"}
          </p>
        </div>
      )}

      {list}

      {dialog?.kind === "create" && (
        <PointFormDialog
          initialType={dialog.type}
          existingCodes={existingCodes}
          onSubmit={(input) =>
            submit(() => source.create(companyId!, input), `${TYPE_SINGULAR[input.type]} ${input.code} cadastrada.`)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "batch" && (
        <BatchDialog
          existingCodes={existingCodes}
          onSubmit={({ rows, generateEan }) =>
            submit(() => source.createBatch(companyId!, rows, generateEan), batchNotice(rows.length, rows[0].type))
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditPointDialog
          key={dialog.point.id}
          point={dialog.point}
          onSubmit={(input) => submit(() => source.update(dialog.point.id, input), `${dialog.point.code} atualizada.`)}
          onGenerateEan={async (regenerate) => {
            const result = await source.generateEan(dialog.point.id, regenerate);
            if (!result.error) void reload();
            return result;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "toggle" && (
        <TogglePointDialog
          key={dialog.point.id}
          point={dialog.point}
          onConfirm={() =>
            submit(
              () => source.setActive(dialog.point.id, !dialog.point.is_active),
              dialog.point.is_active ? `${dialog.point.code} desativada.` : `${dialog.point.code} ativada.`,
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

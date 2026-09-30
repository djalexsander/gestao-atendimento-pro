import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { StockHistoryDialog, StockMovementDialog } from "./StockDialogs";
import { supabaseStockSource, type StockSource } from "./stockApi";
import {
  countByStatus,
  filterStock,
  STOCK_STATUS_LABEL,
  stockStatus,
  type StockFilter,
  type StockRow,
} from "./stockLogic";

const FILTERS: Array<{ value: StockFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "low", label: "Baixo estoque" },
  { value: "out", label: "Sem estoque" },
  { value: "inactive", label: "Inativos" },
];

type Dialog = { kind: "entry" | "adjust" | "history"; row: StockRow };

function StatusBadge({ row }: { row: StockRow }) {
  if (!row.is_active) return <span className="status-badge status-inactive">Inativo</span>;
  const status = stockStatus(row.stock_quantity, row.minimum_stock_quantity);
  return <span className={`status-badge stock-${status}`}>{STOCK_STATUS_LABEL[status]}</span>;
}

// Cadastros > Estoque: SÓ os produtos com controle de quantidade (os preparados não aparecem aqui).
// O saldo não é digitado: entrada e ajuste geram movimentos auditáveis (o servidor é a autoridade).
export function StockAdmin({ source = supabaseStockSource }: { source?: StockSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StockFilter>("all");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.listControlled(companyId);
    if (result.error || !result.data) {
      setError(result.error ?? "Não foi possível carregar o estoque.");
      return;
    }
    setError(null);
    setRows(result.data);
  }, [companyId, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = useMemo(() => filterStock(rows ?? [], query, filter), [rows, query, filter]);
  const counts = useMemo(() => countByStatus(rows ?? []), [rows]);

  function actions(row: StockRow) {
    return (
      <div className="stock-actions">
        <button type="button" className="btn-secondary btn-small" onClick={() => setDialog({ kind: "entry", row })}>
          Entrada
        </button>
        <button type="button" className="btn-secondary btn-small" onClick={() => setDialog({ kind: "adjust", row })}>
          Ajustar
        </button>
        <button type="button" className="btn-secondary btn-small" onClick={() => setDialog({ kind: "history", row })}>
          Histórico
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>Estoque</h2>
      </div>
      <p className="field-hint">
        Mostra só os produtos com <strong>controle de quantidade</strong>. Para controlar um produto, abra-o em Cadastros → Produtos.
        Produtos preparados (espetos, lanches, porções) não precisam de saldo.
      </p>

      <div className="stock-summary">
        <span className="status-badge stock-normal">Normal: {counts.normal}</span>
        <span className="status-badge stock-low">Baixo estoque: {counts.low}</span>
        <span className="status-badge stock-out">Sem estoque: {counts.out}</span>
      </div>

      <div className="stock-filters">
        <div className="field">
          <label htmlFor="stock-search">Buscar</label>
          <input id="stock-search" type="search" placeholder="Nome ou código" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="stock-chips" role="group" aria-label="Situação">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" className="op-chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div role="status" className="form-notice">
          {notice}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {!rows && !error && <p className="op-state">Carregando…</p>}
      {rows && rows.length === 0 && <p className="field-hint">Nenhum produto com controle de estoque ainda.</p>}
      {rows && rows.length > 0 && shown.length === 0 && <p className="field-hint">Nenhum produto encontrado com esses filtros.</p>}

      {shown.length > 0 && (
        <>
          <div className="stock-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Código</th>
                  <th>Estoque atual</th>
                  <th>Mínimo</th>
                  <th>Situação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id} className={row.is_active ? undefined : "row-inactive"}>
                    <td>
                      {row.name}
                      {!row.available_for_sale && <span className="status-badge status-inactive"> Indisponível</span>}
                    </td>
                    <td>{row.code}</td>
                    <td>
                      <strong>{row.stock_quantity}</strong>
                    </td>
                    <td>{row.minimum_stock_quantity}</td>
                    <td>
                      <StatusBadge row={row} />
                    </td>
                    <td>{actions(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="stock-cards">
            {shown.map((row) => (
              <li key={row.id} className="stock-card">
                <div className="stock-card-head">
                  <strong>{row.name}</strong>
                  <StatusBadge row={row} />
                </div>
                <p className="muted">
                  {row.code} · Mínimo {row.minimum_stock_quantity}
                </p>
                <p className="stock-card-qty">Estoque: {row.stock_quantity}</p>
                {actions(row)}
              </li>
            ))}
          </ul>
        </>
      )}

      {dialog && dialog.kind !== "history" && (
        <StockMovementDialog
          source={source}
          productId={dialog.row.id}
          productName={dialog.row.name}
          current={dialog.row.stock_quantity}
          mode={dialog.kind}
          onDone={(message) => {
            setDialog(null);
            setNotice(message);
            void reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog && dialog.kind === "history" && (
        <StockHistoryDialog source={source} productId={dialog.row.id} productName={dialog.row.name} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

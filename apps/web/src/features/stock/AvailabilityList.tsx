import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { supabaseStockSource, type AvailabilityRow, type StockSource } from "./stockApi";

// Disponibilidade manual de produtos (Produção): "o espeto acabou" -> Indisponível para venda.
// Só altera a disponibilidade (nunca preço, cadastro ou estoque). O servidor valida o papel.
export function AvailabilityList({ source = supabaseStockSource }: { source?: StockSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const [rows, setRows] = useState<AvailabilityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.listAvailability(companyId);
    if (result.error || !result.data) {
      setError(result.error);
      return;
    }
    setError(null);
    setRows(result.data);
  }, [companyId, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggle(row: AvailabilityRow) {
    setBusyId(row.id);
    setError(null);
    const result = await source.setAvailability(row.id, !row.available_for_sale);
    setBusyId(null);
    if (result.error) setError(result.error);
    void reload();
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div>
      <p className="field-hint">Marque como indisponível o que acabou. Produto indisponível não pode ser lançado em pedido novo.</p>
      <div className="field">
        <label htmlFor="availability-search">Buscar</label>
        <input id="availability-search" type="search" placeholder="Nome ou código" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && <div className="form-error">{error}</div>}
      {!rows && !error && <p className="op-state">Carregando…</p>}
      <ul className="availability-list">
        {shown.map((row) => (
          <li key={row.id} className={`availability-row${row.available_for_sale ? "" : " availability-off"}`}>
            <div>
              <strong>{row.name}</strong>
              <span className="muted"> {row.code}</span>
              {row.stock_control === "quantity" && <span className="muted"> · estoque {row.stock_quantity}</span>}
              {!row.available_for_sale && <span className="status-badge status-inactive"> Indisponível</span>}
            </div>
            <button
              type="button"
              className={row.available_for_sale ? "btn-secondary kds-btn" : "btn-primary btn-auto kds-btn"}
              disabled={busyId === row.id}
              onClick={() => void toggle(row)}
            >
              {row.available_for_sale ? "Marcar indisponível" : "Voltar a disponível"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

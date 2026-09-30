import { useState } from "react";
import { StockMovementDialog } from "./StockDialogs";
import { supabaseStockSource, type ProductStockState, type StockSource } from "./stockApi";
import { STOCK_STATUS_LABEL, stockStatus } from "./stockLogic";

// Seção ESTOQUE da edição do produto: disponibilidade manual e controle de estoque. Age por RPC na
// hora (o servidor é a autoridade); o saldo NUNCA é digitado: só Entrada e Ajustar.
export function ProductStockPanel({
  source = supabaseStockSource,
  productId,
  productName,
  initial,
  onChanged,
}: {
  source?: StockSource;
  productId: string;
  productName: string;
  initial: ProductStockState;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<ProductStockState>(initial);
  const [mode, setMode] = useState<"none" | "quantity">(initial.stock_control);
  const [minimum, setMinimum] = useState(String(initial.minimum_stock_quantity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"entry" | "adjust" | null>(null);

  const minimumValue = /^\d+$/.test(minimum.trim()) ? Number(minimum.trim()) : null;
  const dirty = mode !== state.stock_control || (mode === "quantity" && minimumValue !== state.minimum_stock_quantity);

  async function toggleAvailability() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await source.setAvailability(productId, !state.available_for_sale);
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error);
      return;
    }
    setState(result.data);
    setNotice(result.data.available_for_sale ? "Produto disponível para venda." : "Produto indisponível para venda.");
    onChanged?.();
  }

  async function saveControl() {
    if (mode === "quantity" && minimumValue === null) {
      setError("Informe o estoque mínimo (número inteiro, pode ser 0).");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await source.setControl(productId, mode, mode === "quantity" ? (minimumValue ?? 0) : 0);
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error);
      return;
    }
    setState(result.data);
    setMode(result.data.stock_control);
    setMinimum(String(result.data.minimum_stock_quantity));
    setNotice(result.data.stock_control === "quantity" ? "Controle de estoque salvo." : "Controle de estoque desativado.");
    onChanged?.();
  }

  const status = stockStatus(state.stock_quantity, state.minimum_stock_quantity);

  return (
    <section className="product-stock-panel" aria-label="Estoque">
      <h4 className="cash-section-title">Estoque</h4>

      <div className="product-stock-row">
        <span>
          Disponível para venda:{" "}
          <strong>{state.available_for_sale ? "Sim" : "Não"}</strong>
        </span>
        {!state.available_for_sale && <span className="status-badge status-inactive">Indisponível</span>}
        <button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => void toggleAvailability()}>
          {state.available_for_sale ? "Marcar como indisponível" : "Marcar como disponível"}
        </button>
      </div>
      <p className="field-hint">Indisponível não entra em pedido novo (continua cadastrado e no histórico).</p>

      <fieldset className="stock-mode">
        <legend>Controle de estoque</legend>
        <label>
          <input type="radio" name="stock-mode" checked={mode === "none"} onChange={() => setMode("none")} /> Não controlar estoque
        </label>
        <label>
          <input type="radio" name="stock-mode" checked={mode === "quantity"} onChange={() => setMode("quantity")} /> Controlar quantidade
        </label>
      </fieldset>

      {mode === "none" ? (
        <p className="field-hint">Este produto poderá ser vendido sem limite de quantidade.</p>
      ) : (
        <div className="field">
          <label htmlFor={`min-stock-${productId}`}>Estoque mínimo (alerta)</label>
          <input id={`min-stock-${productId}`} inputMode="numeric" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
        </div>
      )}

      {state.stock_control === "quantity" && (
        <div className="product-stock-row">
          <span>
            Estoque atual: <strong>{state.stock_quantity}</strong>
          </span>
          <span className={`status-badge stock-${status}`}>{STOCK_STATUS_LABEL[status]}</span>
          <button type="button" className="btn-secondary btn-small" onClick={() => setDialog("entry")}>
            Entrada
          </button>
          <button type="button" className="btn-secondary btn-small" onClick={() => setDialog("adjust")}>
            Ajustar estoque
          </button>
        </div>
      )}

      {dirty && (
        <button type="button" className="btn-primary btn-auto btn-small" disabled={busy} onClick={() => void saveControl()}>
          {busy ? "Salvando…" : "Salvar controle de estoque"}
        </button>
      )}
      {error && <div className="form-error">{error}</div>}
      {notice && (
        <div role="status" className="form-notice">
          {notice}
        </div>
      )}

      {dialog && (
        <StockMovementDialog
          source={source}
          productId={productId}
          productName={productName}
          current={state.stock_quantity}
          mode={dialog}
          onDone={(message) => {
            setDialog(null);
            setNotice(message);
            // saldo novo: o painel relê pelas RPCs na próxima ação; aqui recarrega a lista do produto
            void source.setControl(productId, "quantity", state.minimum_stock_quantity).then((r) => {
              if (r.data) setState(r.data);
            });
            onChanged?.();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

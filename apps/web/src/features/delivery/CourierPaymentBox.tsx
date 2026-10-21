import { useRef, useState } from "react";
import { formatReais } from "../../lib/money";
import type { DeliverySource } from "./deliveryApi";
import {
  METHOD_LABEL,
  courierDraftFor,
  courierPaymentCalc,
  courierPaymentState,
  formatTime,
  type CourierPaymentDraft,
  type DeliveryRow,
  type ExpectedMethod,
} from "./deliveryLogic";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const METHODS: ExpectedMethod[] = ["cash", "pix", "debit_card", "credit_card", "other"];

// Pagamento na entrega (celular do ENTREGADOR). O recebimento fica em CUSTÓDIA do entregador: NÃO entra no caixa até o acerto.
// Pedido já pago no Caixa nunca permite novo recebimento. O servidor revalida tudo (total, rota, atribuição, duplicidade).
export function CourierPaymentBox({ row, source, onDone }: { row: DeliveryRow; source: DeliverySource; onDone: () => void }) {
  const state = courierPaymentState(row);
  const [draft, setDraft] = useState<CourierPaymentDraft>(() => courierDraftFor(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // um pedido de recebimento por abertura: tentar de novo (rede/clique duplo) reaproveita o MESMO id e nunca duplica
  const requestId = useRef(newRequestId());
  const inFlight = useRef(false); // trava síncrona contra clique duplo
  const calc = courierPaymentCalc(row.total, draft);

  if (state.kind === "none") return null;
  if (state.kind === "paid") {
    return (
      <div className="dl-pay dl-pay-paid" role="status" data-testid="courier-paid">
        <strong>Pagamento já recebido</strong>
        <span className="muted"> · registrado no Caixa. Não há nada a cobrar do cliente.</span>
      </div>
    );
  }
  if (state.kind === "held") {
    const c = state.custody;
    return (
      <div className="dl-pay dl-pay-held" role="status" data-testid="courier-held">
        <strong>Recebido por mim</strong>
        <span className="muted"> · aguardando acerto no Caixa</span>
        <div className="dl-pay-line">
          {METHOD_LABEL[c.method]} · <strong>{formatReais(c.amount)}</strong>
          {c.method === "cash" && c.amountReceived !== null && c.changeAmount > 0 ? <> · recebi {formatReais(c.amountReceived)} · troco {formatReais(c.changeAmount)}</> : null}
          <span className="muted"> · às {formatTime(c.receivedAt)}</span>
        </div>
        <small className="field-hint">Entregue o valor ao Caixa para o acerto. Só depois ele conta como pago.</small>
      </div>
    );
  }

  async function submit() {
    if (busy || inFlight.current || calc.error) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await source.registerCourierPayment(row.id, draft.method, calc.received, requestId.current);
    inFlight.current = false;
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    onDone();
  }

  return (
    <div className="dl-pay dl-pay-register" data-testid="courier-register">
      <h4 className="dl-h">Receber do cliente</h4>
      <p className="dl-pay-total">
        Valor do pedido: <strong>{formatReais(row.total)}</strong>
        {row.expectedMethod ? <span className="muted"> · cliente disse: {METHOD_LABEL[row.expectedMethod]}</span> : null}
      </p>
      <label className="dl-field">
        <span>Forma de pagamento recebida</span>
        <select value={draft.method} disabled={busy} onChange={(e) => { setError(null); setDraft({ method: e.target.value as ExpectedMethod, receivedText: e.target.value === "cash" ? draft.receivedText : "" }); }}>
          {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </select>
      </label>
      {draft.method === "cash" && (
        <>
          <label className="dl-field">
            <span>Valor que o cliente entregou</span>
            <input inputMode="decimal" placeholder={formatReais(row.total)} value={draft.receivedText} disabled={busy} onChange={(e) => { setError(null); setDraft({ ...draft, receivedText: e.target.value }); }} />
          </label>
          <p className="dl-pay-change" data-testid="courier-change">
            Troco a devolver: <strong>{formatReais(calc.change)}</strong>
            {row.cashChangeFor !== null ? <span className="muted"> · o cliente pediu troco para {formatReais(row.cashChangeFor)}</span> : null}
          </p>
        </>
      )}
      {calc.error && <div className="field-error">{calc.error}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="field-hint">O valor fica com você até o acerto no Caixa: ele só entra no caixa da empresa quando o Caixa confirmar.</p>
      <button type="button" className="btn-primary btn-auto dl-pay-button" disabled={busy || !!calc.error} onClick={() => void submit()}>
        {busy ? "Registrando…" : "Registrar recebimento"}
      </button>
    </div>
  );
}

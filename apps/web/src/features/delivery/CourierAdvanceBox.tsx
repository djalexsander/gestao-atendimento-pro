import { useCallback, useEffect, useRef, useState } from "react";
import { formatReais } from "../../lib/money";
import type { CompanyRole } from "../../lib/types";
import type { CourierAdvanceInfo, DeliveryRow } from "./deliveryLogic";
import { ADVANCE_STATUS_LABEL, advanceAmountProblem, formatTime } from "./deliveryLogic";
import type { DeliverySource } from "./deliveryApi";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const CASH_ROLES: readonly CompanyRole[] = ["owner", "admin", "cashier"];

// Troco do entregador: o Caixa entrega o troco ANTES da saída (confirmação explícita do operador) e o valor sai do caixa aberto de
// quem confirma. Nada é liberado automaticamente. O entregador só vê a informação. O servidor revalida tudo (papel, caixa, saldo, duplicidade).
export function CourierAdvanceBox({ row, role, source, onChanged }: { row: DeliveryRow; role: CompanyRole | null; source: DeliverySource; onChanged: () => void }) {
  const isCash = role !== null && CASH_ROLES.includes(role);
  const isCourier = role === "courier";
  const [info, setInfo] = useState<CourierAdvanceInfo | null>(null);
  const [amountText, setAmountText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // um id por tentativa com o mesmo valor: repetir (rede/clique duplo) reaproveita o id e nunca duplica
  const requestId = useRef({ key: "", id: newRequestId() });
  const inFlight = useRef(false);

  const applicable = row.fulfillment === "delivery" && (isCash || isCourier || role === "attendant");

  const load = useCallback(async () => {
    const r = await source.advance(row.id);
    if (r.data) setInfo(r.data);
  }, [source, row.id]);

  useEffect(() => {
    if (!applicable) return;
    void load();
  }, [applicable, load, row.status, row.courierUserId, row.sessionStatus, row.courierCustody]);

  if (!applicable || !info) return null;
  const adv = info.advance;
  const live = adv && (adv.status === "open" || adv.status === "settled");

  if (live) {
    return (
      <div className="dl-pay dl-advance dl-advance-given" role="status" data-testid="advance-given">
        <strong>Troco {isCourier ? "recebido do Caixa" : "entregue ao entregador"}: {formatReais(adv.amount)}</strong>
        <span className="muted"> · {ADVANCE_STATUS_LABEL[adv.status]}{adv.givenByName ? ` · por ${adv.givenByName}` : ""} · às {formatTime(adv.givenAt)}</span>
        {adv.status === "open" && (
          <small className="field-hint">
            {isCourier
              ? "Devolva ao Caixa, junto com o dinheiro recebido do cliente, no acerto."
              : "No acerto o entregador devolve o dinheiro bruto: venda em dinheiro + este troco. Se a entrega não ocorrer, receba a devolução em Caixa → Acerto de entregadores."}
          </small>
        )}
      </div>
    );
  }
  if (isCourier || !isCash || !info.canGive) {
    // só orientação quando faz sentido (troco pedido e ainda não entregue)
    if (!isCash || info.suggested <= 0 || !info.blockedReason || row.status === "canceled") return null;
    if (info.blockedReason === "Só o Caixa entrega o troco.") return null;
    return <p className="field-hint dl-advance-hint" role="status">Troco do entregador: {info.blockedReason}</p>;
  }

  const calc = advanceAmountProblem(amountText, info.suggested);

  async function give() {
    if (busy || inFlight.current || calc.value === null) return;
    const key = String(calc.value);
    if (requestId.current.key !== key) requestId.current = { key, id: newRequestId() };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await source.giveAdvance(row.id, calc.value, requestId.current.id, null);
    inFlight.current = false;
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    setConfirming(false);
    setAmountText("");
    await load();
    onChanged();
  }

  return (
    <div className="dl-pay dl-advance dl-advance-form" data-testid="advance-form">
      <h4 className="dl-h">Troco do entregador</h4>
      {info.cashChangeFor !== null && info.expectedMethod === "cash" ? (
        <p className="dl-pay-total">
          Pedido <strong>{formatReais(info.orderTotal)}</strong> · cliente paga com <strong>{formatReais(info.cashChangeFor)}</strong> · troco necessário{" "}
          <strong>{formatReais(info.suggested)}</strong>
        </p>
      ) : (
        <p className="muted">O cliente não informou troco. Se o entregador precisar de troco, informe o valor.</p>
      )}
      <label className="dl-field">
        <span>Valor do troco a entregar</span>
        <input inputMode="decimal" placeholder={info.suggested > 0 ? formatReais(info.suggested) : "0,00"} value={amountText} disabled={busy || confirming} onChange={(e) => { setError(null); setAmountText(e.target.value); }} />
      </label>
      {calc.problem && (amountText.trim() !== "" || info.suggested <= 0) && <div className="field-hint dl-bad">{calc.problem}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {!confirming ? (
        <button type="button" className="btn-secondary btn-auto" disabled={busy || calc.value === null} onClick={() => { setError(null); setConfirming(true); }}>
          {calc.value !== null ? `Entregar troco ${formatReais(calc.value)}` : "Entregar troco"}
        </button>
      ) : (
        <div className="dl-cancel" role="alertdialog" aria-label="Confirmar entrega do troco">
          <p>
            Confirma que está <strong>entregando {calc.value !== null ? formatReais(calc.value) : ""}</strong> do SEU caixa ao entregador{row.courierName ? ` ${row.courierName}` : ""}? O valor sai do caixa agora e será devolvido no acerto.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Voltar</button>
            <button type="button" className="btn-primary btn-auto" data-testid="advance-confirm" disabled={busy || calc.value === null} onClick={() => void give()}>
              {busy ? "Registrando…" : "Confirmar entrega do troco"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

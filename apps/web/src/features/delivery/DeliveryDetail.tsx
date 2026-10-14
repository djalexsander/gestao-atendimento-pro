import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import type { CompanyRole } from "../../lib/types";
import type { CourierOption, DeliveryDetail as Detail, DeliverySource } from "./deliveryApi";
import {
  ACTION_LABEL,
  FEE_SOURCE_LABEL,
  FULFILLMENT_LABEL,
  LOGISTIC_LABEL,
  METHOD_LABEL,
  TIMING_LABEL,
  availableActions,
  etaOf,
  formatAddressLine,
  formatCep,
  formatPhone,
  formatTime,
  isOperator,
  shortId,
  stateLabel,
  type DeliveryAction,
  type DeliveryRow,
} from "./deliveryLogic";

const EVENT_LABEL: Record<string, string> = {
  created: "Pedido criado",
  status_changed: "Estado alterado",
  courier_assigned: "Entregador",
  fee_overridden: "Taxa ajustada",
  canceled: "Pedido cancelado",
};

function describeEvent(e: Detail["events"][number]): string {
  const base = EVENT_LABEL[e.eventType] ?? e.eventType;
  if (e.eventType === "status_changed") {
    const from = String(e.oldValue?.status ?? "");
    const to = String(e.newValue?.status ?? "");
    const l = (s: string) => (LOGISTIC_LABEL as Record<string, string>)[s] ?? s;
    return `${base}: ${l(from)} → ${l(to)}`;
  }
  if (e.eventType === "fee_overridden") {
    const to = Number(e.newValue?.fee ?? 0);
    const from = e.oldValue?.fee === undefined || e.oldValue?.fee === null ? null : Number(e.oldValue.fee);
    return from === null ? `${base}: ${formatReais(to)}` : `${base}: ${formatReais(from)} → ${formatReais(to)}`;
  }
  if (e.eventType === "canceled" && e.note) return `${base}: ${e.note}`;
  return base;
}

// Detalhe de um delivery/retirada: dados operacionais, itens, produção derivada, linha do tempo e AÇÕES conforme o papel.
// Os botões só existem quando a ação é válida (espelho do backend, que revalida e recusa o resto).
export function DeliveryDetail({
  row,
  companyId,
  role,
  userId,
  source,
  onClose,
  onChanged,
}: {
  row: DeliveryRow;
  companyId: string;
  role: CompanyRole | null;
  userId: string | null;
  source: DeliverySource;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [couriers, setCouriers] = useState<CourierOption[] | null>(null);

  const load = useCallback(async () => {
    const r = await source.get(row.id);
    if (r.data) {
      setDetail(r.data);
      setLoadError(null);
    } else setLoadError(r.error);
  }, [source, row.id]);

  useEffect(() => {
    void load();
  }, [load, row.status, row.production, row.courierUserId, row.itemsReady]);

  const actions = availableActions(row, { role, userId });
  const isCourier = role === "courier";
  const operator = isOperator(role);

  const canAssign = actions.includes("assign");
  useEffect(() => {
    if (!canAssign || couriers) return;
    void source.couriers(companyId).then((r) => setCouriers(r.data ?? []));
  }, [canAssign, couriers, source, companyId]);

  async function run(fn: () => Promise<{ error: string | null }>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    onChanged();
    void load();
  }

  const statusActions: Array<Exclude<DeliveryAction, "cancel" | "assign" | "receive">> = actions.filter(
    (a): a is Exclude<DeliveryAction, "cancel" | "assign" | "receive"> => a === "out_for_delivery" || a === "delivered" || a === "picked_up",
  );
  const eta = etaOf(row);

  return (
    <Modal title={`${FULFILLMENT_LABEL[row.fulfillment]} · #${shortId(row.id)}`} onClose={onClose}>
      <div className="dl-detail">
        <div className="dl-badges">
          <span className={`dl-badge dl-badge-${row.fulfillment}`}>{FULFILLMENT_LABEL[row.fulfillment]}</span>
          <span className="dl-badge dl-badge-state">{stateLabel(row)}</span>
          {row.status === "confirmed" && row.production === "ready" && <span className="dl-badge dl-badge-ready">Itens prontos</span>}
        </div>

        <dl className="dl-info">
          <div><dt>Cliente</dt><dd>{row.customerName}</dd></div>
          {row.customerPhone && (
            <div><dt>Telefone</dt><dd><a href={`tel:${row.customerPhone}`}>{formatPhone(row.customerPhone)}</a></dd></div>
          )}
          {row.fulfillment === "delivery" && row.address && (
            <>
              <div><dt>Endereço</dt><dd>{formatAddressLine(row.address)}{row.address.cep ? ` · CEP ${formatCep(row.address.cep)}` : ""}</dd></div>
              {row.address.reference && <div><dt>Referência</dt><dd>{row.address.reference}</dd></div>}
            </>
          )}
          <div><dt>{row.fulfillment === "pickup" ? "Previsão de retirada" : "Previsão de entrega"}</dt><dd>{formatTime(eta)}</dd></div>
          <div><dt>Pagamento</dt><dd>{TIMING_LABEL[row.paymentTiming]}{row.expectedMethod ? ` · ${METHOD_LABEL[row.expectedMethod]}` : ""}</dd></div>
          {row.cashChangeFor !== null && <div><dt>Troco para</dt><dd><strong>{formatReais(row.cashChangeFor)}</strong></dd></div>}
          {row.notes && <div><dt>Observação</dt><dd>{row.notes}</dd></div>}
          {row.fulfillment === "delivery" && <div><dt>Entregador</dt><dd>{row.courierName ?? "Sem entregador"}</dd></div>}
          {row.cancelReason && <div><dt>Motivo do cancelamento</dt><dd>{row.cancelReason}</dd></div>}
        </dl>

        <h4 className="dl-h">Itens</h4>
        {loadError && <div className="form-error">{loadError}</div>}
        {!detail && !loadError && <p className="muted">Carregando itens…</p>}
        {detail && (
          <ul className="dl-items">
            {detail.items.map((i) => (
              <li key={i.id} className={i.cancelledQuantity >= i.quantity ? "dl-item-cancelled" : ""}>
                <span className="dl-item-main">
                  <strong>{i.quantity - i.cancelledQuantity}×</strong> {i.name}
                  {i.cancelledQuantity > 0 && <span className="muted"> ({i.cancelledQuantity} cancelado)</span>}
                </span>
                {i.modifiers.length > 0 && (
                  <span className="dl-item-mods">
                    {i.modifiers.map((m) => `${m.type === "remove" ? "sem " : "+ "}${m.name}`).join(", ")}
                  </span>
                )}
                {i.notes && <span className="dl-item-notes">Obs.: {i.notes}</span>}
                <span className="dl-item-prod">
                  {i.productionStatus === "ready" ? "Pronto" : i.productionStatus === "preparing" ? "Em preparo" : "Aguardando"}
                </span>
                {!isCourier && i.unitPrice !== null && <span className="dl-item-price">{formatReais(i.unitPrice * (i.quantity - i.cancelledQuantity))}</span>}
              </li>
            ))}
          </ul>
        )}

        {!isCourier && (
          <dl className="dl-totals">
            <div><dt>Itens</dt><dd>{formatReais(row.itemsSubtotal)}</dd></div>
            <div><dt>Taxa de entrega{row.feeSource !== "none" ? ` (${FEE_SOURCE_LABEL[row.feeSource]})` : ""}</dt><dd>{formatReais(row.deliveryFee)}</dd></div>
            <div className="dl-total"><dt>Total</dt><dd>{formatReais(row.total)}</dd></div>
          </dl>
        )}
        {isCourier && row.paymentTiming !== "on_order" && (
          <p className="dl-courier-total">Valor a receber na entrega: <strong>{formatReais(row.total)}</strong></p>
        )}

        {detail && detail.events.length > 0 && (
          <>
            <h4 className="dl-h">Linha do tempo</h4>
            <ol className="dl-timeline">
              {detail.events.map((e, idx) => (
                <li key={idx}><span className="muted">{formatTime(e.createdAt)}</span> {describeEvent(e)}</li>
              ))}
            </ol>
          </>
        )}

        {error && <div className="form-error" role="alert">{error}</div>}

        {actions.includes("assign") && (
          <label className="dl-field">
            <span>Entregador</span>
            <select
              value={row.courierUserId ?? ""}
              disabled={busy || !couriers}
              onChange={(e) => void run(() => source.assignCourier(row.id, e.target.value || null))}
            >
              <option value="">Sem entregador</option>
              {(couriers ?? []).map((c) => (
                <option key={c.userId} value={c.userId}>{c.name}</option>
              ))}
            </select>
          </label>
        )}

        <div className="modal-actions dl-actions">
          {statusActions.map((a) => (
            <button key={a} type="button" className="btn-primary btn-auto" disabled={busy} onClick={() => void run(() => source.setStatus(row.id, a))}>
              {ACTION_LABEL[a]}
            </button>
          ))}
          {operator && actions.includes("receive") && (
            <Link className="btn-secondary" to={`/operacional/caixa/${row.sessionId}`}>
              {ACTION_LABEL.receive}
            </Link>
          )}
          {actions.includes("cancel") && !cancelOpen && (
            <button type="button" className="btn-secondary dl-danger" disabled={busy} onClick={() => setCancelOpen(true)}>
              {ACTION_LABEL.cancel}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>Fechar</button>
        </div>

        {cancelOpen && (
          <form
            className="dl-cancel"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason.trim()) {
                setError("Informe o motivo do cancelamento.");
                return;
              }
              void run(async () => {
                const r = await source.cancel(row.id, reason.trim());
                if (!r.error) setCancelOpen(false);
                return r;
              });
            }}
          >
            <label className="dl-field">
              <span>Motivo do cancelamento</span>
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setCancelOpen(false)}>Voltar</button>
              <button type="submit" className="btn-primary btn-auto dl-danger-fill" disabled={busy}>Confirmar cancelamento</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

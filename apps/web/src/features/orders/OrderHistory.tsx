import { formatOpenedFull } from "../operations/panel";
import { formatReais } from "../../lib/money";
import {
  activeQuantity,
  canCancelItem,
  sessionTotal,
  sortOrdersByRecent,
  type SubmittedOrder,
  type SubmittedOrderItem,
} from "./ordersLogic";

const PRODUCTION_LABEL: Record<SubmittedOrder["items"][number]["productionStatus"], string> = {
  pending: "Pendente",
  preparing: "Em preparo",
  ready: "Pronto",
};

const ORIGIN_LABEL: Record<SubmittedOrder["origin"], string> = {
  attendant: "Atendimento",
  cashier: "Caixa",
  whatsapp: "WhatsApp",
};

// Pedidos já enviados da session, mais recente primeiro. Nome, preço e setor vêm dos SNAPSHOTS
// gravados por submit_service_order — não do catálogo atual. Quantidade ORIGINAL nunca muda; o que
// foi cancelado aparece separado (cancelada / válida) com os eventos (motivo, quem, quando) num
// bloco expansível. O status de produção é só leitura. "Cancelar item" só com a conta aberta e
// conforme o papel (o servidor reforça a regra).
export function OrderHistory({
  orders,
  role,
  sessionOpen = false,
  onCancelItem,
}: {
  orders: SubmittedOrder[];
  role?: string | null;
  sessionOpen?: boolean;
  onCancelItem?: (item: SubmittedOrderItem) => void;
}) {
  const sorted = sortOrdersByRecent(orders);

  return (
    <section className="order-history">
      <div className="order-history-total">
        <span>Total do atendimento</span>
        <span>{formatReais(sessionTotal(orders))}</span>
      </div>

      <h3 className="order-history-heading">Pedidos enviados</h3>
      {sorted.length === 0 ? (
        <p className="op-state">Nenhum pedido enviado ainda.</p>
      ) : (
        sorted.map((order) => (
          <article key={order.id} className={`order-history-item${order.status === "cancelled" ? " order-history-item-cancelled" : ""}`}>
            <div className="order-history-head">
              <span>{formatOpenedFull(order.submittedAt)}</span>
              <span>
                {order.createdByName ?? "—"} · {ORIGIN_LABEL[order.origin]}
              </span>
              {order.status === "cancelled" && <span className="status-badge status-inactive">Cancelado</span>}
            </div>
            <ul className="order-history-items">
              {order.items.map((item) => {
                const active = activeQuantity(item);
                const fullyCancelled = active === 0;
                const showCancel = sessionOpen && order.status !== "cancelled" && onCancelItem && canCancelItem(role, item);
                return (
                  <li key={item.id}>
                    <span className="order-history-item-line">
                      <span className={fullyCancelled ? "order-history-struck" : undefined}>
                        {item.quantity}× {item.productNameSnapshot}
                      </span>
                      {item.sectorName && <span className="muted"> · {item.sectorName}</span>}
                      {fullyCancelled ? (
                        <span className="status-badge status-inactive">CANCELADO</span>
                      ) : (
                        <span className={`production-badge production-${item.productionStatus}`}>
                          {PRODUCTION_LABEL[item.productionStatus]}
                        </span>
                      )}
                      <span className="order-history-item-price">{formatReais(item.unitPrice * active)}</span>
                    </span>
                    {item.cancelledQuantity > 0 && !fullyCancelled && (
                      <span className="order-history-item-cancel-summary">
                        {item.cancelledQuantity} {item.cancelledQuantity === 1 ? "cancelada" : "canceladas"} · {active}{" "}
                        {active === 1 ? "válida" : "válidas"}
                      </span>
                    )}
                    {item.notes && <span className="order-history-item-notes">Obs.: {item.notes}</span>}
                    {item.cancellations.length > 0 && (
                      <details className="order-history-cancellations">
                        <summary>
                          {item.cancellations.length === 1 ? "Ver cancelamento" : `Ver ${item.cancellations.length} cancelamentos`}
                        </summary>
                        <ul>
                          {item.cancellations.map((c) => (
                            <li key={c.id}>
                              {c.quantity} {c.quantity === 1 ? "unidade" : "unidades"} · “{c.reason}” · {c.cancelledByName ?? "—"} ·{" "}
                              {formatOpenedFull(c.createdAt)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {showCancel && (
                      <button type="button" className="btn-secondary btn-small btn-danger-text" onClick={() => onCancelItem(item)}>
                        Cancelar item
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>
        ))
      )}
    </section>
  );
}

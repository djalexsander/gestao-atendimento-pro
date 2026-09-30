import { formatOpenedFull } from "../operations/panel";
import { formatReais } from "../../lib/money";
import { sessionTotal, sortOrdersByRecent, type SubmittedOrder } from "./ordersLogic";

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

// Pedidos já enviados da session: só leitura (sem editar/cancelar ainda), mais recente primeiro.
// Nome, preço e setor vêm dos SNAPSHOTS gravados por submit_service_order — não do catálogo
// atual (ver migration 20260928020000).
export function OrderHistory({ orders }: { orders: SubmittedOrder[] }) {
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
              {order.items.map((item) => (
                <li key={item.id}>
                  <span className="order-history-item-line">
                    {item.quantity}× {item.productNameSnapshot}
                    {item.sectorName && <span className="muted"> · {item.sectorName}</span>}
                    {order.status !== "cancelled" && (
                      <span className={`production-badge production-${item.productionStatus}`}>
                        {PRODUCTION_LABEL[item.productionStatus]}
                      </span>
                    )}
                    <span className="order-history-item-price">{formatReais(item.unitPrice * item.quantity)}</span>
                  </span>
                  {item.notes && <span className="order-history-item-notes">Obs.: {item.notes}</span>}
                </li>
              ))}
            </ul>
          </article>
        ))
      )}
    </section>
  );
}

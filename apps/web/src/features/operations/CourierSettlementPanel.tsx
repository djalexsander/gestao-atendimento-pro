import { useMemo, useRef, useState } from "react";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { formatTime, METHOD_LABEL } from "../delivery/deliveryLogic";
import {
  NOTHING_SELECTED,
  methodSummary,
  pruneSelection,
  selectAll,
  selectedByMethod,
  selectedTotal,
  toggleReceipt,
  type SettlementGroup,
  type SettlementResult,
} from "./courierSettlement";
import type { ServicePanelSource } from "./api";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

interface Props {
  companyId: string;
  groups: SettlementGroup[];
  source: ServicePanelSource;
  canVoid: boolean;
  onChanged: () => void;
  /** PT412: o Caixa precisa estar aberto para acertar. A tela pai abre o diálogo de abertura. */
  onNeedCash: () => void;
}

// Acerto de entregadores: o Caixa recebe do entregador o que ele cobrou na rua e confirma. Só aí o valor vira pagamento + movimento de caixa.
export function CourierSettlementPanel({ companyId, groups, source, canVoid, onChanged, onNeedCash }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<SettlementResult | null>(null);
  const group = groups.find((g) => g.courierUserId === openId);

  // o entregador some da lista quando o último recibo é acertado em outro aparelho: sem grupo, sem diálogo
  return (
    <section aria-label="Acerto de entregadores" data-testid="settlement-section">
      {done && (
        <div className="form-notice" role="status" data-testid="settlement-done">
          Acerto confirmado: {done.receiptCount} {done.receiptCount === 1 ? "pedido" : "pedidos"} · <strong>{formatReais(done.totalAmount)}</strong>
          {methodSummary(done.byMethod, formatReais) ? ` (${methodSummary(done.byMethod, formatReais)})` : ""}. Já entraram no caixa.
        </div>
      )}
      {groups.length === 0 ? (
        <p className="op-state" data-testid="settlement-empty">Nenhum entregador com valores a acertar.</p>
      ) : (
        <ul className="op-grid op-grid-comfy" role="list" aria-label="Entregadores com valores a acertar">
          {groups.map((g) => (
            <li key={g.courierUserId}>
              <button type="button" className="op-card op-card-delivery op-card-fin-pending" data-testid="settlement-card" aria-label={`${g.courierName}, ${g.count} pedidos, ${formatReais(g.total)} a acertar`} onClick={() => { setDone(null); setOpenId(g.courierUserId); }}>
                <span className="op-card-head"><span className="op-card-title">{g.courierName}</span></span>
                <span className="op-card-line"><span className="op-fin op-fin-custody">{g.count} {g.count === 1 ? "pedido" : "pedidos"} · aguardando acerto</span></span>
                <span className="op-card-line op-card-total"><strong>{formatReais(g.total)}</strong></span>
                <span className="op-card-line op-card-muted">{methodSummary(g.byMethod, formatReais)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {group && (
        <SettlementDialog
          key={group.courierUserId}
          companyId={companyId}
          group={group}
          source={source}
          canVoid={canVoid}
          onClose={() => setOpenId(null)}
          onSettled={(r) => { setDone(r); setOpenId(null); onChanged(); }}
          onChanged={onChanged}
          onNeedCash={onNeedCash}
        />
      )}
    </section>
  );
}

function SettlementDialog({ companyId, group, source, canVoid, onClose, onSettled, onChanged, onNeedCash }: { companyId: string; group: SettlementGroup; source: ServicePanelSource; canVoid: boolean; onClose: () => void; onSettled: (r: SettlementResult) => void; onChanged: () => void; onNeedCash: () => void }) {
  const [picked, setSelected] = useState<Set<string>>(() => selectAll(group));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // um id por TENTATIVA com a mesma seleção: repetir (rede/clique duplo) reaproveita o id e nunca duplica; mudar a seleção gera outro
  const requestId = useRef({ key: "", id: newRequestId() });

  // recibos que sumiram (acertados/anulados em outro aparelho) saem da seleção, derivado a cada render
  const selected = useMemo(() => pruneSelection(group, picked), [group, picked]);

  const total = selectedTotal(group, selected);
  const byMethod = selectedByMethod(group, selected);

  // trava síncrona: dois cliques no mesmo instante não chegam a disparar duas chamadas
  const inFlight = useRef(false);

  async function confirm() {
    if (busy || inFlight.current) return;
    if (selected.size === 0) { setError(NOTHING_SELECTED); return; }
    if (!source.settleCourier) return;
    const ids = [...selected].sort();
    const key = ids.join(",");
    if (requestId.current.key !== key) requestId.current = { key, id: newRequestId() };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await source.settleCourier(companyId, group.courierUserId, ids, requestId.current.id);
    inFlight.current = false;
    setBusy(false);
    if (r.needsCash) { onNeedCash(); return; }
    if (r.error || !r.data) { setError(r.error ?? "Não foi possível confirmar o acerto."); onChanged(); return; }
    onSettled(r.data);
  }

  async function confirmVoid(receiptId: string) {
    if (busy || !source.voidCourierReceipt) return;
    const text = reason.trim();
    if (!text) { setError("Informe o motivo da anulação."); return; }
    setBusy(true);
    setError(null);
    const r = await source.voidCourierReceipt(receiptId, text);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setVoiding(null);
    setReason("");
    onChanged();
  }

  return (
    <Modal title={`Acerto · ${group.courierName}`} onClose={onClose}>
      <div className="dl-settle" data-testid="settlement-dialog">
        <p className="muted">Confira o valor que o entregador está entregando. Só depois de confirmar ele entra no caixa.</p>
        <ul className="dl-settle-list" role="list">
          {group.receipts.map((r) => (
            <li key={r.receiptId} className="dl-settle-row" data-testid="settlement-receipt">
              <label className="dl-settle-check">
                <input type="checkbox" checked={selected.has(r.receiptId)} disabled={busy} onChange={() => { setError(null); setSelected((s) => toggleReceipt(s, r.receiptId)); }} />
                <span>
                  <strong>#{r.shortCode}</strong> · {r.customerName}
                  <span className="muted"> · {METHOD_LABEL[r.method]} · às {formatTime(r.receivedAt)}</span>
                  {r.method === "cash" && r.amountReceived !== null && r.changeAmount > 0 ? <span className="muted"> · recebeu {formatReais(r.amountReceived)}, troco {formatReais(r.changeAmount)}</span> : null}
                  {r.note ? <span className="muted"> · {r.note}</span> : null}
                </span>
              </label>
              <strong className="dl-settle-amount">{formatReais(r.amount)}</strong>
              {canVoid && voiding !== r.receiptId && (
                <button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => { setVoiding(r.receiptId); setReason(""); setError(null); }}>Anular</button>
              )}
              {voiding === r.receiptId && (
                <div className="dl-settle-void">
                  <input aria-label="Motivo da anulação" placeholder="Motivo da anulação" maxLength={200} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
                  <button type="button" className="btn-danger btn-small" disabled={busy} onClick={() => void confirmVoid(r.receiptId)}>Confirmar anulação</button>
                  <button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => setVoiding(null)}>Voltar</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="dl-settle-total" data-testid="settlement-total">
          Total a acertar: <strong>{formatReais(total)}</strong>
          {methodSummary(byMethod, formatReais) ? <span className="muted"> · {methodSummary(byMethod, formatReais)}</span> : null}
        </p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Fechar</button>
          <button type="button" className="btn-primary btn-auto" data-testid="settlement-confirm" disabled={busy || selected.size === 0} onClick={() => void confirm()}>
            {busy ? "Confirmando…" : `Confirmar acerto · ${formatReais(total)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { useMemo, useRef, useState } from "react";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { formatTime, METHOD_LABEL } from "../delivery/deliveryLogic";
import {
  NOTHING_SELECTED,
  attemptKey,
  confirmReceiptLabel,
  countedOf,
  methodSummary,
  planSettlement,
  pruneSelection,
  selectAll,
  selectedAdvance,
  selectedByMethod,
  selectedNetSales,
  selectedTotal,
  toggleReceipt,
  type CashPending,
  type SettlementGroup,
  type SettlementResult,
} from "./courierSettlement";
import { CourierCashPending } from "./CourierCashPending";
import type { ServicePanelSource } from "./api";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

interface Props {
  companyId: string;
  groups: SettlementGroup[];
  pending?: CashPending | null;
  source: ServicePanelSource;
  canVoid: boolean;
  onChanged: () => void;
  /** PT412: o Caixa precisa estar aberto para acertar. A tela pai abre o diálogo de abertura. */
  onNeedCash: () => void;
}

// Acerto de entregadores: o Caixa recebe do entregador o DINHEIRO BRUTO (venda em dinheiro + troco adiantado) e confirma.
// A venda contabilizada é só o líquido do pedido; o adiantamento devolvido compensa a saída do caixa. Diferenças exigem motivo e ficam
// como pendência rastreável até serem regularizadas.
export function CourierSettlementPanel({ companyId, groups, pending, source, canVoid, onChanged, onNeedCash }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<SettlementResult | null>(null);
  const group = groups.find((g) => g.courierUserId === openId);

  // o entregador some da lista quando o último recibo é acertado em outro aparelho: sem grupo, sem diálogo
  return (
    <section aria-label="Acerto de entregadores" data-testid="settlement-section">
      {done && (
        <div className="form-notice" role="status" data-testid="settlement-done">
          Acerto confirmado: {done.receiptCount} {done.receiptCount === 1 ? "pedido" : "pedidos"} · venda <strong>{formatReais(done.totalAmount)}</strong>
          {methodSummary(done.byMethod, formatReais) ? ` (${methodSummary(done.byMethod, formatReais)})` : ""}.
          {done.countedTotal !== null ? <> Dinheiro recebido do entregador: <strong>{formatReais(done.countedTotal)}</strong>.</> : null}
          {done.differenceTotal !== 0 ? <> Diferença de <strong>{formatReais(Math.abs(done.differenceTotal))}</strong> {done.differenceTotal > 0 ? "a regularizar (veja Pendências de troco)" : "a mais, registrada"}.</> : null}
        </div>
      )}
      {pending && <CourierCashPending pending={pending} source={source} canWriteOff={canVoid} onChanged={onChanged} onNeedCash={onNeedCash} />}
      {groups.length === 0 ? (
        <p className="op-state" data-testid="settlement-empty">Nenhum entregador com valores a acertar.</p>
      ) : (
        <ul className="op-grid op-grid-comfy" role="list" aria-label="Entregadores com valores a acertar">
          {groups.map((g) => (
            <li key={g.courierUserId}>
              <button type="button" className="op-card op-card-delivery op-card-fin-pending" data-testid="settlement-card" aria-label={`${g.courierName}, ${g.count} pedidos, ${formatReais(g.expectedTotal)} a receber do entregador`} onClick={() => { setDone(null); setOpenId(g.courierUserId); }}>
                <span className="op-card-head"><span className="op-card-title">{g.courierName}</span></span>
                <span className="op-card-line"><span className="op-fin op-fin-custody">{g.count} {g.count === 1 ? "pedido" : "pedidos"} · aguardando acerto</span></span>
                <span className="op-card-line op-card-total"><strong>{formatReais(g.expectedTotal)}</strong></span>
                <span className="op-card-line op-card-muted">
                  Venda {formatReais(g.total)}{g.advanceTotal > 0 ? ` · troco adiantado ${formatReais(g.advanceTotal)}` : ""}
                </span>
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
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // um id por TENTATIVA (mesma seleção, valores e motivos): repetir (rede/clique duplo) reaproveita o id e nunca duplica; mudar gera outro
  const requestId = useRef({ key: "", id: newRequestId() });

  // recibos que sumiram (acertados/anulados em outro aparelho) saem da seleção, derivado a cada render
  const selected = useMemo(() => pruneSelection(group, picked), [group, picked]);

  const total = selectedTotal(group, selected);
  const byMethod = selectedByMethod(group, selected);
  const advance = selectedAdvance(group, selected);
  const netSales = selectedNetSales(group, selected);
  const plan = useMemo(() => planSettlement(group, selected, counted, notes), [group, selected, counted, notes]);
  const useCash = !!source.settleCourierCash;

  // trava síncrona: dois cliques no mesmo instante não chegam a disparar duas chamadas
  const inFlight = useRef(false);

  async function confirm() {
    if (busy || inFlight.current) return;
    if (selected.size === 0) { setError(NOTHING_SELECTED); return; }
    if (plan.problem) { setError(plan.problem); return; }
    if (!source.settleCourierCash && !source.settleCourier) return;
    const key = useCash ? attemptKey(plan) : [...selected].sort().join(",");
    if (requestId.current.key !== key) requestId.current = { key, id: newRequestId() };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = useCash
      ? await source.settleCourierCash!(companyId, group.courierUserId, plan.items, requestId.current.id)
      : await source.settleCourier!(companyId, group.courierUserId, [...selected].sort(), requestId.current.id);
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

  const showMoney = useCash && (advance > 0 || group.receipts.some((r) => r.method === "cash"));

  return (
    <Modal title={`Acerto · ${group.courierName}`} onClose={onClose}>
      <div className="dl-settle" data-testid="settlement-dialog">
        <p className="muted">Confira o dinheiro que o entregador está devolvendo. Só depois de confirmar a venda entra no caixa; o troco adiantado volta para o caixa.</p>
        <ul className="dl-settle-list" role="list">
          {group.receipts.map((r) => {
            const c = countedOf(r, counted[r.receiptId]);
            const differs = !c.error && Math.round(c.value * 100) !== Math.round(r.expectedReturn * 100);
            return (
              <li key={r.receiptId} className="dl-settle-row" data-testid="settlement-receipt">
                <label className="dl-settle-check">
                  <input type="checkbox" checked={selected.has(r.receiptId)} disabled={busy} onChange={() => { setError(null); setSelected((s) => toggleReceipt(s, r.receiptId)); }} />
                  <span>
                    <strong>#{r.shortCode}</strong> · {r.customerName}
                    <span className="muted"> · {METHOD_LABEL[r.method]} · às {formatTime(r.receivedAt)}</span>
                    {r.method === "cash" && r.amountReceived !== null && r.changeAmount > 0 ? <span className="muted"> · recebeu {formatReais(r.amountReceived)}, troco {formatReais(r.changeAmount)}</span> : null}
                    {r.advanceAmount > 0 ? <span className="muted"> · troco adiantado {formatReais(r.advanceAmount)}</span> : null}
                    {r.note ? <span className="muted"> · {r.note}</span> : null}
                  </span>
                </label>
                <span className="dl-settle-amount" title="Líquido da venda">
                  <strong>{formatReais(r.netSale)}</strong>
                  {r.expectedReturn !== r.netSale ? <small className="muted"> · devolver {formatReais(r.expectedReturn)}</small> : null}
                </span>
                {useCash && selected.has(r.receiptId) && r.expectedReturn > 0 && (
                  <div className="dl-settle-void">
                    <input aria-label={`Dinheiro contado #${r.shortCode}`} inputMode="decimal" placeholder={`Contado: ${formatReais(r.expectedReturn)}`} value={counted[r.receiptId] ?? ""} disabled={busy} onChange={(e) => { setError(null); setCounted((s) => ({ ...s, [r.receiptId]: e.target.value })); }} />
                    {differs && <input aria-label={`Motivo da diferença #${r.shortCode}`} placeholder="Motivo da diferença (obrigatório)" maxLength={200} value={notes[r.receiptId] ?? ""} disabled={busy} onChange={(e) => { setError(null); setNotes((s) => ({ ...s, [r.receiptId]: e.target.value })); }} />}
                  </div>
                )}
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
            );
          })}
        </ul>
        <dl className="dl-totals" data-testid="settlement-total">
          <div><dt>Venda líquida (faturamento)</dt><dd>{formatReais(netSales || total)}</dd></div>
          {advance > 0 && <div><dt>Troco adiantado a devolver</dt><dd>{formatReais(advance)}</dd></div>}
          {showMoney && <div><dt>Dinheiro bruto esperado</dt><dd>{formatReais(plan.expectedTotal)}</dd></div>}
          {showMoney && plan.countedTotal !== plan.expectedTotal && <div><dt>Dinheiro contado</dt><dd>{formatReais(plan.countedTotal)}</dd></div>}
          {showMoney && plan.difference !== 0 && <div className="dl-total"><dt>{plan.difference > 0 ? "Falta" : "Sobra"}</dt><dd className="dl-bad">{formatReais(Math.abs(plan.difference))}</dd></div>}
        </dl>
        {methodSummary(byMethod, formatReais) ? <p className="muted">{methodSummary(byMethod, formatReais)}</p> : null}
        {plan.difference > 0 && <p className="field-hint">A falta fica registrada como pendência do entregador até ser regularizada (Pendências de troco). O caixa registra só o dinheiro que realmente entrou.</p>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Fechar</button>
          <button type="button" className="btn-primary btn-auto" data-testid="settlement-confirm" disabled={busy || selected.size === 0 || !!plan.problem} onClick={() => void confirm()}>
            {busy ? "Confirmando…" : useCash && (plan.expectedTotal > 0 || plan.countedTotal > 0) ? confirmReceiptLabel(plan.countedTotal, formatReais) : `Confirmar acerto · ${formatReais(total)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

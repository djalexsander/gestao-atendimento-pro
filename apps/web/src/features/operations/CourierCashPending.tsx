import { useRef, useState } from "react";
import { formatReais } from "../../lib/money";
import { formatTime } from "../delivery/deliveryLogic";
import { resolveProblem, returnProblem, type CashPending, type OpenDifference, type PendingReturn } from "./courierSettlement";
import type { ServicePanelSource } from "./api";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

interface Props {
  pending: CashPending;
  source: ServicePanelSource;
  canWriteOff: boolean;
  onChanged: () => void;
  /** PT412: o Caixa precisa estar aberto. A tela pai abre o diálogo de abertura. */
  onNeedCash: () => void;
}

const STATUS_NOTE: Record<string, string> = {
  canceled: "pedido cancelado",
  delivered: "pedido entregue",
  picked_up: "pedido retirado",
  out_for_delivery: "em rota",
  confirmed: "aguardando saída",
};

// Pendências financeiras do troco: nada some sozinho. Troco adiantado cuja entrega não foi acertada (cancelada/recusada/…) e diferenças
// encontradas na devolução continuam aqui até serem regularizadas (dinheiro recebido no caixa de quem confirma) ou baixadas com motivo.
export function CourierCashPending({ pending, source, canWriteOff, onChanged, onNeedCash }: Props) {
  if (pending.returns.length === 0 && pending.differences.length === 0) return null;
  return (
    <section className="dl-card-box dl-pending" aria-label="Pendências de troco dos entregadores" data-testid="cash-pending">
      <h3>Pendências de troco</h3>
      {pending.returns.length > 0 && (
        <>
          <h4 className="dl-h">Troco a devolver ao Caixa</h4>
          <ul className="dl-settle-list" role="list">
            {pending.returns.map((r) => <ReturnRow key={r.advanceId} item={r} source={source} onChanged={onChanged} onNeedCash={onNeedCash} />)}
          </ul>
        </>
      )}
      {pending.differences.length > 0 && (
        <>
          <h4 className="dl-h">Diferenças em aberto</h4>
          <ul className="dl-settle-list" role="list">
            {pending.differences.map((d) => <DifferenceRow key={d.lineId} item={d} source={source} canWriteOff={canWriteOff} onChanged={onChanged} onNeedCash={onNeedCash} />)}
          </ul>
        </>
      )}
    </section>
  );
}

function ReturnRow({ item, source, onChanged, onNeedCash }: { item: PendingReturn; source: ServicePanelSource; onChanged: () => void; onNeedCash: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef({ key: "", id: newRequestId() });
  const inFlight = useRef(false);
  const calc = returnProblem(item.amount, text, note);

  async function confirm() {
    if (busy || inFlight.current || calc.problem || !source.returnAdvance) return;
    const key = `${calc.value}|${note.trim()}`;
    if (requestId.current.key !== key) requestId.current = { key, id: newRequestId() };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await source.returnAdvance(item.advanceId, calc.value, note.trim() || null, requestId.current.id);
    inFlight.current = false;
    setBusy(false);
    if (r.needsCash) { onNeedCash(); return; }
    if (r.error) { setError(r.error); onChanged(); return; }
    setOpen(false);
    onChanged();
  }

  return (
    <li className="dl-settle-row" data-testid="pending-return">
      <span>
        <strong>#{item.shortCode}</strong> · {item.courierName} · {item.customerName}
        <span className="muted"> · {STATUS_NOTE[item.deliveryStatus] ?? item.deliveryStatus} · troco entregue às {formatTime(item.givenAt)}</span>
      </span>
      <strong className="dl-settle-amount">{formatReais(item.amount)}</strong>
      {!open && <button type="button" className="btn-secondary btn-small" onClick={() => { setOpen(true); setError(null); }}>Receber devolução</button>}
      {open && (
        <div className="dl-settle-void">
          <input aria-label="Valor devolvido" inputMode="decimal" placeholder={formatReais(item.amount)} value={text} disabled={busy} onChange={(e) => { setText(e.target.value); setError(null); }} />
          <input aria-label="Motivo da diferença" placeholder="Motivo (se devolver menos)" maxLength={200} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn-primary btn-small" disabled={busy || !!calc.problem} onClick={() => void confirm()}>{busy ? "Registrando…" : `Confirmar ${formatReais(calc.value)}`}</button>
          <button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => setOpen(false)}>Voltar</button>
          {calc.problem && (text.trim() !== "" || note.trim() !== "") && <span className="field-hint dl-bad">{calc.problem}</span>}
          {error && <span className="form-error" role="alert">{error}</span>}
        </div>
      )}
    </li>
  );
}

function DifferenceRow({ item, source, canWriteOff, onChanged, onNeedCash }: { item: OpenDifference; source: ServicePanelSource; canWriteOff: boolean; onChanged: () => void; onNeedCash: () => void }) {
  const [mode, setMode] = useState<"received" | "written_off" | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef({ key: "", id: newRequestId() });
  const inFlight = useRef(false);
  const calc = resolveProblem(item.shortfallOpen, text);

  async function confirm() {
    if (busy || inFlight.current || !source.resolveDifference || !mode) return;
    if (mode === "received" && calc.problem) return;
    if (mode === "written_off" && !note.trim()) { setError("Informe o motivo da baixa."); return; }
    const key = `${mode}|${mode === "received" ? calc.value : ""}|${note.trim()}`;
    if (requestId.current.key !== key) requestId.current = { key, id: newRequestId() };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await source.resolveDifference(item.lineId, mode, mode === "received" ? calc.value : null, note.trim() || null, requestId.current.id);
    inFlight.current = false;
    setBusy(false);
    if (r.needsCash) { onNeedCash(); return; }
    if (r.error) { setError(r.error); onChanged(); return; }
    setMode(null);
    onChanged();
  }

  return (
    <li className="dl-settle-row" data-testid="pending-difference">
      <span>
        <strong>#{item.shortCode}</strong> · {item.courierName}
        <span className="muted"> · esperado {formatReais(item.expected)}, contado {formatReais(item.counted)}{item.reason ? ` · ${item.reason}` : ""}</span>
      </span>
      <strong className="dl-settle-amount dl-bad">{formatReais(item.shortfallOpen)}</strong>
      {mode === null && (
        <span className="dl-addr-actions">
          <button type="button" className="btn-secondary btn-small" onClick={() => { setMode("received"); setError(null); }}>Receber</button>
          {canWriteOff && <button type="button" className="btn-secondary btn-small" onClick={() => { setMode("written_off"); setError(null); }}>Dar baixa</button>}
        </span>
      )}
      {mode !== null && (
        <div className="dl-settle-void">
          {mode === "received" && <input aria-label="Valor recebido" inputMode="decimal" placeholder={formatReais(item.shortfallOpen)} value={text} disabled={busy} onChange={(e) => { setText(e.target.value); setError(null); }} />}
          <input aria-label={mode === "written_off" ? "Motivo da baixa" : "Observação"} placeholder={mode === "written_off" ? "Motivo da baixa (obrigatório)" : "Observação (opcional)"} maxLength={200} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className={mode === "written_off" ? "btn-danger btn-small" : "btn-primary btn-small"} disabled={busy || (mode === "received" && !!calc.problem)} onClick={() => void confirm()}>
            {busy ? "Registrando…" : mode === "received" ? `Confirmar recebimento de ${formatReais(calc.value)}` : `Dar baixa de ${formatReais(item.shortfallOpen)}`}
          </button>
          <button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => setMode(null)}>Voltar</button>
          {mode === "received" && calc.problem && text.trim() !== "" && <span className="field-hint dl-bad">{calc.problem}</span>}
          {error && <span className="form-error" role="alert">{error}</span>}
        </div>
      )}
    </li>
  );
}

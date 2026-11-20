import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatCents } from "../../lib/money";
import { OpenCashDialog } from "./CashDialogs";
import type { CashSource } from "./cashApi";
import { PAYMENT_BUTTON_LABEL, PaymentMethodButtons } from "./PaymentMethodButtons";
import { parseDraftCents, type PaymentMethod } from "./cashLogic";
import { createAccountFinanceController, type FinanceView, type PaymentForm } from "./accountFinanceController";
import { PdvSplitEditor } from "./PdvSplitEditor";
import type { OrderItemSource } from "./splitEditorLogic";
import { partialPaymentsApi, type PartialPaymentsApi } from "./partialPaymentsApi";
import { canRefundOpenPayment, changeCents, paymentStatusLabel, suggestedPaymentCents, validateClose, type CompanyRole, type FinancialState } from "./partialPaymentsLogic";

// PDV do Caixa (v1.0.20) — coluna DIREITA "Receber" (layout do preview aprovado): resumo (total, pago, saldo pendente), partes da conta,
// cinco botões de forma (F1–F5), uma linha editável por forma (combina formas; remover antes de registrar), troco em destaque, pagamentos
// registrados e fechamento. Só muda o DESENHO e a orquestração das linhas: cada linha vira UM register_service_payment pelo MESMO
// accountFinanceController (idempotência por assinatura, resultado desconhecido, saldo desatualizado, caixa fechado) e o encerramento usa a
// mesma validateClose/close. Nenhuma regra financeira nova; o servidor decide saldo, partes e quitação.

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const MAX_LINES = 8;
const reaisText = (cents: number) => (cents > 0 ? (cents / 100).toFixed(2).replace(".", ",") : "");
const PART_TEXT = { paid: "Pago", partial: "Parcial", pending: "Pendente" } as const;

export interface PayLine { key: string; method: PaymentMethod; amountText: string; receivedText: string; partId: string | null; pristine: boolean }
let lineSeq = 0;

// Problema de preenchimento de UMA linha (texto) ou null — só o óbvio; o servidor decide.
export function lineProblem(l: PayLine): string | null {
  const a = parseDraftCents(l.amountText);
  if (a === null || a <= 0) return "Informe um valor maior que zero.";
  if (l.method === "cash" && l.receivedText.trim() !== "") {
    const r = parseDraftCents(l.receivedText);
    if (r === null) return "Valor entregue inválido.";
    if (r < a) return "O valor entregue não pode ser menor que o valor aplicado.";
  }
  return null;
}
export const lineChange = (l: PayLine): number => {
  const a = parseDraftCents(l.amountText);
  if (a === null || l.method !== "cash") return 0;
  const r = l.receivedText.trim() === "" ? a : parseDraftCents(l.receivedText);
  return r === null ? 0 : changeCents({ method: "cash", amountCents: a, receivedCents: r });
};
// Soma das linhas × saldo (e × pendente de cada parte): devolve texto de problema ou null.
export function linesProblem(lines: readonly PayLine[], st: FinancialState): string | null {
  const total = lines.reduce((s, l) => s + (parseDraftCents(l.amountText) ?? 0), 0);
  if (total > st.balanceDueCents) return `A soma das formas (${formatCents(total)}) passa do saldo pendente (${formatCents(st.balanceDueCents)}).`;
  if (st.split) {
    for (const p of st.parts) {
      const sum = lines.filter((l) => l.partId === p.partId).reduce((s, l) => s + (parseDraftCents(l.amountText) ?? 0), 0);
      if (sum > p.pendingCents) return `${p.label}: o valor (${formatCents(sum)}) passa do pendente da parte (${formatCents(p.pendingCents)}).`;
    }
  }
  return null;
}
const toForm = (l: PayLine): PaymentForm => ({ method: l.method, amountText: l.amountText, receivedText: l.method === "cash" ? l.receivedText : "", partId: l.partId, allocations: null, confirmAllocation: false });

export function PdvReceivePanel({
  sessionId,
  role,
  companyId,
  cashSource,
  api = partialPaymentsApi,
  orderItems = [],
  onClosed,
  onChanged,
  splitHost = null,
}: {
  sessionId: string;
  role: CompanyRole | null | undefined;
  companyId: string;
  cashSource: CashSource;
  api?: PartialPaymentsApi;
  orderItems?: OrderItemSource[];
  onClosed: () => void;
  onChanged?: () => void;
  splitHost?: HTMLElement | null;   // aba "Dividir conta" da coluna central
}) {
  const canRefund = canRefundOpenPayment(role);
  const ctrl = useMemo(() => createAccountFinanceController({ api, sessionId, canRefund, newId }), [api, sessionId, canRefund]);
  const [view, setView] = useState<FinanceView>(ctrl.getView());
  const [lines, setLines] = useState<PayLine[]>([]);
  const [partId, setPartId] = useState<string | null>(null);      // parte que está pagando (conta dividida)
  const [splitPending, setSplitPending] = useState(false);
  const [refund, setRefund] = useState({ paymentId: "", amountText: "", reason: "" });
  const [batchChange, setBatchChange] = useState(0);            // troco acumulado das linhas registradas na última operação (só exibição)
  const pendingLine = useRef<{ key: string; before: number } | null>(null);
  const running = useRef(false);
  const [cooling, setCooling] = useState(false);       // ~1,5 s depois de registrar: o botão virou "Fechar comanda", mas só aceita uma NOVA ação
  const lastRegisterAt = useRef(0);    // Enter repetido logo após registrar não encerra a conta sem querer (precisa de um novo Enter depois de ~1,5 s)

  useEffect(() => { const off = ctrl.subscribe(setView); void ctrl.load(); return off; }, [ctrl]);
  const onSplitApplied = useCallback((s: FinancialState | null) => ctrl.refresh(s), [ctrl]);

  const st = view.state;
  const open = st?.sessionStatus === "open";
  const split = st?.split ?? null;
  const partsOpen = useMemo(() => st?.parts.filter((p) => p.pendingCents > 0) ?? [], [st]);
  const locked = view.busy || view.unknown !== null || splitPending;
  const payAvailable = open && (st?.balanceDueCents ?? 0) > 0;
  const closeProblem = validateClose(st);

  // Parte escolhida: mantém a escolha enquanto ela tem pendente; senão, a primeira parte aberta (conta dividida) ou nenhuma.
  useEffect(() => {
    if (!split) { setPartId(null); return; }
    setPartId((cur) => (cur && partsOpen.some((p) => p.partId === cur) ? cur : partsOpen[0]?.partId ?? null));
  }, [split, partsOpen]);
  // Conta mudou por fora (outra aba/operador): descarta o que não cabe mais (linha de parte que quitou).
  useEffect(() => { setLines((cur) => cur.filter((l) => !l.partId || partsOpen.some((p) => p.partId === l.partId))); }, [partsOpen]);

  // PDV: avisa as outras colunas quando o estado financeiro muda por uma operação (não na primeira leitura).
  const changeKey = st ? `${st.paymentsCount}:${st.refundsCount}:${st.split?.version ?? 0}:${st.balanceDueCents}` : null;
  const lastChange = useRef<string | null>(null);
  useEffect(() => {
    if (changeKey === null) return;
    if (lastChange.current !== null && lastChange.current !== changeKey) onChanged?.();
    lastChange.current = changeKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeKey]);
  useEffect(() => { if (view.closed) onClosed(); }, [view.closed, onClosed]);

  // ---- linhas
  const suggestionFor = useCallback((existing: readonly PayLine[], forPart: string | null): string => {
    if (!st) return "";
    const base = suggestedPaymentCents(st, forPart);
    const used = existing.filter((l) => (l.partId ?? null) === forPart).reduce((s, l) => s + (parseDraftCents(l.amountText) ?? 0), 0);
    return reaisText(Math.max(base - used, 0));
  }, [st]);
  const addLine = useCallback((method: PaymentMethod) => {
    if (!payAvailable || locked) return;
    setBatchChange(0);
    setLines((cur) => {
      // uma única linha ainda NÃO editada: trocar a forma troca a linha (F2 depois de F1 não cria duas formas por engano)
      if (cur.length === 1 && cur[0].pristine) return [{ ...cur[0], method, receivedText: "" }];
      if (cur.length >= MAX_LINES) return cur;
      return [...cur, { key: `l${++lineSeq}`, method, amountText: suggestionFor(cur, partId), receivedText: "", partId, pristine: cur.length === 0 }];
    });
  }, [payAvailable, locked, partId, suggestionFor]);
  const edit = (key: string, patch: Partial<PayLine>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch, pristine: false } : l)));
  const removeLine = (key: string) => setLines((cur) => cur.filter((l) => l.key !== key));

  const problems = lines.map(lineProblem);
  const totalsProblem = st && lines.length > 0 ? linesProblem(lines, st) : null;
  const ready = !!st && lines.length > 0 && problems.every((p) => p === null) && !totalsProblem && payAvailable && !locked;
  const totalApplied = lines.reduce((s, l) => s + (parseDraftCents(l.amountText) ?? 0), 0);
  const totalChange = lines.reduce((s, l) => s + lineChange(l), 0);
  const methodLines = lines.filter((l) => l.method === "cash");

  // Registra as linhas EM ORDEM, uma RPC (com o seu id estável) por linha. Para na primeira que não confirmar e mantém ela e as seguintes.
  const registerAll = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBatchChange(0);
    try {
      for (const ln of [...lines]) {
        const before = ctrl.getView().state?.paymentsCount ?? 0;
        pendingLine.current = { key: ln.key, before };
        await ctrl.registerPayment(toForm(ln));
        const v = ctrl.getView();
        const done = (v.state?.paymentsCount ?? 0) > before && v.notice?.kind === "ok";
        if (!done) return;
        pendingLine.current = null;
        setBatchChange((c) => c + (v.lastPayment?.changeCents ?? 0));
        setLines((cur) => cur.filter((x) => x.key !== ln.key));
      }
    } finally {
      running.current = false; lastRegisterAt.current = Date.now();
      setCooling(true); window.setTimeout(() => setCooling(false), 1500);
    }
  }, [lines, ctrl]);
  async function retryUnknown() {
    const p = pendingLine.current;
    await ctrl.retryUnknown();
    const v = ctrl.getView();
    if (p && !v.unknown && (v.state?.paymentsCount ?? 0) > p.before) { pendingLine.current = null; setBatchChange((c) => c + (v.lastPayment?.changeCents ?? 0)); removeLine(p.key); }
  }
  async function confirmUnknown() {
    const p = pendingLine.current;
    await ctrl.confirmUnknown();
    const v = ctrl.getView();
    if (p && (v.state?.paymentsCount ?? 0) > p.before) { pendingLine.current = null; removeLine(p.key); }
  }

  // Atalhos do PDV (evento do CashierPdv): F1–F5 adicionam/trocam a forma; Enter registra as linhas VÁLIDAS ou encerra a conta quitada.
  const ref = useRef({ ready, locked, payAvailable, closeProblem, lines: lines.length, registerAll, addLine });
  ref.current = { ready, locked, payAvailable, closeProblem, lines: lines.length, registerAll, addLine };
  useEffect(() => {
    function onShortcut(e: Event) {
      const d = (e as CustomEvent<{ kind: string; method?: PaymentMethod }>).detail;
      const c = ref.current;
      if (d.kind === "method" && d.method) { c.addLine(d.method); return; }
      if (d.kind === "finalize" && !c.locked) {
        if (c.payAvailable) { if (c.ready) void c.registerAll(); }
        else if (c.lines === 0 && c.closeProblem === null && Date.now() - lastRegisterAt.current > 1500) void ctrl.close();
      }
    }
    window.addEventListener("pdv-shortcut", onShortcut);
    return () => window.removeEventListener("pdv-shortcut", onShortcut);
  }, [ctrl]);

  const refundables = view.payments.filter((p) => p.availableCents > 0);
  function submitRefund() { void ctrl.refund({ paymentId: refund.paymentId || refundables[0]?.paymentId || "", amountText: refund.amountText, reason: refund.reason }); }
  const last = view.lastPayment;
  const pendingParts = st?.parts.filter((p) => p.pendingCents > 0).length ?? 0;

  if (view.loading && !st) return <p className="op-state" role="status">Carregando a situação da conta…</p>;
  if (view.loadError && !st) return <div className="form-error" role="alert">{view.loadError} <button type="button" className="btn-secondary btn-small" onClick={() => void ctrl.load()}>Tentar de novo</button></div>;
  if (!st) return null;

  const balanceTone = st.balanceDueCents > 0 ? "pos" : "zero";
  return (
    <div className="pdv-receive" data-testid="pdv-finance">
      <div className="pdv-receive-scroll">
      {open && splitHost && createPortal(<PdvSplitEditor api={api} sessionId={sessionId} state={st} orderItems={orderItems} disabled={view.busy || view.unknown !== null} onApplied={onSplitApplied} onPendingChange={setSplitPending} />, splitHost)}

      <div className="pdv-sum" data-testid="fin-summary">
        <div><span>Total da conta</span><b data-testid="fin-total">{formatCents(st.totalCents)}</b></div>
        <div><span>Pago até agora</span><b className="pdv-ok" data-testid="fin-received">{formatCents(st.settledPaidCents)}</b></div>
        <div><span>Saldo pendente</span><span className={`pdv-pend pdv-pend-${balanceTone}`} data-testid="fin-balance">{formatCents(st.balanceDueCents)}</span></div>
        <div><span className={`pdv-chip ${st.paymentStatus === "paid" ? "pdv-chip-ok" : st.paymentStatus === "partial" ? "pdv-chip-warn" : ""}`} data-testid="fin-status">{paymentStatusLabel(st.paymentStatus)}</span></div>
      </div>
      {st.overpaidCents > 0 && <div className="form-error">A conta recebeu {formatCents(st.overpaidCents)} a mais que o total. Estorne o excedente antes de encerrar.</div>}
      {split && ((st.overDistributedCents ?? 0) > 0 || (st.undistributedCents ?? 0) > 0) && <div className="form-error">A divisão está desatualizada em relação ao consumo. Refaça a divisão antes de receber ou encerrar.</div>}

      {split && (
        <>
          <div className="pdv-sec">Partes da conta ({st.parts.length})</div>
          <div className="pdv-shares" data-testid="pdv-shares">
            {st.parts.map((p) => (
              <div key={p.partId} className={`pdv-share${partId === p.partId ? " pdv-share-on" : ""}`} data-part={p.partId}>
                <span className="pdv-share-name">{p.label} <span className={`pdv-chip ${p.status === "paid" ? "pdv-chip-ok" : p.status === "partial" ? "pdv-chip-warn" : ""}`}>{PART_TEXT[p.status]}</span></span>
                <button type="button" className="btn-secondary btn-small" disabled={locked || !payAvailable || p.pendingCents <= 0} aria-pressed={partId === p.partId} onClick={() => setPartId(p.partId)}>{partId === p.partId ? "Recebendo" : "Receber parte"}</button>
                <span className="pdv-share-sub">Parte {formatCents(p.plannedCents)} · pago {formatCents(p.paidCents)} · pendente {formatCents(p.pendingCents)}</span>
              </div>
            ))}
          </div>
          <div className="pdv-sum pdv-sum-mini">
            <div><span>Pagamentos realizados</span><b>{st.paymentsCount}</b></div>
            <div><span>Partes pendentes</span><b>{pendingParts}</b></div>
          </div>
        </>
      )}

      {view.notice && <div className={view.notice.kind === "error" ? "form-error" : "form-notice"} role={view.notice.kind === "error" ? "alert" : "status"} data-testid="fin-notice">{view.notice.text}</div>}
      {view.unknown && (
        <div className="form-error" role="alert" data-testid="fin-unknown">
          <p>{view.unknown.text}</p>
          <div className="modal-actions">
            <button type="button" className="btn-primary btn-auto" disabled={view.busy} onClick={() => void retryUnknown()} data-testid="fin-retry">Reenviar o mesmo pedido</button>
            <button type="button" className="btn-secondary" disabled={view.busy} onClick={() => void confirmUnknown()} data-testid="fin-check">Já conferi: atualizar situação</button>
          </div>
        </div>
      )}
      {batchChange > 0 && lines.length === 0 && !view.unknown && (
        <div className="pdv-change pdv-change-big" data-testid="fin-last-change"><span>Troco a devolver ao cliente</span><b>{formatCents(batchChange)}</b></div>
      )}
      {last && !view.unknown && (
        <p className="field-hint" data-testid="fin-last">
          Último pagamento ({last.methodLabel}): aplicado {formatCents(last.appliedCents)}
          {last.receivedCents !== null && <> · entregue {formatCents(last.receivedCents)} · troco {formatCents(last.changeCents)}</>}
        </p>
      )}

      {payAvailable && (
        <>
          <div className="pdv-sec">Forma de pagamento{split && partId ? ` · ${st.parts.find((p) => p.partId === partId)?.label ?? ""}` : ""}</div>
          <PaymentMethodButtons value={lines.length ? lines[lines.length - 1].method : null} onSelect={addLine} disabled={locked} />
          {lines.length === 0 && (
            <p className="field-hint pdv-hint" data-testid="fin-no-method">
              Nenhuma forma selecionada. Ao escolher F1–F5, o valor pendente {split && partId ? "da parte" : "da conta"} é <strong>sugerido</strong> ({formatCents(suggestedPaymentCents(st, partId)) }) e pode ser editado. Só vale depois de registrar. Escolha outra forma para combinar formas.
            </p>
          )}
          {lines.length > 0 && (
            <form id="pdv-lines-form" className="pdv-lines" data-testid="pdv-lines" onSubmit={(e) => { e.preventDefault(); if (ready) void registerAll(); }}>
              {lines.map((l, i) => (
                <div className="pdv-line" key={l.key} data-testid="pdv-line" data-method={l.method}>
                  <div className="pdv-line-head">
                    <b>{PAYMENT_BUTTON_LABEL[l.method]}</b>
                    {l.partId && <span className="pdv-chip">{st.parts.find((p) => p.partId === l.partId)?.label}</span>}
                    {l.pristine && <span className="pdv-chip pdv-chip-warn" data-testid="fin-suggested">Valor sugerido — ainda não registrado</span>}
                    <button type="button" className="pdv-x" aria-label={`Remover ${PAYMENT_BUTTON_LABEL[l.method]}`} disabled={locked} onClick={() => removeLine(l.key)}>×</button>
                  </div>
                  <div className={l.method === "cash" ? "pdv-line-fields pdv-line-fields-2" : "pdv-line-fields"}>
                    <label>Valor aplicado à conta
                      <input id={`fin-amount-${i}`} inputMode="decimal" autoComplete="off" placeholder="0,00" value={l.amountText} disabled={locked} onChange={(e) => edit(l.key, { amountText: e.target.value })} />
                    </label>
                    {l.method === "cash" && (
                      <label>Valor entregue pelo cliente
                        <input id={`fin-received-${i}`} inputMode="decimal" autoComplete="off" placeholder={l.amountText || "0,00"} value={l.receivedText} disabled={locked} onChange={(e) => edit(l.key, { receivedText: e.target.value })} />
                      </label>
                    )}
                  </div>
                  {l.method === "cash" && <div className="pdv-line-change" data-testid="fin-change">Troco desta linha: <b>{formatCents(lineChange(l))}</b></div>}
                  {problems[i] && l.amountText.trim() !== "" && <div className="field-error">{problems[i]}</div>}
                </div>
              ))}
              {methodLines.length > 0 && (
                <div className={`pdv-change${totalChange > 0 ? " pdv-change-big" : ""}`} data-testid="fin-change-total"><span>Troco a devolver</span><b>{formatCents(totalChange)}</b></div>
              )}
              {totalsProblem && <div className="field-error" data-testid="fin-lines-problem">{totalsProblem}</div>}
              <div className="pdv-line-sum"><span>Aplicado nesta operação</span><b>{formatCents(totalApplied)}</b><span>Restará</span><b>{formatCents(Math.max(st.balanceDueCents - totalApplied, 0))}</b></div>
              <div className="pdv-line-actions">
                <button type="button" className="btn-secondary" disabled={locked} onClick={() => setLines([])}>Descartar</button>
              </div>
            </form>
          )}
        </>
      )}

      {canRefund && open && (
        <>
          {view.payments.length > 0 && (
            <>
              <div className="pdv-sec">Pagamentos registrados</div>
              <div className="pdv-paid" data-testid="pdv-paid">
                {view.payments.map((p) => (
                  <div className="pdv-paid-row" key={p.paymentId}><b>{PAYMENT_BUTTON_LABEL[p.method]}</b><span className="muted">{p.refundedCents > 0 ? `estornado ${formatCents(p.refundedCents)}` : ""}</span><b>{formatCents(p.amountCents)}</b></div>
                ))}
              </div>
            </>
          )}
          {refundables.length > 0 && (
            <details className="pdv-refund" data-testid="fin-refund-form">
              <summary>Estornar pagamento (correção)</summary>
              <div className="pdv-line-fields">
                <label>Pagamento
                  <select id="fin-refund-pay" value={refund.paymentId || refundables[0].paymentId} disabled={locked}
                    onChange={(e) => { const p = refundables.find((x) => x.paymentId === e.target.value); setRefund((r) => ({ ...r, paymentId: e.target.value, amountText: p ? reaisText(p.availableCents) : "" })); }}>
                    {refundables.map((p) => <option key={p.paymentId} value={p.paymentId}>{PAYMENT_BUTTON_LABEL[p.method]} — {formatCents(p.amountCents)} (estornável {formatCents(p.availableCents)})</option>)}
                  </select>
                </label>
                <label>Valor a estornar<input inputMode="decimal" placeholder="0,00" value={refund.amountText} disabled={locked} onChange={(e) => setRefund((r) => ({ ...r, amountText: e.target.value }))} /></label>
                <label>Motivo (obrigatório)<input maxLength={200} value={refund.reason} disabled={locked} onChange={(e) => setRefund((r) => ({ ...r, reason: e.target.value }))} /></label>
                <button type="button" className="btn-secondary" disabled={locked} onClick={submitRefund} data-testid="fin-refund-submit">Estornar</button>
              </div>
            </details>
          )}
        </>
      )}

      </div>

      {open && (
        <div className="pdv-foot">
          {/* UM botão principal: com saldo pendente = "Registrar pagamento" (registra só as linhas válidas; nunca fecha); com saldo zero e sem
              operação pendente = "Fechar comanda" (close_settled_service_session), sempre por uma SEGUNDA ação explícita do operador. */}
          {payAvailable ? (
            <button type="submit" form="pdv-lines-form" className="btn-primary pdv-submit" disabled={!ready} data-testid="fin-pay-submit" data-mode="register">
              <span>{view.busy ? "Registrando…" : lines.length > 1 ? `Registrar ${lines.length} pagamentos` : "Registrar pagamento"}</span><kbd className="pay-submit-key">Enter</kbd>
            </button>
          ) : (
            <button type="button" className="btn-primary pdv-submit" disabled={locked || cooling || closeProblem !== null || lines.length > 0} title={closeProblem ?? undefined} onClick={() => { if (!cooling) void ctrl.close(); }} data-testid="fin-close" data-mode="close">
              <span>{view.busy ? "Fechando…" : "Fechar comanda"}</span><kbd className="pay-submit-key">Enter</kbd>
            </button>
          )}
          <div className="pdv-foot-hint muted" data-testid="fin-close-hint">
            {payAvailable ? (lines.length === 0 ? (st.paymentsCount > 0 ? `Saldo pendente ${formatCents(st.balanceDueCents)} — a comanda permanece aberta.` : "Escolha a forma de pagamento (F1–F5) para registrar.") : ready ? "Enter registra os pagamentos acima; a comanda só fecha com saldo zerado." : "Corrija os valores acima para registrar.")
              : closeProblem === null ? "Quitada. Feche a comanda para liberar a mesa."
              : closeProblem}
          </div>
        </div>
      )}

      {view.needsCash && (
        <OpenCashDialog source={cashSource} companyId={companyId} notice="Abra o caixa antes de registrar o pagamento." onOpened={() => ctrl.cashOpened()} onClose={() => ctrl.dismissNeedsCash()} />
      )}
    </div>
  );
}

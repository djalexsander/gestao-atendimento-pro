import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtCompetence, fmtDateTimeSP } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import { CourtesyUnavailableNotice } from "./CourtesyAttentionPanel";
import { ConvertCourtesyDialog, EndCourtesyDialog, RequestConversionDialog } from "./CourtesyActionDialogs";
import { ExtendCourtesyDialog, GrantCourtesyDialog, type DoneInfo } from "./CourtesyDialogs";
import { bridgeHoursFromEvents, canStartContract, conversionPlan, isOpenCourtesy, preservedNotice, preservedWindow, type PreservedWindow, type SubInfo } from "./courtesyActionLogic";
import { canExtend, EXPIRY_NOTICE } from "./courtesyFormLogic";
import {
  courtesyUnavailable,
  markCourtesyUnavailable,
  getCompanyBridges,
  getCourtesyDetail,
  listCompanyCourtesies,
  listCourtesyBilling,
  resetCourtesyAvailability,
  type CourtesyResult,
} from "./courtesyApi";
import {
  BRIDGE_ACTIVE_WARNING,
  BRIDGE_STATE_TEXT,
  BRIDGE_STATE_TONE,
  COURTESY_STATE_TEXT,
  COURTESY_STATE_TONE,
  EVENT_TEXT,
  eventDetail,
  fmtRemaining,
  itemLabel,
  SCOPE_TEXT,
  type BillingRecord,
  type BridgeItem,
  type Courtesy,
  type CourtesyDetail,
} from "./courtesyLogic";
import { Badge } from "./MasterBits";

interface Named {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
type Load<T> = { phase: "loading" } | { phase: "unavailable" } | { phase: "error"; error: string } | { phase: "ok"; data: T };

function toLoad<T>(r: CourtesyResult<T>): Load<T> {
  return r.status === "ok" ? { phase: "ok", data: r.data } : r.status === "unavailable" ? { phase: "unavailable" } : { phase: "error", error: r.error };
}

/** Seção "Cortesias" do detalhe da empresa: consulta + conceder/prorrogar (únicas escritas: master_grant_courtesy e master_extend_courtesy). */
export function CompanyCourtesies({ companyId, companyName, plans, modules, reservedPlanCode, subscription, onStartContract }: { companyId: string; companyName: string; plans: Named[]; modules: Named[]; reservedPlanCode: string | null; subscription: SubInfo | null; onStartContract?: (planId: string) => void }) {
  const [courtesies, setCourtesies] = useState<Load<Courtesy[]>>({ phase: "loading" });
  const [bridges, setBridges] = useState<Load<BridgeItem[]>>({ phase: "loading" });
  const [billing, setBilling] = useState<Load<BillingRecord[]>>({ phase: "loading" });
  const [showClosed, setShowClosed] = useState(false);
  const [version, setVersion] = useState(0);
  const [grantOpen, setGrantOpen] = useState(false);
  const [extendTarget, setExtendTarget] = useState<Courtesy | null>(null);
  const [action, setAction] = useState<{ kind: "end" | "request" | "convert"; courtesy: Courtesy } | null>(null);
  const [done, setDone] = useState<DoneInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // sequencial: se a primeira chamada descobrir que o recurso não existe, as demais nem saem
      const c = await listCompanyCourtesies(companyId, showClosed);
      if (cancelled) return;
      setCourtesies(toLoad(c));
      if (c.status === "unavailable") {
        setBridges({ phase: "unavailable" });
        setBilling({ phase: "unavailable" });
        return;
      }
      const [b, f] = await Promise.all([getCompanyBridges(companyId), listCourtesyBilling(companyId)]);
      if (cancelled) return;
      setBridges(toLoad(b));
      setBilling(toLoad(f));
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, showClosed, version]);

  const reload = (resetAvailability: boolean) => {
    if (resetAvailability) resetCourtesyAvailability();
    setCourtesies({ phase: "loading" });
    setBridges({ phase: "loading" });
    setBilling({ phase: "loading" });
    setVersion((v) => v + 1);
  };
  const retry = () => reload(true);

  // F1: só se afirma com dados reais já lidos (assinatura, cortesias abertas e a consulta de pontes OK sem ponte ativa)
  const preserved = courtesies.phase === "ok" && bridges.phase === "ok" ? preservedWindow(courtesies.data, subscription, bridges.data) : null;
  const unavailable = courtesies.phase === "unavailable" || (courtesyUnavailable() && courtesies.phase !== "ok");
  const list = courtesies.phase === "ok" ? courtesies.data : [];

  // as RPCs de escrita também podem descobrir que o recurso não existe: nada foi gravado e os botões ficam desabilitados
  const onUnavailable = () => {
    markCourtesyUnavailable();
    setGrantOpen(false);
    setExtendTarget(null);
    setAction(null);
    setCourtesies({ phase: "unavailable" });
  };
  const onDone = (info: DoneInfo) => {
    setGrantOpen(false);
    setExtendTarget(null);
    setAction(null);
    setDone(info);
    reload(false); // atualiza as consultas depois do sucesso
  };

  if (unavailable) {
    return (
      <section className="mst-card mst-courtesy" aria-label="Cortesias da empresa">
        <div className="mst-head">
          <h3>Cortesias</h3>
          <button type="button" className="btn-secondary court-grant-btn" disabled aria-disabled="true" title="Recurso ainda não disponível neste ambiente">
            Conceder cortesia
          </button>
        </div>
        <CourtesyUnavailableNotice onRetry={retry} />
      </section>
    );
  }

  return (
    <section className="mst-card mst-courtesy" aria-label="Cortesias da empresa">
      <div className="mst-head">
        <h3>Cortesias</h3>
        <button type="button" className="btn-primary court-grant-btn" onClick={() => { setDone(null); setGrantOpen(true); }} disabled={courtesies.phase === "loading"}>
          Conceder cortesia
        </button>
        <label className="mst-check">
          <input type="checkbox" checked={showClosed} onChange={(e) => { setCourtesies({ phase: "loading" }); setShowClosed(e.target.checked); }} /> Mostrar encerradas e convertidas
        </label>
      </div>
      <p className="court-notice" role="note">
        {EXPIRY_NOTICE}
      </p>
      {done && (
        <div className={`court-done court-done-${done.tone}`} role="status">
          {done.text}
          {done.warnings.length > 0 && (
            <ul>
              {done.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {preserved && <PreservedNoticeBox window={preserved} plans={plans} modules={modules} subscriptionPlanId={subscription?.planId ?? null} />}
      <BridgeList state={bridges} />

      {courtesies.phase === "loading" && <p>Carregando cortesias…</p>}
      {courtesies.phase === "error" && (
        <div className="form-error">
          {courtesies.error}{" "}
          <button type="button" className="btn-link" onClick={() => reload(false)}>
            Tentar novamente
          </button>
        </div>
      )}
      {courtesies.phase === "ok" && courtesies.data.length === 0 && <p className="mst-sub">Nenhuma cortesia {showClosed ? "registrada" : "aberta"} para esta empresa.</p>}
      {courtesies.phase === "ok" && courtesies.data.length > 0 && (
        <ul className="mst-court-list">
          {courtesies.data.map((c) => (
            <CourtesyCard
              key={c.id}
              courtesy={c}
              plans={plans}
              modules={modules}
              sub={subscription}
              onExtend={canExtend(c) ? () => { setDone(null); setExtendTarget(c); } : undefined}
              onEnd={isOpenCourtesy(c) ? () => { setDone(null); setAction({ kind: "end", courtesy: c }); } : undefined}
              onRequest={isOpenCourtesy(c) && !c.conversion_requested_at && !c.conversion_authorized_at ? () => { setDone(null); setAction({ kind: "request", courtesy: c }); } : undefined}
              onConvert={isOpenCourtesy(c) ? () => { setDone(null); setAction({ kind: "convert", courtesy: c }); } : undefined}
              onStartContract={canStartContract(c, subscription) && c.plan_id && onStartContract ? () => onStartContract(c.plan_id as string) : undefined}
            />
          ))}
        </ul>
      )}

      <BillingList state={billing} />

      {grantOpen && (
        <GrantCourtesyDialog
          companyId={companyId}
          companyName={companyName}
          plans={plans}
          modules={modules}
          reservedPlanCode={reservedPlanCode}
          open={list}
          onClose={() => setGrantOpen(false)}
          onDone={onDone}
          onUnavailable={onUnavailable}
        />
      )}
      {action?.kind === "end" && <EndCourtesyDialog courtesy={action.courtesy} itemName={itemLabel(action.courtesy, plans, modules)} sub={subscription} onClose={() => setAction(null)} onDone={onDone} onUnavailable={onUnavailable} />}
      {action?.kind === "request" && <RequestConversionDialog courtesy={action.courtesy} itemName={itemLabel(action.courtesy, plans, modules)} onClose={() => setAction(null)} onDone={onDone} onUnavailable={onUnavailable} />}
      {action?.kind === "convert" && (
        <ConvertCourtesyDialog courtesy={action.courtesy} itemName={itemLabel(action.courtesy, plans, modules)} plan={conversionPlan(action.courtesy, subscription)} onClose={() => setAction(null)} onDone={onDone} onUnavailable={onUnavailable} />
      )}
      {extendTarget && (
        <ExtendCourtesyDialog courtesy={extendTarget} itemName={itemLabel(extendTarget, plans, modules)} onClose={() => setExtendTarget(null)} onDone={onDone} onUnavailable={onUnavailable} />
      )}
    </section>
  );
}

/** F1 (migration 20261121010000): cortesia original preservada enquanto outro plano aguarda pagamento. Sem prazo de ponte. */
export function PreservedNoticeBox({ window: w, plans, modules, subscriptionPlanId }: { window: PreservedWindow; plans: Named[]; modules: Named[]; subscriptionPlanId: string | null }) {
  const pendingPlan = plans.find((p) => p.id === (subscriptionPlanId ?? w.pendingPlanId))?.name ?? "plano contratado";
  const n = preservedNotice(w, { pendingPlan, courtesyItem: itemLabel(w.courtesy, plans, modules) });
  return (
    <div className="court-preserved" role="status" aria-label="Cortesia original preservada">
      <h4>{n.title}</h4>
      {n.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function BridgeList({ state }: { state: Load<BridgeItem[]> }) {
  if (state.phase !== "ok" || state.data.length === 0) {
    return state.phase === "error" ? <div className="form-error">{state.error}</div> : null;
  }
  return (
    <div className="mst-court-bridges">
      <h4>Pontes de pagamento (Pix)</h4>
      <ul className="mst-court-list">
        {state.data.map((b) => (
          <li key={b.bridge_id} className="mst-court-item">
            <div className="mst-court-top">
              <strong>Ponte de acesso temporário</strong>
              <Badge tone={BRIDGE_STATE_TONE[b.state]}>{BRIDGE_STATE_TEXT[b.state]}</Badge>
            </div>
            <dl className="mst-dl">
              <dt>Início</dt>
              <dd>{fmtDateTimeSP(b.starts_at)}</dd>
              <dt>Prazo</dt>
              <dd>
                {fmtDateTimeSP(b.until_at)} ({b.hours} h)
                {b.state === "active" && <strong> — restam {fmtRemaining(b.remaining_minutes)}</strong>}
              </dd>
              <dt>Fatura inicial</dt>
              <dd>
                {b.invoice_status === "paid" ? "Paga" : b.invoice_status === "overdue" ? "Vencida" : b.invoice_status === "void" ? "Anulada" : "Em aberto"} ·{" "}
                <Link to={`/master/faturas/${b.invoice_id}`}>ver fatura</Link>
              </dd>
            </dl>
            {b.state === "active" && <p className="mst-court-warn" role="note">{BRIDGE_ACTIVE_WARNING}</p>}
            {b.state === "expired" && <p className="mst-court-warn">Prazo encerrado sem pagamento: a empresa voltou ao bloqueio normal de assinatura aguardando pagamento.</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CourtesyCard({
  courtesy: c,
  plans,
  modules,
  sub,
  onExtend,
  onEnd,
  onRequest,
  onConvert,
  onStartContract,
}: {
  courtesy: Courtesy;
  plans: Named[];
  modules: Named[];
  sub: SubInfo | null;
  onExtend?: () => void;
  onEnd?: () => void;
  onRequest?: () => void;
  onConvert?: () => void;
  onStartContract?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Load<CourtesyDetail> | null>(null);
  const [bridgeHours, setBridgeHours] = useState<number | null>(null);
  const conv = conversionPlan(c, sub);
  const authorizedOpen = !!c.conversion_authorized_at && isOpenCourtesy(c);

  // prazo da ponte registrado na autorização (vem do histórico; uma consulta por cortesia autorizada e aberta)
  useEffect(() => {
    if (!authorizedOpen) return;
    let cancelled = false;
    (async () => {
      const r = await getCourtesyDetail(c.id);
      if (!cancelled && r.status === "ok") setBridgeHours(bridgeHoursFromEvents(r.data.events));
    })();
    return () => {
      cancelled = true;
    };
  }, [c.id, authorizedOpen]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && detail === null) {
      setDetail({ phase: "loading" });
      setDetail(toLoad(await getCourtesyDetail(c.id)));
    }
  };

  const days = c.days_remaining;
  return (
    <li className="mst-court-item">
      <div className="mst-court-top">
        <strong>{itemLabel(c, plans, modules)}</strong>
        <Badge tone={COURTESY_STATE_TONE[c.effective_state]}>{COURTESY_STATE_TEXT[c.effective_state]}</Badge>
        <Badge tone="muted">{SCOPE_TEXT[c.scope]}</Badge>
      </div>
      <dl className="mst-dl">
        <dt>Período</dt>
        <dd>
          {fmtDateTimeSP(c.starts_at)} até {fmtDateTimeSP(c.ends_at)}
          {days !== null && c.effective_state === "active" && ` — ${days <= 0 ? "vence hoje" : `${days} dia(s) restante(s)`}`}
        </dd>
        <dt>Motivo</dt>
        <dd>{c.reason}</dd>
        <dt>Preço de referência</dt>
        <dd>{c.reference_price_cents > 0 ? `${formatCents(c.reference_price_cents)}/mês (não cobrado enquanto aberta)` : "—"}</dd>
        {c.conversion_requested_at && (
          <>
            <dt>Pedido de conversão</dt>
            <dd>
              {fmtDateTimeSP(c.conversion_requested_at)}
              {c.conversion_note ? ` — ${c.conversion_note}` : ""}
            </dd>
          </>
        )}
        {c.conversion_authorized_at && (
          <>
            <dt>Conversão autorizada</dt>
            <dd>{fmtDateTimeSP(c.conversion_authorized_at)}</dd>
          </>
        )}
        {c.closed_at && (
          <>
            <dt>{c.status === "converted" ? "Convertida em" : "Encerrada em"}</dt>
            <dd>
              {fmtDateTimeSP(c.closed_at)}
              {c.close_note ? ` — ${c.close_note}` : ""}
            </dd>
          </>
        )}
        {c.billing_starts_competence && (
          <>
            <dt>Cobrança volta em</dt>
            <dd>{fmtCompetence(c.billing_starts_competence)}</dd>
          </>
        )}
      </dl>
      <div className="mst-actions court-card-actions">
        {onExtend && (
          <button type="button" className="btn-secondary" onClick={onExtend}>
            Prorrogar
          </button>
        )}
        {onRequest && (
          <button type="button" className="btn-secondary" onClick={onRequest}>
            Solicitar conversão
          </button>
        )}
        {onConvert && conv.mode !== "blocked" && (
          <button type="button" className="btn-secondary" onClick={onConvert}>
            {conv.label}
          </button>
        )}
        {onStartContract && (
          <button type="button" className="btn-primary" onClick={onStartContract}>
            Contratar plano…
          </button>
        )}
        {onEnd && (
          <button type="button" className="btn-secondary court-end-btn" onClick={onEnd}>
            Encerrar
          </button>
        )}
        <button type="button" className="btn-link" aria-expanded={open} onClick={toggle}>
          {open ? "Ocultar histórico" : "Ver histórico"}
        </button>
      </div>
      {authorizedOpen && (
        <p className="court-hint" role="note">
          Conversão autorizada: <strong>não criou assinatura, fatura, Pix nem cobrança</strong>; o acesso segue pela cortesia.
          {bridgeHours ? ` Ao contratar, a ponte de acesso dura ${bridgeHours} h (definido na autorização).` : ""}
          {onStartContract ? " A contratação paga usa o formulário existente \"Contratar plano\"." : ""}
        </p>
      )}
      {onConvert && conv.mode === "blocked" && !authorizedOpen && <p className="court-hint">{conv.hint}</p>}
      {open && detail && (
        <div className="mst-court-history">
          {detail.phase === "loading" && <p>Carregando histórico…</p>}
          {detail.phase === "unavailable" && <CourtesyUnavailableNotice />}
          {detail.phase === "error" && <div className="form-error">{detail.error}</div>}
          {detail.phase === "ok" && (
            <>
              {detail.data.created_by_email && <p className="mst-sub">Concedida por {detail.data.created_by_email}.</p>}
              {detail.data.events.length === 0 ? (
                <p className="mst-sub">Sem eventos registrados.</p>
              ) : (
                <ol className="mst-court-events">
                  {detail.data.events.map((e) => (
                    <li key={e.seq}>
                      <strong>{EVENT_TEXT[e.event_type] ?? e.event_type}</strong> · {fmtDateTimeSP(e.created_at)} · {e.actor_email ?? "sistema (ciclo diário)"}
                      {eventDetail(e) && <small className="mst-cell-sub">{eventDetail(e)}</small>}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function BillingList({ state }: { state: Load<BillingRecord[]> }) {
  if (state.phase === "error") return <div className="form-error">{state.error}</div>;
  if (state.phase !== "ok" || state.data.length === 0) return null;
  return (
    <div className="mst-court-billing">
      <h4>Isenções aplicadas na cobrança</h4>
      <div className="mst-scroll">
        <table className="mst-table">
          <thead>
            <tr>
              <th>Competência</th>
              <th>Item</th>
              <th className="mst-num">Valor isento</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {state.data.map((r) => (
              <tr key={r.id}>
                <td>{fmtCompetence(r.competence)}</td>
                <td>{r.description}</td>
                <td className="mst-num">{formatCents(r.waived_cents)}</td>
                <td>
                  {r.outcome === "waived_no_invoice" ? (
                    "Competência isenta, sem fatura"
                  ) : (
                    <>
                      Desconto na fatura{r.invoice_id ? <> · <Link to={`/master/faturas/${r.invoice_id}`}>ver</Link></> : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mst-sub">Fatura emitida nunca é alterada; o desconto aparece como item separado.</p>
    </div>
  );
}


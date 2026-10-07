import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../app/useAuth";
import {
  supabaseCommercialSource,
  type BillingState,
  type TenantInvoice,
} from "../features/commercial/commercialApi";
import {
  INVOICE_KIND_TEXT,
  INVOICE_STATUS_TEXT,
  TRIAL_CHOOSE_HINT,
  currentInvoice,
  moduleCards,
  monthlySituation,
  needsPayment,
  pageAlertFor,
  pendingSelection,
  pickContractPlan,
  planChip,
  type Catalog,
} from "../features/commercial/commercialLogic";
import { ModulesPanel } from "../features/commercial/ModulesPanel";
import { PaymentPanel } from "../features/commercial/PaymentPanel";
import { PendingAdditionCard } from "../features/commercial/PendingAdditionCard";
import { PendingChangeCard } from "../features/commercial/PendingChangeCard";
import { SubscribePanel } from "../features/commercial/SubscribePanel";
import { useCommercial } from "../features/commercial/CommercialProvider";
import { fmtCompetence, fmtDateOnly } from "../lib/dates";
import { formatCents } from "../lib/money";

const REFRESH_MS = 15_000;
const source = supabaseCommercialSource;

// Configurações → Meus Planos: autogestão comercial da PRÓPRIA empresa (o Master é outra interface). Sempre acessível,
// inclusive em pending_payment/restricted/trial expirado (as RPCs usadas não têm barreira de escrita).
// OWNER: contrata, vê módulos, paga e consulta faturas. ADMIN: só consulta plano, módulos, status e faturas.
export function MyPlansPage() {
  const { activeCompanyId, activeMembership } = useAuth();
  const { info, refresh } = useCommercial();
  const isOwner = activeMembership?.role === "owner";
  const isAdmin = activeMembership?.role === "admin";
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [invoices, setInvoices] = useState<TenantInvoice[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [editRequest, setEditRequest] = useState<{ ids: string[]; nonce: number } | null>(null);

  const load = useCallback(async () => {
    if (!activeCompanyId || !(isOwner || isAdmin)) return;
    const [b, i] = await Promise.all([source.getBillingState(activeCompanyId), source.listInvoices(activeCompanyId)]);
    if (b.error !== null) setError(b.error);
    else {
      setBilling(b.data);
      setError(null);
    }
    if (i.error === null) setInvoices(i.data);
  }, [activeCompanyId, isOwner, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeCompanyId || !(isOwner || isAdmin)) return;
    let cancelled = false;
    void source.getCatalog(activeCompanyId).then((r) => {
      if (!cancelled && r.error === null) setCatalog(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, isOwner, isAdmin]);

  // Refresh controlado: a cada 15s (aba visível) e ao voltar para a aba. Pagamento confirmado => fatura paga, assinatura
  // ativa, banner some e a escrita volta sem novo login.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      setNow(new Date());
      void load();
      void refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, refresh]);

  const sub = billing?.subscription ?? null;
  const plan = useMemo(() => (catalog ? pickContractPlan(catalog) : null), [catalog]);
  const pendingAddition = billing?.pending_module_addition ?? null;
  const pendingRemoval = billing?.pending_change ?? null;
  const cards = useMemo(
    () =>
      catalog
        ? moduleCards(
            catalog,
            sub,
            pendingAddition ? pendingAddition.modules.map((m) => m.module_id) : [],
            pendingRemoval ? pendingRemoval.removed.map((m) => m.module_id) : [],
          )
        : [],
    [catalog, sub, pendingAddition, pendingRemoval],
  );
  const current = useMemo(() => currentInvoice(invoices), [invoices]);
  const alert = pageAlertFor(info, now);
  const chip = planChip(info?.state ?? (billing?.access_state as never));
  const canContract = isOwner && !!billing && !sub;
  const payInvoiceId = payingId ?? (isOwner && alert?.emphasizePay && current ? current.id : null);
  const state = info?.state ?? null;

  if (!activeCompanyId) return <p className="muted">Nenhuma empresa ativa.</p>;
  if (!isOwner && !isAdmin) {
    return (
      <div>
        <div className="page-header"><h2>Meus Planos</h2></div>
        <p className="muted">Somente o proprietário e o administrador da empresa acessam esta área.</p>
      </div>
    );
  }

  const trialDays = billing?.trial?.trial_ends_at && state === "trial"
    ? Math.max(0, Math.ceil((new Date(billing.trial.trial_ends_at).getTime() - now.getTime()) / 86_400_000))
    : null;

  return (
    <div className="myplans-page">
      <div className="page-header"><h2>Meus Planos</h2></div>
      {error && <div className="form-error">{error}</div>}
      {alert && <div className={`commercial-banner commercial-banner-${alert.tone}`} role="status"><span>{alert.text}</span></div>}
      {isAdmin && <p className="field-hint">Você pode consultar o plano, os módulos e as faturas. Somente o proprietário contrata, altera e paga.</p>}

      <section className="overview-grid" aria-label="Visão geral">
        <div className="overview-card">
          <span className="overview-label">Plano atual</span>
          <strong>{sub ? sub.plan_name : state === "trial" ? "Teste gratuito" : "Nenhum plano contratado"}</strong>
        </div>
        <div className="overview-card">
          <span className="overview-label">Status da assinatura</span>
          <strong><span className={`chip chip-${chip.tone}`}>{chip.label}</span></strong>
        </div>
        <div className="overview-card">
          <span className="overview-label">Valor mensal atual</span>
          <strong>{sub ? formatCents(sub.monthly_cents) : "—"}</strong>
          {pendingRemoval && (
            <small className="field-hint">
              Após {fmtDateOnly(pendingRemoval.effective_at)}: {formatCents(pendingRemoval.new_monthly_cents)}
            </small>
          )}
        </div>
        <div className="overview-card">
          <span className="overview-label">Próximo vencimento</span>
          <strong>{sub?.next_due_date ? fmtDateOnly(sub.next_due_date) : "—"}</strong>
        </div>
        <div className="overview-card">
          <span className="overview-label">Situação da mensalidade</span>
          <strong>{sub || current ? monthlySituation(current) : "—"}</strong>
        </div>
      </section>

      {(state === "trial" || state === "trial_expired") && (
        <section className="overview-card trial-card">
          <strong>{state === "trial" ? `Teste gratuito${trialDays === null ? "" : trialDays <= 1 ? " — último dia" : ` — ${trialDays} dias restantes`}` : "Teste gratuito encerrado"}</strong>
          <p className="field-hint">{TRIAL_CHOOSE_HINT} O teste não gera fatura nem dívida.</p>
        </section>
      )}

      {plan && (
        <section className="overview-card base-card">
          <div>
            <h3>{plan.name}</h3>
            <p className="field-hint">{plan.description ?? "Itens incluídos conforme o catálogo atual."}</p>
          </div>
          <strong>{formatCents(plan.monthly_price_cents)}/mês</strong>
        </section>
      )}

      {canContract ? (
        <SubscribePanel
          companyId={activeCompanyId}
          source={source}
          onContracted={(invoiceId) => {
            setPayingId(invoiceId);
            void load();
            void refresh();
          }}
        />
      ) : (
        catalog && (
          <>
            {pendingAddition && (
              <PendingAdditionCard
                companyId={activeCompanyId}
                source={source}
                addition={pendingAddition}
                isOwner={isOwner}
                onPaid={() => {
                  void load();
                  void refresh();
                }}
                onCanceled={() => void load()}
              />
            )}
            {billing?.pending_change && (
              <PendingChangeCard
                companyId={activeCompanyId}
                source={source}
                change={billing.pending_change}
                isOwner={isOwner}
                onEdit={() => setEditRequest({ ids: pendingSelection(billing.pending_change) ?? [], nonce: Date.now() })}
                onCanceled={() => void load()}
              />
            )}
            <ModulesPanel
              companyId={activeCompanyId}
              source={source}
              cards={cards}
              subscription={sub}
              canEdit={isOwner}
              pendingChange={billing?.pending_change ?? null}
              pendingAddition={pendingAddition}
              editRequest={editRequest}
              onScheduled={() => void load()}
              onAdditionRequested={() => {
                // a cobrança proporcional foi criada: o cartão "Aguardando pagamento" (com o Pix) assume
                void load();
                void refresh();
              }}
            />
          </>
        )
      )}

      {(current || payInvoiceId) && (
        <section className="current-invoice">
          <h3>Mensalidade atual</h3>
          {current && (
            <div className="overview-grid">
              <div className="overview-card"><span className="overview-label">Valor</span><strong>{formatCents(current.amount_cents)}</strong></div>
              <div className="overview-card"><span className="overview-label">Vencimento</span><strong>{fmtDateOnly(current.due_date)}</strong></div>
              <div className="overview-card"><span className="overview-label">Status</span><strong>{INVOICE_STATUS_TEXT[current.status]}</strong></div>
              <div className="overview-card"><span className="overview-label">Competência</span><strong>{fmtCompetence(current.competence)}</strong></div>
            </div>
          )}
          {isOwner && current && !payInvoiceId && (
            <button type="button" className="btn-primary btn-auto" onClick={() => setPayingId(current.id)}>
              Pagar mensalidade
            </button>
          )}
          {isOwner && payInvoiceId && (
            <PaymentPanel
              key={payInvoiceId}
              invoiceId={payInvoiceId}
              source={source}
              onPaid={() => {
                void load();
                void refresh();
              }}
            />
          )}
        </section>
      )}

      <section>
        <h3>Histórico de mensalidades</h3>
        {invoices.length === 0 ? (
          <p className="muted">Nenhuma fatura ainda.</p>
        ) : (
          <>
            <div className="table-scroll history-table">
              <table className="data-table">
                <thead>
                  <tr><th>Competência</th><th>Vencimento</th><th>Valor</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>{fmtCompetence(inv.competence)} <small className="field-hint">{INVOICE_KIND_TEXT[inv.kind]}</small></td>
                      <td>{fmtDateOnly(inv.due_date)}</td>
                      <td>{formatCents(inv.amount_cents)}</td>
                      <td>{INVOICE_STATUS_TEXT[inv.status] ?? inv.status}</td>
                      <td>
                        {isOwner && needsPayment(inv) && inv.kind !== "module_addition" && (
                          <button type="button" className="btn-secondary btn-small" onClick={() => setPayingId(inv.id)}>Pagar</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="history-cards">
              {invoices.map((inv) => (
                <li key={inv.id} className="overview-card">
                  <div className="history-row"><strong>{fmtCompetence(inv.competence)}</strong><span>{INVOICE_STATUS_TEXT[inv.status] ?? inv.status}</span></div>
                  <div className="history-row"><span>{INVOICE_KIND_TEXT[inv.kind]} · vence {fmtDateOnly(inv.due_date)}</span><strong>{formatCents(inv.amount_cents)}</strong></div>
                  {isOwner && needsPayment(inv) && inv.kind !== "module_addition" && (
                    <button type="button" className="btn-secondary btn-small btn-auto" onClick={() => setPayingId(inv.id)}>Pagar</button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

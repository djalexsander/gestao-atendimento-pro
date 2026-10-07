import { useEffect, useMemo, useState } from "react";
import { formatCents } from "../../lib/money";
import type { BillingSubscription, CommercialSource, PendingChange, PendingModuleAddition, ScheduleResult } from "./commercialApi";
import {
  MODULE_STATE_LABEL,
  PENDING_ADDITION_BLOCK,
  belowMinimumNote,
  changePreview,
  removalConfirmText,
  confirmLabel,
  fmtFullDate,
  moduleChangeBlockedReason,
  summaryLines,
  type ModuleCard,
} from "./commercialLogic";
import { useModuleChangeQuote } from "./useModuleChangeQuote";

// Módulos da empresa (Contratado / Disponível / Aguardando pagamento / Incluído no plano). O OWNER marca adicionar/remover e
// vê o resultado CALCULADO PELO SERVIDOR (tenant_quote_module_change):
//   ADICIONAR  -> cobrança proporcional até o próximo vencimento e Pix na hora; o módulo só é liberado depois do pagamento
//                 (abaixo do mínimo do Pix: sem cobrança agora, entra no próximo ciclo);
//   REMOVER    -> sem estorno; o módulo continua ativo até o fim do ciclo já pago.
// Uma alteração por vez. O Plano Base não é alterável. O ADMIN só consulta.
export function ModulesPanel({
  companyId,
  source,
  cards,
  subscription,
  canEdit,
  pendingChange,
  pendingAddition,
  editRequest,
  onScheduled,
  onAdditionRequested,
}: {
  companyId: string;
  source: CommercialSource;
  cards: ModuleCard[];
  subscription: BillingSubscription | null;
  canEdit: boolean;
  pendingChange: PendingChange | null;
  pendingAddition: PendingModuleAddition | null;
  // "Alterar" no card da próxima alteração: reabre a seleção com a composição agendada
  editRequest: { ids: string[]; nonce: number } | null;
  onScheduled: (result: ScheduleResult) => void;
  // adição com cobrança: a fatura proporcional foi criada (o pai mostra o Pix)
  onAdditionRequested: (invoiceId: string) => void;
}) {
  // quem já é do cliente (inclui o que tem remoção agendada: continua ativo até a data efetiva)
  const contractedIds = useMemo(() => cards.filter((c) => c.state === "contracted" || c.state === "removal_scheduled").map((c) => c.id), [cards]);
  const [cancelingRemoval, setCancelingRemoval] = useState(false);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ScheduleResult | null>(null);

  useEffect(() => {
    if (editRequest) {
      setSelection(editRequest.ids);
      setDone(null);
      setError(null);
    }
  }, [editRequest]);

  const blocked = pendingAddition ? PENDING_ADDITION_BLOCK : moduleChangeBlockedReason(subscription?.status);
  const interactive = canEdit && !!subscription && blocked === null;
  const baseline = pendingChange ? pendingChange.new_modules.map((m) => m.module_id) : contractedIds;
  const selected = selection ?? baseline;
  const preview = changePreview(cards, selected);
  const editing = interactive && selection !== null;
  const differs = [...selected].sort().join(",") !== [...contractedIds].sort().join(",");
  const { quote, pending, error: quoteError } = useModuleChangeQuote(source, companyId, selected, editing && differs);

  function toggle(card: ModuleCard) {
    if (!interactive || card.state === "included" || card.state === "awaiting_payment" || card.state === "removal_scheduled") return;
    const base = selection ?? baseline;
    setDone(null);
    setSelection(base.includes(card.id) ? base.filter((id) => id !== card.id) : [...base, card.id]);
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    const result = await source.scheduleModuleChange(companyId, selected);
    setSubmitting(false);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setSelection(null);
    if (result.data.mode === "add_now" && result.data.invoice_id) {
      setDone(null);
      onAdditionRequested(result.data.invoice_id);
      return;
    }
    setDone(result.data);
    onScheduled(result.data);
  }

  async function cancelRemoval() {
    setCancelingRemoval(true);
    setError(null);
    const result = await source.cancelModuleChange(companyId);
    setCancelingRemoval(false);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setSelection(null);
    setDone(null);
    onScheduled({ mode: "remove_next_cycle", idempotent: false, new_monthly_cents: subscription?.monthly_cents ?? 0 });
  }

  const lines = quote && subscription ? summaryLines(quote.plan, quote.new_modules.map((m) => ({ name: m.name, monthly_price_cents: m.price_cents }))) : [];
  const mode = quote?.mode;
  const canConfirm = editing && differs && !!quote && !quote.identical && !pending && !submitting && !quote.blocked_reason && mode !== "mixed" && !(quote.pending_locked && !quote.pending_same);

  return (
    <section className="modules-panel">
      <h3>Módulos</h3>
      <div className="module-grid">
        {cards.map((c) => {
          const scheduledOut = c.state === "removal_scheduled";
          const checked = c.state === "included" || c.state === "awaiting_payment" || scheduledOut || selected.includes(c.id);
          const chip = c.state === "contracted" ? "ok" : c.state === "included" ? "info" : c.state === "awaiting_payment" || scheduledOut ? "warn" : "muted";
          return (
            <div key={c.id} className={`module-card module-card-${c.state}${checked && c.state !== "included" ? " module-card-on" : ""}`}>
              <span className="module-card-body">
                <strong>{c.name}</strong>
                {c.description && <small className="field-hint">{c.description}</small>}
                <span className={`chip chip-${chip}`}>{MODULE_STATE_LABEL[c.state]}</span>
                {scheduledOut && pendingChange && <small className="field-hint">Disponível até {fmtFullDate(pendingChange.effective_at)}</small>}
              </span>
              <span className="module-price">{formatCents(c.monthly_price_cents)}/mês</span>
              {interactive && c.state !== "included" && c.state !== "awaiting_payment" && !scheduledOut && (
                <button type="button" className="btn-secondary btn-small" onClick={() => toggle(c)} aria-pressed={checked}>
                  {c.state === "contracted" ? (checked ? "Remover módulo" : "Manter módulo") : checked ? "Adicionado ✓" : "Adicionar"}
                </button>
              )}
              {canEdit && scheduledOut && pendingChange && !pendingChange.locked && (
                <button type="button" className="btn-secondary btn-small" onClick={() => void cancelRemoval()} disabled={cancelingRemoval}>
                  {cancelingRemoval ? "Cancelando…" : "Cancelar remoção"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {canEdit && subscription && blocked && <p className="field-hint">{blocked}</p>}
      {!canEdit && subscription && <p className="field-hint">Somente o proprietário altera a contratação.</p>}

      {done && done.mode === "remove_next_cycle" && (
        <div className="form-notice" role="status">
          <strong>Remoção agendada.</strong> A partir de {fmtFullDate(done.effective_at)}: {formatCents(done.new_monthly_cents)}/mês.{" "}
          {done.deferred_to_following_cycle ? "Como sua próxima mensalidade já foi gerada, esta alteração entra no ciclo seguinte." : "Sem estorno: o módulo segue ativo até lá."}
        </div>
      )}
      {done && done.mode === "add_deferred" && (
        <div className="form-notice" role="status">
          <strong>Adição agendada.</strong> O valor proporcional ficou abaixo do mínimo do Pix, então não há cobrança agora. A partir de{" "}
          {fmtFullDate(done.effective_at)}: {formatCents(done.new_monthly_cents)}/mês.
        </div>
      )}

      {editing && differs && (
        <div className="change-preview" aria-live="polite">
          {mode === "add_now" && quote ? (
            <>
              <h4>Adicionar {quote.lines.map((l) => l.name).join(" e ")}</h4>
              <ul className="plan-summary">
                {quote.lines.map((l) => (
                  <li key={l.module_id}>
                    <span>
                      {l.name} <small className="field-hint">Preço mensal {formatCents(l.monthly_price_cents)}/mês</small>
                    </span>
                    <span>{formatCents(l.prorated_cents)}</span>
                  </li>
                ))}
                <li className="plan-summary-total">
                  <span>Uso proporcional até {fmtFullDate(quote.cycle_end)}</span>
                  <span>{formatCents(quote.prorated_total_cents)}</span>
                </li>
                <li className="plan-summary-total">
                  <span>Cobrança hoje</span>
                  <span>{formatCents(quote.charge_today_cents)}</span>
                </li>
              </ul>
              <p className="field-hint">
                A partir de {fmtFullDate(quote.next_due_date)}: sua mensalidade será {formatCents(quote.new_monthly_cents)}/mês, sem mudar o dia de vencimento.
                O módulo é liberado assim que o Pix for pago.
              </p>
            </>
          ) : (
            <ul className="plan-summary">
              {lines.map((l) => (
                <li key={l.label}>
                  <span>{l.label}</span>
                  <span>{formatCents(l.cents)}</span>
                </li>
              ))}
              <li className="plan-summary-total">
                <span>Novo total{pending ? " (calculando…)" : ""}</span>
                <span>{quote ? `${formatCents(quote.new_monthly_cents)}/mês` : "—"}</span>
              </li>
            </ul>
          )}
          {quote && mode === "add_deferred" && <p className="field-hint">{belowMinimumNote({ prorated_total_cents: quote.prorated_total_cents, min_charge_cents: quote.min_charge_cents, effective_at: quote.effective_at }, formatCents)}</p>}
          {quote && mode === "remove_next_cycle" && (
            <>
              <h4>Remover {quote.removed.map((m) => m.name).join(" e ")}</h4>
              <ul className="plan-summary">
                <li><span>Valor atual</span><span>{formatCents(quote.previous_monthly_cents)}/mês</span></li>
                <li className="plan-summary-total"><span>Após {fmtFullDate(quote.effective_at)}</span><span>{formatCents(quote.new_monthly_cents)}/mês</span></li>
              </ul>
              <p className="field-hint">{removalConfirmText(quote, formatCents)}</p>
            </>
          )}
          {quote?.blocked_reason && <div className="form-error">{quote.blocked_reason}</div>}
          {preview.changed && !quote && <p className="field-hint">Calculando o novo valor…</p>}
          {(quoteError || error) && <div className="form-error">{error ?? quoteError}</div>}
          <div className="row-actions">
            <button type="button" className="btn-primary btn-auto" disabled={!canConfirm} onClick={() => void confirm()}>
              {confirmLabel(mode, submitting, !!pendingChange)}
            </button>
            <button type="button" className="btn-secondary btn-auto" onClick={() => setSelection(null)} disabled={submitting}>
              Descartar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

import { useMemo, useRef, useState, type FormEvent } from "react";
import { fmtDateTimeSP } from "../../lib/dates";
import { Modal } from "../employees/Modal";
import { extendCourtesy, grantCourtesy } from "./courtesyWriteApi";
import {
  buildExtendArgs,
  buildGrantArgs,
  DURATION_OPTIONS,
  EMPTY_GRANT_FORM,
  EXPIRY_NOTICE,
  extendResultMessage,
  fmtISO,
  grantResultMessage,
  grantSummary,
  hasErrors,
  hasOpenCourtesy,
  hasOpenPlanCourtesy,
  newRequestId,
  NO_BILLING_NOTICE,
  REASON_MAX,
  scopeEffectText,
  selectablePlans,
  todaySP,
  addDaysISO,
  MAX_DAYS_AHEAD,
  validateEndDate,
  validateGrant,
  validateReason,
  WARNING_TEXT,
  minExtendDate,
  type DurationChoice,
  type GrantForm,
  type GrantScope,
  type OpenItem,
} from "./courtesyFormLogic";
import type { Courtesy } from "./courtesyLogic";

interface NamedPlan {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
interface NamedModule {
  code: string;
  name: string;
  isActive: boolean;
}

export interface DoneInfo {
  tone: "ok" | "info";
  text: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Conceder
// ---------------------------------------------------------------------------------------------------------------------------
export function GrantCourtesyDialog({
  companyId,
  companyName,
  plans,
  modules,
  reservedPlanCode,
  open,
  onClose,
  onDone,
  onUnavailable,
}: {
  companyId: string;
  companyName: string;
  plans: NamedPlan[];
  modules: NamedModule[];
  reservedPlanCode: string | null;
  open: OpenItem[];
  onClose: () => void;
  onDone: (info: DoneInfo) => void;
  onUnavailable: () => void;
}) {
  const [form, setForm] = useState<GrantForm>(EMPTY_GRANT_FORM);
  const [step, setStep] = useState<"form" | "review">("form");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UMA chave de idempotência por abertura do formulário: reenviar (clique duplo, falha de rede) nunca duplica a concessão
  const requestId = useRef<string>(newRequestId());
  const submitting = useRef(false);

  const [now] = useState(() => new Date());
  const errors = useMemo(() => validateGrant(form, { now, open }), [form, open, now]);
  const planChoices = selectablePlans(plans, reservedPlanCode);
  const itemName = form.scope === "plan" ? planChoices.find((p) => p.id === form.planId)?.name ?? "" : modules.find((m) => m.code === form.moduleCode)?.name ?? form.moduleCode;
  const today = todaySP(now);

  const set = <K extends keyof GrantForm>(k: K, v: GrantForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  function review(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (hasErrors(errors)) return;
    setStep("review");
  }

  async function confirm() {
    if (submitting.current) return; // trava síncrona contra clique duplo
    submitting.current = true;
    setBusy(true);
    setError(null);
    const r = await grantCourtesy(buildGrantArgs(companyId, form, requestId.current));
    submitting.current = false;
    setBusy(false);
    if (r.status === "unavailable") {
      onUnavailable();
      return;
    }
    if (r.status === "error") {
      setError(r.error);
      return;
    }
    const m = grantResultMessage(r.data);
    onDone({ ...m, warnings: r.data.warnings.map((w) => WARNING_TEXT[w] ?? w) });
  }

  const close = () => (busy ? undefined : onClose());

  return (
    <Modal title={step === "form" ? "Conceder cortesia" : "Confirmar cortesia"} onClose={close}>
      <div className="court-form">
        <p className="modal-text">{NO_BILLING_NOTICE}</p>
        {step === "form" ? (
          <form onSubmit={review} noValidate>
            <fieldset className="court-fieldset">
              <legend>O que será concedido</legend>
              <label className="court-radio">
                <input type="radio" name="court-scope" checked={form.scope === "module"} onChange={() => set("scope", "module" as GrantScope)} /> Módulo
              </label>
              <label className="court-radio">
                <input type="radio" name="court-scope" checked={form.scope === "plan"} onChange={() => set("scope", "plan" as GrantScope)} /> Plano base
              </label>
            </fieldset>

            {form.scope === "plan" ? (
              <div className="field">
                <label htmlFor="court-plan">Plano (catálogo)</label>
                <select id="court-plan" value={form.planId} onChange={(e) => set("planId", e.target.value)} aria-invalid={touched && !!errors.item} aria-describedby="court-item-err" disabled={busy}>
                  <option value="">Escolha o plano…</option>
                  {planChoices.map((p) => (
                    <option key={p.id} value={p.id} disabled={hasOpenCourtesy(open, "plan", p.id)}>
                      {p.name}
                      {!p.isActive ? " (inativo no catálogo)" : ""}
                      {hasOpenCourtesy(open, "plan", p.id) ? " — já tem cortesia aberta" : ""}
                    </option>
                  ))}
                </select>
                {planChoices.length === 0 && <small className="field-hint">Nenhum plano disponível no catálogo.</small>}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="court-module">Módulo (catálogo)</label>
                <select id="court-module" value={form.moduleCode} onChange={(e) => set("moduleCode", e.target.value)} aria-invalid={touched && !!errors.item} aria-describedby="court-item-err" disabled={busy}>
                  <option value="">Escolha o módulo…</option>
                  {modules.map((m) => (
                    <option key={m.code} value={m.code} disabled={hasOpenCourtesy(open, "module", m.code)}>
                      {m.name}
                      {!m.isActive ? " (inativo no catálogo)" : ""}
                      {hasOpenCourtesy(open, "module", m.code) ? " — já tem cortesia aberta" : ""}
                    </option>
                  ))}
                </select>
                {modules.length === 0 && <small className="field-hint">Nenhum módulo disponível no catálogo.</small>}
              </div>
            )}
            {touched && errors.item && (
              <div id="court-item-err" className="form-error" role="alert">
                {errors.item}
              </div>
            )}
            <p className="field-hint">{scopeEffectText(form.scope)}</p>
            {form.scope === "plan" && hasOpenPlanCourtesy(open) && <p className="field-hint">Esta empresa já tem uma cortesia de plano aberta; só é possível ter uma por plano.</p>}

            <fieldset className="court-fieldset">
              <legend>Duração</legend>
              {DURATION_OPTIONS.map((o) => (
                <label key={o.value} className="court-radio">
                  <input type="radio" name="court-duration" checked={form.duration === o.value} onChange={() => set("duration", o.value as DurationChoice)} disabled={busy} /> {o.label}
                </label>
              ))}
            </fieldset>
            {form.duration === "custom" && (
              <div className="field">
                <label htmlFor="court-end">Data final</label>
                <input
                  id="court-end"
                  type="date"
                  value={form.endDate}
                  min={today}
                  max={addDaysISO(today, MAX_DAYS_AHEAD - 1)}
                  onChange={(e) => set("endDate", e.target.value)}
                  aria-invalid={touched && !!errors.endDate}
                  aria-describedby="court-end-err"
                  disabled={busy}
                />
                <small className="field-hint">Vale até o fim desse dia (horário de Brasília). No máximo {MAX_DAYS_AHEAD} dias à frente.</small>
                {touched && errors.endDate && (
                  <div id="court-end-err" className="form-error" role="alert">
                    {errors.endDate}
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="court-reason">Motivo (obrigatório)</label>
              <textarea id="court-reason" value={form.reason} maxLength={REASON_MAX + 50} rows={3} onChange={(e) => set("reason", e.target.value)} aria-invalid={touched && !!errors.reason} aria-describedby="court-reason-err" disabled={busy} />
              <small className="field-hint">
                {form.reason.trim().length}/{REASON_MAX}
              </small>
              {touched && errors.reason && (
                <div id="court-reason-err" className="form-error" role="alert">
                  {errors.reason}
                </div>
              )}
            </div>

            <p className="court-notice" role="note">
              {EXPIRY_NOTICE}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary">
                Revisar
              </button>
            </div>
          </form>
        ) : (
          <div>
            <dl className="mst-dl court-summary" aria-label="Resumo da concessão">
              {grantSummary(form, companyName, itemName, now).map((l) => (
                <div key={l.label} className="court-summary-row">
                  <dt>{l.label}</dt>
                  <dd>{l.value}</dd>
                </div>
              ))}
            </dl>
            <p className="field-hint">{scopeEffectText(form.scope)}</p>
            <p className="court-notice" role="note">
              {EXPIRY_NOTICE}
            </p>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStep("form")}>
                Voltar
              </button>
              <button type="button" className="btn-primary" disabled={busy} aria-busy={busy} onClick={() => void confirm()}>
                {busy ? "Concedendo…" : "Confirmar cortesia"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Prorrogar
// ---------------------------------------------------------------------------------------------------------------------------
export function ExtendCourtesyDialog({
  courtesy,
  itemName,
  onClose,
  onDone,
  onUnavailable,
}: {
  courtesy: Courtesy;
  itemName: string;
  onClose: () => void;
  onDone: (info: DoneInfo) => void;
  onUnavailable: () => void;
}) {
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string>(newRequestId());
  const submitting = useRef(false);

  const [now] = useState(() => new Date());
  const today = todaySP(now);
  const minDate = minExtendDate(courtesy.ends_at, now);
  const dateError = validateEndDate(endDate, now, courtesy.ends_at);
  const reasonError = validateReason(reason);
  const expired = courtesy.effective_state === "expired_pending_decision";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (dateError || reasonError || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const r = await extendCourtesy(buildExtendArgs(courtesy.id, endDate, reason, requestId.current));
    submitting.current = false;
    setBusy(false);
    if (r.status === "unavailable") {
      onUnavailable();
      return;
    }
    if (r.status === "error") {
      setError(r.error);
      return;
    }
    onDone({ ...extendResultMessage(r.data), warnings: [] });
  }

  return (
    <Modal title="Prorrogar cortesia" onClose={() => (busy ? undefined : onClose())}>
      <div className="court-form">
        <p className="modal-text">
          <strong>{itemName}</strong>
          <br />
          Vence em {fmtDateTimeSP(courtesy.ends_at)}
          {expired ? " (já venceu e aguarda decisão)" : ""}.
        </p>
        <p className="court-notice" role="note">
          {EXPIRY_NOTICE}
        </p>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="court-ext-date">Nova data final</label>
            <input
              id="court-ext-date"
              type="date"
              value={endDate}
              min={minDate}
              max={addDaysISO(today, MAX_DAYS_AHEAD - 1)}
              onChange={(e) => setEndDate(e.target.value)}
              aria-invalid={touched && !!dateError}
              aria-describedby="court-ext-date-err"
              disabled={busy}
            />
            <small className="field-hint">
              Vale até o fim desse dia (horário de Brasília){endDate && !dateError ? `: ${fmtISO(endDate)}` : ""}. Prorrogar não cria cobrança.
            </small>
            {touched && dateError && (
              <div id="court-ext-date-err" className="form-error" role="alert">
                {dateError}
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="court-ext-reason">Motivo (obrigatório)</label>
            <textarea id="court-ext-reason" value={reason} rows={3} maxLength={REASON_MAX + 50} onChange={(e) => setReason(e.target.value)} aria-invalid={touched && !!reasonError} aria-describedby="court-ext-reason-err" disabled={busy} />
            <small className="field-hint">
              {reason.trim().length}/{REASON_MAX}
            </small>
            {touched && reasonError && (
              <div id="court-ext-reason-err" className="form-error" role="alert">
                {reasonError}
              </div>
            )}
          </div>
          {courtesy.conversion_requested_at && <p className="field-hint">Atenção: prorrogar limpa o pedido de conversão registrado em {fmtDateTimeSP(courtesy.conversion_requested_at)}.</p>}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
              {busy ? "Prorrogando…" : "Prorrogar"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

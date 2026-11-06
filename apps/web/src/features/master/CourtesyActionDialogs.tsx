import { useRef, useState, type FormEvent } from "react";
import { fmtDateTimeSP } from "../../lib/dates";
import { Modal } from "../employees/Modal";
import type { DoneInfo } from "./CourtesyDialogs";
import {
  BRIDGE_DEFAULT_HOURS,
  BRIDGE_HOURS_OPTIONS,
  buildConvertArgs,
  buildEndArgs,
  buildRequestArgs,
  convertResultMessage,
  END_WARNING_TEXT,
  endImpact,
  endResultMessage,
  requestResultMessage,
  validateBillingStart,
  validateBridgeHours,
  validateNote,
  type ConversionPlan,
  type SubInfo,
} from "./courtesyActionLogic";
import { EXPIRY_NOTICE, newRequestId, REASON_MAX } from "./courtesyFormLogic";
import type { Courtesy } from "./courtesyLogic";
import { convertCourtesy, endCourtesy, requestCourtesyConversion } from "./courtesyWriteApi";

interface Common {
  courtesy: Courtesy;
  itemName: string;
  onClose: () => void;
  onDone: (info: DoneInfo) => void;
  onUnavailable: () => void;
}

/** Campo de texto obrigatório (motivo/nota) com contador, rótulo e erro acessíveis. */
function NoteField({ id, label, value, onChange, error, show, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; error: string | null; show: boolean; disabled: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} value={value} rows={3} maxLength={REASON_MAX + 50} onChange={(e) => onChange(e.target.value)} aria-invalid={show && !!error} aria-describedby={`${id}-err`} disabled={disabled} />
      <small className="field-hint">
        {value.trim().length}/{REASON_MAX}
      </small>
      {show && error && (
        <div id={`${id}-err`} className="form-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function BillingStartField({ id, value, onChange, error, show, disabled, hint }: { id: string; value: string; onChange: (v: string) => void; error: string | null; show: boolean; disabled: boolean; hint: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>Início da cobrança (competência, opcional)</label>
      <input id={id} type="month" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={show && !!error} aria-describedby={`${id}-err`} disabled={disabled} />
      <small className="field-hint">{hint}</small>
      {show && error && (
        <div id={`${id}-err`} className="form-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Encerrar
// ---------------------------------------------------------------------------------------------------------------------------
export function EndCourtesyDialog({ courtesy, itemName, sub, onClose, onDone, onUnavailable }: Common & { sub: SubInfo | null }) {
  const [reason, setReason] = useState("");
  const [month, setMonth] = useState("");
  const [step, setStep] = useState<"form" | "review">("form");
  const [confirmed, setConfirmed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string>(newRequestId());
  const submitting = useRef(false);
  const [now] = useState(() => new Date());

  const impact = endImpact(courtesy, sub);
  const reasonError = validateNote(reason);
  const monthError = sub ? validateBillingStart(month, now) : null;

  function review(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (reasonError || monthError) return;
    setStep("review");
  }

  async function confirm() {
    if (submitting.current || !confirmed) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const r = await endCourtesy(buildEndArgs(courtesy.id, reason, sub ? month : "", requestId.current));
    submitting.current = false;
    setBusy(false);
    if (r.status === "unavailable") return onUnavailable();
    if (r.status === "error") return setError(r.error);
    const m = endResultMessage(r.data);
    onDone({ ...m, warnings: r.data.warnings.map((w) => END_WARNING_TEXT[w] ?? w) });
  }

  return (
    <Modal title={step === "form" ? "Encerrar cortesia" : "Confirmar encerramento"} onClose={() => (busy ? undefined : onClose())}>
      <div className="court-form">
        <p className="modal-text">
          <strong>{itemName}</strong>
          <br />
          Vence em {fmtDateTimeSP(courtesy.ends_at)}.
        </p>
        <div className={`court-impact${impact.accessEndsNow ? " court-impact-warn" : ""}`} role="note">
          <strong>{impact.accessEndsNow === true ? "Atenção: o acesso termina na hora" : impact.accessEndsNow === "maybe" ? "Atenção: o acesso ao módulo pode terminar na hora" : "Impacto esperado"}</strong>
          <ul>
            {impact.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <small>O banco confirma o impacto real ao executar e informa os avisos.</small>
        </div>
        {step === "form" ? (
          <form onSubmit={review} noValidate>
            <NoteField id="court-end-reason" label="Motivo do encerramento (obrigatório)" value={reason} onChange={setReason} error={reasonError} show={touched} disabled={busy} />
            {sub && (
              <BillingStartField
                id="court-end-month"
                value={month}
                onChange={setMonth}
                error={monthError}
                show={touched}
                disabled={busy}
                hint="Primeira competência cobrável depois da cortesia. Em branco, o banco usa a primeira ainda não decidida (nunca retroativa). Faturas já emitidas não mudam."
              />
            )}
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
            <dl className="mst-dl court-summary" aria-label="Resumo do encerramento">
              <div className="court-summary-row">
                <dt>Item</dt>
                <dd>{itemName}</dd>
              </div>
              <div className="court-summary-row">
                <dt>Motivo</dt>
                <dd>{reason.trim()}</dd>
              </div>
              {sub && (
                <div className="court-summary-row">
                  <dt>Cobrança volta</dt>
                  <dd>{month ? `${month.slice(5, 7)}/${month.slice(0, 4)}` : "na primeira competência ainda não decidida (definida pelo banco)"}</dd>
                </div>
              )}
            </dl>
            <label className="court-confirm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} /> Entendi o impacto e confirmo o encerramento desta cortesia. Não há como reabri-la depois.
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStep("form")}>
                Voltar
              </button>
              <button type="button" className="btn-danger" disabled={busy || !confirmed} aria-busy={busy} onClick={() => void confirm()}>
                {busy ? "Encerrando…" : "Encerrar cortesia"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Solicitar conversão (só registro)
// ---------------------------------------------------------------------------------------------------------------------------
export function RequestConversionDialog({ courtesy, itemName, onClose, onDone, onUnavailable }: Common) {
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string>(newRequestId());
  const submitting = useRef(false);
  const noteError = validateNote(note);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (noteError || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const r = await requestCourtesyConversion(buildRequestArgs(courtesy.id, note, requestId.current));
    submitting.current = false;
    setBusy(false);
    if (r.status === "unavailable") return onUnavailable();
    if (r.status === "error") return setError(r.error);
    onDone({ ...requestResultMessage(r.data), warnings: [] });
  }

  return (
    <Modal title="Solicitar conversão" onClose={() => (busy ? undefined : onClose())}>
      <div className="court-form">
        <p className="modal-text">
          <strong>{itemName}</strong>
        </p>
        <p className="court-notice" role="note">
          Isto é apenas um REGISTRO do interesse do cliente em contratar. Não autoriza a contratação, não cria assinatura, fatura, Pix nem cobrança e não muda acesso. A prorrogação da cortesia limpa este pedido.
        </p>
        <form onSubmit={submit} noValidate>
          <NoteField id="court-req-note" label="Observação do pedido (obrigatória)" value={note} onChange={setNote} error={noteError} show={touched} disabled={busy} />
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
              {busy ? "Registrando…" : "Registrar pedido"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Autorizar conversão (plano sem assinatura) / converter (plano com assinatura do mesmo plano, ou módulo já extra)
// ---------------------------------------------------------------------------------------------------------------------------
export function ConvertCourtesyDialog({ courtesy, itemName, plan, onClose, onDone, onUnavailable }: Common & { plan: ConversionPlan }) {
  const mode = plan.mode === "blocked" ? "authorize" : plan.mode;
  const authorize = mode === "authorize";
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(BRIDGE_DEFAULT_HOURS);
  const [month, setMonth] = useState("");
  const [step, setStep] = useState<"form" | "review">("form");
  const [confirmed, setConfirmed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string>(newRequestId());
  const submitting = useRef(false);
  const [now] = useState(() => new Date());

  const noteError = validateNote(note);
  const hoursError = authorize ? validateBridgeHours(hours) : null;
  const monthError = authorize ? null : validateBillingStart(month, now);

  function review(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (noteError || hoursError || monthError) return;
    setStep("review");
  }

  async function confirm() {
    if (submitting.current || !confirmed) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const r = await convertCourtesy(buildConvertArgs(courtesy.id, note, mode, { bridgeHours: hours, billingStartsMonth: month }, requestId.current));
    submitting.current = false;
    setBusy(false);
    if (r.status === "unavailable") return onUnavailable();
    if (r.status === "error") return setError(r.error);
    onDone({ ...convertResultMessage(r.data), warnings: [] });
  }

  const title = authorize ? "Autorizar conversão" : "Converter cortesia";
  return (
    <Modal title={step === "form" ? title : `Confirmar: ${title.toLowerCase()}`} onClose={() => (busy ? undefined : onClose())}>
      <div className="court-form">
        <p className="modal-text">
          <strong>{itemName}</strong>
        </p>
        <div className={`court-impact${authorize ? "" : " court-impact-warn"}`} role="note">
          <strong>{authorize ? "A autorização não cria assinatura nem cobrança" : "O que esta conversão faz"}</strong>
          <ul>
            {authorize ? (
              <>
                <li>Só autoriza a contratação paga do plano; a cortesia continua aberta e o acesso e as isenções seguem até a contratação.</li>
                <li>Depois, o Master contrata pelo formulário existente "Contratar plano"; a cortesia só vira "convertida" nessa contratação.</li>
                <li>Entre contratar e o Pix ser pago, uma ponte de acesso temporário mantém a operação pelo prazo escolhido abaixo.</li>
              </>
            ) : mode === "convert_plan" ? (
              <>
                <li>A cortesia é encerrada como convertida; a cobrança do plano volta na competência definida.</li>
                <li>Não cria Pix nem fatura agora; faturas já emitidas não mudam.</li>
              </>
            ) : (
              <>
                <li>O módulo já é extra da assinatura: a conversão só marca a decisão e define quando a cobrança começa.</li>
                <li>Não ativa módulo pago nem gera Pix proporcional.</li>
              </>
            )}
          </ul>
        </div>
        {step === "form" ? (
          <form onSubmit={review} noValidate>
            <NoteField id="court-conv-note" label="Observação (obrigatória)" value={note} onChange={setNote} error={noteError} show={touched} disabled={busy} />
            {authorize ? (
              <div className="field">
                <label htmlFor="court-conv-hours">Prazo da ponte de acesso após contratar</label>
                <select id="court-conv-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-invalid={touched && !!hoursError} disabled={busy}>
                  {BRIDGE_HOURS_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h} horas{h === BRIDGE_DEFAULT_HOURS ? " (padrão)" : ""}
                    </option>
                  ))}
                </select>
                <small className="field-hint">De 24 a 168 horas, contadas da contratação. Fica registrado e não pode ser alterado depois.</small>
              </div>
            ) : (
              <BillingStartField id="court-conv-month" value={month} onChange={setMonth} error={monthError} show={touched} disabled={busy} hint="Em branco, o banco usa a primeira competência ainda não decidida (nunca retroativa)." />
            )}
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
            <dl className="mst-dl court-summary" aria-label="Resumo da decisão">
              <div className="court-summary-row">
                <dt>Ação</dt>
                <dd>{authorize ? "Autorizar conversão (sem criar contratação)" : mode === "convert_plan" ? "Converter plano (retomar a cobrança)" : "Converter módulo"}</dd>
              </div>
              <div className="court-summary-row">
                <dt>Observação</dt>
                <dd>{note.trim()}</dd>
              </div>
              {authorize ? (
                <div className="court-summary-row">
                  <dt>Ponte de acesso</dt>
                  <dd>{hours} horas após a contratação</dd>
                </div>
              ) : (
                <div className="court-summary-row">
                  <dt>Cobrança volta</dt>
                  <dd>{month ? `${month.slice(5, 7)}/${month.slice(0, 4)}` : "na primeira competência ainda não decidida (definida pelo banco)"}</dd>
                </div>
              )}
            </dl>
            <p className="court-notice" role="note">
              {EXPIRY_NOTICE}
            </p>
            <label className="court-confirm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />{" "}
              {authorize ? "Entendi que a autorização não cria assinatura, fatura, Pix nem cobrança e que o prazo da ponte não poderá ser alterado." : "Entendi que a cortesia será convertida (encerrada) e a cobrança volta a seguir o contrato."}
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStep("form")}>
                Voltar
              </button>
              <button type="button" className="btn-primary" disabled={busy || !confirmed} aria-busy={busy} onClick={() => void confirm()}>
                {busy ? "Registrando…" : authorize ? "Autorizar conversão" : "Converter"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

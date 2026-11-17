import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import type { StartAttempt } from "./whatsappStartApi";
import type { StartSource } from "./whatsappStartApi";
import {
  CONSENT_ORIGINS,
  CONSENT_REF_MAX,
  OPTOUT_PENDING_TEXT,
  OPTOUT_TEXT,
  OUTCOME_TEXT,
  PARAM_MAX,
  RESOLUTION_DONE,
  RESOLUTION_LABEL,
  STATE_HELP,
  STATE_LABEL,
  allowedResolutions,
  dailyLimitReached,
  deliveryText,
  needsAttention,
  renderPreview,
  sendableTemplates,
  startFormIssues,
  templateLabel,
  unsupportedTemplateCount,
  type ConsentOrigin,
  type ContactOptout,
  type Resolution,
  type StartOutcome,
  type StartRequest,
  type StartSettings,
  type StartTarget,
  type StartTemplates,
} from "./whatsappStartLogic";

// Interface do "Iniciar conversa" (Etapa 7.11G). Só apresentação + estado do formulário: quem fala com o servidor é o controlador (whatsappStartApi).
// Nunca mostra nem envia telefone digitado: o contato é identificado por id e o servidor resolve o número.

const START_TEXT = {
  title: "Iniciar conversa",
  button: "Iniciar conversa",
  openExisting: "Abrir conversa",
  billing: "Atenção: conversas iniciadas pela empresa com template podem ser cobradas pela Meta, mesmo que o contato não responda.",
  consentLabel: "Confirmo que este contato autorizou receber mensagens da empresa pelo WhatsApp.",
  originLabel: "Origem da autorização",
  originPlaceholder: "Escolha a origem",
  refLabel: "Referência da autorização",
  refHint: "Ex.: número do pedido, ficha, protocolo ou nome do formulário. Não digite telefone.",
  templateLabel: "Template aprovado",
  templatePlaceholder: "Escolha um template",
  preview: "Prévia da mensagem",
  send: "Enviar mensagem",
  sending: "Enviando…",
  retry: "Tentar de novo (mesmo pedido)",
  cancel: "Cancelar",
  close: "Fechar",
  loadingTemplates: "Carregando templates…",
  noTemplates: "Nenhum template aprovado e compatível. Peça ao administrador para sincronizar os templates.",
  notConnected: "O WhatsApp desta empresa não está conectado.",
  stale: "A lista de templates não é atualizada há mais de 24 horas. O servidor confere o status antes de enviar.",
  retryLoad: "Tentar de novo",
  requests: "Solicitações",
} as const;

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const fmt = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateTime.format(d);
};

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Formulário (apresentação pura: testável sem hooks de dados)
// ---------------------------------------------------------------------------
export interface StartFormProps {
  contactName: string;
  phoneText: string;
  settings: StartSettings;
  templates: Load<StartTemplates>;
  optout: Load<ContactOptout>;
  templateId: string;
  values: string[];
  consent: boolean;
  origin: ConsentOrigin | "";
  refText: string;
  touched: boolean;
  busy: boolean;
  /** Erro/aviso da última tentativa (sem conversa criada). */
  banner: { tone: "error" | "warning"; text: string } | null;
  /** Reaproveita o mesmo pedido (rede caiu / resposta incerta): o botão muda de texto. */
  isRetry: boolean;
  onTemplate: (id: string) => void;
  onValue: (index: number, value: string) => void;
  onConsent: (v: boolean) => void;
  onOrigin: (v: ConsentOrigin | "") => void;
  onRef: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onRetryLoad: () => void;
}

export function StartConversationForm(p: StartFormProps) {
  const tpls = p.templates.status === "ready" ? p.templates.data : null;
  const sendable = sendableTemplates(tpls);
  const chosen = sendable.find((t) => t.id === p.templateId) ?? null;
  const optoutData = p.optout.status === "ready" ? p.optout.data : null;
  const issues = startFormIssues({ template: chosen, values: p.values, consent: p.consent, origin: p.origin, ref: p.refText, optout: optoutData, limitReached: dailyLimitReached(p.settings) });
  const show = p.touched;
  const hidden = unsupportedTemplateCount(tpls);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (p.busy) return;
    p.onSubmit();
  }

  return (
    <form className="sc-form" onSubmit={submit} noValidate>
      <div className="sc-contact">
        <strong className="sc-contact-name">{p.contactName}</strong>
        {p.phoneText && <span className="sc-contact-phone">{p.phoneText}</span>}
      </div>

      <p className="sc-billing" role="note">
        <span aria-hidden="true">💲 </span>
        {START_TEXT.billing}
      </p>
      <p className="sc-usage muted">
        Hoje: {p.settings.usedToday} de {p.settings.dailyLimit} conversas iniciadas
        {p.settings.minIntervalHours > 0 ? ` · intervalo mínimo de ${p.settings.minIntervalHours} h por contato` : ""}.
      </p>

      {p.optout.status === "loading" && (
        <p className="op-state" role="status">
          {OPTOUT_PENDING_TEXT}
        </p>
      )}
      {p.optout.status === "error" && (
        <div className="form-error sc-error" role="alert">
          <span>Não foi possível verificar o bloqueio do contato. Por segurança, o envio fica bloqueado. {p.optout.message}</span>
          <button type="button" className="btn-secondary btn-small" onClick={p.onRetryLoad}>
            {START_TEXT.retryLoad}
          </button>
        </div>
      )}
      {optoutData?.optedOut && (
        <div className="form-error sc-error" role="alert">
          <span>{OPTOUT_TEXT}</span>
        </div>
      )}
      {issues.blocker && !optoutData?.optedOut && p.optout.status === "ready" && (
        <div className="form-error sc-error" role="alert">
          <span>{issues.blocker}</span>
        </div>
      )}

      <div className="field">
        <label htmlFor="sc-template">{START_TEXT.templateLabel}</label>
        {p.templates.status === "loading" && (
          <p className="op-state" role="status">
            {START_TEXT.loadingTemplates}
          </p>
        )}
        {p.templates.status === "error" && (
          <div className="form-error sc-error" role="alert">
            <span>{p.templates.message}</span>
            <button type="button" className="btn-secondary btn-small" onClick={p.onRetryLoad}>
              {START_TEXT.retryLoad}
            </button>
          </div>
        )}
        {tpls && !tpls.connected && <p className="sc-field-error">{START_TEXT.notConnected}</p>}
        {tpls && tpls.connected && sendable.length === 0 && <p className="sc-field-error">{START_TEXT.noTemplates}</p>}
        {tpls && tpls.connected && sendable.length > 0 && (
          <select id="sc-template" value={chosen ? chosen.id : ""} disabled={p.busy} onChange={(e) => p.onTemplate(e.target.value)} aria-invalid={show && !!issues.template} aria-describedby={show && issues.template ? "sc-template-err" : undefined}>
            <option value="">{START_TEXT.templatePlaceholder}</option>
            {sendable.map((t) => (
              <option key={t.id} value={t.id}>
                {templateLabel(t)}
              </option>
            ))}
          </select>
        )}
        {show && issues.template && sendable.length > 0 && (
          <p id="sc-template-err" className="sc-field-error" role="alert">
            {issues.template}
          </p>
        )}
        {tpls?.stale && <p className="field-hint">{START_TEXT.stale}</p>}
        {hidden > 0 && <p className="field-hint">{hidden} template{hidden === 1 ? "" : "s"} aprovado{hidden === 1 ? "" : "s"} não aparece{hidden === 1 ? "" : "m"} aqui por ainda não ser{hidden === 1 ? "" : "em"} compatível{hidden === 1 ? "" : "is"} com o envio pelo aplicativo.</p>}
      </div>

      {chosen && chosen.variableCount > 0 && (
        <fieldset className="sc-vars">
          <legend>Variáveis da mensagem</legend>
          {Array.from({ length: chosen.variableCount }, (_, i) => (
            <div className="field" key={`${chosen.id}-${i}`}>
              <label htmlFor={`sc-var-${i}`}>{`Variável {{${i + 1}}}`}</label>
              <input id={`sc-var-${i}`} type="text" autoComplete="off" maxLength={PARAM_MAX + 50} value={p.values[i] ?? ""} disabled={p.busy} onChange={(e) => p.onValue(i, e.target.value)} aria-invalid={show && !!issues.params[i]} aria-describedby={show && issues.params[i] ? `sc-var-${i}-err` : undefined} />
              {show && issues.params[i] && (
                <p id={`sc-var-${i}-err`} className="sc-field-error" role="alert">
                  {issues.params[i]}
                </p>
              )}
            </div>
          ))}
        </fieldset>
      )}

      {chosen && (
        <div className="sc-preview" aria-live="polite">
          <div className="sc-preview-title">{START_TEXT.preview}</div>
          <p className="sc-preview-body" data-testid="sc-preview">
            {renderPreview(chosen.bodyText, p.values)}
          </p>
        </div>
      )}

      <fieldset className="sc-consent">
        <legend>Autorização do contato</legend>
        <label className="sc-check">
          <input type="checkbox" checked={p.consent} disabled={p.busy} onChange={(e) => p.onConsent(e.target.checked)} aria-invalid={show && !!issues.consent} />
          <span>{START_TEXT.consentLabel}</span>
        </label>
        {show && issues.consent && (
          <p className="sc-field-error" role="alert">
            {issues.consent}
          </p>
        )}
        <div className="field">
          <label htmlFor="sc-origin">{START_TEXT.originLabel}</label>
          <select id="sc-origin" value={p.origin} disabled={p.busy} onChange={(e) => p.onOrigin(e.target.value as ConsentOrigin | "")} aria-invalid={show && !!issues.origin}>
            <option value="">{START_TEXT.originPlaceholder}</option>
            {CONSENT_ORIGINS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {show && issues.origin && (
            <p className="sc-field-error" role="alert">
              {issues.origin}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="sc-ref">{START_TEXT.refLabel}</label>
          <input id="sc-ref" type="text" autoComplete="off" maxLength={CONSENT_REF_MAX + 20} value={p.refText} disabled={p.busy} onChange={(e) => p.onRef(e.target.value)} aria-invalid={show && !!issues.ref} aria-describedby="sc-ref-hint" />
          <p id="sc-ref-hint" className={show && issues.ref ? "sc-field-error" : "field-hint"} role={show && issues.ref ? "alert" : undefined}>
            {show && issues.ref ? issues.ref : START_TEXT.refHint}
          </p>
        </div>
      </fieldset>

      {p.banner && (
        <div className={p.banner.tone === "error" ? "form-error sc-error" : "sc-warning"} role="alert">
          <span>{p.banner.text}</span>
        </div>
      )}

      <div className="modal-actions sc-actions">
        <button type="button" className="btn-secondary" disabled={p.busy} onClick={p.onCancel}>
          {START_TEXT.cancel}
        </button>
        <button type="submit" className="btn-primary" disabled={p.busy || (p.touched && !issues.ok)} aria-busy={p.busy}>
          {p.busy ? START_TEXT.sending : p.isRetry ? START_TEXT.retry : START_TEXT.send}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Resultado (accepted/unconfirmed/in_progress/failed com conversa)
// ---------------------------------------------------------------------------
export function StartResultView({ outcome, onOpenConversation, onOpenRequests, onClose }: { outcome: StartOutcome; onOpenConversation: (id: string) => void; onOpenRequests: () => void; onClose: () => void }) {
  const t = OUTCOME_TEXT[outcome.status];
  const tone = outcome.status === "accepted" ? "sc-result-ok" : outcome.status === "failed" ? "sc-result-fail" : "sc-result-warn";
  return (
    <div className={`sc-result ${tone}`} data-testid="sc-result" data-status={outcome.status}>
      <h4 className="sc-result-title">{t.title}</h4>
      <p>{outcome.status === "failed" && outcome.message ? outcome.message : t.detail}</p>
      {outcome.status === "failed" && <p className="muted">A conversa foi criada com a mensagem marcada como não enviada. Você pode abri-la e conferir.</p>}
      <div className="modal-actions sc-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          {START_TEXT.close}
        </button>
        {(outcome.status === "unconfirmed" || outcome.status === "in_progress") && (
          <button type="button" className="btn-secondary" onClick={onOpenRequests}>
            Ver {START_TEXT.requests.toLowerCase()}
          </button>
        )}
        {outcome.conversationId && (
          <button type="button" className="btn-primary" onClick={() => onOpenConversation(outcome.conversationId as string)}>
            {START_TEXT.openExisting}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diálogo: carrega templates e bloqueio, guarda o formulário e chama o controlador
// ---------------------------------------------------------------------------
export function StartConversationDialog({
  companyId,
  source,
  start,
  target,
  contactName,
  phoneText,
  settings,
  onClose,
  onOpenConversation,
  onOpenRequests,
  onStarted,
}: {
  companyId: string;
  source: StartSource;
  /** Controlador (um envio por vez). */
  start: (input: { clientRequestId: string; contactKind: "manual" | "customer"; contactRef: string; templateId: string; params: string[]; consentOrigin: ConsentOrigin; consentRef: string }, expectedVariables: number) => Promise<StartAttempt | { kind: "stale" }>;
  target: StartTarget;
  contactName: string;
  phoneText: string;
  settings: StartSettings;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenRequests: () => void;
  /** Algo foi criado no servidor: a tela atualiza a configuração (vagas do dia) e as solicitações. */
  onStarted: () => void;
}) {
  const [templates, setTemplates] = useState<Load<StartTemplates>>({ status: "loading" });
  const [optout, setOptout] = useState<Load<ContactOptout>>({ status: "loading" });
  const [templateId, setTemplateId] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [origin, setOrigin] = useState<ConsentOrigin | "">("");
  const [refText, setRefText] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [banner, setBanner] = useState<{ tone: "error" | "warning"; text: string } | null>(null);
  const [result, setResult] = useState<StartOutcome | null>(null);
  const [isRetry, setIsRetry] = useState(false);
  // um id por tentativa: repetido enquanto o pedido pode já existir no servidor, renovado depois de uma recusa definitiva
  const requestId = useRef<string>(crypto.randomUUID());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setTemplates({ status: "loading" });
    setOptout({ status: "loading" });
    void source.templates(companyId).then((r) => alive.current && setTemplates(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.message }));
    void source.optout(companyId, target.kind, target.ref).then((r) => alive.current && setOptout(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.message }));
  }, [source, companyId, target.kind, target.ref]);
  useEffect(() => {
    load();
  }, [load]);

  const sendable = useMemo(() => sendableTemplates(templates.status === "ready" ? templates.data : null), [templates]);
  const chosen = sendable.find((t) => t.id === templateId) ?? null;

  async function submit() {
    setTouched(true);
    const issues = startFormIssues({ template: chosen, values, consent, origin, ref: refText, optout: optout.status === "ready" ? optout.data : null, limitReached: dailyLimitReached(settings) });
    if (!issues.ok || !chosen || origin === "") return;
    if (busyRef.current) return; // clique repetido: só um envio por vez
    busyRef.current = true;
    setBusy(true);
    setBanner(null);
    const attempt = await start({ clientRequestId: requestId.current, contactKind: target.kind, contactRef: target.ref, templateId: chosen.id, params: values.slice(0, chosen.variableCount), consentOrigin: origin, consentRef: refText }, chosen.variableCount);
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (attempt.kind === "duplicate" || attempt.kind === "stale") return;
    if (attempt.kind === "blocked") {
      setBanner({ tone: "error", text: attempt.message });
      return;
    }
    const o = attempt.outcome;
    if (!o.keepRequestId) requestId.current = crypto.randomUUID();
    if (o.conversationId || o.requestId) onStarted();
    if (o.status === "accepted" && o.conversationId) {
      onOpenConversation(o.conversationId); // abre ?conversation=<id>
      return;
    }
    if (o.conversationId) {
      setResult(o);
      return;
    }
    setIsRetry(o.keepRequestId);
    setBanner({ tone: o.status === "failed" ? "error" : "warning", text: o.message ?? OUTCOME_TEXT[o.status].detail });
  }

  return (
    <Modal title={START_TEXT.title} onClose={() => !busy && onClose()}>
      {result ? (
        <StartResultView outcome={result} onOpenConversation={onOpenConversation} onOpenRequests={onOpenRequests} onClose={onClose} />
      ) : (
        <StartConversationForm
          contactName={contactName}
          phoneText={phoneText}
          settings={settings}
          templates={templates}
          optout={optout}
          templateId={chosen ? chosen.id : ""}
          values={values}
          consent={consent}
          origin={origin}
          refText={refText}
          touched={touched}
          busy={busy}
          banner={banner}
          isRetry={isRetry}
          onTemplate={(id) => {
            setTemplateId(id);
            setValues([]);
            setBanner(null);
          }}
          onValue={(i, v) => setValues((prev) => Object.assign([...prev], { [i]: v }))}
          onConsent={setConsent}
          onOrigin={setOrigin}
          onRef={setRefText}
          onSubmit={() => void submit()}
          onCancel={onClose}
          onRetryLoad={load}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Solicitações (pedidos de início): acompanhar e resolver o que ficou incerto — NUNCA reenvia
// ---------------------------------------------------------------------------
export function StartRequestsList({
  items,
  busyId,
  message,
  onResolve,
  onOpenConversation,
}: {
  items: StartRequest[];
  busyId: string | null;
  message: string | null;
  onResolve: (requestId: string, resolution: Resolution) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  if (items.length === 0) return <p className="op-state">Nenhuma solicitação por aqui.</p>;
  return (
    <ul className="sc-requests" aria-label="Solicitações de início de conversa">
      {items.map((r) => {
        const actions = allowedResolutions(r.state);
        const delivery = deliveryText(r);
        const when = fmt(r.createdAt);
        return (
          <li key={r.requestId} className={needsAttention(r) ? "sc-req sc-req-attn" : "sc-req"} data-state={r.state} data-testid="sc-request">
            <div className="sc-req-top">
              <strong>{r.contactName ?? "Contato"}</strong>
              <span className={`sc-state sc-state-${r.state}`}>{STATE_LABEL[r.state]}</span>
            </div>
            <div className="sc-req-meta muted">
              {r.templateName && <span>Template: {r.templateName}</span>}
              {when && <span>{when}</span>}
              {delivery && <span>Entrega: {delivery}</span>}
              {r.resolution && <span>{RESOLUTION_DONE[r.resolution] ?? "Resolvida."}</span>}
            </div>
            <p className="sc-req-help">{STATE_HELP[r.state]}</p>
            {actions.length > 0 && (
              <div className="sc-req-actions">
                <label className="sc-check">
                  <input type="checkbox" checked={!!attested[r.requestId]} disabled={busyId !== null} onChange={(e) => setAttested((p) => ({ ...p, [r.requestId]: e.target.checked }))} />
                  <span>Conferi o envio no WhatsApp/Meta antes de resolver.</span>
                </label>
                <div className="mc-actions-row">
                  {actions.map((a) => (
                    <button key={a} type="button" className="btn-secondary btn-small" disabled={busyId !== null || !attested[r.requestId]} onClick={() => onResolve(r.requestId, a)}>
                      {busyId === r.requestId ? "Salvando…" : RESOLUTION_LABEL[a]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {r.conversationId && (
              <button type="button" className="btn-secondary btn-small" onClick={() => onOpenConversation(r.conversationId as string)}>
                {START_TEXT.openExisting}
              </button>
            )}
          </li>
        );
      })}
      {message && (
        <li className="sc-note" role="status">
          {message}
        </li>
      )}
    </ul>
  );
}

export function StartRequestsDialog({
  companyId,
  source,
  onClose,
  onOpenConversation,
  onChanged,
}: {
  companyId: string;
  source: StartSource;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onChanged: () => void;
}) {
  const [onlyAttention, setOnlyAttention] = useState(true);
  const [state, setState] = useState<Load<StartRequest[]>>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  const token = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (attention: boolean) => {
      const t = ++token.current;
      setState({ status: "loading" });
      const r = await source.requests(companyId, attention);
      if (!alive.current || t !== token.current) return; // resposta de uma consulta anterior
      setState(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.message });
    },
    [source, companyId],
  );
  useEffect(() => {
    void load(onlyAttention);
  }, [load, onlyAttention]);

  async function resolve(requestId: string, resolution: Resolution) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(requestId);
    setMessage(null);
    const r = await source.resolve(requestId, resolution, true);
    busyRef.current = false;
    if (!alive.current) return;
    setBusyId(null);
    setMessage(r.ok ? RESOLUTION_DONE[resolution] : r.message);
    if (r.ok) {
      onChanged();
      void load(onlyAttention);
    }
  }

  return (
    <Modal title="Solicitações de início de conversa" onClose={onClose}>
      <div className="sc-requests-wrap">
        <p className="muted">Acompanhe as conversas iniciadas pela empresa. Resultados incertos nunca são reenviados automaticamente: confira e registre o resultado.</p>
        <div className="wc-filter" role="group" aria-label="Mostrar solicitações">
          <button type="button" className={onlyAttention ? "wc-filter-btn wc-filter-btn-on" : "wc-filter-btn"} aria-pressed={onlyAttention} onClick={() => setOnlyAttention(true)}>
            Precisam de ação
          </button>
          <button type="button" className={!onlyAttention ? "wc-filter-btn wc-filter-btn-on" : "wc-filter-btn"} aria-pressed={!onlyAttention} onClick={() => setOnlyAttention(false)}>
            Todas
          </button>
        </div>
        {state.status === "loading" && (
          <p className="op-state" role="status">
            Carregando solicitações…
          </p>
        )}
        {state.status === "error" && (
          <div className="form-error sc-error" role="alert">
            <span>{state.message}</span>
            <button type="button" className="btn-secondary btn-small" onClick={() => void load(onlyAttention)}>
              {START_TEXT.retryLoad}
            </button>
          </div>
        )}
        {state.status === "ready" && <StartRequestsList items={state.data} busyId={busyId} message={message} onResolve={(id, res) => void resolve(id, res)} onOpenConversation={onOpenConversation} />}
        <div className="modal-actions sc-actions">
          <button type="button" className="btn-secondary" onClick={() => void load(onlyAttention)} disabled={state.status === "loading"}>
            Atualizar
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            {START_TEXT.close}
          </button>
        </div>
      </div>
    </Modal>
  );
}

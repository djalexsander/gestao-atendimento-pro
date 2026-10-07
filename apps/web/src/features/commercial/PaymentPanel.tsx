import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDateOnly } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import { supabaseCommercialSource, type CommercialSource } from "./commercialApi";
import { loadPayment, retryPix, type PixLoad } from "./commercialFlow";
import { INVOICE_KIND_TEXT, INVOICE_STATUS_TEXT, pixImageSrc, pollIntervalMs } from "./commercialLogic";
import { useCommercial } from "./CommercialProvider";

// Pagamento Pix de UMA fatura. Mostra só o necessário (valor, vencimento COMERCIAL, status, QR, copia e cola, segunda
// via): nenhum id interno do Asaas. A criação da cobrança é assíncrona e recuperável: "gerando" atualiza sozinho e há
// "Tentar gerar Pix novamente". Pagamento confirmado pelo webhook => a fatura vira paga, o acesso volta (refresh do
// estado global) e o banner some, sem logout. Atualização por refresh controlado (sem Realtime: as tabelas comerciais
// não são expostas ao tenant).
export function PaymentPanel({
  invoiceId,
  source = supabaseCommercialSource,
  onPaid,
}: {
  invoiceId: string;
  source?: CommercialSource;
  onPaid?: () => void;
}) {
  const { refresh } = useCommercial();
  const [load, setLoad] = useState<PixLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const requested = useRef(false);
  const paidNotified = useRef(false);

  const apply = useCallback(
    (next: PixLoad) => {
      setLoad(next);
      if (next.view === "paid" && !paidNotified.current) {
        paidNotified.current = true;
        void refresh();
        onPaid?.();
      }
    },
    [onPaid, refresh],
  );

  const reload = useCallback(
    async (firstTime: boolean) => {
      const requestIfMissing = firstTime && !requested.current;
      if (requestIfMissing) requested.current = true;
      apply(await loadPayment(source, invoiceId, { requestIfMissing }));
    },
    [apply, invoiceId, source],
  );

  useEffect(() => {
    requested.current = false;
    paidNotified.current = false;
    setLoad(null);
    void reload(true);
  }, [invoiceId, reload]);

  const view = load?.view ?? null;
  useEffect(() => {
    const interval = pollIntervalMs(view);
    if (interval === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload(false);
    }, interval);
    return () => window.clearInterval(timer);
  }, [view, reload]);

  async function handleRetry() {
    setBusy(true);
    apply(await retryPix(source, invoiceId));
    setBusy(false);
  }
  async function handleRefresh() {
    setBusy(true);
    await reload(false);
    setBusy(false);
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  if (!load) return <p className="muted">Carregando pagamento…</p>;
  if (load.error || !load.payment) return <div className="form-error">{load.error ?? "Não foi possível carregar o pagamento."}</div>;

  const { invoice, payment } = load.payment;
  const qr = payment && payment.state === "ready" ? pixImageSrc(payment.pix_qr) : null;

  return (
    <section className="payment-panel" aria-live="polite">
      <dl className="payment-summary">
        <div><dt>Fatura</dt><dd>{INVOICE_KIND_TEXT[invoice.kind] ?? invoice.kind}</dd></div>
        <div><dt>Valor</dt><dd>{formatCents(invoice.amount_cents)}</dd></div>
        <div><dt>Vencimento</dt><dd>{fmtDateOnly(invoice.due_date)}</dd></div>
        <div><dt>Situação</dt><dd>{INVOICE_STATUS_TEXT[invoice.status] ?? invoice.status}</dd></div>
      </dl>

      {load.view === "paid" && (
        <div className="form-notice">
          {invoice.kind === "module_addition" ? "Pagamento confirmado. Obrigado! O módulo já está liberado." : "Pagamento confirmado. Obrigado! O acesso completo já está liberado."}
        </div>
      )}
      {load.view === "void" && <div className="form-error">Esta fatura foi anulada.</div>}
      {load.view === "settling" && <div className="form-notice">Pagamento recebido — confirmando. Isto leva alguns instantes.</div>}
      {load.view === "review" && <div className="form-error">Esta cobrança está em análise. Fale com o suporte para regularizar.</div>}

      {load.view === "generating" && (
        <div>
          <p className="muted">Gerando o Pix desta fatura… A tela atualiza sozinha.</p>
          {load.chargeError && <div className="form-error">{load.chargeError}</div>}
          <button type="button" className="btn-secondary btn-auto" onClick={() => void handleRetry()} disabled={busy}>
            {busy ? "Tentando…" : "Tentar gerar Pix novamente"}
          </button>
        </div>
      )}

      {load.view === "ready" && payment && payment.state === "ready" && (
        <div className="payment-pix">
          {qr && <img className="payment-qr" src={qr} alt="QR Code Pix" width={220} height={220} />}
          {payment.pix_payload && (
            <div className="field">
              <label htmlFor="pix-copy">Pix copia e cola</label>
              <div className="input-with-action">
                <input id="pix-copy" readOnly value={payment.pix_payload} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn-secondary" onClick={() => void copy(payment.pix_payload ?? "")}>
                  {copied ? "Copiado!" : "Copiar"}
                </button>
              </div>
            </div>
          )}
          <div className="row-actions">
            {payment.invoice_url && (
              <a className="btn-secondary" href={payment.invoice_url} target="_blank" rel="noreferrer">
                Abrir segunda via
              </a>
            )}
            <button type="button" className="btn-secondary" onClick={() => void handleRefresh()} disabled={busy}>
              {busy ? "Atualizando…" : "Atualizar pagamento"}
            </button>
          </div>
          <p className="field-hint">Depois de pagar, a confirmação chega em instantes e o acesso é liberado automaticamente.</p>
        </div>
      )}
    </section>
  );
}

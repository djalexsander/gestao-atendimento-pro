import { useEffect, useRef, useState } from "react";
import { Modal } from "../employees/Modal";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { supabaseCashSource, type CashSource } from "./cashApi";
import { CashMovementDialog, CloseCashDialog, OpenCashDialog } from "./CashDialogs";
import { reconcile, summarizeMovements, type CashMovementRow } from "./cashLogic";
import { supabaseDocumentsSource, type DocumentsSource } from "../printing/documentsApi";
import { PrintDocumentButton } from "../printing/PrintDocumentButton";
import { notifyCashChanged, useMyOpenCash } from "./useMyOpenCash";

const dateOnly = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const brl = (cents: number) => formatReais(cents / 100);

// Caixa aberto num dia anterior ao de hoje (fuso local): merece alerta destacado.
export function isFromPreviousDay(openedAtIso: string, now: Date = new Date()): boolean {
  return dateOnly.format(new Date(openedAtIso)) !== dateOnly.format(now);
}

// Faixa do Caixa / Balcão no TOPO da tela (antes das Comandas/Mesas) com o estado do PRÓPRIO
// caixa: sem caixa aberto oferece "Abrir caixa"; com caixa aberto mostra operador, abertura e
// saldo inicial e oferece "Fechar caixa" (resumo). Um caixa aberto é sempre retomado (o banco
// só admite um por operador). Só owner/admin/cashier veem; attendant não. O servidor é a
// autoridade (open/close_cash_session). Comandas abertas não impedem o fechamento do caixa.
export function CashControl({
  source = supabaseCashSource,
  documentsSource = supabaseDocumentsSource,
}: {
  source?: CashSource;
  documentsSource?: DocumentsSource;
}) {
  const { activeMembership, profile } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const allowed = role === "owner" || role === "admin" || role === "cashier";

  const { cash, loaded } = useMyOpenCash(allowed, source);
  const [movements, setMovements] = useState<CashMovementRow[]>([]);
  const [dialog, setDialog] = useState<"open" | "close" | "supply" | "withdrawal" | "choose" | null>(null);
  const [stripMovements, setStripMovements] = useState<CashMovementRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Caixa que ESTE operador acabou de fechar: oferece imprimir o fechamento (manual; F8).
  const [closedCashId, setClosedCashId] = useState<string | null>(null);

  // Carrega os movimentos do caixa (prévia de esperado/disponível) e abre o modal.
  async function startDialog(kind: "close" | "supply" | "withdrawal") {
    if (!cash) return;
    const result = await source.listMovements(cash.id);
    setMovements(result.data ?? []);
    setNotice(null);
    setDialog(kind);
  }

  // Faixa do PDV: vendas e dinheiro esperado vêm dos movimentos do próprio caixa (mesma leitura do fechamento); recarrega quando o caixa muda.
  const cashId = cash?.id ?? null;
  useEffect(() => {
    if (!cashId) { setStripMovements([]); return; }
    let alive = true;
    const load = async () => { const r = await source.listMovements(cashId); if (alive && r.data) setStripMovements(r.data); };
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    return () => { alive = false; window.clearInterval(t); };
  }, [cashId, source, dialog]);

  // Atalhos do caixa: F9 suprimento/sangria, F10 fechar caixa (não agem com diálogo aberto nem sem caixa aberto).
  const keyRef = useRef<(k: "F9" | "F10") => void>(() => undefined);
  keyRef.current = (k) => {
    if (!cash || dialog !== null || document.querySelector(".modal")) return;
    if (k === "F9") setDialog("choose");
    else void startDialog("close");
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "F9" || e.key === "F10") && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); if (!e.repeat) keyRef.current(e.key); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!allowed || !companyId || !loaded) return null;

  const operatorName = cash?.openedByName ?? profile?.full_name ?? null;

  return (
    <div className="cash-control cash-control-strip">
      {cash && isFromPreviousDay(cash.openedAt) && (
        <div className="form-error cash-control-alert" role="alert">
          Existe um caixa aberto desde {dateOnly.format(new Date(cash.openedAt))} às{" "}
          {timeOnly.format(new Date(cash.openedAt))}. Feche esse caixa antes de iniciar um novo turno.
        </div>
      )}
      {cash ? (
        <>
          <span className="cash-pill" title={operatorName ? `Caixa de ${operatorName}` : undefined}>
            <span className="cash-dot" aria-hidden="true" /> Caixa aberto desde {timeOnly.format(new Date(cash.openedAt))}
          </span>
          <span className="cash-fig">Troco inicial <strong>{formatReais(cash.openingAmount)}</strong></span>
          <span className="cash-fig">Vendas <strong>{brl(Math.round(summarizeMovements(stripMovements).total * 100))}</strong></span>
          <span className="cash-fig">Dinheiro esperado <strong>{brl(reconcile(cash.openingAmount, summarizeMovements(stripMovements).netCash, "").expectedCents)}</strong></span>
          <span className="cash-spacer" />
          <button className="btn-secondary btn-small" type="button" onClick={() => setDialog("choose")} data-testid="cash-f9">
            Suprimento / Sangria <kbd className="pay-method-key">F9</kbd>
          </button>
          <button className="btn-secondary btn-small" type="button" onClick={() => void startDialog("close")} data-testid="cash-f10">
            Fechar caixa <kbd className="pay-method-key">F10</kbd>
          </button>
        </>
      ) : (
        <>
          <span>Nenhum caixa aberto.</span>
          <button className="btn-primary btn-auto btn-small" type="button" onClick={() => setDialog("open")}>
            Abrir caixa
          </button>
        </>
      )}
      {notice && (
        <span role="status" className="form-notice">
          {notice}
        </span>
      )}
      {!cash && closedCashId && (
        <PrintDocumentButton
          label="Imprimir fechamento"
          successMessage="Fechamento enviado para impressão."
          enabled={dialog === null}
          request={() => documentsSource.cashClosing(closedCashId)}
        />
      )}

      {dialog === "choose" && cash && (
        <Modal title="Suprimento / Sangria" onClose={() => setDialog(null)}>
          <p className="modal-text">O que você quer registrar neste caixa?</p>
          <div className="modal-actions">
            <button className="btn-secondary" type="button" onClick={() => setDialog(null)}>Cancelar</button>
            <button className="btn-primary btn-auto" type="button" autoFocus onClick={() => void startDialog("supply")}>Suprimento (entrada)</button>
            <button className="btn-primary btn-auto" type="button" onClick={() => void startDialog("withdrawal")}>Sangria (retirada)</button>
          </div>
        </Modal>
      )}
      {dialog === "open" && (
        <OpenCashDialog
          source={source}
          companyId={companyId}
          onOpened={() => {
            setDialog(null);
            setNotice(null);
            setClosedCashId(null);
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog === "supply" || dialog === "withdrawal") && cash && (
        <CashMovementDialog
          source={source}
          cash={cash}
          kind={dialog}
          movements={movements}
          operatorName={operatorName}
          onDone={(message) => {
            setDialog(null);
            setNotice(message);
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close" && cash && (
        <CloseCashDialog
          source={source}
          cash={cash}
          operatorName={operatorName}
          movements={movements}
          onClosed={() => {
            setDialog(null);
            setNotice("Caixa fechado com sucesso.");
            setClosedCashId(cash.id);
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

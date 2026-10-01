import { useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { supabaseCashSource, type CashSource } from "./cashApi";
import { CashMovementDialog, CloseCashDialog, OpenCashDialog } from "./CashDialogs";
import type { CashMovementRow } from "./cashLogic";
import { supabaseDocumentsSource, type DocumentsSource } from "../printing/documentsApi";
import { PrintDocumentButton } from "../printing/PrintDocumentButton";
import { notifyCashChanged, useMyOpenCash } from "./useMyOpenCash";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

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
  const [dialog, setDialog] = useState<"open" | "close" | "supply" | "withdrawal" | null>(null);
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

  if (!allowed || !companyId || !loaded) return null;

  const operatorName = cash?.openedByName ?? profile?.full_name ?? null;

  return (
    <div className="cash-control">
      {cash && isFromPreviousDay(cash.openedAt) && (
        <div className="form-error cash-control-alert" role="alert">
          Existe um caixa aberto desde {dateOnly.format(new Date(cash.openedAt))} às{" "}
          {timeOnly.format(new Date(cash.openedAt))}. Feche esse caixa antes de iniciar um novo turno.
        </div>
      )}
      <span>
        {cash
          ? `Caixa aberto${operatorName ? ` por ${operatorName}` : ""} desde ${dateTime.format(new Date(cash.openedAt))} · saldo inicial ${formatReais(cash.openingAmount)}`
          : "Nenhum caixa aberto."}
      </span>
      {cash ? (
        <>
          <button className="btn-secondary btn-small" type="button" onClick={() => void startDialog("supply")}>
            Suprimento
          </button>
          <button className="btn-secondary btn-small" type="button" onClick={() => void startDialog("withdrawal")}>
            Sangria
          </button>
          <button className="btn-secondary btn-small" type="button" onClick={() => void startDialog("close")}>
            Fechar caixa
          </button>
        </>
      ) : (
        <button className="btn-primary btn-auto btn-small" type="button" onClick={() => setDialog("open")}>
          Abrir caixa
        </button>
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

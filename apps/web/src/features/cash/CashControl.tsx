import { useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { supabaseCashSource, type CashSource } from "./cashApi";
import { CloseCashDialog, OpenCashDialog } from "./CashDialogs";
import type { CashMovementRow } from "./cashLogic";
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
export function CashControl({ source = supabaseCashSource }: { source?: CashSource }) {
  const { activeMembership, profile } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const allowed = role === "owner" || role === "admin" || role === "cashier";

  const { cash, loaded } = useMyOpenCash(allowed, source);
  const [movements, setMovements] = useState<CashMovementRow[]>([]);
  const [dialog, setDialog] = useState<"open" | "close" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function startClose() {
    if (!cash) return;
    const result = await source.listMovements(cash.id);
    setMovements(result.data ?? []);
    setDialog("close");
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
        <button className="btn-secondary btn-small" type="button" onClick={() => void startClose()}>
          Fechar caixa
        </button>
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

      {dialog === "open" && (
        <OpenCashDialog
          source={source}
          companyId={companyId}
          onOpened={() => {
            setDialog(null);
            setNotice(null);
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
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

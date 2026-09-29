import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { supabaseCashSource, type CashSession, type CashSource } from "./cashApi";
import { CloseCashDialog, OpenCashDialog } from "./CashDialogs";
import type { CashMovementRow } from "./cashLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

// Faixa do Caixa / Balcão com o estado do PRÓPRIO caixa: sem caixa aberto oferece "Abrir caixa";
// com caixa aberto oferece "Fechar caixa" (abre o resumo). Só owner/admin/cashier veem; attendant
// não vê nada. O servidor continua sendo a autoridade (open/close_cash_session).
export function CashControl({ source = supabaseCashSource }: { source?: CashSource }) {
  const { activeMembership, user, profile } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const userId = user?.id ?? null;
  const allowed = role === "owner" || role === "admin" || role === "cashier";

  const [cash, setCash] = useState<CashSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [movements, setMovements] = useState<CashMovementRow[]>([]);
  const [dialog, setDialog] = useState<"open" | "close" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!companyId || !userId) return;
    const result = await source.getMyOpenCash(companyId, userId);
    if (!result.error) {
      setCash(result.data);
      setLoaded(true);
    }
  }, [companyId, userId, source]);

  useEffect(() => {
    if (allowed) void refresh();
  }, [allowed, refresh]);

  async function startClose() {
    if (!cash) return;
    const result = await source.listMovements(cash.id);
    setMovements(result.data ?? []);
    setDialog("close");
  }

  if (!allowed || !companyId || !loaded) return null;

  return (
    <div className="cash-control">
      <span>
        {cash
          ? `Caixa aberto desde ${dateTime.format(new Date(cash.openedAt))} · saldo inicial ${formatReais(cash.openingAmount)}`
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
            void refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close" && cash && (
        <CloseCashDialog
          source={source}
          cash={cash}
          operatorName={profile?.full_name ?? null}
          movements={movements}
          onClosed={() => {
            setDialog(null);
            setCash(null);
            setNotice("Caixa fechado com sucesso.");
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

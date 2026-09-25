import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDateOnly } from "../../lib/dates";
import { STATUS_LABEL } from "../../lib/subscriptionLabels";
import type { BillingState } from "../../lib/types";
import { getBillingState } from "./subscriptionApi";

// Situação financeira derivada das faturas (calculada no banco). Só leitura:
// a automação diária e a baixa/anulação de faturas é que movem o status.
export function BillingStatus({ subscriptionId }: { subscriptionId: string }) {
  const [state, setState] = useState<BillingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getBillingState(subscriptionId);
      if (cancelled) return;
      setState(result.data);
      setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriptionId]);

  if (error) return <div className="form-error">{error}</div>;
  if (!state) return null;

  return (
    <div style={{ margin: "16px 0" }}>
      <h4>Situação financeira</h4>
      {state.debt_state === "awaiting_initial_payment" && state.initial_invoice_status === "void" ? (
        <p>
          A <strong>cobrança inicial foi anulada</strong>: esta assinatura não pode ser ativada. Cancele-a e contrate
          novamente.{" "}
          {state.initial_invoice_id && <Link to={`/master/faturas/${state.initial_invoice_id}`}>Ver fatura</Link>}
        </p>
      ) : state.debt_state === "awaiting_initial_payment" ? (
        <p>
          Aguardando o <strong>pagamento da cobrança inicial</strong>
          {state.initial_invoice_due_date ? ` (vencimento ${fmtDateOnly(state.initial_invoice_due_date)})` : ""}. A
          assinatura só é liberada comercialmente depois que ela for paga.{" "}
          {state.initial_invoice_overdue && (
            <>
              A cobrança inicial está <strong>vencida há {state.initial_days_overdue} dia(s)</strong>, mas isso não
              gera carência nem restrição: a assinatura segue aguardando o pagamento.{" "}
            </>
          )}
          {state.initial_invoice_id && <Link to={`/master/faturas/${state.initial_invoice_id}`}>Ver fatura</Link>}
        </p>
      ) : state.debt_state === "ok" ? (
        <p>
          Nenhuma fatura vencida em aberto. Status: <strong>{STATUS_LABEL[state.status]}</strong>
          {state.status_source === "manual" ? " (definido manualmente)" : " (automático)"}.
        </p>
      ) : (
        <p>
          Fatura vencida há <strong>{state.days_overdue} dia(s)</strong> (vencimento{" "}
          {fmtDateOnly(state.oldest_due_date)}
          {state.overdue_count > 1 ? `; ${state.overdue_count} faturas vencidas` : ""}).{" "}
          {state.debt_state === "grace" ? (
            <>
              Em carência até <strong>{fmtDateOnly(state.debt_grace_until)}</strong>; restrição a partir de{" "}
              <strong>{fmtDateOnly(state.restriction_from)}</strong>.
            </>
          ) : (
            <>
              Restrita desde <strong>{fmtDateOnly(state.restriction_from)}</strong> (leitura mantida).
            </>
          )}{" "}
          {state.oldest_overdue_invoice_id && (
            <Link to={`/master/faturas/${state.oldest_overdue_invoice_id}`}>Ver fatura</Link>
          )}
        </p>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        O status muda sozinho conforme as faturas (vencida → carência de 3 dias → restrita; paga → ativa). Estados
        manuais como suspensa e cancelada nunca são alterados pela automação. Para liberar uma restrição
        automática, quite ou anule a fatura vencida.
      </p>
    </div>
  );
}

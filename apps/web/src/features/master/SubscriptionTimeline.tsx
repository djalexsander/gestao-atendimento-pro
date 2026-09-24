import { useEffect, useState } from "react";
import { fmtCompetence } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import type { SubscriptionHistory } from "../../lib/types";
import { getSubscriptionHistory } from "./subscriptionApi";

// Mostra ao Master A PARTIR DE QUAL COMPETÊNCIA cada alteração contratual vale.
// A regra é aplicada no banco (não aqui): a alteração vale para a primeira
// competência ainda não faturada, a partir do mês em que foi feita.
export function SubscriptionTimeline({ subscriptionId }: { subscriptionId: string }) {
  const [history, setHistory] = useState<SubscriptionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getSubscriptionHistory(subscriptionId);
      if (cancelled) return;
      setHistory(result.data);
      setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriptionId]);

  return (
    <div>
      <h4 style={{ marginTop: 24 }}>Vigência do contrato por competência</h4>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Toda alteração (plano, dia de vencimento, módulos adicionais) vale a partir da primeira competência
        ainda não faturada, contando do mês em que foi feita — competência inteira, sem prorrata. Faturas já
        geradas, inclusive de meses futuros, são imutáveis e não mudam. Ao gerar uma competência passada, o
        sistema usa o contrato que valia naquela competência, não o atual.
      </p>
      {error && <div className="form-error">{error}</div>}
      {history && (
        <>
          <ul style={{ paddingLeft: 18 }}>
            {history.terms.map((t) => (
              <li key={t.id}>
                A partir de <strong>{fmtCompetence(t.effective_from_competence)}</strong>: plano {t.plan_name} (
                {formatCents(t.plan_price_cents)}), vence dia {t.billing_day}
              </li>
            ))}
          </ul>
          {history.extras.length > 0 && (
            <ul style={{ paddingLeft: 18 }}>
              {history.extras.map((e) => (
                <li key={e.id}>
                  Extra {e.name} ({formatCents(e.price_cents)}): cobrado de{" "}
                  <strong>{fmtCompetence(e.effective_from_competence)}</strong>
                  {e.effective_to_competence
                    ? e.effective_to_competence === e.effective_from_competence
                      ? " — nunca cobrado (removido antes de ser faturado)"
                      : ` até a competência anterior a ${fmtCompetence(e.effective_to_competence)}`
                    : " em diante"}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import type { CommercialSource, Quote } from "./commercialApi";

/**
 * Cotação feita pelo SERVIDOR (tenant_quote_subscription): o frontend só exibe. Enquanto a resposta não chega (ou se falhar)
 * o chamador mostra a estimativa local; o total confirmado e cobrado é sempre o do servidor.
 */
export function useServerQuote(
  source: CommercialSource,
  companyId: string,
  planId: string | null,
  extraModuleIds: readonly string[],
  enabled = true,
): { quote: Quote | null; pending: boolean; error: string | null } {
  const key = `${companyId}|${planId}|${[...extraModuleIds].sort().join(",")}`;
  const [state, setState] = useState<{ key: string; quote: Quote | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !planId) return;
    let cancelled = false;
    const ids = key.split("|")[2] ? key.split("|")[2].split(",") : [];
    const timer = window.setTimeout(() => {
      void source.quote(companyId, planId, ids).then((result) => {
        if (cancelled) return;
        setState(result.error === null ? { key, quote: result.data, error: null } : { key, quote: null, error: result.error });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, enabled, source, companyId, planId]);

  const fresh = state && state.key === key ? state : null;
  return { quote: fresh?.quote ?? null, pending: enabled && !!planId && !fresh, error: fresh?.error ?? null };
}

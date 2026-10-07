import { useEffect, useState } from "react";
import type { CommercialSource, ModuleChangeQuote } from "./commercialApi";

/**
 * Cotação da alteração de módulos feita pelo SERVIDOR (tenant_quote_module_change): novo total, vigência e se a alteração
 * foi empurrada para o ciclo seguinte (fatura já emitida). O frontend só exibe.
 */
export function useModuleChangeQuote(
  source: CommercialSource,
  companyId: string,
  moduleIds: readonly string[],
  enabled: boolean,
): { quote: ModuleChangeQuote | null; pending: boolean; error: string | null } {
  const key = `${companyId}|${[...moduleIds].sort().join(",")}`;
  const [state, setState] = useState<{ key: string; quote: ModuleChangeQuote | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const ids = key.split("|")[1] ? key.split("|")[1].split(",") : [];
    const timer = window.setTimeout(() => {
      void source.quoteModuleChange(companyId, ids).then((result) => {
        if (cancelled) return;
        setState(result.error === null ? { key, quote: result.data, error: null } : { key, quote: null, error: result.error });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, enabled, source, companyId]);

  const fresh = state && state.key === key ? state : null;
  return { quote: fresh?.quote ?? null, pending: enabled && !fresh, error: fresh?.error ?? null };
}

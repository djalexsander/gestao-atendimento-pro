import { useEffect, useState } from "react";
import { loadOperationalPreferences } from "./systemApi";
import { DEFAULT_OPERATIONAL_PREFERENCES, type OperationalPreferences } from "./systemLogic";

const STALE_AFTER_MS = 60_000;

// Preferências da empresa para as listagens operacionais. Começa no padrão (como hoje), carrega ao abrir e
// ao voltar para a aba depois de 1 min (sem polling). Falha silenciosa = padrão.
export function useOperationalPreferences(companyId: string | null): { prefs: OperationalPreferences; loaded: boolean } {
  const [state, setState] = useState<{ prefs: OperationalPreferences; loaded: boolean }>({
    prefs: DEFAULT_OPERATIONAL_PREFERENCES,
    loaded: false,
  });

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    let loadedAt = 0;
    const load = () => {
      void loadOperationalPreferences(companyId).then((prefs) => {
        if (!live) return;
        loadedAt = Date.now();
        setState({ prefs, loaded: true });
      });
    };
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt > STALE_AFTER_MS) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [companyId]);

  return state;
}

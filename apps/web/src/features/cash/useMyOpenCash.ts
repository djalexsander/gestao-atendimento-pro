import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { supabaseCashSource, type CashSession, type CashSource } from "./cashApi";

// Quem abre/fecha caixa avisa aqui; todo componente que mostra o estado do caixa recarrega do
// banco (o banco é a autoridade — nada de localStorage nem estado copiado).
const CASH_CHANGED_EVENT = "cash:changed";

export function notifyCashChanged() {
  window.dispatchEvent(new Event(CASH_CHANGED_EVENT));
}

// Caixa ABERTO do próprio usuário na empresa ativa (null = sem caixa). `loaded` só vira true
// depois de uma leitura bem-sucedida, para a tela não afirmar "sem caixa" antes de saber.
export function useMyOpenCash(enabled: boolean, source: CashSource = supabaseCashSource) {
  const { activeMembership, user } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const userId = user?.id ?? null;
  const [cash, setCash] = useState<CashSession | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !companyId || !userId) return;
    const result = await source.getMyOpenCash(companyId, userId);
    if (!result.error) {
      setCash(result.data);
      setLoaded(true);
    }
  }, [enabled, companyId, userId, source]);

  useEffect(() => {
    void refresh();
    window.addEventListener(CASH_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASH_CHANGED_EVENT, refresh);
  }, [refresh]);

  return { cash, loaded, refresh };
}

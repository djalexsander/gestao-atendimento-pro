import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../app/useAuth";
import { supabaseCommercialSource, type CommercialSource, type Entitlements } from "./commercialApi";
import { READ_ONLY_EVENT, isReadOnlyState, type AccessInfo } from "./commercialLogic";

// Estado comercial GLOBAL da empresa ativa (tenant_get_access_state): lido ao entrar, ao trocar de empresa, ao voltar
// para a aba, a cada minuto e quando qualquer mutação recebe PT402. É só exibição (banner/avisos): quem barra a escrita
// é o banco. Pagamento confirmado pelo webhook => o próximo refresh vira active e o banner some sem logout.
interface CommercialContextValue {
  info: AccessInfo | null;
  // módulos que a empresa pode usar agora (null = ainda carregando): vem do banco e é renovado junto com o estado comercial
  entitlements: Entitlements | null;
  loading: boolean;
  readOnly: boolean;
  // aviso transitório do último PT402 (mensagem amigável + ação)
  readOnlyNoticeAt: number | null;
  dismissReadOnlyNotice: () => void;
  refresh: () => Promise<void>;
}

const CommercialContext = createContext<CommercialContextValue | null>(null);
const REFRESH_MS = 60_000;

export function CommercialProvider({ children, source = supabaseCommercialSource }: { children: ReactNode; source?: CommercialSource }) {
  const { session, activeCompanyId } = useAuth();
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [loading, setLoading] = useState(false);
  const [noticeAt, setNoticeAt] = useState<number | null>(null);
  const companyRef = useRef<string | null>(null);
  companyRef.current = session ? activeCompanyId : null;

  const refresh = useCallback(async () => {
    const companyId = companyRef.current;
    if (!companyId) {
      setInfo(null);
      return;
    }
    const [result, ent] = await Promise.all([source.getAccessState(companyId), source.getEntitlements(companyId)]);
    // a empresa pode ter mudado durante a chamada
    if (companyRef.current !== companyId) return;
    if (result.error === null) setInfo(result.data);
    if (ent.error === null) setEntitlements(ent.data);
  }, [source]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setEntitlements(null);
    if (!session || !activeCompanyId) return;
    setLoading(true);
    void refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [session, activeCompanyId, refresh]);

  useEffect(() => {
    if (!session || !activeCompanyId) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onReadOnly = () => {
      setNoticeAt(Date.now());
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(READ_ONLY_EVENT, onReadOnly);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(READ_ONLY_EVENT, onReadOnly);
    };
  }, [session, activeCompanyId, refresh]);

  const value = useMemo<CommercialContextValue>(
    () => ({
      info,
      entitlements,
      loading,
      readOnly: isReadOnlyState(info?.state),
      readOnlyNoticeAt: noticeAt,
      dismissReadOnlyNotice: () => setNoticeAt(null),
      refresh,
    }),
    [info, entitlements, loading, noticeAt, refresh],
  );
  return <CommercialContext.Provider value={value}>{children}</CommercialContext.Provider>;
}

export function useCommercial(): CommercialContextValue {
  const ctx = useContext(CommercialContext);
  if (!ctx) throw new Error("useCommercial precisa estar dentro de <CommercialProvider>.");
  return ctx;
}

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { browserPwaEnv } from "./browserPwaEnv";
import { createPwaUpdateController, type PwaUpdateController } from "./pwaUpdateLogic";
import { PwaUpdateBanner } from "./PwaUpdateBanner";
import { PwaUpdateContext, type PwaUpdateContextValue } from "./pwaUpdateContext";

// Camada central de atualização do PWA (ver pwaUpdateLogic.ts). Só existe no navegador/PWA: no Desktop (Tauri) nada é
// registrado e nenhum banner aparece — quem atualiza o Desktop é o updater do Tauri.

export function PwaUpdateProvider({ children, controller }: { children: ReactNode; controller?: PwaUpdateController }) {
  const ctl = useMemo(() => controller ?? createPwaUpdateController(browserPwaEnv()), [controller]);
  const state = useSyncExternalStore(ctl.subscribe, ctl.getState, ctl.getState);

  useEffect(() => ctl.start(), [ctl]);

  const value = useMemo<PwaUpdateContextValue>(() => ({ state, dismiss: ctl.dismiss, applyNow: ctl.applyNow }), [state, ctl]);
  return (
    <PwaUpdateContext.Provider value={value}>
      {children}
      <PwaUpdateBanner />
    </PwaUpdateContext.Provider>
  );
}

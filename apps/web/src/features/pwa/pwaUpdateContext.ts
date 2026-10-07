import { createContext, useContext } from "react";
import type { PwaUpdateState } from "./pwaUpdateLogic";

export interface PwaUpdateContextValue {
  state: PwaUpdateState;
  dismiss(): void;
  applyNow(): Promise<void>;
}
export const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null);

export function usePwaUpdate(): PwaUpdateContextValue {
  const ctx = useContext(PwaUpdateContext);
  if (!ctx) throw new Error("usePwaUpdate precisa estar dentro de <PwaUpdateProvider>.");
  return ctx;
}

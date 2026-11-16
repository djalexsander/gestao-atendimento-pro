import { useMemo, useRef } from "react";
import type { ConversationRow } from "./whatsappLogic";

/**
 * Estado MUTÁVEL do pedido externo da caixa de entrada (?conversation=), fora da renderização:
 *  - pinned: conversa pedida de fora que passa do limite da lista (fica fixada enquanto estiver selecionada);
 *  - listCompany: empresa a que a lista atual pertence (na troca de empresa ela ainda pode ser a da anterior);
 *  - handled: pedido (empresa + id) já tratado, para não reabrir depois que a pessoa escolhe outra conversa.
 * Fica num objeto estável com acessores (e não em refs soltas no componente) para que os callbacks usados em useMemo/useCallback da
 * caixa de entrada não leiam `.current` durante a renderização. O comportamento é idêntico ao das refs: nada aqui causa nova renderização.
 */
export interface OpenRequestStore {
  getPinned(): ConversationRow | null;
  setPinned(row: ConversationRow | null): void;
  getListCompany(): string | null;
  setListCompany(companyId: string | null): void;
  getHandled(): string | null;
  setHandled(key: string | null): void;
}

export function useOpenRequestStore(): OpenRequestStore {
  const pinned = useRef<ConversationRow | null>(null);
  const listCompany = useRef<string | null>(null);
  const handled = useRef<string | null>(null);
  return useMemo<OpenRequestStore>(
    () => ({
      getPinned: () => pinned.current,
      setPinned: (row) => {
        pinned.current = row;
      },
      getListCompany: () => listCompany.current,
      setListCompany: (companyId) => {
        listCompany.current = companyId;
      },
      getHandled: () => handled.current,
      setHandled: (key) => {
        handled.current = key;
      },
    }),
    [],
  );
}

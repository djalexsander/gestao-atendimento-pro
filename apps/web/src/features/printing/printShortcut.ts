import { useEffect, useRef } from "react";

// F8 = Imprimir. Atalho CONTEXTUAL: quem o registra é o componente do botão de impressão (e o
// remove ao desmontar); não existe listener global. É só conveniência de desktop — o botão
// continua visível e utilizável em celular/tablet.

export interface ShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export interface ShortcutEventLike {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target: ShortcutTarget | null;
  preventDefault(): void;
}

export interface ShortcutState {
  enabled: boolean; // há documento válido e a tela está ativa
  busy: boolean; // um pedido de impressão já está em andamento
  hasOpenDialog: boolean; // algum <dialog> aberto na página
  allowInDialog: boolean; // o botão mora dentro desse diálogo (ex.: "Conta fechada")
}

export function isEditableTarget(target: ShortcutTarget | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Decide e, se for o caso, dispara a MESMA ação do botão. Devolve true quando tratou o F8.
export function handlePrintShortcut(event: ShortcutEventLike, state: ShortcutState, action: () => void): boolean {
  if (event.key !== "F8") return false;
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
  if (!state.enabled || state.busy) return false;
  if (isEditableTarget(event.target)) return false;
  if (state.hasOpenDialog && !state.allowInDialog) return false;
  event.preventDefault();
  action();
  return true;
}

export interface KeyTarget {
  addEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
}

// Registra o F8 num alvo (window) e devolve o cleanup. Separado do hook para ser testável sem DOM.
export function registerPrintShortcut(
  target: KeyTarget,
  getAction: () => () => void,
  getState: () => ShortcutState,
): () => void {
  function onKeyDown(event: KeyboardEvent) {
    handlePrintShortcut(event as unknown as ShortcutEventLike, getState(), getAction());
  }
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

export function usePrintShortcut(action: () => void, getState: () => Omit<ShortcutState, "hasOpenDialog">) {
  const actionRef = useRef(action);
  const stateRef = useRef(getState);
  actionRef.current = action;
  stateRef.current = getState;

  useEffect(
    () =>
      registerPrintShortcut(
        window,
        () => actionRef.current,
        () => ({ ...stateRef.current(), hasOpenDialog: document.querySelector("dialog[open]") !== null }),
      ),
    [],
  );
}

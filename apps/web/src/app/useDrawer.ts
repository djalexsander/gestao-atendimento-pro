import { useEffect, type RefObject } from "react";

/** Largura (px) até a qual o menu lateral vira drawer (celular e tablet em pé). Mantida igual ao @media do index.css. */
export const DRAWER_MAX_WIDTH = 900;

// Comportamento de acessibilidade do drawer: ESC fecha, o foco entra no drawer ao abrir e volta ao botão que o abriu, Tab fica
// preso dentro dele enquanto aberto, a página de trás não rola, e crescer a janela acima do ponto de corte fecha o drawer.
export function useDrawer({
  open,
  onClose,
  drawerRef,
  openerRef,
}: {
  open: boolean;
  onClose: () => void;
  drawerRef: RefObject<HTMLElement | null>;
  openerRef: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const opener = openerRef.current;
    const focusables = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => el.offsetParent !== null,
      );
    focusables()[0]?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);

    const media = window.matchMedia?.(`(min-width: ${DRAWER_MAX_WIDTH + 1}px)`);
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) onClose();
    };
    media?.addEventListener?.("change", onWide);

    return () => {
      document.removeEventListener("keydown", onKey);
      media?.removeEventListener?.("change", onWide);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [open, onClose, drawerRef, openerRef]);
}

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { nextFocusIndex, resolveCategorySelection, scrollDeltaToListStart, type CategoryBarItem } from "./categoryBarLogic";

// Estado da categoria selecionada para quem usa a barra: a seleção efetiva nunca aponta para uma categoria que sumiu
// (excluída/inativada => volta para "Todos"); durante um recarregamento normal a escolha é preservada.
export function useCategorySelection(categories: readonly CategoryBarItem[]): [string | null, (id: string | null) => void] {
  const [selected, setSelected] = useState<string | null>(null);
  const effective = resolveCategorySelection(selected, categories);
  useEffect(() => {
    if (selected !== null && effective === null) setSelected(null);
  }, [selected, effective]);
  return [effective, setSelected];
}

/**
 * Barra de categorias: UMA linha horizontal rolável (swipe no celular), botão "Todos" + um botão por categoria, destaque na
 * selecionada (aria-pressed), foco visível e setas/Home/End no teclado. Fica FIXA no topo da área de produtos (sticky) logo abaixo
 * do cabeçalho; quem a usa só fornece as categorias reais da empresa.
 */
export function CategoryBar({
  categories,
  value,
  onChange,
  label = "Categorias",
  allLabel = "Todos",
  className = "",
}: {
  categories: readonly CategoryBarItem[];
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  allLabel?: string;
  className?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const items: Array<{ id: string | null; name: string }> = [{ id: null, name: allLabel }, ...categories];

  // mantém o botão selecionado visível dentro da barra (sem rolar a página)
  useEffect(() => {
    const active = groupRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    const group = groupRef.current;
    if (!active || !group) return;
    const left = active.offsetLeft - group.clientWidth / 2 + active.clientWidth / 2;
    if (typeof group.scrollTo === "function") group.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
    else group.scrollLeft = Math.max(0, left);
  }, [value, categories.length]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(groupRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const next = nextFocusIndex(event.key, current, buttons.length);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className={`category-bar ${className}`.trim()}
      role="group"
      aria-label={label}
      data-category-bar=""
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id ?? "__all"}
          type="button"
          className="op-chip category-chip"
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.name}
        </button>
      ))}
    </div>
  );
}

/** Depois de trocar a categoria, leva o INÍCIO DA LISTA para logo abaixo da barra fixa (só se ele ficou atrás dela). */
export function useScrollToListStart(): { anchorRef: React.RefObject<HTMLDivElement | null>; scrollToListStart: () => void } {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const scrollToListStart = useCallback(() => {
    requestAnimationFrame(() => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const bar = anchor.parentElement?.querySelector<HTMLElement>("[data-category-bar]");
      const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
      const delta = scrollDeltaToListStart(anchor.getBoundingClientRect().top, barBottom);
      if (delta !== 0) window.scrollBy({ top: delta, behavior: "auto" });
    });
  }, []);
  return { anchorRef, scrollToListStart };
}

// Lógica ÚNICA da barra de categorias (Cadastros → Produtos e catálogo do atendimento/caixa/delivery). As categorias vêm SEMPRE
// da fonte oficial da empresa (nada de lista fixa); aqui só se decide o que mostrar e como a seleção se comporta.

export interface CategoryBarItem {
  id: string;
  name: string;
}

/** Categorias exibidas como botões: só as ATIVAS (quando o campo existe), na ordem recebida da fonte oficial, sem repetir. */
export function barCategories<T extends { id: string; name: string; is_active?: boolean }>(categories: readonly T[]): CategoryBarItem[] {
  const seen = new Set<string>();
  const out: CategoryBarItem[] = [];
  for (const c of categories) {
    if (c.is_active === false || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, name: c.name });
  }
  return out;
}

/** Seleção efetiva: a categoria escolhida só vale se ainda existe na lista; excluída/inativada/inexistente volta para Todos (null). */
export function resolveCategorySelection(selectedId: string | null, categories: readonly CategoryBarItem[]): string | null {
  if (selectedId === null) return null;
  return categories.some((c) => c.id === selectedId) ? selectedId : null;
}

/** Navegação por teclado entre os botões (setas, Home, End). Devolve o índice a focar, ou null se a tecla não é de navegação. */
export function nextFocusIndex(key: string, current: number, total: number): number | null {
  if (total <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % total;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return null;
  }
}

/** Ao trocar de categoria: só rola se o início da lista ficou ATRÁS da barra fixa (nunca joga a página inteira para o topo). */
export function scrollDeltaToListStart(listTop: number, barBottom: number): number {
  return listTop < barBottom ? listTop - barBottom : 0;
}

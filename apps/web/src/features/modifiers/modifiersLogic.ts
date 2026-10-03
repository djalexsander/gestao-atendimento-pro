// Lógica PURA de adicionais / modificadores de produto (sem React, sem Supabase), testável à parte.
// A AUTORIDADE continua no banco: submit_service_order (migration 20261002010000) valida empresa,
// vínculo com o produto, ativo, min/max e CALCULA o acréscimo. Aqui só há UX: seleção, mensagens,
// total informativo e agrupamento de linhas da cesta.

export type SelectionType = "single" | "multiple";
export type ModifierType = "add" | "remove";

export interface ModifierOption {
  id: string;
  groupId: string;
  name: string;
  type: ModifierType;
  priceDelta: number;
  sortOrder: number;
  isActive: boolean;
}

export interface ModifierGroup {
  id: string;
  name: string;
  selectionType: SelectionType;
  minSelection: number;
  maxSelection: number | null; // null = sem limite (só multiple)
  sortOrder: number;
  isActive: boolean;
  options: ModifierOption[];
}

// O que ficou escolhido num item da cesta (ids + rótulos para exibir sem consultar o banco de novo).
export interface SelectedModifier {
  optionId: string;
  groupName: string;
  name: string;
  type: ModifierType;
  priceDelta: number;
}

export const NAME_MAX = 60;

function byOrder<T extends { sortOrder: number; name: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR");
}

// Só o que o garçom vê: grupos ativos com ao menos uma opção ativa, na ordem configurada.
export function activeGroups(groups: ModifierGroup[]): ModifierGroup[] {
  return groups
    .filter((g) => g.isActive)
    .map((g) => ({ ...g, options: g.options.filter((o) => o.isActive).sort(byOrder) }))
    .filter((g) => g.options.length > 0)
    .sort(byOrder);
}

// Máximo efetivo de um grupo (single = 1; multiple = max_selection ou sem limite).
export function groupMax(group: Pick<ModifierGroup, "selectionType" | "maxSelection">): number | null {
  return group.selectionType === "single" ? 1 : group.maxSelection;
}

// Mínimo efetivo: nunca maior que a quantidade de opções disponíveis (grupo sem opção não trava a venda).
export function groupMin(group: Pick<ModifierGroup, "minSelection" | "options">): number {
  return Math.min(group.minSelection, group.options.length);
}

export function isRequired(group: Pick<ModifierGroup, "minSelection" | "options">): boolean {
  return groupMin(group) >= 1;
}

// "Escolha até 1" / "Escolha de 1 a 3" / "Escolha pelo menos 1" / "Opcional".
export function groupHint(group: ModifierGroup): string {
  const min = groupMin(group);
  const max = groupMax(group);
  if (max === 1 && min === 1) return "Escolha 1 opção";
  if (min >= 1 && max !== null) return min === max ? `Escolha ${min} opções` : `Escolha de ${min} a ${max}`;
  if (min >= 1) return `Escolha pelo menos ${min}`;
  if (max !== null) return `Opcional · até ${max}`;
  return "Opcional";
}

// Toque numa opção. single: seleciona (e, se opcional, tocar de novo desmarca); multiple: alterna, mas
// não passa do máximo (devolve a seleção inalterada).
export function toggleOption(group: ModifierGroup, selected: string[], optionId: string): string[] {
  const has = selected.includes(optionId);
  const inGroup = new Set(group.options.map((o) => o.id));
  if (group.selectionType === "single") {
    const others = selected.filter((id) => !inGroup.has(id));
    if (has) return isRequired(group) ? selected : others;
    return [...others, optionId];
  }
  if (has) return selected.filter((id) => id !== optionId);
  const max = groupMax(group);
  const count = selected.filter((id) => inGroup.has(id)).length;
  if (max !== null && count >= max) return selected;
  return [...selected, optionId];
}

// Opção que não pode mais ser marcada (limite do grupo atingido).
export function isOptionBlocked(group: ModifierGroup, selected: string[], optionId: string): boolean {
  if (group.selectionType === "single" || selected.includes(optionId)) return false;
  const max = groupMax(group);
  if (max === null) return false;
  const inGroup = new Set(group.options.map((o) => o.id));
  return selected.filter((id) => inGroup.has(id)).length >= max;
}

export function groupError(group: ModifierGroup, selected: string[]): string | null {
  const inGroup = new Set(group.options.map((o) => o.id));
  const count = selected.filter((id) => inGroup.has(id)).length;
  const min = groupMin(group);
  const max = groupMax(group);
  if (count < min) return `Escolha pelo menos ${min} ${min === 1 ? "opção" : "opções"} em "${group.name}".`;
  if (max !== null && count > max) return `Escolha no máximo ${max} ${max === 1 ? "opção" : "opções"} em "${group.name}".`;
  return null;
}

export function firstSelectionError(groups: ModifierGroup[], selected: string[]): string | null {
  for (const group of groups) {
    const problem = groupError(group, selected);
    if (problem) return problem;
  }
  return null;
}

// Acréscimo POR UNIDADE (informativo; o servidor recalcula).
export function extraPerUnit(groups: ModifierGroup[], selected: string[]): number {
  let sum = 0;
  for (const group of groups) for (const option of group.options) if (selected.includes(option.id)) sum += option.priceDelta;
  return Math.round(sum * 100) / 100;
}

// Seleção -> lista ordenada como o garçom vê (grupo, depois opção).
export function selectedModifiers(groups: ModifierGroup[], selected: string[]): SelectedModifier[] {
  const out: SelectedModifier[] = [];
  for (const group of groups) {
    for (const option of group.options) {
      if (selected.includes(option.id)) {
        out.push({ optionId: option.id, groupName: group.name, name: option.name, type: option.type, priceDelta: option.priceDelta });
      }
    }
  }
  return out;
}

// Todos os grupos opcionais e nada obrigatório: dá para "adicionar sem alterações".
export function canAddWithoutChanges(groups: ModifierGroup[]): boolean {
  return groups.every((g) => !isRequired(g));
}

// Chave de agrupamento: só junta linhas com o MESMO produto, as MESMAS opções e a MESMA observação.
export function lineKey(productId: string, optionIds: string[], notes: string): string {
  return `${productId}|${[...optionIds].sort().join(",")}|${notes.trim()}`;
}

// --- Admin -------------------------------------------------------------------------------------

export function validateModifierName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Informe o nome.";
  if (name.length > NAME_MAX) return `O nome pode ter no máximo ${NAME_MAX} caracteres.`;
  return null;
}

// "5", "5,00", "5.5" -> número em reais com 2 casas; negativo/inválido -> null.
export function parseDelta(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return 0;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100) / 100;
}

export function groupSummary(group: ModifierGroup): string {
  const count = group.options.length;
  return `${count} ${count === 1 ? "opção" : "opções"}`;
}

export function selectionTypeLabel(type: SelectionType): string {
  return type === "single" ? "Escolher 1" : "Escolher várias";
}

// Mensagens PT4xx do banco já vêm em português; o resto vira texto genérico.
export function describeModifierError(error: { code?: string | null; message?: string | null }, fallback: string): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  if (code === "23514") return "Confira os valores informados (limites do grupo ou preço).";
  if (code === "23505") return "Este vínculo já existe.";
  return fallback;
}

// --- Carregamento do catálogo (garçom) ---------------------------------------------------------

export interface RawModifierGroup {
  id: string;
  name: string;
  selection_type: SelectionType;
  min_selection: number;
  max_selection: number | null;
  sort_order: number;
  is_active: boolean;
}
export interface RawModifierOption {
  id: string;
  group_id: string;
  name: string;
  modifier_type: ModifierType;
  price_delta: number | string;
  sort_order: number;
  is_active: boolean;
}
export interface RawModifierLink {
  group_id: string;
  product_id: string;
}
export type QueryPart<T> = { data: T[] | null; error: unknown };

export interface ProductModifiers {
  groups: ModifierGroup[];
  // true = NÃO sabemos se o produto tem opções (falha ao carregar). Diferente de "não tem": groups vazio e failed false.
  failed: boolean;
}

// Monta, por produto, os grupos ativos com opções. Falha de consulta NUNCA vira "sem modificadores":
//   - vínculos falharam  -> TODOS os produtos ficam "failed" (não dá para provar que algum não tem grupo);
//   - grupos/opções falharam -> ficam "failed" só os produtos que TÊM vínculo (os demais, sem vínculo, são provadamente sem grupos).
export function buildProductModifiers(
  productIds: string[],
  groupsRes: QueryPart<RawModifierGroup>,
  optionsRes: QueryPart<RawModifierOption>,
  linksRes: QueryPart<RawModifierLink>,
): Map<string, ProductModifiers> {
  const out = new Map<string, ProductModifiers>();
  if (linksRes.error || !linksRes.data) {
    for (const id of productIds) out.set(id, { groups: [], failed: true });
    return out;
  }
  const detailFailed = Boolean(groupsRes.error || optionsRes.error || !groupsRes.data || !optionsRes.data);
  const optionsByGroup = new Map<string, ModifierOption[]>();
  for (const o of optionsRes.data ?? []) {
    const list = optionsByGroup.get(o.group_id) ?? [];
    list.push({ id: o.id, groupId: o.group_id, name: o.name, type: o.modifier_type, priceDelta: Number(o.price_delta), sortOrder: o.sort_order, isActive: o.is_active });
    optionsByGroup.set(o.group_id, list);
  }
  const groupById = new Map<string, ModifierGroup>();
  for (const g of groupsRes.data ?? []) {
    groupById.set(g.id, {
      id: g.id,
      name: g.name,
      selectionType: g.selection_type,
      minSelection: g.min_selection,
      maxSelection: g.max_selection,
      sortOrder: g.sort_order,
      isActive: g.is_active,
      options: optionsByGroup.get(g.id) ?? [],
    });
  }
  const linked = new Map<string, ModifierGroup[]>();
  const linkedAny = new Set<string>();
  for (const link of linksRes.data) {
    linkedAny.add(link.product_id);
    const group = groupById.get(link.group_id);
    if (!group) continue;
    linked.set(link.product_id, [...(linked.get(link.product_id) ?? []), group]);
  }
  for (const id of productIds) {
    if (detailFailed && linkedAny.has(id)) out.set(id, { groups: [], failed: true });
    else out.set(id, { groups: activeGroups(linked.get(id) ?? []), failed: false });
  }
  return out;
}

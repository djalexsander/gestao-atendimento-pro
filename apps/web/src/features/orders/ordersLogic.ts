// Lógica PURA do fluxo de pedido do atendimento: catálogo visual, cesta local e formatação.
// Sem React e sem Supabase, de propósito, para ser testada à parte. A AUTORIDADE de preço, nome,
// setor e permissão continua inteira no backend (submit_service_order, migration 20260928020000)
// — nada aqui é revalidado como regra de negócio, só UX (feedback imediato e cálculo informativo).

import type { ModifierGroup, SelectedModifier } from "../modifiers/modifiersLogic";

export const NOTES_MAX_LENGTH = 200; // mesmo limite de service_order_items.notes

export interface CatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface CatalogProduct {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  code: string;
  barcode: string | null;
  salePrice: number;
  imagePath: string | null;
  // Disponibilidade manual e estoque controlado (o servidor é a autoridade no envio do pedido).
  availableForSale: boolean;
  stockControl: "none" | "quantity";
  stockQuantity: number;
  minimumStockQuantity: number;
  // Grupos de adicionais/opções ATIVOS (com ao menos 1 opção ativa), na ordem configurada. Vazio = sem diálogo.
  modifierGroups: ModifierGroup[];
  // true = o carregamento dos adicionais FALHOU (não sabemos se o produto tem opções). Diferente de "não tem".
  modifiersFailed: boolean;
}

// O que um toque no produto faz: direto na cesta (comprovadamente sem opções), diálogo de opções ou bloqueio
// (falha ao carregar as opções: nunca deixa montar item incompleto para descobrir o erro só no envio).
export function decideAdd(product: Pick<CatalogProduct, "modifierGroups" | "modifiersFailed">): "direct" | "dialog" | "blocked" {
  if (product.modifiersFailed) return "blocked";
  return product.modifierGroups.length > 0 ? "dialog" : "direct";
}

export const MODIFIERS_LOAD_ERROR = "Não foi possível carregar as opções deste produto. Tente novamente.";

// Por que um produto não pode ser lançado agora (null = pode). Só UX: submit_service_order confere.
export function unavailableReason(product: Pick<CatalogProduct, "availableForSale" | "stockControl" | "stockQuantity">): "unavailable" | "out" | null {
  if (!product.availableForSale) return "unavailable";
  if (product.stockControl === "quantity" && product.stockQuantity <= 0) return "out";
  return null;
}

// "Restam N" só para produto controlado com estoque baixo (no mínimo ou abaixo, e ainda > 0).
export function lowStockNote(product: Pick<CatalogProduct, "stockControl" | "stockQuantity" | "minimumStockQuantity">): string | null {
  if (product.stockControl !== "quantity") return null;
  if (product.stockQuantity > 0 && product.stockQuantity <= product.minimumStockQuantity) return `Restam ${product.stockQuantity}`;
  return null;
}

// Item da cesta LOCAL (frontend-only; nunca persistida como draft no banco). `price` é só
// informativo para a UX — no envio, o backend é quem determina o preço de verdade.
export interface CartItem {
  // Identidade da LINHA (o mesmo produto pode aparecer em linhas diferentes: opções/observação distintas).
  lineId: string;
  productId: string;
  name: string;
  // Preço BASE unitário (informativo); os adicionais entram por cartItemUnitPrice.
  price: number;
  modifiers: SelectedModifier[];
  imagePath: string | null;
  quantity: number;
  notes: string;
}

// Um evento de cancelamento (append-only no banco): quantidade, motivo, quem e quando.
export interface ItemCancellation {
  id: string;
  quantity: number;
  reason: string;
  createdAt: string;
  cancelledByName: string | null;
}

export interface SubmittedOrderItem {
  id: string;
  productId: string;
  productNameSnapshot: string;
  quantity: number;
  unitPrice: number;
  notes: string | null;
  sectorName: string | null;
  // Estado de produção do item (somente leitura aqui; quem altera é a tela de Produção).
  productionStatus: "pending" | "preparing" | "ready";
  // Adicionais/opções congelados no envio (snapshot). unitPrice já INCLUI o acréscimo; base = unitPrice - modifiersUnitTotal.
  modifiers: Array<{ groupName: string; name: string; type: "add" | "remove"; priceDelta: number }>;
  modifiersUnitTotal: number;
  // `quantity` é a ORIGINAL (nunca muda); cobrável = quantity - cancelledQuantity.
  cancelledQuantity: number;
  cancellations: ItemCancellation[];
}

export type OrderOrigin = "attendant" | "cashier" | "whatsapp";

export interface SubmittedOrder {
  id: string;
  origin: OrderOrigin;
  status: "submitted" | "cancelled";
  submittedAt: string;
  createdByName: string | null;
  items: SubmittedOrderItem[];
}

// Minúsculas e sem acento (mesmo padrão de panel.ts/productsLogic.ts/adminLogic.ts).
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Busca por nome, código, barcode ou descrição.
export function filterCatalog(
  products: CatalogProduct[],
  { query, categoryId }: { query: string; categoryId: string | null },
): CatalogProduct[] {
  const q = normalize(query.trim());
  return products.filter((product) => {
    if (categoryId && product.categoryId !== categoryId) return false;
    if (!q) return true;
    const fields = [product.name, product.code, product.barcode ?? "", product.description ?? ""];
    return fields.some((field) => normalize(field).includes(q));
  });
}

// Leitor de código de barras (Caixa): só o EXATO, sem os fallbacks de código/busca única do
// painel de comandas — aqui é sempre "achou o produto exato ou não achou nada".
export function resolveBarcodeMatch(products: CatalogProduct[], raw: string): CatalogProduct | null {
  const value = raw.trim();
  if (!value) return null;
  return products.find((p) => p.barcode !== null && p.barcode === value) ?? null;
}

// --- Cesta ------------------------------------------------------------------------------------

let lineSeq = 0;
function newLineId(): string {
  lineSeq += 1;
  return `line-${Date.now().toString(36)}-${lineSeq}`;
}

function cartLineKey(item: Pick<CartItem, "productId" | "modifiers" | "notes">): string {
  // Mesma regra de lineKey (modifiersLogic): produto + opções (sem ordem) + observação. Local para a lógica de pedido não depender de import em runtime.
  return `${item.productId}|${item.modifiers.map((m) => m.optionId).sort().join(",")}|${item.notes.trim()}`;
}

export interface AddOptions {
  modifiers?: SelectedModifier[];
  notes?: string;
  quantity?: number;
}

// Toque no produto: SÓ junta com linha existente quando for exatamente igual (mesmo produto, mesmas
// opções, mesma observação) -> +quantidade; senão entra como linha nova. Sem diálogo para produto sem opções.
export function addToCart(cart: CartItem[], product: CatalogProduct, options: AddOptions = {}): CartItem[] {
  const candidate: CartItem = {
    lineId: newLineId(),
    productId: product.id,
    name: product.name,
    price: product.salePrice,
    modifiers: options.modifiers ?? [],
    imagePath: product.imagePath,
    quantity: Math.max(1, options.quantity ?? 1),
    notes: (options.notes ?? "").slice(0, NOTES_MAX_LENGTH),
  };
  const key = cartLineKey(candidate);
  const existing = cart.find((item) => cartLineKey(item) === key);
  if (existing) {
    return cart.map((item) => (item.lineId === existing.lineId ? { ...item, quantity: item.quantity + candidate.quantity } : item));
  }
  return [...cart, candidate];
}

// Edita uma linha ANTES de enviar (quantidade, opções, observação). Se passar a ficar igual a outra
// linha, as duas viram uma só (soma as quantidades).
export function updateCartLine(
  cart: CartItem[],
  lineId: string,
  patch: { modifiers: SelectedModifier[]; notes: string; quantity: number },
): CartItem[] {
  const updated = cart.map((item) =>
    item.lineId === lineId
      ? { ...item, modifiers: patch.modifiers, notes: patch.notes.slice(0, NOTES_MAX_LENGTH), quantity: Math.max(1, patch.quantity) }
      : item,
  );
  const target = updated.find((item) => item.lineId === lineId);
  if (!target) return cart;
  const key = cartLineKey(target);
  const twin = updated.find((item) => item.lineId !== lineId && cartLineKey(item) === key);
  if (!twin) return updated;
  return updated
    .filter((item) => item.lineId !== lineId)
    .map((item) => (item.lineId === twin.lineId ? { ...item, quantity: item.quantity + target.quantity } : item));
}

// delta positivo ou negativo; quantidade <= 0 remove a linha.
export function changeCartQuantity(cart: CartItem[], lineId: string, delta: number): CartItem[] {
  return cart
    .map((item) => (item.lineId === lineId ? { ...item, quantity: item.quantity + delta } : item))
    .filter((item) => item.quantity > 0);
}

export function removeCartItem(cart: CartItem[], lineId: string): CartItem[] {
  return cart.filter((item) => item.lineId !== lineId);
}

// Observação digitada direto na linha (sem fundir linhas enquanto se digita; a fusão é só ao adicionar/editar).
export function setCartItemNotes(cart: CartItem[], lineId: string, notes: string): CartItem[] {
  const trimmed = notes.slice(0, NOTES_MAX_LENGTH);
  return cart.map((item) => (item.lineId === lineId ? { ...item, notes: trimmed } : item));
}

// Preço unitário informativo da linha: base + soma dos adicionais.
export function cartItemUnitPrice(item: Pick<CartItem, "price" | "modifiers">): number {
  return Math.round((item.price + item.modifiers.reduce((s, m) => s + m.priceDelta, 0)) * 100) / 100;
}

// Total de UNIDADES na cesta (2x Coca + 1x Espeto = 3 itens), não de linhas distintas — é o que
// aparece na barra fixa do celular ("3 itens • R$ 54,00").
export function cartItemCount(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

// Total informativo: preço exibido × quantidade. NUNCA é o que decide o preço cobrado — só UX.
export function cartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + cartItemUnitPrice(item) * item.quantity, 0);
}

export interface OrderItemPayload {
  product_id: string;
  quantity: number;
  notes: string | null;
  // SÓ os ids: nome, tipo e acréscimo são lidos no servidor (nunca confia em preço do browser).
  modifier_option_ids: string[];
}

// O ÚNICO formato que sai da cesta para o envio: product_id, quantity e notes. Nunca preço, nome
// ou setor — a RPC é quem determina isso no servidor (ver migration 20260928020000).
export function toSubmitPayload(cart: CartItem[]): OrderItemPayload[] {
  return cart.map((item) => ({
    product_id: item.productId,
    quantity: item.quantity,
    notes: item.notes.trim() || null,
    modifier_option_ids: item.modifiers.map((m) => m.optionId),
  }));
}

// Soma dos pedidos já ENVIADOS (não cancelados) da session, pelos snapshots gravados — não pelo
// preço atual do produto.
// Quantidade cobrável de um item (a original menos o que foi cancelado).
export function activeQuantity(item: Pick<SubmittedOrderItem, "quantity" | "cancelledQuantity">): number {
  return Math.max(0, item.quantity - item.cancelledQuantity);
}

// Só informativo para a UX (o total real é do servidor): usa a quantidade cobrável.
export function sessionTotal(orders: SubmittedOrder[]): number {
  return orders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + order.items.reduce((s, item) => s + item.unitPrice * activeQuantity(item), 0), 0);
}

// Quem pode cancelar o quê (espelho da regra do servidor, só para decidir o que a tela MOSTRA):
// owner/admin qualquer item; attendant/cashier só item ainda pendente na produção.
export function canCancelItem(
  role: string | null | undefined,
  item: Pick<SubmittedOrderItem, "quantity" | "cancelledQuantity" | "productionStatus">,
): boolean {
  if (activeQuantity(item) <= 0) return false;
  if (role === "owner" || role === "admin") return true;
  if (role === "attendant" || role === "cashier") return item.productionStatus === "pending";
  return false;
}

// Mais recente primeiro.
export function sortOrdersByRecent(orders: SubmittedOrder[]): SubmittedOrder[] {
  return [...orders].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
}

// As regras do banco levantam PT4xx com mensagem pronta em português: passa como veio. O resto
// vira mensagem genérica (o texto técnico não vai para a tela). Mesmo padrão de
// describeProductError/describeServiceError.
export function describeOrderError(error: { code?: string | null; message?: string | null }, fallback: string): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  return fallback;
}

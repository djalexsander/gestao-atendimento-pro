// Lógica PURA do fluxo de pedido do atendimento: catálogo visual, cesta local e formatação.
// Sem React e sem Supabase, de propósito, para ser testada à parte. A AUTORIDADE de preço, nome,
// setor e permissão continua inteira no backend (submit_service_order, migration 20260928020000)
// — nada aqui é revalidado como regra de negócio, só UX (feedback imediato e cálculo informativo).

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
}

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
  productId: string;
  name: string;
  price: number;
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

// Toque no produto: já na cesta -> +1; senão entra com quantidade 1. Rápido, sem diálogo.
export function addToCart(cart: CartItem[], product: CatalogProduct): CartItem[] {
  const existing = cart.find((item) => item.productId === product.id);
  if (existing) {
    return cart.map((item) => (item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item));
  }
  return [
    ...cart,
    { productId: product.id, name: product.name, price: product.salePrice, imagePath: product.imagePath, quantity: 1, notes: "" },
  ];
}

// delta positivo ou negativo; quantidade <= 0 remove o item.
export function changeCartQuantity(cart: CartItem[], productId: string, delta: number): CartItem[] {
  return cart
    .map((item) => (item.productId === productId ? { ...item, quantity: item.quantity + delta } : item))
    .filter((item) => item.quantity > 0);
}

export function removeCartItem(cart: CartItem[], productId: string): CartItem[] {
  return cart.filter((item) => item.productId !== productId);
}

export function setCartItemNotes(cart: CartItem[], productId: string, notes: string): CartItem[] {
  const trimmed = notes.slice(0, NOTES_MAX_LENGTH);
  return cart.map((item) => (item.productId === productId ? { ...item, notes: trimmed } : item));
}

// Total de UNIDADES na cesta (2x Coca + 1x Espeto = 3 itens), não de linhas distintas — é o que
// aparece na barra fixa do celular ("3 itens • R$ 54,00").
export function cartItemCount(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

// Total informativo: preço exibido × quantidade. NUNCA é o que decide o preço cobrado — só UX.
export function cartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export interface OrderItemPayload {
  product_id: string;
  quantity: number;
  notes: string | null;
}

// O ÚNICO formato que sai da cesta para o envio: product_id, quantity e notes. Nunca preço, nome
// ou setor — a RPC é quem determina isso no servidor (ver migration 20260928020000).
export function toSubmitPayload(cart: CartItem[]): OrderItemPayload[] {
  return cart.map((item) => ({
    product_id: item.productId,
    quantity: item.quantity,
    notes: item.notes.trim() || null,
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

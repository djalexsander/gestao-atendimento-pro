// Lógica PURA da tela administrativa de Produtos: tipos, validações que espelham o banco (só
// para dar retorno imediato; a autoridade é o backend) e tradução dos erros do banco para
// mensagens amigáveis. Sem React e sem Supabase, de propósito, para ser testada à parte. Mesmo
// padrão de categoriesLogic.ts / sectorsLogic.ts.
import { validateEan13AwareBarcode } from "../../lib/ean13";
import { parseReais } from "../../lib/money";
import type { AdminCategory } from "./categoriesLogic";
import type { AdminSector } from "./sectorsLogic";

export interface AdminProductSector {
  id: string;
  name: string;
  is_active: boolean;
}

export interface AdminProductCategory {
  id: string;
  name: string;
  is_active: boolean;
  default_sector: AdminProductSector | null;
}

export interface AdminProduct {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  code: string;
  barcode: string | null;
  sale_price: number;
  production_sector_id: string | null;
  image_path: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Estoque simples e disponibilidade manual (só RPCs alteram; ver features/stock).
  stock_control: "none" | "quantity";
  stock_quantity: number;
  minimum_stock_quantity: number;
  available_for_sale: boolean;
  // Joins do Supabase (ver PRODUCT_COLUMNS em productsApi.ts).
  category: AdminProductCategory | null;
  sector: AdminProductSector | null;
}

export const CODE_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 200;
export const BARCODE_MAX_LENGTH = 64;

// Mesmo formato de categories/sectors: CHECK products_code_format.
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

export const normalizeCode = (value: string): string => value.trim().toUpperCase();

export function validateName(name: string): string | null {
  if (!name) return "Informe o nome.";
  if (name.length > NAME_MAX_LENGTH) return `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  return null;
}

export function validateCode(code: string): string | null {
  if (!code) return "Informe o código.";
  if (code.length > CODE_MAX_LENGTH) return `Use no máximo ${CODE_MAX_LENGTH} caracteres.`;
  if (!CODE_RE.test(code)) {
    return "Use letras maiúsculas, números, - e _, começando por letra ou número (ex.: ESPETO-ALCATRA).";
  }
  return null;
}

// Vazio é válido (descrição é opcional); quem decide null-vs-texto é normalizeDescription.
export function validateDescription(description: string): string | null {
  if (description.length > DESCRIPTION_MAX_LENGTH) return `Use no máximo ${DESCRIPTION_MAX_LENGTH} caracteres.`;
  return null;
}

export function normalizeDescription(description: string): string | null {
  const trimmed = description.trim();
  return trimmed ? trimmed : null;
}

// Vazio é válido (barcode é opcional); quem decide null-vs-texto é normalizeBarcode. Formato
// interno (200 + 13 dígitos, gerado por "Gerar EAN-13") tem o dígito verificador exigido; barcode
// legado/próprio do estabelecimento continua liberado (lib/ean13.ts — compartilhado com
// Comandas/Mesas e futuros cadastros com barcode, ver migration 20260928010000).
export function validateBarcode(barcode: string): string | null {
  return validateEan13AwareBarcode(barcode, BARCODE_MAX_LENGTH);
}

export function normalizeBarcode(barcode: string): string | null {
  const trimmed = barcode.trim();
  return trimmed ? trimmed : null;
}

// Preço em formato brasileiro ("18,00" ou "18.00"); devolve reais (não centavos — sale_price é
// numeric(12,2) em reais, ver productsApi.ts/money.ts). parseReais já recusa sinal negativo.
export function parsePrice(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: "Informe o preço de venda." };
  const value = parseReais(trimmed);
  if (value === null) return { value: null, error: "Informe um preço válido (ex.: 18,00)." };
  return { value, error: null };
}

// O caminho é sempre determinístico (ver CHECK products_image_path_shape): nunca depende do
// image_path guardado, então continua correto mesmo com dado ainda não recarregado na tela.
export function buildImagePath(companyId: string, productId: string): string {
  return `${companyId}/${productId}/main.webp`;
}

// As regras do banco levantam PT4xx com mensagem pronta em português: passam como vieram. As
// constraints mais comuns viram frase curta; o resto vira a mensagem genérica (o texto técnico
// não vai para a tela). Mesmo padrão de describeCategoryError/describeSectorError.
export function describeProductError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  if (code === "23505") {
    if (message.includes("products_company_code_key")) return "Já existe um produto com este código.";
    if (message.includes("products_company_barcode_key")) return "Já existe um produto com este código de barras.";
  }
  if (code === "23503") {
    if (message.includes("products_category_fkey")) return "Categoria inválida.";
    if (message.includes("products_production_sector_fkey")) return "Setor de produção inválido.";
  }
  if (code === "23514") {
    if (message.includes("products_name_length")) return `O nome deve ter de 1 a ${NAME_MAX_LENGTH} caracteres.`;
    if (message.includes("products_description_length")) return `A descrição deve ter até ${DESCRIPTION_MAX_LENGTH} caracteres.`;
    if (message.includes("products_code_format")) return "Código inválido. Use letras maiúsculas, números, - e _ (até 32 caracteres).";
    if (message.includes("products_barcode_format")) return `Código de barras inválido. Não pode ter espaços (até ${BARCODE_MAX_LENGTH} caracteres).`;
    if (message.includes("products_barcode_ean13_check_digit")) return "Código EAN-13 inválido: o dígito verificador não confere.";
    if (message.includes("products_sale_price_check")) return "Informe um preço de venda válido (maior ou igual a zero).";
  }
  if (code === "42501") return "Você não tem permissão para alterar produtos.";
  return fallback;
}

// Erros do Storage (StorageError) não trazem `code` Postgres — só uma mensagem. Aproximação por
// texto, com um fallback amigável genérico para o resto.
export function describeImageError(error: { message?: string | null } | null | undefined, fallback: string): string {
  const message = error?.message ?? "";
  if (/row-level security|permission/i.test(message)) {
    return "Você não tem permissão para enviar ou remover fotos deste produto.";
  }
  if (/exceeded|maximum allowed size|too large/i.test(message)) {
    return "A imagem passou do limite de 2 MB.";
  }
  if (/mime type|not supported/i.test(message)) {
    return "Formato de imagem não suportado. Envie JPEG, PNG ou WebP.";
  }
  return fallback;
}

export type ProductFilter = "all" | "active" | "inactive";

// Minúsculas e sem acento.
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Busca por nome, código, barcode ou nome da categoria; filtro de status + categoria (id exato).
// Ordenada por nome (produtos não têm ordem própria, diferente de categorias).
export function filterProducts(
  products: AdminProduct[],
  { query, filter, categoryId }: { query: string; filter: ProductFilter; categoryId: string | null },
): AdminProduct[] {
  const q = normalize(query.trim());
  return products
    .filter((product) => {
      if (filter === "active" && !product.is_active) return false;
      if (filter === "inactive" && product.is_active) return false;
      if (categoryId && product.category_id !== categoryId) return false;
      if (!q) return true;
      const fields = [product.name, product.code, product.barcode ?? "", product.category?.name ?? ""];
      return fields.some((field) => normalize(field).includes(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

// "Bebidas" / "Bebidas (inativa)" — nunca esconde um vínculo com categoria desativada.
export function formatCategoryLabel(category: { name: string; is_active: boolean } | null): string {
  if (!category) return "—";
  return category.is_active ? category.name : `${category.name} (inativa)`;
}

export interface EffectiveSector {
  name: string;
  source: "own" | "category";
}

// Mesma regra do view products_with_effective_sector (ver migration 040000): setor próprio,
// senão o padrão da categoria, senão nenhum. Refeita aqui em JS, e não pela view, porque a tela
// também precisa saber a ORIGEM (próprio vs. herdado) para o rótulo — a view só devolve o id.
export function effectiveSector(product: Pick<AdminProduct, "production_sector_id" | "category" | "sector">): EffectiveSector | null {
  if (product.production_sector_id && product.sector) {
    return { name: product.sector.name, source: "own" };
  }
  if (product.category?.default_sector) {
    return { name: product.category.default_sector.name, source: "category" };
  }
  return null;
}

export interface CategoryOption {
  id: string;
  label: string;
}

// Para NOVO produto só entram categorias ATIVAS; na edição, a categoria vinculada entra também
// se estiver inativa (identificada), para nunca esconder o vínculo. Mesmo espírito de
// buildSectorOptions (categoriesLogic.ts), mas sem opção "nenhuma" — categoria é obrigatória.
export function buildCategoryOptions(categories: AdminCategory[], currentCategoryId: string | null): CategoryOption[] {
  const options: CategoryOption[] = [];
  for (const category of categories) {
    if (category.is_active) options.push({ id: category.id, label: category.name });
  }
  const current = currentCategoryId ? categories.find((c) => c.id === currentCategoryId) : null;
  if (current && !current.is_active) {
    options.push({ id: current.id, label: `${current.name} (inativa)` });
  }
  return options;
}

export interface ProductSectorOption {
  id: string | null; // null = usar o padrão da categoria
  label: string;
}

// Radios do formulário: "Usar padrão da categoria" (grava production_sector_id = NULL) + setores
// ATIVOS da empresa; o setor hoje vinculado ao produto entra também se estiver inativo (mesma
// regra de buildSectorOptions em categoriesLogic.ts, mas com o rótulo do "nulo" próprio de produto).
export function buildProductSectorOptions(sectors: AdminSector[], currentSectorId: string | null): ProductSectorOption[] {
  const options: ProductSectorOption[] = [{ id: null, label: "Usar padrão da categoria" }];
  for (const sector of sectors) {
    if (sector.is_active) options.push({ id: sector.id, label: sector.name });
  }
  const current = currentSectorId ? sectors.find((s) => s.id === currentSectorId) : null;
  if (current && !current.is_active) {
    options.push({ id: current.id, label: `${current.name} (inativo)` });
  }
  return options;
}

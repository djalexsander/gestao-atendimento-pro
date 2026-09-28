import { supabase } from "../../lib/supabaseClient";
import type { AdminCategory } from "./categoriesLogic";
import { supabaseCategoriesAdminSource } from "./categoriesApi";
import { buildImagePath, describeImageError, describeProductError, type AdminProduct } from "./productsLogic";
import { supabaseSectorsAdminSource } from "./sectorsApi";
import type { AdminSector } from "./sectorsLogic";

const LOAD_ERROR = "Não foi possível carregar os produtos agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const UPLOAD_ERROR = "Não foi possível enviar a foto agora. Tente novamente.";
// RLS não distingue "não existe" de "sem permissão" (por desenho): um UPDATE que não acha a
// linha pode ser qualquer um dos dois. Mesmo texto de categoriesApi.ts/sectorsApi.ts.
const NOT_FOUND_OR_NO_PERMISSION = "Não foi possível alterar este produto: ele não existe mais, ou você não tem permissão.";

const IMAGE_BUCKET = "product-images";
// 1h: tempo de sobra para uma sessão administrativa nesta tela; a URL assinada não é persistida
// em lugar nenhum (nem no banco, nem em localStorage), só usada em memória para os <img>.
const SIGNED_URL_TTL_SECONDS = 3600;

export interface NewProduct {
  category_id: string;
  name: string;
  description: string | null;
  code: string;
  barcode: string | null;
  sale_price: number;
  production_sector_id: string | null;
  is_active: boolean;
}

export interface EditProduct {
  category_id: string;
  name: string;
  description: string | null;
  code: string;
  barcode: string | null;
  sale_price: number;
  production_sector_id: string | null;
}

// Fonte de dados da tela administrativa. Recebida por parâmetro (a real, abaixo, é o padrão)
// para poder exercitar a tela com dados simulados, sem login e sem banco/Storage. Toda operação
// devolve só a mensagem de erro (ou null): quem manda de verdade é o RLS + as regras do banco.
// Mesmo padrão de categoriesApi.ts/sectorsApi.ts.
export interface ProductsAdminSource {
  load(companyId: string): Promise<{ data: AdminProduct[] | null; error: string | null }>;
  // Categorias/setores para os <select>/radios: reaproveita categoriesApi.ts e sectorsApi.ts
  // (mesma fonte das telas Categorias e Setores de produção).
  loadCategories(companyId: string): Promise<{ data: AdminCategory[] | null; error: string | null }>;
  loadSectors(companyId: string): Promise<{ data: AdminSector[] | null; error: string | null }>;
  // path -> URL assinada (bucket privado); caminhos que falharem ficam de fora do Map.
  getImageUrls(paths: string[]): Promise<Map<string, string>>;
  create(companyId: string, input: NewProduct): Promise<{ data: { id: string } | null; error: string | null }>;
  update(productId: string, input: EditProduct): Promise<{ error: string | null }>;
  setActive(productId: string, active: boolean): Promise<{ error: string | null }>;
  uploadImage(companyId: string, productId: string, blob: Blob): Promise<{ error: string | null }>;
  removeImage(companyId: string, productId: string): Promise<{ error: string | null }>;
  // Gera (p_regenerate=false) ou regenera (true) o EAN-13 de um produto EXISTENTE. A geração real
  // é sempre do banco (generate_product_ean13 — migration 20260928010000, consome a MESMA
  // sequência de Comandas/Mesas); devolve o barcode novo para atualizar a tela.
  generateEan(productId: string, regenerate?: boolean): Promise<{ barcode: string | null; error: string | null }>;
}

// select relacional (embed do PostgREST) com DOIS níveis (categoria -> setor padrão da
// categoria) + o setor próprio do produto: uma consulta só, sem N+1, para listar produtos com
// categoria e setor efetivo (ver effectiveSector em productsLogic.ts).
const PRODUCT_COLUMNS =
  "id, category_id, name, description, code, barcode, sale_price, production_sector_id, image_path, is_active, created_at, updated_at, " +
  "category:product_categories(id, name, is_active, default_sector:production_sectors(id, name, is_active)), " +
  "sector:production_sectors(id, name, is_active)";

interface RawSector {
  id: string;
  name: string;
  is_active: boolean;
}

interface RawCategory {
  id: string;
  name: string;
  is_active: boolean;
  default_sector: RawSector | RawSector[] | null;
}

// O cliente sem tipos gerados do banco (createClient sem <Database>) tipa TODO embed como array,
// mesmo quando a FK é N:1 e o PostgREST devolve um objeto único (ou null) em tempo de execução.
// Normaliza aqui os dois formatos, para o resto do app trabalhar só com AdminProduct.category e
// AdminProduct.sector como objeto único. Mesmo problema de categoriesApi.ts, com mais um nível.
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

interface RawProductRow extends Omit<AdminProduct, "category" | "sector"> {
  category: RawCategory | RawCategory[] | null;
  sector: RawSector | RawSector[] | null;
}

function normalizeProductRow(row: RawProductRow): AdminProduct {
  const category = one(row.category);
  return {
    ...row,
    category: category ? { ...category, default_sector: one(category.default_sector) } : null,
    sector: one(row.sector),
  };
}

// Usa DIRETO as policies e os grants da migration 040000 (owner e admin; sem service_role). Não
// se apaga nada: só desativa. image_path fica fora do INSERT (o grant não libera a coluna: o id
// do produto só existe depois de criado) — confirmado lendo a migration antes de implementar,
// nada foi mudado no banco nem nas Storage policies.
export const supabaseProductsAdminSource: ProductsAdminSource = {
  async load(companyId) {
    const { data, error } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("company_id", companyId);
    if (error) {
      console.error("Falha ao carregar produtos (admin):", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as unknown as RawProductRow[];
    return { data: rows.map(normalizeProductRow), error: null };
  },

  loadCategories: (companyId) => supabaseCategoriesAdminSource.load(companyId),
  loadSectors: (companyId) => supabaseSectorsAdminSource.load(companyId),

  async getImageUrls(paths) {
    const map = new Map<string, string>();
    const unique = Array.from(new Set(paths));
    if (unique.length === 0) return map;
    const { data, error } = await supabase.storage.from(IMAGE_BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      console.error("Falha ao gerar URLs assinadas das fotos:", error?.message);
      return map;
    }
    // Por índice, não por `item.path`: preserva a ordem de entrada independente do que o SDK ecoa.
    data.forEach((item, index) => {
      if (item.signedUrl && !item.error) map.set(unique[index], item.signedUrl);
    });
    return map;
  },

  async create(companyId, input) {
    const { data, error } = await supabase
      .from("products")
      .insert({
        company_id: companyId,
        category_id: input.category_id,
        name: input.name,
        description: input.description,
        code: input.code,
        barcode: input.barcode,
        sale_price: input.sale_price,
        production_sector_id: input.production_sector_id,
        is_active: input.is_active,
      })
      .select("id")
      .single();
    if (error) return { data: null, error: describeProductError(error, SAVE_ERROR) };
    return { data: { id: data.id as string }, error: null };
  },

  async update(productId, input) {
    const { data, error } = await supabase
      .from("products")
      .update({
        category_id: input.category_id,
        name: input.name,
        description: input.description,
        code: input.code,
        barcode: input.barcode,
        sale_price: input.sale_price,
        production_sector_id: input.production_sector_id,
      })
      .eq("id", productId)
      .select("id");
    if (error) return { error: describeProductError(error, SAVE_ERROR) };
    return { error: data && data.length > 0 ? null : NOT_FOUND_OR_NO_PERMISSION };
  },

  async setActive(productId, active) {
    const { data, error } = await supabase
      .from("products")
      .update({ is_active: active })
      .eq("id", productId)
      .select("id");
    if (error) return { error: describeProductError(error, SAVE_ERROR) };
    return { error: data && data.length > 0 ? null : NOT_FOUND_OR_NO_PERMISSION };
  },

  async uploadImage(companyId, productId, blob) {
    const path = buildImagePath(companyId, productId);
    // upsert: true -- "trocar foto" reusa o MESMO caminho (main.webp) em vez de acumular
    // arquivos; a troca de URL assinada a cada chamada já invalida o cache do navegador.
    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(path, blob, { contentType: "image/webp", upsert: true });
    if (uploadError) return { error: describeImageError(uploadError, UPLOAD_ERROR) };

    const { error: updateError } = await supabase.from("products").update({ image_path: path }).eq("id", productId);
    if (updateError) return { error: describeProductError(updateError, SAVE_ERROR) };
    return { error: null };
  },

  async removeImage(companyId, productId) {
    // image_path -> NULL primeiro (é o que decide "produto tem foto" para o resto do app); a
    // remoção do arquivo do Storage é best-effort, como o item 12 do pedido pede ("quando possível").
    const { error: updateError } = await supabase.from("products").update({ image_path: null }).eq("id", productId);
    if (updateError) return { error: describeProductError(updateError, SAVE_ERROR) };

    const path = buildImagePath(companyId, productId);
    const { error: removeError } = await supabase.storage.from(IMAGE_BUCKET).remove([path]);
    if (removeError) {
      console.error("Produto ficou sem foto, mas o arquivo não pôde ser removido do Storage:", removeError.message);
    }
    return { error: null };
  },

  async generateEan(productId, regenerate = false) {
    const { data, error } = await supabase.rpc("generate_product_ean13", {
      p_product_id: productId,
      p_regenerate: regenerate,
    });
    if (error) return { barcode: null, error: describeProductError(error, SAVE_ERROR) };
    return { barcode: data as string, error: null };
  },
};

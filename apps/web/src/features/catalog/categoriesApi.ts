import { supabase } from "../../lib/supabaseClient";
import { describeCategoryError, type AdminCategory } from "./categoriesLogic";
import { supabaseSectorsAdminSource } from "./sectorsApi";
import type { AdminSector } from "./sectorsLogic";

const LOAD_ERROR = "Não foi possível carregar as categorias agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
// RLS não distingue "não existe" de "sem permissão" (por desenho): um UPDATE que não acha a
// linha pode ser qualquer um dos dois.
const NOT_FOUND_OR_NO_PERMISSION = "Não foi possível alterar esta categoria: ela não existe mais, ou você não tem permissão.";

export interface NewCategory {
  name: string;
  code: string;
  default_production_sector_id: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface EditCategory {
  name: string;
  code: string;
  default_production_sector_id: string | null;
  sort_order: number;
}

// Fonte de dados da tela administrativa. Recebida por parâmetro (a real, abaixo, é o padrão)
// para poder exercitar a tela com dados simulados, sem login e sem banco. Toda operação devolve
// só a mensagem de erro (ou null): quem manda de verdade é o RLS + as regras do banco. Mesmo
// padrão de sectorsApi.ts.
export interface CategoriesAdminSource {
  load(companyId: string): Promise<{ data: AdminCategory[] | null; error: string | null }>;
  // Setores para o <select>: reaproveita sectorsApi.ts (mesma fonte de Setores de produção).
  loadSectors(companyId: string): Promise<{ data: AdminSector[] | null; error: string | null }>;
  create(companyId: string, input: NewCategory): Promise<{ error: string | null }>;
  update(categoryId: string, input: EditCategory): Promise<{ error: string | null }>;
  setActive(categoryId: string, active: boolean): Promise<{ error: string | null }>;
}

// select relacional (embed do PostgREST): uma consulta só, sem N+1, para trazer o nome do setor
// padrão junto com a categoria.
const CATEGORY_COLUMNS =
  "id, name, code, default_production_sector_id, sort_order, is_active, default_sector:production_sectors(id, name, code, is_active)";

// O cliente sem tipos gerados do banco (createClient sem <Database>) tipa TODO embed como array,
// mesmo quando a FK (default_production_sector_id -> production_sectors) é N:1 e o PostgREST
// devolve um objeto único (ou null) em tempo de execução. Normaliza aqui os dois formatos, para
// o resto do app trabalhar só com AdminCategory.default_sector como objeto único.
type RawCategoryRow = Omit<AdminCategory, "default_sector"> & {
  default_sector: AdminCategory["default_sector"] | AdminCategory["default_sector"][];
};

function normalizeCategoryRow(row: RawCategoryRow): AdminCategory {
  return {
    ...row,
    default_sector: Array.isArray(row.default_sector) ? (row.default_sector[0] ?? null) : row.default_sector,
  };
}

// Usa DIRETO as policies e os grants da migration 040000 (owner e admin; sem service_role). Não
// se apaga nada: só desativa. Código, setor padrão e ordem são editáveis (o grant de UPDATE
// inclui os três, e o trigger de 040000 só trava company_id) — confirmado lendo a migration
// antes de implementar, nada foi mudado no banco.
export const supabaseCategoriesAdminSource: CategoriesAdminSource = {
  async load(companyId) {
    const { data, error } = await supabase
      .from("product_categories")
      .select(CATEGORY_COLUMNS)
      .eq("company_id", companyId);
    if (error) {
      console.error("Falha ao carregar categorias (admin):", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as unknown as RawCategoryRow[];
    return { data: rows.map(normalizeCategoryRow), error: null };
  },

  loadSectors: (companyId) => supabaseSectorsAdminSource.load(companyId),

  async create(companyId, input) {
    const { error } = await supabase.from("product_categories").insert({
      company_id: companyId,
      name: input.name,
      code: input.code,
      default_production_sector_id: input.default_production_sector_id,
      sort_order: input.sort_order,
      is_active: input.is_active,
    });
    if (error) return { error: describeCategoryError(error, SAVE_ERROR) };
    return { error: null };
  },

  async update(categoryId, input) {
    const { data, error } = await supabase
      .from("product_categories")
      .update({
        name: input.name,
        code: input.code,
        default_production_sector_id: input.default_production_sector_id,
        sort_order: input.sort_order,
      })
      .eq("id", categoryId)
      .select("id");
    if (error) return { error: describeCategoryError(error, SAVE_ERROR) };
    return { error: data && data.length > 0 ? null : NOT_FOUND_OR_NO_PERMISSION };
  },

  async setActive(categoryId, active) {
    const { data, error } = await supabase
      .from("product_categories")
      .update({ is_active: active })
      .eq("id", categoryId)
      .select("id");
    if (error) return { error: describeCategoryError(error, SAVE_ERROR) };
    return { error: data && data.length > 0 ? null : NOT_FOUND_OR_NO_PERMISSION };
  },
};

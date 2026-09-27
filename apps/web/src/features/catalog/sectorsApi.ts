import { supabase } from "../../lib/supabaseClient";
import { describeSectorError, type AdminSector } from "./sectorsLogic";

const LOAD_ERROR = "Não foi possível carregar os setores de produção agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const NO_PERMISSION = "Você não tem permissão para alterar setores de produção.";

export interface NewSector {
  name: string;
  code: string;
  is_active: boolean;
}

// Fonte de dados da tela administrativa. Recebida por parâmetro (a real, abaixo, é o padrão)
// para poder exercitar a tela com dados simulados, sem login e sem banco. Toda operação devolve
// só a mensagem de erro (ou null): quem manda de verdade é o RLS + as regras do banco (a mesma
// proteção de desativação com uso ativo já vem pronta da migration 040000; nada disso é repetido
// aqui). Mesmo padrão de features/operations/adminApi.ts.
export interface SectorsAdminSource {
  load(companyId: string): Promise<{ data: AdminSector[] | null; error: string | null }>;
  create(companyId: string, input: NewSector): Promise<{ error: string | null }>;
  update(sectorId: string, input: { name: string; code: string }): Promise<{ error: string | null }>;
  setActive(sectorId: string, active: boolean): Promise<{ error: string | null }>;
}

const SECTOR_COLUMNS = "id, name, code, is_active";

// Usa DIRETO as policies e os grants da migration 040000 (owner e admin; sem service_role). Não
// se apaga nada: só desativa. O código é editável (o grant de UPDATE inclui `code`, e o trigger
// de 040000 não o trava como trava em service_points) — confirmado lendo a migration antes de
// implementar, nada foi mudado no banco.
export const supabaseSectorsAdminSource: SectorsAdminSource = {
  async load(companyId) {
    const { data, error } = await supabase
      .from("production_sectors")
      .select(SECTOR_COLUMNS)
      .eq("company_id", companyId);
    if (error) {
      console.error("Falha ao carregar setores de produção (admin):", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    return { data: (data ?? []) as AdminSector[], error: null };
  },

  async create(companyId, input) {
    const { error } = await supabase.from("production_sectors").insert({
      company_id: companyId,
      name: input.name,
      code: input.code,
      is_active: input.is_active,
    });
    if (error) return { error: describeSectorError(error, SAVE_ERROR) };
    return { error: null };
  },

  async update(sectorId, input) {
    const { data, error } = await supabase
      .from("production_sectors")
      .update({ name: input.name, code: input.code })
      .eq("id", sectorId)
      .select("id");
    if (error) return { error: describeSectorError(error, SAVE_ERROR) };
    // O RLS não recusa com erro: um UPDATE sem permissão simplesmente não acha linha.
    return { error: data && data.length > 0 ? null : NO_PERMISSION };
  },

  async setActive(sectorId, active) {
    const { data, error } = await supabase
      .from("production_sectors")
      .update({ is_active: active })
      .eq("id", sectorId)
      .select("id");
    if (error) return { error: describeSectorError(error, SAVE_ERROR) };
    return { error: data && data.length > 0 ? null : NO_PERMISSION };
  },
};

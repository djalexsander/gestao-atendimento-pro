import { supabase } from "../../lib/supabaseClient";
import { describeServiceError, type AdminServicePoint, type BatchRow } from "./adminLogic";
import type { ServiceMode, ServicePointType } from "./panel";

const LOAD_ERROR = "Não foi possível carregar as comandas e mesas agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const NO_PERMISSION = "Você não tem permissão para alterar comandas e mesas.";

export interface ServicePointsAdminData {
  mode: ServiceMode;
  points: AdminServicePoint[];
}

export interface NewServicePoint {
  type: ServicePointType;
  code: string;
  display_name: string;
  barcode: string | null;
  is_active: boolean;
}

// Fonte de dados da tela administrativa. Recebida por parâmetro (a real, abaixo, é o padrão)
// para poder exercitar a tela com dados simulados, sem login e sem banco. Toda operação devolve
// só a mensagem de erro (ou null): quem manda de verdade é o RLS + as regras do banco.
export interface ServicePointsAdminSource {
  load(companyId: string): Promise<{ data: ServicePointsAdminData | null; error: string | null }>;
  saveMode(companyId: string, mode: ServiceMode): Promise<{ error: string | null }>;
  create(companyId: string, input: NewServicePoint): Promise<{ error: string | null }>;
  createBatch(companyId: string, rows: BatchRow[]): Promise<{ error: string | null }>;
  update(pointId: string, input: { display_name: string; barcode: string | null }): Promise<{ error: string | null }>;
  setActive(pointId: string, active: boolean): Promise<{ error: string | null }>;
}

const POINT_COLUMNS = "id, type, code, display_name, barcode, is_active";

async function setPointActive(pointId: string, active: boolean): Promise<{ error: string | null }> {
  const { data, error } = await supabase
    .from("service_points")
    .update({ is_active: active })
    .eq("id", pointId)
    .select("id");
  if (error) return { error: describeServiceError(error, SAVE_ERROR) };
  // O RLS não recusa com erro: um UPDATE sem permissão simplesmente não acha linha.
  return { error: data && data.length > 0 ? null : NO_PERMISSION };
}

// Usa DIRETO as policies e os grants da migration 020000 (owner e admin; sem service_role).
// Não se apaga nada: só desativa.
export const supabaseServicePointsAdminSource: ServicePointsAdminSource = {
  async load(companyId) {
    const [settings, points] = await Promise.all([
      supabase.from("company_operational_settings").select("service_mode").eq("company_id", companyId).maybeSingle(),
      supabase.from("service_points").select(POINT_COLUMNS).eq("company_id", companyId),
    ]);
    if (settings.error || points.error || !settings.data) {
      const failure = settings.error ?? points.error;
      console.error("Falha ao carregar comandas e mesas (admin):", failure?.code ?? "sem configuração");
      return { data: null, error: LOAD_ERROR };
    }
    return {
      data: {
        mode: (settings.data as { service_mode: ServiceMode }).service_mode,
        points: (points.data ?? []) as AdminServicePoint[],
      },
      error: null,
    };
  },

  async saveMode(companyId, mode) {
    const { data, error } = await supabase
      .from("company_operational_settings")
      .update({ service_mode: mode })
      .eq("company_id", companyId)
      .select("service_mode");
    if (error) return { error: describeServiceError(error, SAVE_ERROR) };
    // O RLS não recusa com erro: um UPDATE sem permissão simplesmente não acha linha.
    return { error: data && data.length > 0 ? null : NO_PERMISSION };
  },

  async create(companyId, input) {
    const { data, error } = await supabase
      .from("service_points")
      .insert({
        company_id: companyId,
        type: input.type,
        code: input.code,
        display_name: input.display_name,
        barcode: input.barcode,
      })
      .select("id")
      .single();
    if (error || !data) return { error: describeServiceError(error ?? {}, SAVE_ERROR) };
    // is_active não faz parte do INSERT liberado ao cliente (nasce ativo): criar já inativo é
    // insert + update.
    if (!input.is_active) {
      const off = await setPointActive((data as { id: string }).id, false);
      if (off.error) return { error: `Criada, mas não foi possível deixá-la inativa: ${off.error}` };
    }
    return { error: null };
  },

  // Uma instrução só: ou cria o lote inteiro, ou nada.
  async createBatch(companyId, rows) {
    const { error } = await supabase.from("service_points").insert(
      rows.map((row) => ({
        company_id: companyId,
        type: row.type,
        code: row.code,
        display_name: row.display_name,
      })),
    );
    if (error) {
      const friendly = describeServiceError(error, SAVE_ERROR);
      return {
        error: error.code === "23505" ? "Algum código do intervalo já existe. Atualize a lista e tente de novo." : friendly,
      };
    }
    return { error: null };
  },

  async update(pointId, input) {
    const { data, error } = await supabase
      .from("service_points")
      .update({ display_name: input.display_name, barcode: input.barcode })
      .eq("id", pointId)
      .select("id");
    if (error) return { error: describeServiceError(error, SAVE_ERROR) };
    return { error: data && data.length > 0 ? null : NO_PERMISSION };
  },

  setActive: setPointActive,
};

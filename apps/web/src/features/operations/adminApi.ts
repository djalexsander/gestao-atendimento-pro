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
  // Ponto ainda não existe: não há como gerar o EAN antes de salvar. Marcado, o create() cria o
  // ponto (sem barcode) e, em seguida, pede o EAN ao banco — nunca inventado no frontend.
  generate_ean: boolean;
}

// Fonte de dados da tela administrativa. Recebida por parâmetro (a real, abaixo, é o padrão)
// para poder exercitar a tela com dados simulados, sem login e sem banco. Toda operação devolve
// só a mensagem de erro (ou null): quem manda de verdade é o RLS + as regras do banco.
export interface ServicePointsAdminSource {
  load(companyId: string): Promise<{ data: ServicePointsAdminData | null; error: string | null }>;
  saveMode(companyId: string, mode: ServiceMode): Promise<{ error: string | null }>;
  create(companyId: string, input: NewServicePoint): Promise<{ error: string | null }>;
  createBatch(companyId: string, rows: BatchRow[], generateEan: boolean): Promise<{ error: string | null }>;
  update(pointId: string, input: { display_name: string; barcode: string | null }): Promise<{ error: string | null }>;
  setActive(pointId: string, active: boolean): Promise<{ error: string | null }>;
  // Gera (p_regenerate=false) ou regenera (true) o EAN-13 de um ponto EXISTENTE. A geração real é
  // sempre do banco (generate_service_point_ean13); devolve o barcode novo para atualizar a tela.
  generateEan(pointId: string, regenerate?: boolean): Promise<{ barcode: string | null; error: string | null }>;
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
        barcode: input.generate_ean ? null : input.barcode,
      })
      .select("id")
      .single();
    if (error || !data) return { error: describeServiceError(error ?? {}, SAVE_ERROR) };
    const pointId = (data as { id: string }).id;
    // is_active não faz parte do INSERT liberado ao cliente (nasce ativo): criar já inativo é
    // insert + update.
    if (!input.is_active) {
      const off = await setPointActive(pointId, false);
      if (off.error) return { error: `Criada, mas não foi possível deixá-la inativa: ${off.error}` };
    }
    if (input.generate_ean) {
      const gen = await this.generateEan(pointId);
      if (gen.error) return { error: `Criada, mas não foi possível gerar o código de barras: ${gen.error}` };
    }
    return { error: null };
  },

  // Uma RPC só: ou cria (e gera o EAN de) o lote inteiro, ou nada — mesma atomicidade de antes,
  // agora incluindo a geração do código de barras quando marcada.
  async createBatch(companyId, rows, generateEan) {
    const { error } = await supabase.rpc("create_service_points_batch", {
      p_company_id: companyId,
      p_type: rows[0].type,
      p_rows: rows.map((row) => ({ code: row.code, display_name: row.display_name })),
      p_generate_ean: generateEan,
    });
    if (error) return { error: describeServiceError(error, SAVE_ERROR) };
    return { error: null };
  },

  async generateEan(pointId, regenerate = false) {
    const { data, error } = await supabase.rpc("generate_service_point_ean13", {
      p_service_point_id: pointId,
      p_regenerate: regenerate,
    });
    if (error) return { barcode: null, error: describeServiceError(error, SAVE_ERROR) };
    return { barcode: data as string, error: null };
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

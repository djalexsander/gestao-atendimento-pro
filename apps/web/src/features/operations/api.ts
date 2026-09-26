import { supabase } from "../../lib/supabaseClient";
import type { OpenSession, ServicePanelData } from "./panel";

const LOAD_ERROR = "Não foi possível carregar as comandas e mesas agora. Tente novamente.";
const OPEN_ERROR = "Não foi possível abrir o atendimento agora. Tente novamente.";

// Fonte de dados do painel. A tela recebe uma por parâmetro (a real, abaixo, é o padrão) para
// poder ser exercitada com dados simulados, sem login e sem banco.
export interface ServicePanelSource {
  // UMA chamada: modo de atendimento + pontos compatíveis + atendimento aberto de cada um.
  load(companyId: string): Promise<{ data: ServicePanelData | null; error: string | null }>;
  // Abre o atendimento (quem abriu é gravado pelo backend). `conflict` = alguém abriu antes ou
  // regra de negócio (a tela recarrega o painel).
  open(
    pointId: string,
    customerName: string | null,
  ): Promise<{ session: OpenSession | null; error: string | null; conflict: boolean }>;
}

// As RPCs levantam PT400/401/403/404/409 com mensagem amigável em português; qualquer outro
// erro do banco vira uma mensagem genérica (o texto técnico não vai para a tela).
export const supabaseServicePanelSource: ServicePanelSource = {
  async load(companyId) {
    const { data, error } = await supabase.rpc("service_points_panel", { p_company_id: companyId });
    if (error) {
      console.error("Falha ao carregar o painel de comandas e mesas:", error.code ?? error.message);
      return { data: null, error: error.code?.startsWith("PT") ? error.message : LOAD_ERROR };
    }
    return { data: data as ServicePanelData, error: null };
  },

  async open(pointId, customerName) {
    const { data, error } = await supabase.rpc("open_service_session", {
      p_service_point_id: pointId,
      p_customer_name: customerName,
    });
    if (error) {
      const friendly = error.code?.startsWith("PT");
      if (!friendly) console.error("Falha ao abrir atendimento:", error.code ?? error.message);
      return { session: null, error: friendly ? error.message : OPEN_ERROR, conflict: error.code === "PT409" };
    }
    const row = data as { id: string; customer_name: string | null; opened_at: string; opened_by: string };
    return {
      session: {
        id: row.id,
        customer_name: row.customer_name,
        opened_at: row.opened_at,
        opened_by: row.opened_by,
        opened_by_name: null,
      },
      error: null,
      conflict: false,
    };
  },
};

import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { supabase } from "../../lib/supabaseClient";
import { subscribeToPrintChanges, type PrintTable } from "./printingRealtime";
import {
  ATTENTION_LIMIT,
  buildAttention,
  nextCursor,
  rangeBoundsUtc,
  unresolvedErrors,
  type AttentionResult,
  type HistoryResult,
  type QueueCursor,
  type QueueRange,
} from "./printingQueueLogic";
import {
  describePrintError,
  type DeviceInput,
  type DocumentRoute,
  type PairingCode,
  type PrintAgent,
  type PrintEnqueueFailure,
  type PaperWidth,
  type PrintDevice,
  type PrintJob,
  type PrintSector,
} from "./printingLogic";

const LOAD_ERROR = "Não foi possível carregar a configuração de impressão agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const QUEUE_ERROR = "Não foi possível carregar a fila de impressão agora. Tente novamente.";

// Colunas LEVES da lista (sem o payload inteiro: só 3 campos dele via JSON path). O payload completo e os
// carimbos de tempo só vêm sob demanda, em loadJobDetails.
const JOB_LIST_COLUMNS =
  "id, print_device_id, job_type, status, attempts, error_message, reprint_of_id, created_at, " +
  "printer_name:payload->printer->>name, point_label:payload->service_point->>label, operator_name:payload->operator->>name";

type LightRow = Omit<PrintJob, "payload"> & { printer_name: string | null; point_label: string | null; operator_name: string | null };

function toLightJob(row: LightRow): PrintJob {
  const { printer_name, point_label, operator_name, ...rest } = row;
  return {
    ...rest,
    payload: {
      printer: printer_name ? { name: printer_name } : undefined,
      service_point: point_label ? { label: point_label } : undefined,
      operator: operator_name ? { name: operator_name } : undefined,
    },
  };
}

export interface JobDetails {
  job: PrintJob; // com o payload completo
  claimed_at: string | null;
  printed_at: string | null;
  printer_name: string | null; // impressora lógica atual
  windows_printer_name: string | null; // vínculo ATUAL com a impressora do Windows
}

// Fonte de dados da tela. Recebida por parâmetro (a real, abaixo, é o padrão) para exercitar a
// tela com dados simulados. Leituras vão direto às tabelas (RLS: só owner/admin); toda escrita
// passa por RPC (SECURITY DEFINER) — o cliente não tem INSERT/UPDATE/DELETE nelas. Nada aqui lista
// impressoras do Windows nem imprime: isso é do Agente (etapa futura).
export interface PrintingSource {
  loadConfig(companyId: string): Promise<{ data: { devices: PrintDevice[]; sectors: PrintSector[] } | null; error: string | null }>;
  // Fila reorganizada: Atenção (pending/claimed/erros em aberto, qualquer data) + Histórico do período (cursor).
  loadAttention(companyId: string): Promise<{ data: AttentionResult | null; error: string | null }>;
  loadHistory(
    companyId: string,
    range: QueueRange,
    cursor: QueueCursor | null,
    limit: number,
  ): Promise<{ data: HistoryResult | null; error: string | null }>;
  loadJobDetails(jobId: string): Promise<{ data: JobDetails | null; error: string | null }>;
  // Status de UM job (acompanhar o teste de impressão mesmo fora do período exibido).
  loadJobStatus(jobId: string): Promise<{ data: PrintJob | null; error: string | null }>;
  createDevice(companyId: string, input: DeviceInput): Promise<{ error: string | null }>;
  updateDevice(deviceId: string, input: DeviceInput): Promise<{ error: string | null }>;
  archiveDevice(deviceId: string): Promise<{ error: string | null }>;
  testPrint(deviceId: string): Promise<{ error: string | null; jobId?: string | null }>;
  reprint(jobId: string): Promise<{ error: string | null }>;
  loadFailures(companyId: string): Promise<{ data: PrintEnqueueFailure[] | null; error: string | null }>;
  resolveFailure(failureId: string): Promise<{ error: string | null }>;
  loadAgents(companyId: string): Promise<{ data: PrintAgent[] | null; error: string | null }>;
  createPairingCode(companyId: string): Promise<{ data: PairingCode | null; error: string | null }>;
  revokeAgent(agentId: string): Promise<{ error: string | null }>;
  unbindDevice(deviceId: string): Promise<{ error: string | null }>;
  // Realtime (opcional: fontes simuladas não têm). Só avisa qual tabela mudou; a tela recarrega do servidor.
  subscribeToChanges?(companyId: string, onChange: (table: PrintTable) => void): () => void;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`Falha em ${name}:`, error.code);
    return { error: describePrintError(error, SAVE_ERROR) };
  }
  return { error: null };
}

export const supabasePrintingSource: PrintingSource = {
  async loadConfig(companyId) {
    const [devices, routes, sectors] = await Promise.all([
      supabase
        .from("print_devices")
        .select("id, name, paper_width, windows_printer_name, is_ready, agent_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("created_at"),
      supabase.from("print_device_routes").select("print_device_id, route_type, production_sector_id").eq("company_id", companyId),
      supabase.from("production_sectors").select("id, name, is_active").eq("company_id", companyId),
    ]);
    if (devices.error || routes.error || sectors.error) {
      console.error("Falha ao carregar impressão:", devices.error?.code ?? routes.error?.code ?? sectors.error?.code);
      return { data: null, error: LOAD_ERROR };
    }
    const routeRows = routes.data ?? [];
    return {
      data: {
        sectors: (sectors.data ?? []) as PrintSector[],
        devices: (devices.data ?? []).map((d) => ({
          id: d.id as string,
          name: d.name as string,
          paper_width: d.paper_width as PaperWidth,
          windows_printer_name: (d.windows_printer_name as string | null) ?? null,
          ready: d.is_ready === true,
          agent_id: (d.agent_id as string | null) ?? null,
          full_order: routeRows.some((r) => r.print_device_id === d.id && r.route_type === "full_order"),
          documents: routeRows
            .filter((r) => r.print_device_id === d.id && ["customer_bill", "payment_receipt", "cash_closing"].includes(r.route_type))
            .map((r) => r.route_type as DocumentRoute),
          sector_ids: routeRows
            .filter((r) => r.print_device_id === d.id && r.route_type === "production_sector" && r.production_sector_id)
            .map((r) => r.production_sector_id as string),
        })),
      },
      error: null,
    };
  },

  async loadAttention(companyId) {
    const [open, errors] = await Promise.all([
      supabase
        .from("print_jobs")
        .select(JOB_LIST_COLUMNS)
        .eq("company_id", companyId)
        .in("status", ["pending", "claimed"])
        .order("created_at", { ascending: true })
        .limit(ATTENTION_LIMIT + 1),
      supabase
        .from("print_jobs")
        .select(JOB_LIST_COLUMNS)
        .eq("company_id", companyId)
        .eq("status", "error")
        .order("created_at", { ascending: false })
        .limit(ATTENTION_LIMIT + 1),
    ]);
    if (open.error || errors.error) {
      console.error("Falha ao carregar a atenção da fila:", open.error?.code ?? errors.error?.code);
      return { data: null, error: QUEUE_ERROR };
    }
    const errorJobs = ((errors.data ?? []) as unknown as LightRow[]).map(toLightJob);
    // Erro com reimpressão IMPRESSA já foi resolvido: sai da Atenção (continua no histórico).
    let printedReprintOf: string[] = [];
    if (errorJobs.length > 0) {
      const reprints = await supabase
        .from("print_jobs")
        .select("reprint_of_id")
        .eq("company_id", companyId)
        .eq("status", "printed")
        .in("reprint_of_id", errorJobs.map((j) => j.id));
      if (reprints.error) {
        console.error("Falha ao conferir reimpressões:", reprints.error.code);
        return { data: null, error: QUEUE_ERROR };
      }
      printedReprintOf = (reprints.data ?? []).map((r) => (r as { reprint_of_id: string }).reprint_of_id);
    }
    const openJobs = ((open.data ?? []) as unknown as LightRow[]).map(toLightJob);
    return { data: buildAttention(openJobs, unresolvedErrors(errorJobs, printedReprintOf)), error: null };
  },

  async loadHistory(companyId, range, cursor, limit) {
    const { startIso, endIso } = rangeBoundsUtc(range);
    let query = supabase
      .from("print_jobs")
      .select(JOB_LIST_COLUMNS)
      .eq("company_id", companyId)
      .in("status", ["printed", "cancelled", "error"])
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor) {
      // keyset: estritamente mais antigo que (created_at, id) do último item já carregado
      query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
    }
    const { data, error } = await query;
    if (error) {
      console.error("Falha ao carregar o histórico da fila:", error.code);
      return { data: null, error: QUEUE_ERROR };
    }
    const rows = ((data ?? []) as unknown as LightRow[]).map(toLightJob);
    const page = rows.slice(0, limit);
    return { data: { jobs: page, nextCursor: rows.length > limit ? nextCursor(page) : null }, error: null };
  },

  async loadJobDetails(jobId) {
    const { data, error } = await supabase
      .from("print_jobs")
      .select("id, company_id, print_device_id, job_type, status, attempts, error_message, reprint_of_id, created_at, claimed_at, printed_at, payload")
      .eq("id", jobId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("Falha ao carregar o detalhe da impressão:", error.code);
      return { data: null, error: QUEUE_ERROR };
    }
    const row = data as unknown as PrintJob & { claimed_at: string | null; printed_at: string | null };
    const device = await supabase.from("print_devices").select("name, windows_printer_name").eq("id", row.print_device_id).maybeSingle();
    const dev = (device.data ?? null) as { name: string; windows_printer_name: string | null } | null;
    return {
      data: { job: row, claimed_at: row.claimed_at, printed_at: row.printed_at, printer_name: dev?.name ?? null, windows_printer_name: dev?.windows_printer_name ?? null },
      error: null,
    };
  },

  async loadJobStatus(jobId) {
    const { data, error } = await supabase.from("print_jobs").select(JOB_LIST_COLUMNS).eq("id", jobId).maybeSingle();
    if (error) return { data: null, error: QUEUE_ERROR };
    return { data: data ? toLightJob(data as unknown as LightRow) : null, error: null };
  },

  createDevice: (companyId, input) =>
    rpc("create_print_device", {
      p_company_id: companyId,
      p_name: input.name,
      p_paper_width: input.paper_width,
      p_full_order: input.full_order,
      p_sector_ids: input.sector_ids,
      p_documents: input.documents,
    }),

  updateDevice: (deviceId, input) =>
    rpc("update_print_device", {
      p_device_id: deviceId,
      p_name: input.name,
      p_paper_width: input.paper_width,
      p_full_order: input.full_order,
      p_sector_ids: input.sector_ids,
      p_documents: input.documents,
    }),

  async loadFailures(companyId) {
    const { data, error } = await supabase
      .from("print_enqueue_failures")
      .select("id, event_type, summary, created_at")
      .eq("company_id", companyId)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      console.error("Falha ao carregar avisos de impressão:", error.code);
      return { data: null, error: QUEUE_ERROR };
    }
    return { data: (data ?? []) as PrintEnqueueFailure[], error: null };
  },

  async loadAgents(companyId) {
    const { data, error } = await supabase
      .from("print_agents")
      .select("id, name, machine_name, is_active, last_seen_at, created_at")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("created_at");
    if (error) {
      console.error("Falha ao carregar agentes:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    return { data: (data ?? []) as PrintAgent[], error: null };
  },

  async createPairingCode(companyId) {
    const { data, error } = await supabase.rpc("create_print_agent_pairing_code", { p_company_id: companyId });
    if (error) {
      console.error("Falha ao gerar código de conexão:", error.code);
      return { data: null, error: describePrintError(error, SAVE_ERROR) };
    }
    return { data: data as PairingCode, error: null };
  },

  revokeAgent: (agentId) => rpc("revoke_print_agent", { p_agent_id: agentId }),
  unbindDevice: (deviceId) => rpc("unbind_print_device", { p_device_id: deviceId }),
  subscribeToChanges: (companyId, onChange) => subscribeToPrintChanges(supabase as unknown as RealtimeClientLike, companyId, onChange),
  resolveFailure: (failureId) => rpc("resolve_print_enqueue_failure", { p_failure_id: failureId }),
  archiveDevice: (deviceId) => rpc("archive_print_device", { p_device_id: deviceId }),
  // A RPC devolve a linha de print_jobs criada: o id permite à tela acompanhar exatamente este teste.
  async testPrint(deviceId) {
    const { data, error } = await supabase.rpc("enqueue_test_print", { p_device_id: deviceId });
    if (error) {
      console.error("Falha em enqueue_test_print:", error.code);
      return { error: describePrintError(error, SAVE_ERROR) };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const id = row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : null;
    return { error: null, jobId: id };
  },
  reprint: (jobId) => rpc("reprint_print_job", { p_job_id: jobId }),
};

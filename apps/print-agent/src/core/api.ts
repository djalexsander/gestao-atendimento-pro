import { parseClaimResult, type JobModel } from "./model.ts";

// Cliente das RPCs do agente. Credencial = (agent_id, token) validados no servidor; o app só conhece a
// URL e a chave PÚBLICA (anon) do Supabase. Nunca há service_role aqui.

export type FailureKind = "offline" | "unauthorized" | "rate_limited" | "rejected";
export type ApiResult<T> = { ok: true; data: T } | { ok: false; kind: FailureKind; message: string };

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface Credentials {
  agentId: string;
  token: string;
}

export interface LogicalDevice {
  id: string;
  name: string;
  paperWidth: number;
  // "label" = impressora de etiquetas (sem papel 58/80); labelSummary = "50 × 30 mm · 2 colunas".
  kind: "receipt" | "label";
  labelSummary: string | null;
  windowsPrinterName: string | null;
  isReady: boolean;
  boundToMe: boolean;
  boundToOther: boolean;
  fullOrder: boolean;
  sectors: string[];
  documents: string[];
}

function labelSummaryOf(l: Record<string, unknown>): string | null {
  const w = Number(l.width_mm), h = Number(l.height_mm), c = Number(l.columns);
  return Number.isFinite(w) && Number.isFinite(h) && Number.isFinite(c) ? `${w} × ${h} mm · ${c} ${c === 1 ? "coluna" : "colunas"}` : null;
}

export const DOCUMENT_LABEL: Record<string, string> = {
  customer_bill: "Conta",
  payment_receipt: "Comprovante",
  cash_closing: "Fechamento",
};

export const OFFLINE_MESSAGE = "Sem conexão com o servidor.";
const TIMEOUT_MS = 10_000;

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class AgentApi {
  private readonly base: string;
  private readonly anonKey: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(cfg: { supabaseUrl: string; anonKey: string }, fetchFn: FetchLike, timeoutMs: number = TIMEOUT_MS) {
    this.base = `${cfg.supabaseUrl}/rest/v1/rpc/`;
    this.anonKey = cfg.anonKey;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  // Erro de rede/timeout/5xx = offline (o app segue vivo e tenta de novo); 401 = credencial inválida;
  // demais 4xx = recusa do servidor com a mensagem amigável do banco.
  async rpc(name: string, args: Record<string, unknown>): Promise<ApiResult<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.base + name, {
        method: "POST",
        headers: { apikey: this.anonKey, Authorization: `Bearer ${this.anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      const raw = await res.text();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      if (res.ok) return { ok: true, data: body };
      if (res.status >= 500) return { ok: false, kind: "offline", message: OFFLINE_MESSAGE };
      const err = record(body);
      const message = typeof err.message === "string" ? err.message : "O servidor recusou a operação.";
      if (err.code === "PT401" || res.status === 401) return { ok: false, kind: "unauthorized", message };
      return { ok: false, kind: "rejected", message };
    } catch {
      return { ok: false, kind: "offline", message: OFFLINE_MESSAGE };
    } finally {
      clearTimeout(timer);
    }
  }

  async pair(code: string, machineId: string, machineName: string): Promise<ApiResult<{ agentId: string; token: string; agentName: string; companyName: string }>> {
    const res = await this.rpc("pair_print_agent", { p_code: code, p_machine_id: machineId, p_machine_name: machineName });
    if (!res.ok) return res;
    const r = record(res.data);
    if (r.ok === true && typeof r.agent_id === "string" && typeof r.token === "string") {
      return {
        ok: true,
        data: {
          agentId: r.agent_id,
          token: r.token,
          agentName: typeof r.agent_name === "string" ? r.agent_name : machineName,
          companyName: typeof r.company_name === "string" ? r.company_name : "",
        },
      };
    }
    if (r.error === "rate_limited") {
      return { ok: false, kind: "rate_limited", message: "Muitas tentativas. Aguarde alguns minutos e tente de novo." };
    }
    return { ok: false, kind: "rejected", message: "Código inválido ou expirado. Gere um novo código no sistema." };
  }

  async heartbeat(c: Credentials): Promise<ApiResult<{ companyName: string; agentName: string }>> {
    const res = await this.rpc("print_agent_heartbeat", { p_agent_id: c.agentId, p_token: c.token });
    if (!res.ok) return res;
    const r = record(res.data);
    return { ok: true, data: { companyName: String(r.company_name ?? ""), agentName: String(r.agent_name ?? "") } };
  }

  async listDevices(c: Credentials): Promise<ApiResult<LogicalDevice[]>> {
    const res = await this.rpc("list_agent_print_devices", { p_agent_id: c.agentId, p_token: c.token });
    if (!res.ok) return res;
    const list = Array.isArray(res.data) ? res.data : [];
    return {
      ok: true,
      data: list.map((entry) => {
        const d = record(entry);
        return {
          id: String(d.id),
          name: String(d.name ?? "?"),
          paperWidth: Number(d.paper_width) || 80,
          kind: d.device_kind === "label" ? "label" : "receipt",
          labelSummary: d.device_kind === "label" ? labelSummaryOf(record(d.label)) : null,
          windowsPrinterName: typeof d.windows_printer_name === "string" ? d.windows_printer_name : null,
          isReady: d.is_ready === true,
          boundToMe: d.bound_to_me === true,
          boundToOther: d.bound_to_other === true,
          fullOrder: d.full_order === true,
          sectors: Array.isArray(d.sectors) ? d.sectors.map(String) : [],
          documents: Array.isArray(d.documents) ? d.documents.map(String) : [],
        };
      }),
    };
  }

  async bind(c: Credentials, deviceId: string, windowsPrinterName: string): Promise<ApiResult<null>> {
    const res = await this.rpc("bind_print_device", {
      p_agent_id: c.agentId,
      p_token: c.token,
      p_print_device_id: deviceId,
      p_windows_printer_name: windowsPrinterName,
    });
    return res.ok ? { ok: true, data: null } : res;
  }

  async claim(c: Credentials, limit: number): Promise<ApiResult<{ jobs: JobModel[]; invalid: number }>> {
    const res = await this.rpc("claim_print_jobs", { p_agent_id: c.agentId, p_token: c.token, p_limit: limit, p_capabilities: ["labels"] });
    if (!res.ok) return res;
    return { ok: true, data: parseClaimResult(res.data) };
  }

  async complete(c: Credentials, jobId: string): Promise<ApiResult<null>> {
    const res = await this.rpc("complete_print_job", { p_agent_id: c.agentId, p_token: c.token, p_job_id: jobId });
    return res.ok ? { ok: true, data: null } : res;
  }

  async fail(c: Credentials, jobId: string, error: string): Promise<ApiResult<null>> {
    const res = await this.rpc("fail_print_job", { p_agent_id: c.agentId, p_token: c.token, p_job_id: jobId, p_error: error });
    return res.ok ? { ok: true, data: null } : res;
  }
}

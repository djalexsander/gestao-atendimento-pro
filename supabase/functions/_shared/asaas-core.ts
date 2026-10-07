// Núcleo do Asaas: configuração por secrets, cliente HTTP com timeout/classificação de erro e utilitários puros. Sem imports
// e sem Deno: testável em qualquer runtime com um fetch simulado.
//
// SEGURANÇA
//   * ASAAS_API_KEY, ASAAS_ENV e ASAAS_WEBHOOK_TOKEN só existem como secrets das Edge Functions (nunca no frontend,
//     em VITE_ ou no git). Nenhum valor tem default: sem configuração completa NENHUMA chamada ao Asaas acontece.
//   * AMBIENTE: ASAAS_ENV aceita SOMENTE "sandbox" ou "production" (exato, sem fallback). Ausente, vazio ou qualquer outro
//     valor => recusa antes de qualquer requisição (nunca cai em produção por engano). A URL base é escolhida AQUI, uma só
//     vez, por getAsaasBaseUrl(); billing-charge, billing-worker e asaas-webhook (reconsulta do pagamento) usam o MESMO
//     cliente criado desta configuração, então customer, payment e Pix nunca misturam ambientes.
//   * Cada ambiente tem a sua própria chave: chave de produção ("_prod_") em sandbox e chave de homologação ("_hmlg_") em
//     produção são recusadas.
//   * Chave, token e dados do cliente nunca entram em log/erro devolvido.

export type AsaasEnvironment = "sandbox" | "production";
const ASAAS_BASE_URLS: Record<AsaasEnvironment, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};
const USER_AGENT = "GestaoAtendimentoPro-Billing/1.0";

/** Única fonte da URL base da API do Asaas. */
export function getAsaasBaseUrl(environment: AsaasEnvironment): string {
  return ASAAS_BASE_URLS[environment];
}

/** "sandbox" | "production" (aparando espaços/caixa) ou null para ausente, vazio ou desconhecido. */
export function parseAsaasEnv(raw: string | undefined | null): AsaasEnvironment | null {
  const env = (raw ?? "").trim().toLowerCase();
  return env === "sandbox" || env === "production" ? env : null;
}

export interface AsaasConfig {
  apiKey: string;
  baseUrl: string;
  /** só para log/diagnóstico (nunca a chave) */
  environment: AsaasEnvironment;
}
export type AsaasConfigResult =
  | { ok: true; config: AsaasConfig }
  | {
      ok: false;
      reason: "missing_api_key" | "missing_env" | "unsupported_env" | "production_key_in_sandbox" | "sandbox_key_in_production";
    };

export function readAsaasConfig(getEnv: (name: string) => string | undefined): AsaasConfigResult {
  const raw = (getEnv("ASAAS_ENV") ?? "").trim();
  if (!raw) return { ok: false, reason: "missing_env" };
  const environment = parseAsaasEnv(raw);
  if (!environment) return { ok: false, reason: "unsupported_env" };
  const apiKey = (getEnv("ASAAS_API_KEY") ?? "").trim();
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  // marcadores de ambiente da chave do Asaas: produção "_prod_", homologação (sandbox) "_hmlg_"
  if (environment === "sandbox" && apiKey.includes("_prod_")) return { ok: false, reason: "production_key_in_sandbox" };
  if (environment === "production" && apiKey.includes("_hmlg_")) return { ok: false, reason: "sandbox_key_in_production" };
  return { ok: true, config: { apiKey, baseUrl: getAsaasBaseUrl(environment), environment } };
}

export function timingSafeEqual(received: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(received);
  const b = encoder.encode(expected);
  const length = Math.max(a.length, b.length, 1);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const centsToValue = (cents: number): number => Math.round(cents) / 100;
export const valueToCents = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

// --- Erros ----------------------------------------------------------------------------------------------------------

export class AsaasApiError extends Error {
  // transient: vale tentar de novo (rede, timeout, 408/429/5xx). uncertain: a requisição pode ter sido aplicada no
  // Asaas (timeout/queda de conexão) — quem criou algo deve consultar antes de recriar.
  constructor(
    message: string,
    readonly status: number,
    readonly transient: boolean,
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = "AsaasApiError";
  }
}

// --- Cliente --------------------------------------------------------------------------------------------------------

export interface AsaasPaymentDto {
  id?: string;
  status?: string;
  value?: number;
  billingType?: string | null;
  externalReference?: string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  confirmedDate?: string | null;
  clientPaymentDate?: string | null;
  invoiceUrl?: string | null;
  deleted?: boolean | null;
  customer?: string | null;
}
export interface AsaasCustomerDto {
  id?: string;
  externalReference?: string | null;
  cpfCnpj?: string | null;
  deleted?: boolean | null;
}
export interface AsaasPixQrCode {
  encodedImage?: string | null;
  payload?: string | null;
  expirationDate?: string | null;
}

/**
 * Prefixo do externalReference das NOSSAS cobranças (gestao-atendimento-pro|invoice|<uuid>). A conta Asaas de produção é
 * compartilhada com outros sistemas: o que não tiver este prefixo é de outro sistema e nunca é tocado por nós.
 */
export const OUR_INVOICE_REF_PREFIX = "gestao-atendimento-pro|invoice|";
export function isOurInvoiceReference(ref: unknown): boolean {
  return typeof ref === "string" && ref.startsWith(OUR_INVOICE_REF_PREFIX);
}

export interface AsaasClient {
  /** ambiente do qual o cliente foi criado: todo id/estado gravado no banco carrega este valor */
  readonly environment: AsaasEnvironment;
  /** busca SOMENTE por externalReference (company:<id>); nunca por CPF/CNPJ, para não adotar customer de outro sistema */
  findCustomer(externalReference: string): Promise<string | null>;
  createCustomer(input: { name: string; cpfCnpj: string; email: string; mobilePhone?: string | null; externalReference: string }): Promise<string>;
  findPaymentByExternalReference(externalReference: string): Promise<AsaasPaymentDto | null>;
  createPayment(input: { customer: string; valueCents: number; dueDate: string; description: string; externalReference: string }): Promise<AsaasPaymentDto>;
  getPayment(paymentId: string): Promise<AsaasPaymentDto>;
  getPixQrCode(paymentId: string): Promise<AsaasPixQrCode>;
  deletePayment(paymentId: string): Promise<"deleted" | "not_found">;
}

export function createAsaasClient(
  config: AsaasConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15000,
): AsaasClient {
  async function request(method: string, path: string, body?: unknown, mutating = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          access_token: config.apiKey,
          "User-Agent": USER_AGENT,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // rede/timeout: o resultado de uma escrita é INCERTO
      throw new AsaasApiError("falha de rede ao chamar o Asaas", 0, true, mutating);
    }
    const raw = await response.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (response.status === 404) throw new AsaasApiError("recurso não encontrado no Asaas", 404, false, false);
    if (!response.ok) {
      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      // mensagem curta e SEM corpo da resposta (pode conter dados do cliente)
      throw new AsaasApiError(`Asaas respondeu ${response.status}`, response.status, transient, mutating && transient);
    }
    return data;
  }

  const list = <T>(data: unknown): T[] =>
    data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data) ? ((data as { data: T[] }).data) : [];
  const q = encodeURIComponent;

  return {
    environment: config.environment,
    async findCustomer(externalReference) {
      // o filtro por externalReference é documentado, mas cada item é CONFERIDO: se o filtro for ignorado, nada alheio é adotado.
      // NÃO há busca por CPF/CNPJ: em conta compartilhada ela poderia adotar o customer de outro sistema.
      const byRef = list<AsaasCustomerDto>(await request("GET", `/customers?externalReference=${q(externalReference)}&limit=100`));
      const exact = byRef.find((c) => c.id && c.externalReference === externalReference && !c.deleted);
      return exact?.id ?? null;
    },
    async createCustomer(input) {
      const body: Record<string, unknown> = {
        name: input.name,
        cpfCnpj: input.cpfCnpj,
        email: input.email,
        externalReference: input.externalReference,
      };
      if (input.mobilePhone) body.mobilePhone = input.mobilePhone;
      const data = (await request("POST", "/customers", body, true)) as AsaasCustomerDto | null;
      if (!data?.id) throw new AsaasApiError("Asaas não retornou o id do cliente", 502, true, false);
      return data.id;
    },
    async findPaymentByExternalReference(externalReference) {
      const items = list<AsaasPaymentDto>(await request("GET", `/payments?externalReference=${q(externalReference)}&limit=100`));
      const mine = items.filter((p) => p.id && p.externalReference === externalReference && !p.deleted && (p.billingType ?? "PIX") === "PIX");
      // prefere a que já foi paga, depois as abertas
      const rank = (p: AsaasPaymentDto) => (["RECEIVED", "CONFIRMED"].includes(String(p.status)) ? 0 : 1);
      mine.sort((a, b) => rank(a) - rank(b));
      return mine[0] ?? null;
    },
    async createPayment(input) {
      const data = (await request(
        "POST",
        "/payments",
        {
          customer: input.customer,
          billingType: "PIX",
          value: centsToValue(input.valueCents),
          dueDate: input.dueDate,
          description: input.description.slice(0, 500),
          externalReference: input.externalReference,
        },
        true,
      )) as AsaasPaymentDto | null;
      if (!data?.id) throw new AsaasApiError("Asaas não retornou o id da cobrança", 502, true, true);
      return data;
    },
    async getPayment(paymentId) {
      const data = (await request("GET", `/payments/${q(paymentId)}`)) as AsaasPaymentDto | null;
      if (!data || typeof data !== "object") throw new AsaasApiError("resposta inválida do Asaas", 502, true, false);
      return data;
    },
    async getPixQrCode(paymentId) {
      const data = (await request("GET", `/payments/${q(paymentId)}/pixQrCode`)) as AsaasPixQrCode | null;
      return data ?? {};
    },
    async deletePayment(paymentId) {
      try {
        await request("DELETE", `/payments/${q(paymentId)}`, undefined, true);
        return "deleted";
      } catch (e) {
        if (e instanceof AsaasApiError && e.status === 404) return "not_found";
        throw e;
      }
    },
  };
}

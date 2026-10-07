// Edge Function billing-charge: gera (ou devolve) a cobrança Pix Asaas de UMA fatura em aberto, a pedido do OWNER.
//
// Segurança
//   * JWT obrigatório (verify_jwt em config.toml + validação aqui). O usuário vem do JWT, NUNCA do corpo.
//   * O corpo aceita SOMENTE { invoice_id }. company_id, amount, due_date, document, plano/módulos... são recusados
//     (400): tudo isso é lido/calculado no servidor a partir da fatura.
//   * Autorização no banco, com o JWT do próprio usuário: tenant_prepare_invoice_charge exige OWNER ativo da empresa
//     da fatura e fatura aberta. Só então as RPCs billing_* (service_role) e o Asaas entram.
//   * Sem ASAAS_ENV válido (sandbox ou production) + ASAAS_API_KEY: 503 e NENHUMA chamada ao Asaas.
//   * A resposta devolve só o necessário para exibir o Pix (nunca ids do Asaas, nem customer).
import { type AsaasClient, type AsaasConfigResult } from "../_shared/asaas-core.ts";
import { type BillingDb, createChargeForInvoice } from "../_shared/billing-core.ts";

export interface PrepareResult {
  ok: boolean;
  status?: number;
  error?: string;
}
export interface ChargeDeps {
  config: AsaasConfigResult;
  // service_role: RPCs billing_*
  db: BillingDb;
  createAsaas(): AsaasClient;
  // valida o JWT e devolve o id do usuário (ou null)
  authenticate(jwt: string): Promise<string | null>;
  // tenant_prepare_invoice_charge com o JWT do usuário
  prepare(authorization: string, invoiceId: string): Promise<PrepareResult>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

export async function handleBillingCharge(req: Request, deps: ChargeDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Faça login para continuar." }, 401);
  const userId = await deps.authenticate(authorization.slice("Bearer ".length));
  if (!userId) return json({ error: "Sessão inválida. Entre novamente." }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Requisição inválida." }, 400);
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((k) => k !== "invoice_id")) return json({ error: "Campos não permitidos na requisição." }, 400);
  const invoiceId = (body as Record<string, unknown>).invoice_id;
  if (typeof invoiceId !== "string" || !UUID_RE.test(invoiceId)) return json({ error: "Informe a fatura." }, 400);

  const prep = await deps.prepare(authorization, invoiceId.toLowerCase());
  if (!prep.ok) return json({ error: prep.error ?? "Não foi possível concluir a operação." }, prep.status ?? 500);

  if (!deps.config.ok) {
    console.error(`billing-charge: Asaas não configurado (${deps.config.reason})`);
    return json({ error: "Cobrança indisponível no momento. Tente novamente mais tarde." }, 503);
  }

  const outcome = await createChargeForInvoice(deps.db, deps.createAsaas(), invoiceId.toLowerCase());
  switch (outcome.kind) {
    case "ready":
      return json({
        state: "ready",
        payment: {
          status: outcome.charge.status,
          invoice_url: outcome.charge.invoice_url,
          pix_payload: outcome.charge.pix_payload,
          pix_qr: outcome.charge.pix_qr,
          gateway_due_date: outcome.charge.gateway_due_date,
          amount_cents: outcome.charge.amount_cents,
        },
      });
    case "busy":
      return json({ state: "creating" }, 202);
    case "ineligible":
      return json({ error: "Esta fatura não está disponível para cobrança." }, 409);
    default:
      console.error(`billing-charge: falha ao gerar a cobrança (${outcome.retryable ? "transitória" : "definitiva"})`);
      return json({ error: "Não foi possível gerar a cobrança agora. Tente novamente em instantes." }, 502);
  }
}

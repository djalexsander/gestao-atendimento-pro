// Edge Function billing-worker: consome o outbox (billing_jobs) e a reconciliação leve. Chamada SÓ pelo banco
// (pg_net, billing_dispatch_jobs a cada 5 min, e apenas quando há trabalho) com o segredo compartilhado no header
// x-internal-secret (>= 32 caracteres, tempo constante). verify_jwt = false em config.toml: não há JWT de usuário.
//
//   create_charge  -> createChargeForInvoice (idempotente pela fatura; lease; consulta por externalReference)
//   cancel_charge  -> exclui a cobrança Asaas aberta de fatura paga por outro caminho/anulada (nunca uma já recebida)
//   reconciliação  -> cobranças abertas sem conferência há >6h: reconsulta e aplica pelo MESMO caminho do webhook
//                    (cura evento perdido; não é polling agressivo)
//
// Sem ASAAS_ENV válido (sandbox ou production) + ASAAS_API_KEY: 503 ANTES de reivindicar qualquer job (nada é consumido nem chamado).
import { authorizeInternalRequest } from "../_shared/push-core.ts";
import { type AsaasClient, type AsaasConfigResult } from "../_shared/asaas-core.ts";
import { type BillingDb, cancelChargeForInvoice, createChargeForInvoice, processPaymentEvent } from "../_shared/billing-core.ts";

export interface WorkerDeps {
  internalSecret: string | undefined;
  config: AsaasConfigResult;
  db: BillingDb;
  createAsaas(): AsaasClient;
  today(): string; // AAAA-MM-DD (chave de dedupe da reconciliação)
}

interface Job {
  id: string;
  invoice_id: string;
  kind: "create_charge" | "cancel_charge";
  attempts: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export async function handleBillingWorker(req: Request, deps: WorkerDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = authorizeInternalRequest(deps.internalSecret, req.headers.get("x-internal-secret"));
  if (auth === "misconfigured") {
    console.error("billing-worker: BILLING_WORKER_SECRET ausente ou com menos de 32 caracteres");
    return json({ error: "Worker unavailable" }, 503);
  }
  if (auth === "unauthorized") {
    console.error("billing-worker: chamada não autorizada recusada");
    return json({ error: "Unauthorized" }, 401);
  }
  if (!deps.config.ok) {
    console.error(`billing-worker: Asaas não configurado (${deps.config.reason})`);
    return json({ error: "Worker unavailable" }, 503);
  }

  const asaas = deps.createAsaas();
  const summary = { jobs: 0, done: 0, retried: 0, failed: 0, reconciled: 0, reconcile_errors: 0 };

  const claimed = await deps.db.rpc("billing_claim_jobs", { p_limit: 10 });
  if (claimed.error) {
    console.error("billing-worker: falha ao reivindicar jobs");
    return json({ error: "Unable to claim jobs" }, 500);
  }
  const jobs = (claimed.data ?? []) as Job[];
  summary.jobs = jobs.length;

  for (const job of jobs) {
    let outcome: "done" | "retry" | "failed" = "retry";
    let error: string | null = null;
    try {
      if (job.kind === "create_charge") {
        const r = await createChargeForInvoice(deps.db, asaas, job.invoice_id);
        if (r.kind === "ready" || r.kind === "ineligible") outcome = "done";
        else if (r.kind === "busy") { outcome = "retry"; error = "cobrança em criação por outro processo"; }
        else { outcome = r.retryable ? "retry" : "failed"; error = r.error; }
      } else {
        const r = await cancelChargeForInvoice(deps.db, asaas, job.invoice_id);
        if (r.kind === "done") outcome = "done";
        else { outcome = "retry"; error = r.error; }
      }
    } catch (e) {
      outcome = "retry";
      error = e instanceof Error ? e.message.slice(0, 300) : "erro";
    }
    await deps.db.rpc("billing_complete_job", { p_job_id: job.id, p_outcome: outcome, p_error: error });
    if (outcome === "done") summary.done += 1;
    else if (outcome === "retry") summary.retried += 1;
    else summary.failed += 1;
  }

  const rec = await deps.db.rpc("billing_claim_reconcile", { p_environment: asaas.environment, p_limit: 10 });
  if (!rec.error) {
    for (const item of (rec.data ?? []) as Array<{ asaas_payment_id: string }>) {
      const r = await processPaymentEvent(deps.db, asaas, {
        eventId: `reconcile:${item.asaas_payment_id}:${deps.today()}`,
        event: "PAYMENT_RECONCILE",
        paymentId: item.asaas_payment_id,
        storedPayload: { event: "PAYMENT_RECONCILE", payment: { id: item.asaas_payment_id } },
      });
      if (r.http === 200) summary.reconciled += 1;
      else summary.reconcile_errors += 1;
    }
  }

  return json(summary);
}

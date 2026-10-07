// Edge Function asaas-webhook (PÚBLICA, verify_jwt = false): recebe os eventos de cobrança do Asaas.
//
// Segurança e semântica
//   * Autenticação: header `asaas-access-token` contra ASAAS_WEBHOOK_TOKEN, em TEMPO CONSTANTE. Sem token configurado,
//     sem ASAAS_ENV válido (sandbox ou production) ou sem chave: 503 e nada é processado (o Asaas retenta; a fila só pausa após 15 falhas).
//   * O payload NUNCA é confiado: o pagamento é RECONSULTADO no Asaas (GET /payments/{id}) e o banco valida id, referência
//     externa, valor, fatura e empresa antes de mudar qualquer estado (billing_event_apply).
//   * Idempotência: event_id do Asaas (ou hash do corpo quando não houver) em asaas_webhook_events.
//   * Resposta: 2xx para tudo que é definitivo (inclusive divergências, que viram anomalia); 5xx SÓ para falha transitória
//     real (Asaas fora do ar, banco indisponível), para o Asaas reentregar.
//   * Só eventos PAYMENT_* interessam; os demais são registrados como ignorados.
//   * O que se guarda do evento é MÍNIMO (id, evento, id/status/valor/referência do pagamento): nada do cliente.
import { type AsaasClient, type AsaasConfigResult, timingSafeEqual } from "../_shared/asaas-core.ts";
import { type BillingDb, processPaymentEvent } from "../_shared/billing-core.ts";

export interface WebhookDeps {
  config: AsaasConfigResult;
  webhookToken: string | undefined;
  db: BillingDb;
  createAsaas(): AsaasClient;
  sha256(value: string): Promise<string>;
}

const MAX_BODY_BYTES = 256 * 1024;
const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function handleAsaasWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method === "GET") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  if (!deps.webhookToken || !deps.config.ok) {
    console.error("asaas-webhook: não configurado (ASAAS_WEBHOOK_TOKEN/ASAAS_ENV/ASAAS_API_KEY)");
    return json({ error: "Webhook indisponível." }, 503);
  }

  const received = req.headers.get("asaas-access-token") ?? req.headers.get("x-asaas-access-token") ?? "";
  if (!timingSafeEqual(received, deps.webhookToken)) {
    console.warn("asaas-webhook: token inválido");
    return json({ error: "Não autorizado." }, 401);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Corpo grande demais." }, 413);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const event = typeof payload.event === "string" && payload.event ? payload.event : "UNKNOWN";
  const payment = payload.payment && typeof payload.payment === "object" ? (payload.payment as Record<string, unknown>) : null;
  const paymentId = typeof payment?.id === "string" && payment.id ? payment.id : null;
  const suppliedId = typeof payload.id === "string" && payload.id ? payload.id : null;
  const eventId = suppliedId ?? `sha256:${await deps.sha256(raw)}`;

  const stored: Record<string, unknown> = {
    event,
    id: suppliedId,
    payment: payment
      ? {
          id: paymentId,
          status: typeof payment.status === "string" ? payment.status : null,
          value: typeof payment.value === "number" ? payment.value : null,
          externalReference: typeof payment.externalReference === "string" ? payment.externalReference : null,
          billingType: typeof payment.billingType === "string" ? payment.billingType : null,
        }
      : null,
  };

  // eventos que não são de cobrança (assinatura, checkout, nota...) ou sem pagamento: registra e encerra
  if (!event.startsWith("PAYMENT_") || !paymentId) {
    const begin = await deps.db.rpc("billing_event_begin", { p_event_id: eventId, p_event: event, p_payment_id: paymentId, p_payload: stored });
    if (begin.error) return json({ error: "Falha ao registrar o evento." }, 500);
    await deps.db.rpc("billing_event_finish", { p_event_id: eventId, p_status: "ignored", p_result: "evento_sem_pagamento", p_error: null });
    return json({ received: true, processed: false });
  }

  const outcome = await processPaymentEvent(deps.db, deps.createAsaas(), { eventId, event, paymentId, storedPayload: stored });
  if (outcome.http === 500) {
    console.error("asaas-webhook: falha transitória ao processar o evento");
    return json({ error: "Falha ao processar o evento." }, 500);
  }
  return json({ received: true, result: outcome.result });
}

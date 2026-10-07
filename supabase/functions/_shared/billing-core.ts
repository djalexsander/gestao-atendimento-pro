// Fluxos de cobrança compartilhados por billing-charge (usuário) e billing-worker (outbox/cron). Toda decisão de
// estado é do BANCO (RPCs billing_*); aqui só se orquestra a chamada HTTP ao Asaas FORA de qualquer transação:
//
//   reservar (lease) -> customer (lease) -> [consultar por externalReference] -> POST /payments -> gravar o id ->
//   GET pixQrCode -> gravar o Pix
//
// Cada gravação carrega o lease_token; quem perde o lease não grava mais nada (um segundo worker assumiu).
import { AsaasApiError, type AsaasClient, type AsaasPaymentDto, isOurInvoiceReference, valueToCents } from "./asaas-core.ts";

export interface RpcError {
  message: string;
  code?: string;
}
export interface BillingDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

async function call<T = Record<string, unknown>>(db: BillingDb, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export interface PublicCharge {
  status: string;
  invoice_url: string | null;
  pix_payload: string | null;
  pix_qr: string | null;
  gateway_due_date: string;
  amount_cents: number;
}
export type ChargeOutcome =
  | { kind: "ready"; charge: PublicCharge }
  | { kind: "busy" }
  | { kind: "ineligible"; reason: string }
  | { kind: "failed"; error: string; retryable: boolean };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const isTransient = (e: unknown): boolean => !(e instanceof AsaasApiError) || e.transient;

// --- Customer -------------------------------------------------------------------------------------------------------

type CustomerResult = { ok: true; customerId: string } | { ok: false; reason: string; retryable: boolean };

export async function ensureCustomer(db: BillingDb, asaas: AsaasClient, companyId: string): Promise<CustomerResult> {
  const claim = await call<{
    state: string; problem?: string; customer_id?: string; token?: string; external_reference?: string;
    profile?: { name: string; document: string; email: string; phone: string | null };
  }>(db, "billing_claim_customer", { p_company_id: companyId, p_environment: asaas.environment });

  if (claim.state === "ready" && claim.customer_id) return { ok: true, customerId: claim.customer_id };
  if (claim.state === "invalid_profile") return { ok: false, reason: `perfil de cobrança inválido (${claim.problem})`, retryable: true };
  if (claim.state === "busy") return { ok: false, reason: "customer em criação por outro processo", retryable: true };
  if (claim.state !== "claimed" || !claim.token || !claim.profile || !claim.external_reference) {
    return { ok: false, reason: "estado inesperado do customer", retryable: true };
  }

  try {
    let customerId = await asaas.findCustomer(claim.external_reference);
    if (!customerId) {
      customerId = await asaas.createCustomer({
        name: claim.profile.name,
        cpfCnpj: claim.profile.document,
        email: claim.profile.email,
        mobilePhone: claim.profile.phone,
        externalReference: claim.external_reference,
      });
    }
    const set = await call<{ ok: boolean; reason?: string }>(db, "billing_set_customer", {
      p_company_id: companyId, p_token: claim.token, p_customer_id: customerId, p_environment: asaas.environment,
    });
    if (!set.ok) return { ok: false, reason: `customer não gravado (${set.reason})`, retryable: set.reason === "lease_lost" };
    return { ok: true, customerId };
  } catch (e) {
    await db.rpc("billing_release_customer", { p_company_id: companyId, p_token: claim.token, p_environment: asaas.environment });
    return { ok: false, reason: errText(e), retryable: isTransient(e) };
  }
}

// --- Cobrança -------------------------------------------------------------------------------------------------------

export async function createChargeForInvoice(db: BillingDb, asaas: AsaasClient, invoiceId: string): Promise<ChargeOutcome> {
  const claim = await call<{
    state: string; reason?: string; token?: string; company_id?: string; description?: string; charge?: Record<string, unknown>;
  }>(db, "billing_claim_charge", { p_invoice_id: invoiceId, p_environment: asaas.environment });

  if (claim.state === "ready") return { kind: "ready", charge: claim.charge as unknown as PublicCharge };
  if (claim.state === "busy") return { kind: "busy" };
  if (claim.state === "ineligible") return { kind: "ineligible", reason: claim.reason ?? "ineligible" };
  if (claim.state !== "claimed" || !claim.token || !claim.charge || !claim.company_id) {
    return { kind: "failed", error: "estado inesperado da cobrança", retryable: true };
  }

  const chargeId = claim.charge.id as string;
  const companyId = claim.company_id;
  const token = claim.token;
  const ref = claim.charge.external_reference as string;
  const amountCents = claim.charge.amount_cents as number;
  // Depois que o POST /payments foi CONFIRMADO (id gravado), a cobrança existe no Asaas: qualquer falha adiante (QR, rede,
  // 4xx de configuração) é só a ETAPA RESTANTE e deve ser retentada — nunca recriar a cobrança nem virar falha definitiva.
  let paymentKnown = Boolean(claim.charge.asaas_payment_id);
  const fail = async (e: unknown, retryable = paymentKnown ? true : isTransient(e)): Promise<ChargeOutcome> => {
    await db.rpc("billing_charge_fail", { p_charge_id: chargeId, p_token: token, p_error: errText(e) });
    return { kind: "failed", error: errText(e), retryable };
  };
  // divergência entre o que o Asaas devolve e o que a fatura local manda: anomalia auditável (deduplicada), sem retry cego
  const diverged = async (kind: "value_mismatch" | "reference_mismatch", detail: Record<string, unknown>): Promise<ChargeOutcome> => {
    await db.rpc("billing_record_anomaly", {
      p_kind: kind, p_detail: { stage: "charge_creation", ...detail }, p_company_id: companyId, p_invoice_id: invoiceId,
      p_charge_id: chargeId, p_event_id: `charge:${chargeId}:${kind}`, p_environment: asaas.environment,
    });
    return await fail(new Error(kind === "value_mismatch" ? "valor da cobrança no Asaas diverge da fatura" : "referência da cobrança no Asaas diverge da fatura"), false);
  };
  const checkConsistency = async (p: AsaasPaymentDto): Promise<ChargeOutcome | null> => {
    if (p.externalReference !== ref) return await diverged("reference_mismatch", { gateway_reference: p.externalReference ?? null });
    const cents = valueToCents(p.value);
    if (cents !== amountCents) return await diverged("value_mismatch", { gateway_value_cents: cents, charge_amount_cents: amountCents });
    return null;
  };
  const retiredOnGateway = async (reason: string): Promise<ChargeOutcome> => {
    await db.rpc("billing_charge_mark_deleted", { p_charge_id: chargeId, p_reason: reason });
    return { kind: "failed", error: `${reason}; será recriada`, retryable: true };
  };

  try {
    let paymentId = (claim.charge.asaas_payment_id as string | null) ?? null;
    let payment: AsaasPaymentDto | null = null;

    if (!paymentId) {
      const customer = await ensureCustomer(db, asaas, companyId);
      if (!customer.ok) return await fail(new Error(customer.reason), customer.retryable);

      // ANTES de criar: um timeout anterior pode ter criado a cobrança no Asaas (consulta por externalReference)
      payment = await asaas.findPaymentByExternalReference(ref);
      if (payment) {
        const bad = await checkConsistency(payment);
        if (bad) return bad;
      } else {
        payment = await asaas.createPayment({
          customer: customer.customerId,
          valueCents: amountCents,
          dueDate: String(claim.charge.gateway_due_date).slice(0, 10),
          description: claim.description ?? "Gestão Atendimento Pro",
          externalReference: ref,
        });
      }
      paymentId = payment.id as string;

      const rec = await call<{ ok: boolean; reason?: string; invoice_status?: string }>(db, "billing_charge_record_payment", {
        p_charge_id: chargeId, p_token: token, p_payment_id: paymentId,
        p_invoice_url: payment.invoiceUrl ?? null, p_asaas_status: payment.status ?? null,
      });
      if (!rec.ok) return { kind: "busy" }; // lease perdido: outro processo assumiu
      paymentKnown = true;
      if (rec.invoice_status && !["open", "overdue"].includes(rec.invoice_status)) {
        // a fatura foi paga/anulada enquanto o POST estava em curso: não deixa cobrança órfã no Asaas
        await asaas.deletePayment(paymentId);
        await db.rpc("billing_charge_mark_deleted", { p_charge_id: chargeId, p_reason: "fatura encerrada durante a criação" });
        return { kind: "ineligible", reason: `invoice_${rec.invoice_status}` };
      }
    } else {
      // RETOMADA (id já gravado): NUNCA há novo POST. Reconsulta o estado real e completa só o que falta (o QR).
      try {
        payment = await asaas.getPayment(paymentId);
      } catch (e) {
        if (e instanceof AsaasApiError && e.status === 404) return await retiredOnGateway("cobrança inexistente no Asaas");
        throw e;
      }
      if (payment.deleted === true) return await retiredOnGateway("cobrança excluída no Asaas");
      const bad = await checkConsistency(payment);
      if (bad) return bad;
      // já paga: o webhook/reconciliação baixa a fatura; não há QR a buscar
      if (["RECEIVED", "CONFIRMED"].includes(String(payment.status).toUpperCase())) {
        return { kind: "ineligible", reason: "payment_already_received" };
      }
    }

    let pix;
    try {
      pix = await asaas.getPixQrCode(paymentId);
    } catch (e) {
      // 404 no QR: confirma se a cobrança ainda existe antes de decidir; qualquer outra falha só é retentada
      if (e instanceof AsaasApiError && e.status === 404) {
        const still = await asaas.getPayment(paymentId).catch((x) => (x instanceof AsaasApiError && x.status === 404 ? null : Promise.reject(x)));
        if (!still || still.deleted === true) return await retiredOnGateway("cobrança excluída/inexistente no Asaas");
      }
      throw e;
    }
    if (!pix.payload || !pix.encodedImage) return await fail(new Error("Asaas não retornou o código Pix completo"), true);

    const done = await call<{ ok: boolean; reason?: string; charge?: PublicCharge }>(db, "billing_charge_record_pix", {
      p_charge_id: chargeId, p_token: token, p_pix_payload: pix.payload, p_pix_qr: pix.encodedImage,
      p_invoice_url: payment?.invoiceUrl ?? null, p_asaas_status: payment?.status ?? null,
    });
    if (!done.ok || !done.charge) return { kind: "busy" };
    return { kind: "ready", charge: done.charge };
  } catch (e) {
    return await fail(e);
  }
}

// --- Cancelamento (fatura paga por outro caminho ou anulada) ------------------------------------------------------------

export type CancelOutcome = { kind: "done" } | { kind: "retry"; error: string };

export async function cancelChargeForInvoice(db: BillingDb, asaas: AsaasClient, invoiceId: string): Promise<CancelOutcome> {
  try {
    const claim = await call<{ state: string; charge_id?: string; asaas_payment_id?: string | null; external_reference?: string }>(
      db, "billing_claim_cancel", { p_invoice_id: invoiceId, p_environment: asaas.environment });
    if (claim.state === "nothing") return { kind: "done" };
    if (claim.state === "busy") return { kind: "retry", error: "cobrança em criação" };
    if (!claim.charge_id) return { kind: "retry", error: "estado inesperado" };

    let paymentId = claim.asaas_payment_id ?? null;
    if (!paymentId && claim.external_reference) {
      paymentId = (await asaas.findPaymentByExternalReference(claim.external_reference))?.id ?? null;
    }
    if (paymentId) {
      const current = await asaas.getPayment(paymentId).catch((e) => {
        if (e instanceof AsaasApiError && e.status === 404) return null;
        throw e;
      });
      // dinheiro já recebido: NUNCA exclui (o webhook cuida do que for preciso)
      if (current && ["RECEIVED", "CONFIRMED"].includes(String(current.status).toUpperCase())) return { kind: "done" };
      await asaas.deletePayment(paymentId);
    }
    await db.rpc("billing_charge_mark_deleted", { p_charge_id: claim.charge_id, p_reason: "fatura encerrada" });
    return { kind: "done" };
  } catch (e) {
    return { kind: "retry", error: errText(e) };
  }
}

// --- Evento de pagamento (webhook e reconciliação) -----------------------------------------------------------------------

export interface PaymentEventInput {
  eventId: string;
  event: string;
  paymentId: string;
  // payload MÍNIMO a guardar (nunca dados do cliente)
  storedPayload: Record<string, unknown>;
}
export type PaymentEventOutcome =
  | { http: 200; result: string }
  | { http: 500; error: string };

// begin (idempotência) -> RECONSULTA o pagamento no Asaas (o payload do webhook nunca é confiado) -> apply (uma transação).
// Divergências viram anomalia no banco e a resposta é 200; 500 só para falha transitória (Asaas/banco), para o Asaas reentregar.
export async function processPaymentEvent(db: BillingDb, asaas: AsaasClient, input: PaymentEventInput): Promise<PaymentEventOutcome> {
  const environment = asaas.environment;
  try {
    const begin = await call<{ duplicate: boolean }>(db, "billing_event_begin", {
      p_event_id: input.eventId, p_event: input.event, p_payment_id: input.paymentId, p_payload: input.storedPayload,
      p_environment: environment,
    });
    if (begin.duplicate) return { http: 200, result: "duplicate" };
    // conta Asaas compartilhada: o payload já traz a referência de OUTRO sistema => registra e ignora, sem reconsultar o Asaas
    // (nem anomalia, nem baixa, nem job). Payload sem referência segue o fluxo completo e é decidido após a reconsulta.
    const claimed = (input.storedPayload.payment as { externalReference?: unknown } | null | undefined)?.externalReference;
    if (typeof claimed === "string" && claimed && !isOurInvoiceReference(claimed)) {
      await db.rpc("billing_event_finish", {
        p_event_id: input.eventId, p_status: "ignored", p_result: "ignored_foreign_payment", p_error: null, p_environment: environment,
      });
      return { http: 200, result: "ignored_foreign_payment" };
    }
  } catch (e) {
    return { http: 500, error: errText(e) };
  }

  let verified: AsaasPaymentDto;
  try {
    verified = await asaas.getPayment(input.paymentId);
  } catch (e) {
    if (e instanceof AsaasApiError && e.status === 404) {
      await db.rpc("billing_record_anomaly", {
        p_kind: "payment_not_found_in_asaas", p_detail: { event: input.event }, p_payment_id: input.paymentId, p_event_id: input.eventId,
        p_environment: environment,
      });
      await db.rpc("billing_event_finish", { p_event_id: input.eventId, p_status: "anomaly", p_result: "payment_not_found_in_asaas", p_error: null, p_environment: environment });
      return { http: 200, result: "payment_not_found_in_asaas" };
    }
    await db.rpc("billing_event_finish", { p_event_id: input.eventId, p_status: "failed", p_result: null, p_error: errText(e), p_environment: environment });
    return { http: 500, error: errText(e) };
  }

  if (verified.id !== input.paymentId) {
    await db.rpc("billing_event_finish", { p_event_id: input.eventId, p_status: "anomaly", p_result: "payment_id_mismatch", p_error: null, p_environment: environment });
    return { http: 200, result: "payment_id_mismatch" };
  }

  // exclusão: o status consultado não muda; na reconciliação o flag deleted é o que decide
  const event = input.event === "PAYMENT_RECONCILE" && verified.deleted === true ? "PAYMENT_DELETED" : input.event;
  const paymentDate = (verified.paymentDate ?? verified.confirmedDate ?? verified.clientPaymentDate ?? null)?.slice(0, 10) ?? null;

  try {
    const applied = await call<{ result: string }>(db, "billing_event_apply", {
      p_event_id: input.eventId,
      p_event: event,
      p_environment: environment,
      p_payment: {
        id: verified.id,
        status: verified.status ?? null,
        value_cents: valueToCents(verified.value),
        external_reference: verified.externalReference ?? null,
        billing_type: verified.billingType ?? null,
        due_date: verified.dueDate ?? null,
        payment_date: paymentDate,
        deleted: verified.deleted ?? null,
        invoice_url: verified.invoiceUrl ?? null,
      },
    });
    return { http: 200, result: applied.result };
  } catch (e) {
    await db.rpc("billing_event_finish", { p_event_id: input.eventId, p_status: "failed", p_result: null, p_error: errText(e), p_environment: environment });
    return { http: 500, error: errText(e) };
  }
}

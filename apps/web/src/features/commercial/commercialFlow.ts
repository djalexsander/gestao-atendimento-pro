import type { ChargeResult, CommercialSource, SubscribeResult } from "./commercialApi";
import type { Catalog, CatalogPlan, InvoicePayment, PaymentView } from "./commercialLogic";
import { monthlyTotalCents, paymentView, pickContractPlan, selectableModules } from "./commercialLogic";

// Orquestração da contratação e do Pix, com a fonte INJETADA (testável com fakes, sem rede).
//
// Regra central: tenant_subscribe NÃO depende da API externa. Se a Edge billing-charge falhar (ou demorar), a
// contratação local continua válida (assinatura pending_payment + fatura inicial) e o outbox recupera sozinho; a tela
// mostra "Tentar gerar Pix novamente", que chama a mesma Edge (idempotente).

export type ContractOutcome =
  | { ok: false; error: string }
  | { ok: true; subscribe: SubscribeResult; charge: ChargeResult };

export async function contractAndCharge(
  source: CommercialSource,
  companyId: string,
  catalog: Catalog,
  selectedModuleIds: readonly string[],
): Promise<ContractOutcome> {
  const plan: CatalogPlan | null = pickContractPlan(catalog);
  if (!plan) return { ok: false, error: "Nenhum plano disponível para contratação." };
  // só módulos opcionais reais (nunca ids inventados nem módulos já incluídos no plano)
  const allowed = new Set(selectableModules(catalog, plan).map((m) => m.id));
  const extras = selectedModuleIds.filter((id) => allowed.has(id));

  const subscribed = await source.subscribe(companyId, plan.id, extras);
  if (subscribed.error !== null) return { ok: false, error: subscribed.error };

  // A cobrança é um passo À PARTE: falhar aqui não desfaz a contratação.
  let charge: ChargeResult;
  try {
    charge = await source.requestCharge(subscribed.data.invoice_id);
  } catch {
    charge = { state: "error", message: "Não foi possível gerar o Pix agora. Tente novamente em instantes." };
  }
  return { ok: true, subscribe: subscribed.data, charge };
}

export interface PixLoad {
  payment: InvoicePayment | null;
  view: PaymentView | null;
  error: string | null;
  chargeError: string | null;
}

/**
 * Carrega a situação do pagamento da fatura. Se o Pix ainda não existe (cobrança ainda não criada) pede UMA vez à Edge
 * (idempotente); a criação concorrente de outro processo (202) não é erro: a tela continua "gerando" e atualiza sozinha.
 */
export async function loadPayment(source: CommercialSource, invoiceId: string, opts: { requestIfMissing: boolean }): Promise<PixLoad> {
  let chargeError: string | null = null;
  let got = await source.getInvoicePayment(invoiceId);
  if (got.error !== null) return { payment: null, view: null, error: got.error, chargeError };

  const needsCharge = (p: InvoicePayment) => p.invoice.status === "open" || p.invoice.status === "overdue"
    ? p.payment?.state === "not_created" : false;
  if (opts.requestIfMissing && needsCharge(got.data)) {
    const charged = await source.requestCharge(invoiceId);
    if (charged.state === "error") chargeError = charged.message;
    const again = await source.getInvoicePayment(invoiceId);
    if (again.error === null) got = again;
  }
  return { payment: got.data, view: paymentView(got.data), error: null, chargeError };
}

/** "Tentar gerar Pix novamente": mesma Edge, mesma fatura; devolve o estado atualizado. */
export async function retryPix(source: CommercialSource, invoiceId: string): Promise<PixLoad> {
  const charged = await source.requestCharge(invoiceId);
  const load = await loadPayment(source, invoiceId, { requestIfMissing: false });
  return { ...load, chargeError: charged.state === "error" ? charged.message : load.chargeError };
}

export { monthlyTotalCents };

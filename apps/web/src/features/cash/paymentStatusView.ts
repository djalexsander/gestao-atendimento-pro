import { formatCents } from "../../lib/money";
import { canViewFinancialValues, isPartialPaymentsEnabled, paymentStatusLabel } from "./partialPaymentsLogic";
import type { CompanyRole, FinancialState, OverviewRow, PaymentStatus } from "./partialPaymentsLogic";

// E9.3 — Indicador de status de pagamento (só EXIBIÇÃO). Sem React, sem Supabase. O chip aparece apenas com o módulo partial_payments
// habilitado para a empresa; o atendente vê SÓ o status (nunca valor): os valores só são montados para owner/admin/cashier, e mesmo
// assim apenas quando o servidor os devolveu (o banco já recusa/omite valores do atendente).

export type ChipTone = "pending" | "paid" | "muted";
export interface PaymentChipView {
  status: PaymentStatus;
  label: string;          // "Pago em parte", "Quitada"...
  tone: ChipTone;         // reaproveita as cores op-fin-*
  detail: string | null;  // linha de valores (só quem pode ver valores)
  aria: string;
}

const TONE: Record<PaymentStatus, ChipTone> = { closed: "muted", no_charge: "muted", unpaid: "muted", partial: "pending", paid: "paid" };

// Quem pode ver o indicador: com o recurso ligado e papel operacional de conta (os demais papéis nem chamam o banco).
export const PAYMENT_CHIP_ROLES: readonly CompanyRole[] = ["owner", "admin", "cashier", "attendant"];
export function paymentChipsEnabled(entitlements: { modules?: readonly string[] | null } | null | undefined, role: CompanyRole | null | undefined, readOnly = false): boolean {
  return isPartialPaymentsEnabled(entitlements, readOnly) && !!role && PAYMENT_CHIP_ROLES.includes(role);
}

interface Money {
  totalCents: number;
  settledPaidCents: number;
  balanceDueCents: number;
  overpaidCents: number;
  hasSplit: boolean;
  partsPending: number;
  undistributedCents: number | null;
  overDistributedCents: number | null;
}

function detailOf(status: PaymentStatus, m: Money): string | null {
  const parts: string[] = [];
  if (status === "partial") parts.push(`Recebido ${formatCents(m.settledPaidCents)} · Saldo ${formatCents(m.balanceDueCents)}`);
  else if (status === "unpaid") parts.push(`Saldo ${formatCents(m.balanceDueCents)}`);
  else if (status === "paid") parts.push(`Total ${formatCents(m.totalCents)}`);
  if (m.overpaidCents > 0) parts.push(`Recebido a mais ${formatCents(m.overpaidCents)}`);
  if (m.hasSplit) {
    if ((m.overDistributedCents ?? 0) > 0 || (m.undistributedCents ?? 0) > 0) parts.push("Divisão desatualizada");
    else parts.push(m.partsPending > 0 ? `Dividida · ${m.partsPending} ${m.partsPending === 1 ? "parte pendente" : "partes pendentes"}` : "Dividida · partes quitadas");
  }
  return parts.length ? parts.join(" · ") : null;
}

function build(status: PaymentStatus, money: Money | null, role: CompanyRole | null | undefined): PaymentChipView {
  const label = paymentStatusLabel(status);
  const detail = money && canViewFinancialValues(role) ? detailOf(status, money) : null;
  return { status, label, tone: TONE[status], detail, aria: detail ? `${label}. ${detail}` : label };
}

// Linha da visão geral (painel de comandas/mesas). `row` nulo (ainda não carregou/conta sem dados) = sem chip.
export function chipFromOverview(row: OverviewRow | null | undefined, role: CompanyRole | null | undefined): PaymentChipView | null {
  if (!row) return null;
  const f = row.financial;
  return build(row.paymentStatus, f && { totalCents: f.totalCents, settledPaidCents: f.settledPaidCents, balanceDueCents: f.balanceDueCents, overpaidCents: f.overpaidCents, hasSplit: f.hasSplit, partsPending: f.partsPending, undistributedCents: f.undistributedCents, overDistributedCents: f.overDistributedCents }, role);
}

// Estado completo de uma conta (cabeçalho da tela de pedido; owner/admin/cashier). Para o atendente só existe o status simples.
export function chipFromState(state: FinancialState | null | undefined, role: CompanyRole | null | undefined): PaymentChipView | null {
  if (!state) return null;
  return build(state.paymentStatus, { totalCents: state.totalCents, settledPaidCents: state.settledPaidCents, balanceDueCents: state.balanceDueCents, overpaidCents: state.overpaidCents, hasSplit: state.split !== null, partsPending: state.parts.filter((p) => p.pendingCents > 0).length, undistributedCents: state.undistributedCents, overDistributedCents: state.overDistributedCents }, role);
}
export function chipFromStatus(paymentStatus: string | null | undefined): PaymentChipView | null {
  if (!paymentStatus || !(paymentStatus in TONE)) return null;
  return build(paymentStatus as PaymentStatus, null, "attendant");
}

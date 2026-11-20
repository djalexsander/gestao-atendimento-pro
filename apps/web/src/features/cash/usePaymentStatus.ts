import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCommercial } from "../commercial/CommercialProvider";
import { partialPaymentsApi, type PartialPaymentsApi } from "./partialPaymentsApi";
import { canViewFinancialValues } from "./partialPaymentsLogic";
import type { CompanyRole, FinancialState, OverviewRow } from "./partialPaymentsLogic";
import { chipFromOverview, chipFromState, chipFromStatus, paymentChipsEnabled, type PaymentChipView } from "./paymentStatusView";

// E9.3 — Hooks de EXIBIÇÃO do status de pagamento. Com o módulo partial_payments desligado para a empresa (padrão) ou papel sem
// acesso, NÃO chamam o banco e devolvem sem chips: a tela fica exatamente como era. Nenhuma ação financeira aqui (só leitura).

const REFRESH_MS = 30_000;

// Painel de comandas/mesas: uma consulta em lote (list_session_payment_overview). `refreshKey` muda quando o painel recarrega.
export function usePaymentOverview(companyId: string | null, role: CompanyRole | null | undefined, refreshKey: unknown, api: PartialPaymentsApi = partialPaymentsApi) {
  const { entitlements, readOnly } = useCommercial();
  const enabled = !!companyId && paymentChipsEnabled(entitlements, role, readOnly);
  const [rows, setRows] = useState<Map<string, OverviewRow>>(new Map());
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!enabled || !companyId) return;
    const current = ++seq.current;
    const result = await api.listPaymentOverview(companyId);
    if (current !== seq.current) return;                 // só a resposta MAIS NOVA vale
    if (result.ok) setRows(new Map(result.data.rows.map((r) => [r.sessionId, r])));
    // falha de leitura: mantém o que já havia (o painel tradicional não depende disto)
  }, [enabled, companyId, api]);
  useEffect(() => { if (!enabled) { seq.current++; setRows(new Map()); } }, [enabled]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [enabled, load]);
  const chipFor = useCallback((sessionId: string | null | undefined): PaymentChipView | null => (enabled && sessionId ? chipFromOverview(rows.get(sessionId), role) : null), [enabled, rows, role]);
  const rowFor = useCallback((sessionId: string | null | undefined): OverviewRow | null => (enabled && sessionId ? rows.get(sessionId) ?? null : null), [enabled, rows]);
  return useMemo(() => ({ enabled, chipFor, rowFor, reload: load }), [enabled, chipFor, rowFor, load]);
}

// Tela do pedido: o estado de UMA conta. owner/admin/cashier leem o estado completo (valores); o atendente lê só o status.
export function useSessionFinance(sessionId: string, role: CompanyRole | null | undefined, applicable: boolean, refreshKey: unknown, api: PartialPaymentsApi = partialPaymentsApi) {
  const { entitlements, readOnly } = useCommercial();
  const enabled = applicable && paymentChipsEnabled(entitlements, role, readOnly);
  const [chip, setChip] = useState<PaymentChipView | null>(null);
  const [state, setState] = useState<FinancialState | null>(null);
  const seq = useRef(0);
  const full = canViewFinancialValues(role);
  const load = useCallback(async () => {
    if (!enabled) return;
    const current = ++seq.current;
    if (full) {
      const r = await api.getFinancialState(sessionId);
      if (current === seq.current && r.ok) { setChip(chipFromState(r.data, role)); setState(r.data); }
    } else {
      const r = await api.getPaymentStatus(sessionId);
      if (current === seq.current && r.ok) setChip(chipFromStatus(r.data.paymentStatus));
    }
  }, [enabled, full, sessionId, role, api]);
  useEffect(() => { if (!enabled) { seq.current++; setChip(null); setState(null); } }, [enabled]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [enabled, load]);
  return { enabled, chip: enabled ? chip : null, state: enabled ? state : null, reload: load };
}
export function useSessionPaymentChip(sessionId: string, role: CompanyRole | null | undefined, applicable: boolean, refreshKey: unknown, api: PartialPaymentsApi = partialPaymentsApi): PaymentChipView | null {
  return useSessionFinance(sessionId, role, applicable, refreshKey, api).chip;
}

// O indicador (mesmo visual do chip financeiro do delivery). Sem dados = nada na tela.
export function paymentChipClass(chip: PaymentChipView): string {
  return `op-fin op-fin-${chip.tone === "pending" ? "pending" : chip.tone === "paid" ? "paid" : "no_charge"}`;
}

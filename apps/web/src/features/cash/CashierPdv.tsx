import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { OPERATIONAL_PATH } from "../../app/accessRules";
import { useAuth } from "../../app/useAuth";
import { formatCents, formatReais } from "../../lib/money";
import { orderTitle } from "../../lib/orderNumber";
import { supabaseServicePanelSource, type ServicePanelSource } from "../operations/api";
import { ServicePointsPanel } from "../operations/ServicePointsPanel";
import { formatOpenedFull } from "../operations/panel";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseOrdersSource, type OrdersSource, type SessionHeader } from "../orders/ordersApi";
import { activeQuantity, sessionTotal, type SubmittedOrder } from "../orders/ordersLogic";
import { supabaseDocumentsSource, type DocumentsSource } from "../printing/documentsApi";
import { PrintDocumentButton } from "../printing/PrintDocumentButton";
import { PdvReceivePanel } from "./PdvReceivePanel";
import { supabaseCashSource, type CashSource } from "./cashApi";
import { CheckoutDialog, OpenCashDialog } from "./CashDialogs";
import type { PaymentMethod } from "./cashLogic";
import { partialPaymentsApi, type PartialPaymentsApi } from "./partialPaymentsApi";
import { isPartialPaymentsEnabled } from "./partialPaymentsLogic";
import { useCommercial } from "../commercial/CommercialProvider";
import type { OrderItemSource } from "./splitEditorLogic";
import { paymentChipClass, useSessionFinance } from "./usePaymentStatus";

// PDV do Caixa (v1.0.20) — layout de TRÊS COLUNAS em /operacional/caixa: contas à esquerda (busca, leitor, filtros), a conta selecionada no
// centro (itens, total, conferência, atalho para o lançamento de pedidos) e o recebimento à direita (inline). Só COMPÕE componentes e RPCs que
// já existem: ServicePointsPanel (lista), orders (cabeçalho/itens), CheckoutDialog (recebimento tradicional, módulo desligado) e
// PdvReceivePanel (recebimento parcial/várias formas, divisão e estorno; plano base). Nenhuma regra financeira nova; o servidor decide tudo.
// Só o Caixa monta esta tela (a rota exige a área "caixa"); Balcão e Atendimento não a usam.

type Tab = "list" | "account" | "pay";
const TAB_LABEL: Record<Tab, string> = { list: "1 · Contas", account: "2 · Conta", pay: "3 · Receber" };
const METHOD_KEYS: Record<string, PaymentMethod> = { F1: "cash", F2: "pix", F3: "debit_card", F4: "credit_card", F5: "other" };
export const PDV_SHORTCUT_EVENT = "pdv-shortcut";
const SCANNER_GAP_MS = 35;
const SCANNER_BURST = 4;

// Cabeçalho + pedidos da conta selecionada. Recarrega quando `refreshKey` muda e em tempo real (mesmas assinaturas da tela de pedido).
function useSessionAccount(source: OrdersSource, sessionId: string | null, refreshKey: number) {
  const [header, setHeader] = useState<SessionHeader | null>(null);
  const [orders, setOrders] = useState<SubmittedOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const current = ++seq.current;
    const [h, o] = await Promise.all([source.loadSessionHeader(sessionId), source.loadOrders(sessionId)]);
    if (current !== seq.current) return;               // só a resposta MAIS NOVA vale
    if (h.error || !h.data) { setError(h.error ?? "Não foi possível carregar esta conta."); setLoading(false); return; }
    setError(null); setHeader(h.data); if (o.data) setOrders(o.data); setLoading(false);
  }, [source, sessionId]);

  useEffect(() => {
    seq.current++;
    setHeader(null); setOrders([]); setError(null);
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    void load();
  }, [sessionId, load]);

  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } void load(); }, [refreshKey, load]);

  useEffect(() => {
    if (!sessionId) return;
    const run = createCoalescedRunner(load);
    const off = source.subscribeToOrders(sessionId, run);
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { off(); document.removeEventListener("visibilitychange", onVisible); };
  }, [source, sessionId, load]);

  return { header, orders, loading, error, reload: load };
}

const sessionLabelOf = (h: SessionHeader) =>
  h.point ? `${h.point.displayName} (${h.point.code})` : orderTitle(h.fulfillment === "pickup" ? "pickup" : "delivery", h.delivery?.orderNumber ?? null);

export function CashierPdv({
  panelSource = supabaseServicePanelSource,
  ordersSource = supabaseOrdersSource,
  cashSource = supabaseCashSource,
  documentsSource = supabaseDocumentsSource,
  partialApi = partialPaymentsApi,
}: {
  panelSource?: ServicePanelSource;
  ordersSource?: OrdersSource;
  cashSource?: CashSource;
  documentsSource?: DocumentsSource;
  partialApi?: PartialPaymentsApi;
}) {
  const { activeMembership } = useAuth();
  const role = activeMembership?.role ?? null;
  const companyId = activeMembership?.companyId ?? null;
  const [params, setParams] = useSearchParams();
  const selected = params.get("conta");
  const [tab, setTab] = useState<Tab>(selected ? "account" : "list");
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [closed, setClosed] = useState<{ sessionId: string; label: string } | null>(null);
  const [needCash, setNeedCash] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [centerTab, setCenterTab] = useState<"conf" | "split">("conf");
  const [splitHost, setSplitHost] = useState<HTMLElement | null>(null);   // onde o SplitEditor E9.5 é desenhado (aba "Dividir conta")

  const account = useSessionAccount(ordersSource, selected, tick);
  const { header, orders } = account;
  const isPoint = header?.kind === "point";
  const finance = useSessionFinance(selected ?? "", role, !!header && header.status === "open" && isPoint, orders, partialApi);
  const label = header ? sessionLabelOf(header) : "";
  const splitAvailable = finance.enabled && isPoint;
  const { entitlements, readOnly } = useCommercial();
  // Motivo do bloqueio (só informativo): o Caixa completo é do plano base; a aba só bloqueia em empresa somente leitura, conta que não é comanda/mesa, conta encerrada ou perfil sem acesso.
  const splitLockReason = splitAvailable ? null : !isPoint ? "not-point" : header?.status !== "open" ? "closed" : !isPartialPaymentsEnabled(entitlements, readOnly) ? "read-only" : "role";
  const totalReais = sessionTotal(orders) + (header?.deliveryFee ?? 0);

  const select = useCallback((id: string) => {
    setClosed(null); setNotice(null); setCenterTab("conf");
    setParams({ conta: id }, { replace: true });
    setTab("account");
  }, [setParams]);
  const clearSelection = useCallback(() => {
    setClosed(null); setNotice(null);
    setParams({}, { replace: true });
    setTab("list");
    bump();
  }, [setParams, bump]);

  // Atalhos (sem conflito com o leitor): F1–F5 escolhem a forma, Enter finaliza, F8 imprime, Esc volta à busca (F9/F10 são do CashControl).
  // O leitor USB digita caracteres e Enter, nunca teclas F. Enter só finaliza FORA de campos/botões/links e fora da busca, nunca logo após uma
  // rajada de caracteres (leitor) e nunca com diálogo aberto; dentro de um campo do recebimento o Enter já envia o formulário (validado).
  // Uma RAJADA de caracteres dentro de um campo de recebimento é ignorada (não vira valor).
  const burst = useRef({ last: 0, n: 0 });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inModal = !!document.querySelector(".modal");
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const now = performance.now();
        burst.current = { last: now, n: now - burst.current.last < SCANNER_GAP_MS ? burst.current.n + 1 : 1 };
        if (burst.current.n >= SCANNER_BURST && t && t.closest(".pdv-right") && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !inModal) {
          e.preventDefault();
          setNotice("Leitura de código detectada em um campo de recebimento e ignorada. Esc volta à busca.");
          return;
        }
      }
      if (inModal) return;
      if (METHOD_KEYS[e.key] && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        setTab("pay");
        window.dispatchEvent(new CustomEvent(PDV_SHORTCUT_EVENT, { detail: { kind: "method", method: METHOD_KEYS[e.key] } }));
        return;
      }
      if (e.key === "Enter" && !e.altKey && !e.metaKey && !e.shiftKey) {
        if (e.repeat) { if (!e.ctrlKey) return; e.preventDefault(); return; }
        const tag = (t?.tagName ?? "").toUpperCase();
        const interactive = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A" || !!t?.isContentEditable;
        const afterScan = performance.now() - burst.current.last < 120 && burst.current.n >= 2;
        if (afterScan || t?.closest(".pdv-left")) return;                 // leitor / busca: Enter é do leitor
        if (interactive && !e.ctrlKey) return;                            // campo ou botão focado: comportamento nativo
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(PDV_SHORTCUT_EVENT, { detail: { kind: "finalize" } }));
        return;
      }
      if (e.key === "F8") { e.preventDefault(); document.querySelector<HTMLButtonElement>("[data-pdv-print] button")?.click(); return; }
      if (e.key === "Escape") {
        if (t && t.closest(".pdv-right")) (t as HTMLElement).blur();
        document.querySelector<HTMLInputElement>(".pdv-left .op-search-input")?.focus();
        setTab("list");
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const orderItems: OrderItemSource[] = useMemo(
    () => orders.filter((o) => o.status === "submitted").flatMap((o) => o.items).filter((i) => activeQuantity(i) > 0)
      .map((i) => ({ itemId: i.id, name: i.productNameSnapshot, unitCents: Math.round(i.unitPrice * 100), billable: activeQuantity(i) })),
    [orders],
  );

  const afterClosed = useCallback(() => { setClosed({ sessionId: selected ?? "", label }); bump(); }, [selected, label, bump]);

  return (
    <div className="pdv" data-tab={tab} data-testid="pdv">
      <div className="pdv-tabs" role="tablist" aria-label="Seções do PDV">
        {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "pdv-tab pdv-tab-on" : "pdv-tab"} onClick={() => setTab(k)}>{TAB_LABEL[k]}</button>
        ))}
      </div>

      <section className="pdv-col pdv-left" aria-label="Contas" data-testid="pdv-left">
        <ServicePointsPanel variant="cashier" source={panelSource} cashSource={cashSource} onSelectSession={select} selectedSessionId={selected} reloadKey={tick} />
      </section>

      <section className="pdv-col pdv-center" aria-label="Conta selecionada" data-testid="pdv-center">
        {!selected && <div className="pdv-empty">Selecione uma comanda, mesa, delivery ou retirada para conferir o consumo.</div>}
        {selected && account.loading && !header && <p className="op-state" role="status">Carregando a conta…</p>}
        {selected && account.error && !header && <div className="form-error" role="alert">{account.error}</div>}
        {selected && header && (
          <>
            <div className="pdv-head">
              <div>
                <h3 className="pdv-title">{label}</h3>
                <p className="muted">{header.customerName ?? "Sem cliente"} · aberta em {formatOpenedFull(header.openedAt)} · por {header.openedByName ?? "—"}</p>
              </div>
              <div className="pdv-head-actions">
                {finance.chip && <span className={paymentChipClass(finance.chip)} data-testid="pdv-pay-chip" title={finance.chip.aria}>{finance.chip.label}</span>}
                <span data-pdv-print>
                  <PrintDocumentButton label="Imprimir conferência" successMessage="Conferência enviada para impressão." request={() => documentsSource.customerBill(header.id)} className="btn-secondary btn-small" />
                </span>
              </div>
            </div>
            <div className="pdv-subtabs" role="tablist" aria-label="Painel da conta">
              <button type="button" role="tab" aria-selected={centerTab === "conf"} className={centerTab === "conf" ? "pdv-subtab pdv-subtab-on" : "pdv-subtab"} onClick={() => setCenterTab("conf")} data-testid="pdv-tab-conf">Conferência</button>
              <button type="button" role="tab" aria-selected={centerTab === "split"} aria-disabled={!splitAvailable} className={`${centerTab === "split" ? "pdv-subtab pdv-subtab-on" : "pdv-subtab"}${splitAvailable ? "" : " pdv-subtab-locked"}`} onClick={() => setCenterTab("split")} data-testid="pdv-tab-split">Dividir conta{splitAvailable ? "" : " 🔒"}</button>
            </div>
            {/* Empresa somente leitura (ou delivery/retirada): a aba continua visível, mas bloqueada — só o aviso, nenhum editor/operação de divisão. */}
            {centerTab === "split" && !splitAvailable && (
              <div className="form-notice pdv-split-locked" role="status" data-testid="pdv-split-locked" data-reason={splitLockReason ?? undefined}>
                {splitLockReason === "not-point" ? "A divisão de conta só vale para comandas e mesas."
                  : splitLockReason === "closed" ? "Esta conta já foi encerrada."
                  : splitLockReason === "role" ? "Seu perfil não tem acesso à divisão de conta."
                  : "A empresa está em modo somente leitura. Regularize a contratação/pagamento para dividir a conta."}
              </div>
            )}
            <div ref={setSplitHost} className="pdv-split-host" hidden={!splitAvailable || centerTab !== "split"} data-testid="pdv-split-host" />
            <div className="pdv-conf" hidden={centerTab === "split"}>
            <div className="pdv-items" data-testid="pdv-items">
              {orders.filter((o) => o.status !== "cancelled").flatMap((o) => o.items).length === 0 ? (
                <p className="op-state">Nenhum pedido enviado nesta conta ainda.</p>
              ) : (
                <table>
                  <thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Unit.</th><th className="num">Subtotal</th></tr></thead>
                  <tbody>
                    {orders.filter((o) => o.status !== "cancelled").flatMap((o) => o.items).map((i) => {
                      const q = activeQuantity(i);
                      return (
                        <tr key={i.id} className={q === 0 ? "pdv-cancelled" : undefined}>
                          <td>
                            {i.productNameSnapshot}
                            {i.cancelledQuantity > 0 && <span className="pdv-tag">{i.cancelledQuantity} cancelado{i.cancelledQuantity > 1 ? "s" : ""}</span>}
                            {i.modifiers.length > 0 && <small className="muted"> · {i.modifiers.map((m) => `${m.type === "remove" ? "sem " : ""}${m.name}`).join(", ")}</small>}
                          </td>
                          <td className="num"><span className="pdv-qty">{q}</span></td>
                          <td className="num">{formatReais(i.unitPrice)}</td>
                          <td className="num">{formatReais(i.unitPrice * q)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="pdv-totals" data-testid="pdv-totals">
              <div className="pdv-itemcount"><span>Itens ({orders.filter((o) => o.status !== "cancelled").flatMap((o) => o.items).reduce((s, i) => s + activeQuantity(i), 0)})</span><span>{formatReais(sessionTotal(orders))}</span></div>
              {(header.deliveryFee ?? 0) > 0 && <div><span>Taxa de entrega</span><span>{formatReais(header.deliveryFee)}</span></div>}
              <div className="pdv-total"><span>Total da conta</span><strong>{formatReais(totalReais)}</strong></div>
              {finance.enabled && finance.state && (
                <>
                  <div><span>Recebido</span><span>{formatCents(finance.state.settledPaidCents)}</span></div>
                  <div><span>Saldo pendente</span><strong>{formatCents(finance.state.balanceDueCents)}</strong></div>
                </>
              )}
            </div>
            <div className="pdv-center-actions">
              <Link className="btn-secondary btn-small" to={`${OPERATIONAL_PATH.caixa}/${header.id}`} data-testid="pdv-order-link">Lançar / editar pedido</Link>
              <button type="button" className="btn-secondary btn-small pdv-only-narrow" onClick={() => setTab("pay")}>Receber</button>
            </div>
            </div>
          </>
        )}
      </section>

      <section className="pdv-col pdv-right" aria-label="Receber" data-testid="pdv-right">
        <h3 className="pdv-col-title">Receber{label ? <span> · {label}</span> : null}</h3>
        {notice && <div className="form-notice" role="status" data-testid="pdv-notice">{notice}</div>}
        {!selected && <div className="pdv-empty">O recebimento aparece aqui.</div>}
        {selected && !header && !account.error && <p className="op-state">Carregando…</p>}
        {selected && header && closed && closed.sessionId === header.id && (
          <div className="pdv-done" data-testid="pdv-done">
            <h4>Conta fechada ✔</h4>
            <p>{closed.label} foi encerrada. A comanda/mesa está livre.</p>
            <PrintDocumentButton label="Imprimir comprovante" successMessage="Comprovante enviado para impressão." request={() => documentsSource.paymentReceipt(header.id)} allowInDialog className="btn-secondary" />
            <button type="button" className="btn-primary btn-auto" onClick={clearSelection} autoFocus>Próxima conta</button>
          </div>
        )}
        {selected && header && !(closed && closed.sessionId === header.id) && header.status === "closed" && <p className="op-state">Esta conta já foi encerrada.</p>}
        {selected && header && header.status === "open" && !(closed && closed.sessionId === header.id) && companyId && role && (
          finance.enabled && isPoint ? (
            <PdvReceivePanel
              key={header.id}
              sessionId={header.id}
              role={role}
              companyId={companyId}
              cashSource={cashSource}
              api={partialApi}
              orderItems={orderItems}
              onClosed={afterClosed}
              onChanged={bump}
              splitHost={splitHost}
            />
          ) : (
            <CheckoutDialog
              key={`${header.id}:${Math.round(totalReais * 100)}`}
              inline
              source={cashSource}
              sessionId={header.id}
              pointLabel={label}
              totalReais={totalReais}
              delivery={header.delivery ? { deliveryOrderId: header.delivery.deliveryOrderId, expectedMethod: header.delivery.expectedMethod, cashChangeFor: header.delivery.cashChangeFor } : null}
              onNeedCash={() => setNeedCash(true)}
              onDone={afterClosed}
              onClose={() => undefined}
            />
          )
        )}
        {needCash && companyId && (
          <OpenCashDialog source={cashSource} companyId={companyId} notice="Abra o caixa antes de receber esta conta." onOpened={() => { setNeedCash(false); setNotice("Caixa aberto. Finalize o recebimento novamente."); }} onClose={() => setNeedCash(false)} />
        )}
      </section>
    </div>
  );
}

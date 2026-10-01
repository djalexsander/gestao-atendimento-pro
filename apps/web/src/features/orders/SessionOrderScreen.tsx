import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OPERATIONAL_PATH } from "../../app/accessRules";
import { useAuth } from "../../app/useAuth";
import { supabaseCashSource, type CashSource } from "../cash/cashApi";
import { CheckoutDialog, OpenCashDialog } from "../cash/CashDialogs";
import { Modal } from "../employees/Modal";
import { supabaseDocumentsSource, type DocumentsSource } from "../printing/documentsApi";
import { PrintDocumentButton } from "../printing/PrintDocumentButton";
import { formatOpenedFull } from "../operations/panel";
import { createCoalescedRunner } from "./coalesce";
import { CancelItemDialog } from "./CancelItemDialog";
import { Catalog } from "./Catalog";
import { CartBar, CartPanel } from "./Cart";
import { OrderHistory } from "./OrderHistory";
import { supabaseOrdersSource, type OrdersSource, type SessionHeader } from "./ordersApi";
import { addToCart, changeCartQuantity, removeCartItem, sessionTotal, setCartItemNotes, type CartItem, type CatalogCategory, type CatalogProduct, type SubmittedOrder, type SubmittedOrderItem } from "./ordersLogic";

// Tela real de atendimento (substitui o modal provisório): catálogo visual, cesta local e envio
// via submit_service_order. O MESMO componente serve Atendimento e Caixa — só troca o `variant`
// (ênfase da busca/leitor) e a rota de volta. Preço, nome, setor e origem são sempre autoridade
// do backend; a cesta aqui é só UX (ver ordersLogic.ts).
export function SessionOrderScreen({
  sessionId,
  variant,
  source = supabaseOrdersSource,
  cashSource = supabaseCashSource,
  documentsSource = supabaseDocumentsSource,
}: {
  sessionId: string;
  variant: "attendant" | "cashier";
  source?: OrdersSource;
  cashSource?: CashSource;
  documentsSource?: DocumentsSource;
}) {
  const navigate = useNavigate();
  const backPath = OPERATIONAL_PATH[variant === "attendant" ? "atendimento" : "caixa"];

  const [header, setHeader] = useState<SessionHeader | null>(null);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  const [orders, setOrders] = useState<SubmittedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);

  const [syncNotice, setSyncNotice] = useState(false);

  // Fechar conta (só Caixa: owner/admin/cashier). O backend valida papel, caixa e total.
  const { user, activeMembership } = useAuth();
  const canCheckout =
    variant === "cashier" &&
    (activeMembership?.role === "owner" || activeMembership?.role === "admin" || activeMembership?.role === "cashier");
  const [checkoutStage, setCheckoutStage] = useState<"none" | "checkout" | "open-cash" | "done">("none");
  const [checkoutChecking, setCheckoutChecking] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<SubmittedOrderItem | null>(null);

  async function startCheckout() {
    if (!activeMembership || !user) return;
    setCheckoutChecking(true);
    const cash = await cashSource.getMyOpenCash(activeMembership.companyId, user.id);
    setCheckoutChecking(false);
    // Falha ao consultar o caixa: abre o fechamento mesmo assim; o servidor decide (PT412).
    setCheckoutStage(cash.data || cash.error ? "checkout" : "open-cash");
  }
  const submittingRef = useRef(false);
  submittingRef.current = submitting;

  // Recarrega SÓ o histórico enviado (o banco é a fonte da verdade); nunca toca na cesta local.
  const reloadOrders = useCallback(async () => {
    const result = await source.loadOrders(sessionId);
    if (result.data) setOrders(result.data);
    console.info(`[realtime] orders reload ${result.data ? `ok (${result.data.length} pedidos)` : "failed"}`);
  }, [source, sessionId]);

  // Recarrega SÓ o catálogo (estoque/disponibilidade mudaram em outro aparelho). Não toca na cesta;
  // a validação real do saldo continua sendo do servidor no envio do pedido.
  const companyId = header?.companyId ?? null;
  const reloadCatalog = useCallback(async () => {
    if (!companyId) return;
    const result = await source.loadCatalog(companyId);
    if (result.data) {
      setCategories(result.data.categories);
      setProducts(result.data.products);
    }
  }, [source, companyId]);
  const requestCatalogReload = useMemo(() => createCoalescedRunner(reloadCatalog), [reloadCatalog]);

  useEffect(() => {
    if (!companyId || !source.subscribeToProducts) return;
    return source.subscribeToProducts(companyId, requestCatalogReload);
  }, [source, companyId, requestCatalogReload]);

  // Broadcast, postgres_changes e foco podem chegar quase juntos: uma busca por vez, sem atraso
  // (se chegar outro pedido durante a busca, roda mais uma logo depois).
  const requestReload = useMemo(() => createCoalescedRunner(reloadOrders), [reloadOrders]);

  // Realtime: uma assinatura por sessão, removida ao trocar de sessão/desmontar (logout desmonta).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = source.subscribeToOrders(sessionId, () => {
      requestReload();
      if (!submittingRef.current) {
        setSyncNotice(true);
        clearTimeout(timer);
        timer = setTimeout(() => setSyncNotice(false), 3000);
      }
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [source, sessionId, requestReload]);

  // Fallback barato (sem polling): ao voltar o foco/visibilidade, recarrega uma vez.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") {
        requestReload();
        requestCatalogReload();
      }
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [requestReload, requestCatalogReload]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const headerResult = await source.loadSessionHeader(sessionId);
      if (cancelled) return;
      if (headerResult.error || !headerResult.data) {
        setLoadError(headerResult.error ?? "Não foi possível carregar este atendimento.");
        setLoading(false);
        return;
      }
      setHeader(headerResult.data);

      const [catalogResult, ordersResult] = await Promise.all([
        source.loadCatalog(headerResult.data.companyId),
        source.loadOrders(sessionId),
      ]);
      if (cancelled) return;
      if (catalogResult.error || !catalogResult.data) {
        setLoadError(catalogResult.error ?? "Não foi possível carregar o catálogo.");
        setLoading(false);
        return;
      }
      setCategories(catalogResult.data.categories);
      setProducts(catalogResult.data.products);
      if (ordersResult.data) setOrders(ordersResult.data);

      const paths = catalogResult.data.products.filter((p) => p.imagePath).map((p) => p.imagePath as string);
      const urls = await source.getImageUrls(paths);
      if (!cancelled) setImageUrls(urls);

      setLoadError(null);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [source, sessionId]);

  const canOrder = header?.status === "open";

  // Qualquer mudança na cesta (adicionar, +/-, remover, observação) limpa o aviso/erro do envio
  // anterior — senão "Pedido enviado com sucesso." ou o erro ficariam pendurados enquanto o
  // atendente já está montando o pedido seguinte.
  function mutateCart(updater: (current: CartItem[]) => CartItem[]) {
    setSubmitNotice(null);
    setSubmitError(null);
    setCart(updater);
  }

  function handleAdd(product: CatalogProduct) {
    mutateCart((current) => addToCart(current, product));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    const result = await source.submitOrder(sessionId, cart);
    setSubmitting(false);
    if (result.error) {
      setSubmitError(result.error);
      return;
    }
    // NÃO fecha a cesta: no celular ela é o único lugar onde a confirmação aparece. O
    // atendente fecha quando quiser (ou ela volta a ficar vazia/escondida sozinha).
    setCart([]);
    setSubmitNotice("Pedido enviado com sucesso.");
    requestReload();
  }

  let content;
  if (loading) {
    content = <p className="op-state">Carregando atendimento…</p>;
  } else if (loadError || !header) {
    content = (
      <div className="op-state">
        <p>{loadError}</p>
        <button className="btn-secondary" type="button" onClick={() => navigate(backPath)}>
          Voltar para Comandas / Mesas
        </button>
      </div>
    );
  } else if (!canOrder) {
    content = (
      <div className="op-state">
        <p>Este atendimento não está mais aberto.</p>
        <button className="btn-secondary" type="button" onClick={() => navigate(backPath)}>
          Voltar para Comandas / Mesas
        </button>
      </div>
    );
  } else {
    content = (
      <>
        <div className="order-body">
          <Catalog categories={categories} products={products} imageUrls={imageUrls} variant={variant} onAdd={handleAdd} />
          <CartPanel
            cart={cart}
            imageUrls={imageUrls}
            open={cartOpen}
            submitting={submitting}
            error={submitError}
            notice={submitNotice}
            onClose={() => setCartOpen(false)}
            onIncrement={(id) => mutateCart((c) => changeCartQuantity(c, id, 1))}
            onDecrement={(id) => mutateCart((c) => changeCartQuantity(c, id, -1))}
            onRemove={(id) => mutateCart((c) => removeCartItem(c, id))}
            onNotesChange={(id, notes) => mutateCart((c) => setCartItemNotes(c, id, notes))}
            onSubmit={() => void handleSubmit()}
          />
        </div>
        <OrderHistory
          orders={orders}
          role={activeMembership?.role}
          sessionOpen={canOrder}
          onCancelItem={(item) => setCancelTarget(item)}
        />
        {cancelTarget && (
          <CancelItemDialog
            source={source}
            item={cancelTarget}
            onDone={() => {
              setCancelTarget(null);
              requestReload();
            }}
            onClose={() => setCancelTarget(null)}
          />
        )}
        <CartBar cart={cart} onOpen={() => setCartOpen(true)} />
      </>
    );
  }

  return (
    <div className="order-screen">
      <div className="order-header">
        <div>
          <a
            className="order-header-back"
            href={backPath}
            onClick={(e) => {
              e.preventDefault();
              navigate(backPath);
            }}
          >
            ← Comandas / Mesas
          </a>
          {header && (
            <div className="order-header-title">
              {header.point.displayName} <span className="muted">({header.point.code})</span>
            </div>
          )}
        </div>
        {header && (
          <dl className="order-header-info">
            <div>
              <dt>Cliente</dt>
              <dd>{header.customerName ?? "Não informado"}</dd>
            </div>
            <div>
              <dt>Aberta em</dt>
              <dd>{formatOpenedFull(header.openedAt)}</dd>
            </div>
            <div>
              <dt>Aberta por</dt>
              <dd>{header.openedByName ?? "—"}</dd>
            </div>
          </dl>
        )}
        {header && canOrder && (
          // Conta / pré-conta (manual; F8 contextual). Só com itens válidos e sem diálogo de fechamento aberto.
          <PrintDocumentButton
            label="Imprimir conta"
            successMessage="Conta enviada para impressão."
            enabled={sessionTotal(orders) > 0 && checkoutStage === "none" && !cancelTarget}
            request={() => documentsSource.customerBill(sessionId)}
          />
        )}
        {canCheckout && header && canOrder && (
          <button className="btn-primary btn-auto" type="button" disabled={checkoutChecking} onClick={() => void startCheckout()}>
            Fechar conta
          </button>
        )}
      </div>

      {checkoutStage === "open-cash" && activeMembership && (
        <OpenCashDialog
          source={cashSource}
          companyId={activeMembership.companyId}
          notice="Abra o caixa antes de receber esta conta."
          onOpened={() => setCheckoutStage("checkout")}
          onClose={() => setCheckoutStage("none")}
        />
      )}
      {checkoutStage === "checkout" && header && (
        <CheckoutDialog
          source={cashSource}
          sessionId={sessionId}
          pointLabel={`${header.point.displayName} (${header.point.code})`}
          totalReais={sessionTotal(orders)}
          onNeedCash={() => setCheckoutStage("open-cash")}
          onDone={() => setCheckoutStage("done")}
          onClose={() => {
            setCheckoutStage("none");
            requestReload();
          }}
        />
      )}
      {checkoutStage === "done" && (
        <Modal title="Conta fechada" onClose={() => navigate(backPath)}>
          <p className="modal-text">Pagamento registrado e conta fechada com sucesso. A comanda/mesa está livre.</p>
          <PrintDocumentButton
            label="Imprimir comprovante"
            successMessage="Comprovante enviado para impressão."
            request={() => documentsSource.paymentReceipt(sessionId)}
            allowInDialog
            className="btn-secondary"
          />
          <div className="modal-actions">
            <button className="btn-primary btn-auto" type="button" autoFocus onClick={() => navigate(backPath)}>
              Voltar para Comandas / Mesas
            </button>
          </div>
        </Modal>
      )}

      {syncNotice && (
        <p className="muted" role="status" style={{ margin: "4px 0", textAlign: "center" }}>
          Pedido atualizado
        </p>
      )}

      {content}
    </div>
  );
}

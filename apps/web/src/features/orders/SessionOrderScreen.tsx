import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OPERATIONAL_PATH } from "../../app/accessRules";
import { formatOpenedFull } from "../operations/panel";
import { Catalog } from "./Catalog";
import { CartBar, CartPanel } from "./Cart";
import { OrderHistory } from "./OrderHistory";
import { supabaseOrdersSource, type OrdersSource, type SessionHeader } from "./ordersApi";
import { addToCart, changeCartQuantity, removeCartItem, setCartItemNotes, type CartItem, type CatalogCategory, type CatalogProduct, type SubmittedOrder } from "./ordersLogic";

// Tela real de atendimento (substitui o modal provisório): catálogo visual, cesta local e envio
// via submit_service_order. O MESMO componente serve Atendimento e Caixa — só troca o `variant`
// (ênfase da busca/leitor) e a rota de volta. Preço, nome, setor e origem são sempre autoridade
// do backend; a cesta aqui é só UX (ver ordersLogic.ts).
export function SessionOrderScreen({
  sessionId,
  variant,
  source = supabaseOrdersSource,
}: {
  sessionId: string;
  variant: "attendant" | "cashier";
  source?: OrdersSource;
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
  const submittingRef = useRef(false);
  submittingRef.current = submitting;

  // Recarrega SÓ o histórico enviado (o banco é a fonte da verdade); nunca toca na cesta local.
  const reloadOrders = useCallback(async () => {
    const result = await source.loadOrders(sessionId);
    if (result.data) setOrders(result.data);
  }, [source, sessionId]);

  // Realtime: uma assinatura por sessão, removida ao trocar de sessão/desmontar (logout desmonta).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = source.subscribeToOrders(sessionId, () => {
      void reloadOrders();
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
  }, [source, sessionId, reloadOrders]);

  // Fallback barato (sem polling): ao voltar o foco/visibilidade, recarrega uma vez.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") void reloadOrders();
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [reloadOrders]);

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
    void reloadOrders();
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
        <OrderHistory orders={orders} />
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
      </div>

      {syncNotice && (
        <p className="muted" role="status" style={{ margin: "4px 0", textAlign: "center" }}>
          Pedido atualizado
        </p>
      )}

      {content}
    </div>
  );
}

import { useEffect, useRef } from "react";
import { formatReais } from "../../lib/money";
import { ModifierLines } from "../modifiers/ModifierDialog";
import { cartItemCount, cartItemUnitPrice, cartTotal, NOTES_MAX_LENGTH, type CartItem } from "./ordersLogic";

// Barra fixa do celular (escondida no desktop via CSS — ver .cart-bar em index.css): toca para
// abrir o painel da cesta como bottom sheet. Só aparece com pelo menos 1 item.
export function CartBar({ cart, onOpen }: { cart: CartItem[]; onOpen: () => void }) {
  if (cart.length === 0) return null;
  const count = cartItemCount(cart);
  return (
    <button type="button" className="cart-bar" onClick={onOpen}>
      <span>
        {count} {count === 1 ? "item" : "itens"} • {formatReais(cartTotal(cart))}
      </span>
      <span>Ver pedido</span>
    </button>
  );
}

function CartItemRow({
  item,
  imageUrl,
  onIncrement,
  onDecrement,
  onRemove,
  onNotesChange,
  onEdit,
}: {
  item: CartItem;
  imageUrl: string | null;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  onNotesChange: (notes: string) => void;
  onEdit: (() => void) | null;
}) {
  return (
    <li className="cart-item">
      <div className="cart-item-main">
        {imageUrl ? (
          <img className="cart-item-thumb" src={imageUrl} loading="lazy" alt="" />
        ) : (
          <div className="cart-item-thumb cart-item-thumb-placeholder" aria-hidden="true" />
        )}
        <span className="cart-item-name">{item.name}</span>
        <span className="cart-item-price">{formatReais(cartItemUnitPrice(item) * item.quantity)}</span>
      </div>
      <ModifierLines modifiers={item.modifiers} />
      <div className="cart-item-controls">
        <div className="cart-qty">
          <button type="button" className="cart-qty-btn" aria-label={`Diminuir quantidade de ${item.name}`} onClick={onDecrement}>
            −
          </button>
          <span className="cart-qty-value">{item.quantity}</span>
          <button type="button" className="cart-qty-btn" aria-label={`Aumentar quantidade de ${item.name}`} onClick={onIncrement}>
            +
          </button>
        </div>
        {onEdit && (
          <button type="button" className="btn-secondary btn-small" onClick={onEdit}>
            Editar
          </button>
        )}
        <button type="button" className="btn-secondary btn-small btn-danger-text" onClick={onRemove}>
          Remover
        </button>
      </div>
      <input
        className="cart-item-notes"
        type="text"
        maxLength={NOTES_MAX_LENGTH}
        placeholder="Observação (opcional) — ex.: sem cebola"
        aria-label={`Observação para ${item.name}`}
        value={item.notes}
        onChange={(e) => onNotesChange(e.target.value)}
      />
    </li>
  );
}

// Desktop/tablet: o painel é sticky e nasce abaixo do cabeçalho, então "100svh" fixo o deixaria passar do
// rodapé da janela (total e botão fora de alcance até rolar a página). Limita a altura ao que cabe de
// fato entre a posição atual dele e a base da janela; a lista interna é quem rola (.cart-scroll).
// No celular (<768px) o painel é um bottom sheet fixo e o CSS (85svh) já basta.
function useFitToViewport(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia("(min-width: 768px)");
    let scrollParent: HTMLElement | null = el.parentElement;
    while (scrollParent && !/(auto|scroll)/.test(getComputedStyle(scrollParent).overflowY)) scrollParent = scrollParent.parentElement;
    const apply = () => {
      if (!mq.matches) {
        el.style.maxHeight = "";
        return;
      }
      // Referência = início da célula do grid (onde o painel nasce), não o próprio painel: a posição dele
      // muda com o sticky e com a altura que acabamos de definir.
      // A área visível é a do ancestral rolável mais próximo (ex.: corpo do "Novo pedido" de Delivery) ou a janela.
      const bounds = scrollParent?.getBoundingClientRect();
      const viewTop = Math.max(bounds?.top ?? 0, 0);
      const viewBottom = Math.min(bounds?.bottom ?? window.innerHeight, window.innerHeight);
      const top = Math.max((el.parentElement ?? el).getBoundingClientRect().top, viewTop + 12);
      // Um sticky não passa do fim da célula do grid: ao rolar até o fim do catálogo, um painel mais alto que o
      // espaço restante seria empurrado para cima e perderia o cabeçalho. Por isso o limite inferior também é o
      // fim do conteúdo ao lado (catálogo), ignorando o próprio painel para não criar realimentação.
      let contentBottom = Infinity;
      for (const sibling of Array.from(el.parentElement?.children ?? [])) {
        if (sibling === el) continue;
        const r = sibling.getBoundingClientRect();
        if (r.height > 0) contentBottom = Math.max(contentBottom === Infinity ? -Infinity : contentBottom, r.bottom);
      }
      const limit = Math.min(viewBottom - 12, contentBottom);
      el.style.maxHeight = `${Math.max(limit - top, 240)}px`;
    };
    const schedule = apply;
    apply();
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    mq.addEventListener("change", schedule);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      mq.removeEventListener("change", schedule);
      el.style.maxHeight = "";
    };
  }, [ref]);
}

// Painel da cesta: sidebar fixa no desktop/tablet, bottom sheet no celular (CSS troca o
// comportamento via .cart-panel/.cart-panel-open — mesmo mecanismo do drawer da sidebar
// administrativa, em index.css). `open` só importa no celular; no desktop o painel já é visível.
export function CartPanel({
  cart,
  imageUrls,
  open,
  submitting,
  error,
  notice,
  onClose,
  onIncrement,
  onDecrement,
  onRemove,
  onNotesChange,
  onEdit,
  onSubmit,
  submitLabel = "Enviar pedido",
  hint = "Total só informativo: o preço cobrado é sempre conferido no envio.",
}: {
  cart: CartItem[];
  imageUrls: Map<string, string>;
  open: boolean;
  submitting: boolean;
  error: string | null;
  notice: string | null;
  onClose: () => void;
  onIncrement: (lineId: string) => void;
  onDecrement: (lineId: string) => void;
  onRemove: (lineId: string) => void;
  onNotesChange: (lineId: string, notes: string) => void;
  // null = a linha não tem opções para editar (quantidade/observação ficam na própria linha)
  onEdit: (item: CartItem) => (() => void) | null;
  onSubmit: () => void;
  // Reuso fora do atendimento (ex.: novo pedido de Delivery): rótulo do botão e texto de apoio.
  submitLabel?: string;
  hint?: string;
}) {
  const total = cartTotal(cart);
  const panelRef = useRef<HTMLDivElement>(null);
  useFitToViewport(panelRef);

  return (
    <>
      <div className={`cart-scrim${open ? " cart-scrim-visible" : ""}`} onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className={`cart-panel${open ? " cart-panel-open" : ""}`} role="region" aria-label="Cesta do pedido">
        <div className="cart-panel-head">
          <h3 className="cart-panel-title">Cesta</h3>
          <button className="btn-secondary btn-small cart-panel-close" type="button" onClick={onClose} aria-label="Fechar cesta">
            Fechar
          </button>
        </div>

        {notice && <div className="form-notice">{notice}</div>}
        {error && <div className="form-error">{error}</div>}

        {cart.length === 0 ? (
          <p className="cart-empty">Nenhum item na cesta ainda. Toque em um produto para adicionar.</p>
        ) : (
          <>
            <div className="cart-scroll">
              <ul className="cart-list">
                {cart.map((item) => (
                  <CartItemRow
                    key={item.lineId}
                    item={item}
                    imageUrl={item.imagePath ? (imageUrls.get(item.imagePath) ?? null) : null}
                    onIncrement={() => onIncrement(item.lineId)}
                    onDecrement={() => onDecrement(item.lineId)}
                    onRemove={() => onRemove(item.lineId)}
                    onNotesChange={(notes) => onNotesChange(item.lineId, notes)}
                    onEdit={onEdit(item)}
                  />
                ))}
              </ul>
            </div>
            <div className="cart-footer">
              <div className="cart-totals">
                <span>Total da cesta</span>
                <span>{formatReais(total)}</span>
              </div>
              <span className="field-hint">{hint}</span>
              <button className="btn-primary" type="button" disabled={submitting} onClick={onSubmit}>
                {submitting ? "Enviando…" : submitLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

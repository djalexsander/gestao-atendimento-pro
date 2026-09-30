import { useMemo, useState, type FormEvent } from "react";
import { formatReais } from "../../lib/money";
import { filterCatalog, lowStockNote, resolveBarcodeMatch, unavailableReason, type CatalogCategory, type CatalogProduct } from "./ordersLogic";

function ProductPhoto({ url }: { url: string | null }) {
  return url ? (
    <img className="catalog-card-photo" src={url} loading="lazy" alt="" />
  ) : (
    <div className="catalog-card-photo catalog-card-photo-placeholder" aria-hidden="true" />
  );
}

// Catálogo visual: busca + chips de categoria + grade de produtos. Toque no produto adiciona 1 à
// cesta na hora (sem diálogo) — a observação é ajustada depois, na cesta (ver Cart.tsx). No
// Caixa, código de barras EXATO + Enter também adiciona direto (leitor USB).
export function Catalog({
  categories,
  products,
  imageUrls,
  variant,
  onAdd,
}: {
  categories: CatalogCategory[];
  products: CatalogProduct[];
  imageUrls: Map<string, string>;
  variant: "attendant" | "cashier";
  onAdd: (product: CatalogProduct) => void;
}) {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const shown = useMemo(() => filterCatalog(products, { query, categoryId }), [products, query, categoryId]);

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    if (variant !== "cashier" || !query.trim()) return;
    const match = resolveBarcodeMatch(products, query);
    if (!match) {
      setScanMessage(`Nenhum produto encontrado para "${query.trim()}".`);
      return;
    }
    if (unavailableReason(match)) {
      setScanMessage(`${match.name}: ${unavailableReason(match) === "out" ? "sem estoque" : "este produto está indisponível para venda"}.`);
      return;
    }
    onAdd(match);
    setQuery("");
    setScanMessage(null);
  }

  let body;
  if (products.length === 0) {
    body = <p className="op-state">Nenhum produto disponível.</p>;
  } else if (shown.length === 0) {
    body = <p className="op-state">Nenhum produto nesta categoria.</p>;
  } else {
    body = (
      <ul className="catalog-grid" role="list">
        {shown.map((product) => {
          const blocked = unavailableReason(product);
          const low = lowStockNote(product);
          return (
          <li key={product.id}>
            <button
              type="button"
              className={`catalog-card${blocked ? " catalog-card-unavailable" : ""}`}
              aria-label={blocked ? `${product.name}: ${blocked === "out" ? "sem estoque" : "indisponível"}` : `Adicionar ${product.name}, ${formatReais(product.salePrice)}, à cesta`}
              disabled={blocked !== null}
              onClick={() => onAdd(product)}
            >
              <ProductPhoto url={product.imagePath ? (imageUrls.get(product.imagePath) ?? null) : null} />
              <span className="catalog-card-body">
                <span className="catalog-card-name">{product.name}</span>
                {product.description && <span className="catalog-card-desc">{product.description}</span>}
                <span className="catalog-card-price">{formatReais(product.salePrice)}</span>
                {blocked && <span className="status-badge status-inactive">{blocked === "out" ? "Sem estoque" : "Indisponível"}</span>}
                {!blocked && low && <span className="status-badge stock-low">{low}</span>}
              </span>
            </button>
          </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="catalog">
      <form className="op-toolbar" role="search" onSubmit={handleSearchSubmit}>
        <div className="op-search">
          <input
            className="op-search-input"
            type="search"
            value={query}
            placeholder="Buscar produto…"
            aria-label="Buscar produto por nome, código, código de barras ou descrição"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(e) => {
              setQuery(e.target.value);
              setScanMessage(null);
            }}
          />
        </div>
      </form>
      {scanMessage && <div className="form-error">{scanMessage}</div>}

      {categories.length > 0 && (
        <div className="catalog-chips" role="group" aria-label="Categorias">
          <button type="button" className="op-chip" aria-pressed={categoryId === null} onClick={() => setCategoryId(null)}>
            Todos
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className="op-chip"
              aria-pressed={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>
      )}

      {body}
    </div>
  );
}

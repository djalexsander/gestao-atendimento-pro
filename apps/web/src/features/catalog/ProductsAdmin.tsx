import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import type { AdminCategory } from "./categoriesLogic";
import { EditProductDialog, NewProductDialog, ToggleProductDialog } from "./ProductDialogs";
import type { ProcessedImage } from "./productImage";
import { supabaseProductsAdminSource, type NewProduct, type ProductsAdminSource } from "./productsApi";
import {
  buildImagePath,
  effectiveSector,
  filterProducts,
  formatCategoryLabel,
  type AdminProduct,
  type ProductFilter,
} from "./productsLogic";
import type { AdminSector } from "./sectorsLogic";

const FILTER_CHIPS: Array<{ value: ProductFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
];

type OpenDialog = { kind: "create" } | { kind: "edit" | "toggle"; product: AdminProduct };

function ProductThumb({ url, large }: { url: string | null; large?: boolean }) {
  const className = `product-thumb${large ? " product-thumb-lg" : ""}`;
  return url ? (
    <img className={className} src={url} loading="lazy" alt="" />
  ) : (
    <div className={`${className} product-thumb-placeholder`} aria-hidden="true" />
  );
}

// "Bar / Definido no produto", "Bar / Herdado da categoria" ou "Sem setor" — mesma regra do
// banco (ver effectiveSector em productsLogic.ts), nunca escondendo a origem do setor.
function SectorInfo({ product }: { product: AdminProduct }) {
  const sector = effectiveSector(product);
  if (!sector) return <span className="muted">Sem setor</span>;
  return (
    <>
      {sector.name}
      <div className="cell-subtext">{sector.source === "own" ? "Definido no produto" : "Herdado da categoria"}</div>
    </>
  );
}

// Disponibilidade manual e estoque controlado (só badges; a edição fica na seção Estoque do produto).
function StockBadges({ product }: { product: AdminProduct }) {
  return (
    <>
      {!product.available_for_sale && <span className="status-badge status-inactive"> Indisponível</span>}
      {product.stock_control === "quantity" && (
        <span className={`status-badge ${product.stock_quantity <= 0 ? "stock-out" : product.stock_quantity <= product.minimum_stock_quantity ? "stock-low" : "stock-normal"}`}>
          {" "}
          Estoque: {product.stock_quantity}
        </span>
      )}
    </>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return <span className={`status-badge ${active ? "status-active" : "status-inactive"}`}>{active ? "Ativo" : "Inativo"}</span>;
}

function RowActions({ onEdit, onToggle, active }: { onEdit: () => void; onToggle: () => void; active: boolean }) {
  return (
    <div className="row-actions">
      <button className="btn-secondary btn-small" type="button" onClick={onEdit}>
        Editar
      </button>
      <button className="btn-secondary btn-small" type="button" onClick={onToggle}>
        {active ? "Desativar" : "Ativar"}
      </button>
    </div>
  );
}

// Cadastro de Produtos (Administrativo): criar (com foto opcional), editar, buscar/filtrar
// (nome/código/barras/categoria + status + categoria), ativar/desativar e trocar/remover foto.
// Só owner e admin (o Administrativo já barra os demais; aqui vai uma segunda checagem) e, de
// verdade, o RLS do banco (migration 040000). Nada é excluído. Mesmo padrão de
// CategoriesAdmin.tsx/SectorsAdmin.tsx/ServicePointsAdmin.tsx.
export function ProductsAdmin({ source = supabaseProductsAdminSource }: { source?: ProductsAdminSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const canManage = role === "owner" || role === "admin";

  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [sectors, setSectors] = useState<AdminSector[]>([]);
  // path -> URL assinada (bucket privado product-images); recarregada junto com a lista.
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const [productsResult, categoriesResult, sectorsResult] = await Promise.all([
      source.load(companyId),
      source.loadCategories(companyId),
      source.loadSectors(companyId),
    ]);
    setLoading(false);
    if (productsResult.error || !productsResult.data) {
      setLoadError(productsResult.error ?? "Não foi possível carregar os produtos.");
      return;
    }
    setLoadError(null);
    setProducts(productsResult.data);
    setCategories(categoriesResult.data ?? []);
    setSectors(sectorsResult.data ?? []);

    const paths = productsResult.data.map((p) => p.image_path).filter((p): p is string => p !== null);
    setImageUrls(await source.getImageUrls(paths));
  }, [companyId, source]);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  const list = useMemo(() => products ?? [], [products]);
  const existingCodes = useMemo(() => new Set(list.map((p) => p.code)), [list]);
  const existingBarcodes = useMemo(() => new Set(list.map((p) => p.barcode).filter((b): b is string => b !== null)), [list]);
  const shown = useMemo(() => filterProducts(list, { query, filter, categoryId: categoryFilter }), [list, query, filter, categoryFilter]);

  if (!canManage) {
    return <p className="form-notice">Somente donos(as) e administradores(as) podem configurar produtos.</p>;
  }

  // Roda a operação; se der certo fecha o diálogo, avisa e recarrega a lista. Erro volta para o
  // diálogo, que o mostra sem fechar. Mesmo padrão de CategoriesAdmin.tsx.
  async function submit(request: () => Promise<{ error: string | null }>, successNotice: string): Promise<string | null> {
    const result = await request();
    if (result.error) return result.error;
    setDialog(null);
    setNotice(successNotice);
    void reload();
    return null;
  }

  // Cria o produto; só DEPOIS (já com o id) tenta enviar a foto pendente e/ou gerar o EAN-13
  // marcado. Falha em qualquer um dos dois NÃO desfaz o produto — fecha o diálogo do mesmo jeito
  // e avisa que dá para tentar de novo editando (itens 9 do pedido de Produtos e 5 do pedido de
  // EAN-13, mesma regra para os dois).
  async function submitCreate(input: NewProduct, pendingImage: ProcessedImage | null, generateEan: boolean): Promise<string | null> {
    const created = await source.create(companyId!, input);
    if (created.error || !created.data) {
      return created.error ?? "Não foi possível cadastrar o produto agora. Tente novamente.";
    }
    const productId = created.data.id;
    setDialog(null);

    let notice = `${input.name} cadastrado.`;
    if (pendingImage) {
      const uploadResult = await source.uploadImage(companyId!, productId, pendingImage.blob);
      if (uploadResult.error) {
        notice += " Não foi possível enviar a foto — você pode tentar de novo editando o produto.";
      }
    }
    if (generateEan) {
      const eanResult = await source.generateEan(productId, false);
      if (eanResult.error) {
        notice += " Não foi possível gerar o código de barras — você pode tentar de novo editando o produto.";
      }
    }
    setNotice(notice);
    void reload();
    return null;
  }

  // Troca/remoção de foto e geração/regeneração de EAN na edição são ações imediatas e
  // independentes do "Salvar" (ver EditPhotoField/BarcodeField em ProductDialogs.tsx). `await
  // reload()`/`void reload()` garantem que a lista e (no caso da foto) a URL assinada ficam em
  // dia; o diálogo, ainda aberto, recebe as props atualizadas e re-renderiza sozinho.
  async function handleUploadImage(productId: string, blob: Blob): Promise<string | null> {
    const result = await source.uploadImage(companyId!, productId, blob);
    if (result.error) return result.error;
    await reload();
    return null;
  }

  async function handleRemoveImage(productId: string): Promise<string | null> {
    const result = await source.removeImage(companyId!, productId);
    if (result.error) return result.error;
    await reload();
    return null;
  }

  async function handleGenerateEan(productId: string, regenerate: boolean): Promise<{ barcode: string | null; error: string | null }> {
    const result = await source.generateEan(productId, regenerate);
    if (!result.error) void reload();
    return result;
  }

  function open(next: OpenDialog) {
    setNotice(null);
    setDialog(next);
  }

  let body;
  if (loading && products === null) {
    body = <p className="op-state">Carregando produtos…</p>;
  } else if (products === null) {
    body = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (list.length === 0) {
    body = <p className="op-state">Nenhum produto cadastrado ainda. Use "Novo produto".</p>;
  } else if (shown.length === 0) {
    body = <p className="op-state">Nada encontrado com esses filtros.</p>;
  } else {
    body = (
      <>
        <div className="table-scroll product-table">
          <table className="data-table">
            <thead>
              <tr>
                <th>Foto</th>
                <th>Nome</th>
                <th>Código</th>
                <th>Categoria</th>
                <th>Preço</th>
                <th>Setor de produção</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((product) => (
                <tr key={product.id} className={product.is_active ? undefined : "row-inactive"}>
                  <td>
                    <ProductThumb url={product.image_path ? (imageUrls.get(product.image_path) ?? null) : null} />
                  </td>
                  <td>{product.name}</td>
                  <td className="mono">{product.code}</td>
                  <td>{formatCategoryLabel(product.category)}</td>
                  <td className="mono">{formatReais(product.sale_price)}</td>
                  <td>
                    <SectorInfo product={product} />
                  </td>
                  <td>
                    <StatusBadge active={product.is_active} />
                    <StockBadges product={product} />
                  </td>
                  <td>
                    <RowActions
                      active={product.is_active}
                      onEdit={() => open({ kind: "edit", product })}
                      onToggle={() => open({ kind: "toggle", product })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="product-cards">
          {shown.map((product) => (
            <li key={product.id} className={`product-card${product.is_active ? "" : " product-card-inactive"}`}>
              <div className="product-card-top">
                <ProductThumb url={product.image_path ? (imageUrls.get(product.image_path) ?? null) : null} large />
                <div className="product-card-main">
                  <div className="product-card-name">{product.name}</div>
                  <div className="product-card-price">{formatReais(product.sale_price)}</div>
                  <StatusBadge active={product.is_active} />
                    <StockBadges product={product} />
                </div>
              </div>
              <dl className="product-card-details">
                <div>
                  <dt>Código</dt>
                  <dd className="mono">{product.code}</dd>
                </div>
                <div>
                  <dt>Categoria</dt>
                  <dd>{formatCategoryLabel(product.category)}</dd>
                </div>
                <div>
                  <dt>Setor</dt>
                  <dd>
                    <SectorInfo product={product} />
                  </dd>
                </div>
              </dl>
              <RowActions
                active={product.is_active}
                onEdit={() => open({ kind: "edit", product })}
                onToggle={() => open({ kind: "toggle", product })}
              />
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="sp-admin">
      <div className="admin-actions">
        <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "create" })}>
          Novo produto
        </button>
      </div>

      {loadError && <div className="form-error">{loadError}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {products && list.length > 0 && (
        <div className="admin-filters">
          <input
            className="admin-search"
            type="search"
            value={query}
            placeholder="Buscar nome, código, barras ou categoria"
            aria-label="Buscar por nome, código, código de barras ou categoria"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="op-filters" role="group" aria-label="Filtrar lista">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                className="op-chip"
                aria-pressed={filter === chip.value}
                onClick={() => setFilter(chip.value)}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {categories.length > 0 && (
            <select
              className="admin-search"
              aria-label="Filtrar por categoria"
              value={categoryFilter ?? ""}
              onChange={(e) => setCategoryFilter(e.target.value || null)}
            >
              <option value="">Todas as categorias</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {body}

      {dialog?.kind === "create" && (
        <NewProductDialog
          categories={categories}
          sectors={sectors}
          existingCodes={existingCodes}
          existingBarcodes={existingBarcodes}
          onSubmit={(input, pendingImage, generateEan) => submitCreate(input, pendingImage, generateEan)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditProductDialog
          key={dialog.product.id}
          product={dialog.product}
          categories={categories}
          sectors={sectors}
          existingCodes={existingCodes}
          existingBarcodes={existingBarcodes}
          imageUrl={imageUrls.get(buildImagePath(companyId!, dialog.product.id)) ?? null}
          onSubmit={(input) => submit(() => source.update(dialog.product.id, input), `${input.name} atualizado.`)}
          onUploadImage={(blob) => handleUploadImage(dialog.product.id, blob)}
          onRemoveImage={() => handleRemoveImage(dialog.product.id)}
          onGenerateEan={(regenerate) => handleGenerateEan(dialog.product.id, regenerate)}
          onStockChanged={() => void reload()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "toggle" && (
        <ToggleProductDialog
          key={dialog.product.id}
          product={dialog.product}
          onConfirm={() =>
            submit(
              () => source.setActive(dialog.product.id, !dialog.product.is_active),
              dialog.product.is_active ? `${dialog.product.name} desativado.` : `${dialog.product.name} ativado.`,
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

import { ProductsAdmin } from "../features/catalog/ProductsAdmin";

// Administrativo: cadastro de Produtos. Só owner e admin (ver ProductsAdmin).
export function ProductsPage() {
  return (
    <div>
      <h2>Produtos</h2>
      <p className="field-hint">Cadastre os produtos disponíveis para venda e atendimento.</p>
      <ProductsAdmin />
    </div>
  );
}

import { CategoriesAdmin } from "../features/catalog/CategoriesAdmin";

// Administrativo: cadastro de Categorias. Só owner e admin (ver CategoriesAdmin).
export function ProductCategoriesPage() {
  return (
    <div>
      <h2>Categorias</h2>
      <p className="field-hint">Organize os produtos e defina, quando necessário, um setor de produção padrão.</p>
      <CategoriesAdmin />
    </div>
  );
}

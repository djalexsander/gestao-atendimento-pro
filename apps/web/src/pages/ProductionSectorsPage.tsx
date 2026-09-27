import { SectorsAdmin } from "../features/catalog/SectorsAdmin";

// Administrativo: cadastro de Setores de produção. Só owner e admin (ver SectorsAdmin).
export function ProductionSectorsPage() {
  return (
    <div>
      <h2>Setores de produção</h2>
      <p className="field-hint">Defina para onde os itens serão enviados durante a produção.</p>
      <SectorsAdmin />
    </div>
  );
}

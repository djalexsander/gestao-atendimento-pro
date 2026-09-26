import type { ServicePointsAdminSource } from "../features/operations/adminApi";
import { ServicePointsAdmin } from "../features/operations/ServicePointsAdmin";

// Administrativo: configuração de Comandas / Mesas. Só owner e admin (ver ServicePointsAdmin).
// `source` só existe para exercitar a tela com dados simulados; na rota fica o padrão (Supabase).
export function ServicePointsAdminPage({ source }: { source?: ServicePointsAdminSource }) {
  return (
    <div>
      <h2>Comandas / Mesas</h2>
      <ServicePointsAdmin source={source} />
    </div>
  );
}

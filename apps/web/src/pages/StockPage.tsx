import { StockAdmin } from "../features/stock/StockAdmin";

// Administrativo: Estoque dos produtos com controle de quantidade. Só owner e admin (rota /app).
export function StockPage() {
  return <StockAdmin />;
}

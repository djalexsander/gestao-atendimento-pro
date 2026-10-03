import { ModifiersAdmin } from "../features/modifiers/ModifiersAdmin";

// Administrativo: Adicionais / opções dos produtos. Só owner e admin (ver ModifiersAdmin).
export function ProductModifiersPage() {
  return (
    <div>
      <h2>Adicionais / opções</h2>
      <p className="field-hint">Crie grupos de opções (ex.: Como servir, Adicionais) e vincule aos produtos. O garçom escolhe ao lançar o pedido.</p>
      <ModifiersAdmin />
    </div>
  );
}

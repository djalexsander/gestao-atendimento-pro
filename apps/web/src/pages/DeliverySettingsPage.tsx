import { useAuth } from "../app/useAuth";
import { DeliverySettings } from "../features/delivery/DeliverySettings";

// Configurações → Delivery. Só owner e admin (o Administrativo já barra os demais; segunda checagem aqui).
export function DeliverySettingsPage() {
  const { activeMembership } = useAuth();
  if (!activeMembership) return null;
  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";
  return (
    <div>
      <h2>Delivery</h2>
      {canEdit ? (
        <DeliverySettings companyId={activeMembership.companyId} />
      ) : (
        <p style={{ color: "var(--text-muted)" }}>Somente donos(as) e administradores(as) podem configurar o Delivery.</p>
      )}
    </div>
  );
}

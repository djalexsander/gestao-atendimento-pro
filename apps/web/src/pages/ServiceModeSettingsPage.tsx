import { useAuth } from "../app/useAuth";
import { ServiceModeSection } from "../features/operations/ServiceModeSection";

// Configurações → Modo de atendimento. Só owner e admin (o Administrativo já barra os demais;
// aqui vai uma segunda checagem, mesmo padrão de ServicePointsAdmin/CompanySettingsPage).
export function ServiceModeSettingsPage() {
  const { activeMembership } = useAuth();
  if (!activeMembership) return null;

  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";

  return (
    <div>
      <h2>Modo de atendimento</h2>
      {canEdit ? (
        <ServiceModeSection companyId={activeMembership.companyId} />
      ) : (
        <p style={{ color: "var(--text-muted)" }}>
          Somente donos(as) e administradores(as) podem alterar o modo de atendimento.
        </p>
      )}
    </div>
  );
}

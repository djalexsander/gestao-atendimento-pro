import { useAuth } from "../app/useAuth";
import { WhatsappAiSettings } from "../features/whatsapp/WhatsappAiSettings";

// Configurações → IA do WhatsApp. Só owner e admin (o Administrativo já barra os demais; segunda checagem aqui).
export function WhatsappAiSettingsPage() {
  const { activeMembership } = useAuth();
  if (!activeMembership) return null;
  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";
  return (
    <div>
      <h2>IA do WhatsApp</h2>
      {canEdit ? (
        <WhatsappAiSettings companyId={activeMembership.companyId} />
      ) : (
        <p style={{ color: "var(--text-muted)" }}>Somente donos(as) e administradores(as) podem configurar a IA do WhatsApp.</p>
      )}
    </div>
  );
}

import { useAuth } from "../app/useAuth";
import { WhatsappConnection } from "../features/whatsapp/WhatsappConnection";
import { canUseWhatsapp } from "../features/whatsapp/whatsappLogic";

// Configurações → Conexão do WhatsApp. Papéis operacionais veem o status; só owner/admin gerenciam (o banco confere de novo).
export function WhatsappConnectionPage() {
  const { activeMembership } = useAuth();
  if (!activeMembership) return null;
  return (
    <div>
      <h2>WhatsApp</h2>
      {canUseWhatsapp(activeMembership.role) ? (
        <WhatsappConnection companyId={activeMembership.companyId} />
      ) : (
        <p style={{ color: "var(--text-muted)" }}>Você não tem permissão para ver a conexão do WhatsApp.</p>
      )}
    </div>
  );
}

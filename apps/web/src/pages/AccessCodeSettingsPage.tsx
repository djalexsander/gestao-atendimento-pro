import { useAuth } from "../app/useAuth";
import type { AccessCodeSource } from "../features/company/accessCodeApi";
import { AccessCodeSection } from "../features/company/AccessCodeSection";

// Configurações → Código de acesso. AccessCodeSection já tem seu próprio título ("Código de
// acesso dos funcionários"), a explicação de uso, a regra de bloqueio e a distinção
// slug ≠ código — nada disso é duplicado aqui, só a rota própria.
// `accessCodeSource` só existe para exercitar a tela com dados simulados; na rota fica o padrão.
export function AccessCodeSettingsPage({ accessCodeSource }: { accessCodeSource?: AccessCodeSource }) {
  const { activeMembership } = useAuth();
  if (!activeMembership) return null;

  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";

  return <AccessCodeSection company={activeMembership.company} canEdit={canEdit} source={accessCodeSource} />;
}

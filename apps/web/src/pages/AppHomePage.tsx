import { useAuth } from "../app/useAuth";

export function AppHomePage() {
  const { activeMembership } = useAuth();

  return (
    <>
      <h2>Bem-vindo(a) ao {activeMembership?.company.name}</h2>
      <p style={{ color: "var(--text-muted)" }}>
        O painel completo ainda está em construção. Use o menu acima para configurações
        da empresa e gestão da equipe.
      </p>
    </>
  );
}

import { useEffect, useState } from "react";
import { useAuth } from "../app/useAuth";
import { WhatsappAiIndicators } from "../features/whatsapp/WhatsappAiIndicators";
import { WhatsappAiSettings } from "../features/whatsapp/WhatsappAiSettings";
import { WhatsappKnowledgeSettings } from "../features/whatsapp/WhatsappKnowledgeSettings";
import { supabaseWhatsappModulesSource } from "../features/whatsapp/whatsappModulesApi";
import { AI_NEEDS_WHATSAPP_TEXT, aiPanelKind, type ModuleState } from "../features/whatsapp/whatsappModulesLogic";

// Configurações → Inteligência Artificial. Só owner e admin (o Administrativo já barra os demais; segunda checagem aqui).
// A IA atende PELO WhatsApp: sem o módulo WhatsApp mostra a orientação de dependência (sem alterar o contrato).
export function WhatsappAiSettingsPage() {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const [state, setState] = useState<ModuleState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    void supabaseWhatsappModulesSource.state(companyId).then((r) => {
      if (!alive) return;
      setState(r.data);
      setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [companyId]);

  if (!activeMembership || !companyId) return null;
  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";
  if (!canEdit) {
    return (
      <div>
        <h2>Inteligência Artificial</h2>
        <p style={{ color: "var(--text-muted)" }}>Somente donos(as) e administradores(as) podem configurar a IA do WhatsApp.</p>
      </div>
    );
  }
  const kind = state ? aiPanelKind(state) : null;
  return (
    <div>
      <h2>Inteligência Artificial</h2>
      {error && <div className="form-error" role="alert">{error}</div>}
      {!state && !error && <p className="muted">Carregando…</p>}
      {kind === "needs_whatsapp" && (
        <div className="module-locked" role="status">
          <p>{AI_NEEDS_WHATSAPP_TEXT}</p>
        </div>
      )}
      {kind === "ready" && (
        <>
          <WhatsappAiSettings companyId={companyId} />
          <WhatsappAiIndicators companyId={companyId} />
          <WhatsappKnowledgeSettings companyId={companyId} />
        </>
      )}
    </div>
  );
}

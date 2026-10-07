import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FullPageLoader } from "../../app/FullPageLoader";
import { useAuth } from "../../app/useAuth";
import { BILLING_PATH, MODULE_NAME, lockedModuleText, moduleAccess, type ModuleCode } from "./commercialLogic";
import { useCommercial } from "./CommercialProvider";

// Rota exclusiva de um módulo: só renderiza quando o BANCO diz que a empresa tem o módulo ativo (tenant_get_entitlements).
// Sem o módulo, mostra o convite para contratar — a rota direta (digitar a URL) cai aqui também. É a camada visual: a barreira
// das operações é do backend (assert_company_module). Enquanto o entitlement carrega, espera (nunca libera por palpite).
export function ModuleGate({ module, children }: { module: ModuleCode; children: ReactNode }) {
  const { entitlements } = useCommercial();
  const { activeMembership } = useAuth();
  const access = moduleAccess(entitlements, module);
  if (access === "loading") return <FullPageLoader />;
  if (access === "allowed") return <>{children}</>;
  const isOwner = activeMembership?.role === "owner";
  return (
    <div className="module-locked" role="status">
      <h2>{MODULE_NAME[module]}</h2>
      <p>{lockedModuleText(module, isOwner)}</p>
      <p className="field-hint">Seus dados continuam guardados: ao contratar o módulo, tudo volta a aparecer.</p>
      {isOwner && (
        <Link className="btn-primary btn-auto" to={BILLING_PATH}>
          Adicionar em Meus Planos
        </Link>
      )}
    </div>
  );
}

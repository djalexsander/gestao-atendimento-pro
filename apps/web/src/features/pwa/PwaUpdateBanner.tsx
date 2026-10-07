import { usePwaUpdate } from "./pwaUpdateContext";

export const UPDATE_TITLE = (version: string) => `Nova versão disponível — v${version}`;
export const UPDATE_TEXT = "Atualize agora para usar as melhorias mais recentes.";

// Banner global de nova versão do PWA: fixo na base da tela (respeita a área segura do iPhone), acima da sidebar e dos
// menus, sem bloquear a operação. "Depois" só o fecha nesta sessão; "Atualizar agora" atualiza o service worker e recarrega.
export function PwaUpdateBanner() {
  const { state, dismiss, applyNow } = usePwaUpdate();
  if (state.status === "idle" || !state.version || (state.status === "available" && state.dismissed)) return null;
  const updating = state.status === "updating";
  return (
    <div className="pwa-update" role="status" aria-live="polite">
      <div className="pwa-update-text">
        <strong>{UPDATE_TITLE(state.version)}</strong>
        <span>{UPDATE_TEXT}</span>
      </div>
      <div className="pwa-update-actions">
        <button type="button" className="btn-primary btn-auto" onClick={() => void applyNow()} disabled={updating}>
          {updating ? "Atualizando..." : "ATUALIZAR AGORA"}
        </button>
        <button type="button" className="btn-secondary btn-auto" onClick={dismiss} disabled={updating}>
          DEPOIS
        </button>
      </div>
    </div>
  );
}
